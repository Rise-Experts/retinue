/**
 * Per-tenant rate limiting at run admission — REQ-058 (#246), task #248.
 *
 * Cost quotas already gate admission and work well: reservations, `UsageCeiling`, refusal before a provider call
 * (`quota.ts`). **Rate is a different axis and nothing bounded it.** A thousand runs a second, each costing a
 * fraction of a cent, passes every check that existed — `grep -ril "rate limit"` found the phrase only in
 * `runtime/retry.ts`, handling a *provider's* 429, and in the load-test scenario.
 *
 * The two fail differently, which is why this is not a dimension of the quota guard:
 *
 * - A cost ceiling stops a tenant **spending too much over a period**. It is answered from a rollup.
 * - A rate limit stops a tenant **consuming a deployment's capacity right now**. It is answered from a counter
 *   that has to be correct across every process in the fleet.
 *
 * ## Why this lives in `usage/`
 *
 * It is not usage, and it sits here anyway: it is an *admission guard*, it is called on the same line as the
 * quota guard, a deployment configures both in the same place, and putting it in its own module would add a
 * published subpath for one port. The alternative was worse than the mild misfiling.
 *
 * ## Fixed window, and what that costs
 *
 * The window is identified by its **start, truncated to the period** — the same decision `bucketStartFor` makes
 * for rollups, for the same reason: two processes asking "which window does T belong to" must agree, and they do
 * because truncation is a pure function of T rather than a range someone chooses. It also means the Redis key is
 * deterministic, so a key can never be created without an expiry and strand a tenant.
 *
 * The cost is the boundary burst: a tenant may send `max` at the end of one window and `max` at the start of the
 * next, so the true worst case over a sliding window is 2×`max`. A sliding-log implementation would fix that and
 * costs a sorted set per tenant with a member per request. Not worth it: the point is to stop a runaway client
 * saturating a fleet, and 2× the intended rate for one window boundary does not.
 *
 * ## Two axes deliberately not implemented — AC-1
 *
 * **Concurrent runs per tenant.** This is a real gap: `startOrEnqueueRun` serialises runs *within* a
 * conversation, and `serialization.ts` says outright that a conversation-less run's concurrency is "bounded
 * where it should be: the worker's own limits, and quotas" — which is a per-process setting and a spend limit,
 * neither of which stops one tenant occupying every slot in the fleet. It is left out because a *correct*
 * implementation must be crash-safe, and a counter incremented at admission and decremented at completion leaks
 * a permanent unit every time a worker dies mid-run. The right home is the existing run **lease**, which already
 * has a TTL and a heartbeat — so this belongs with the lease rather than beside it, and doing it here would mean
 * shipping the leaky version first.
 *
 * **Tool executions per run per interval.** `ExecutionLimits.maxToolCalls` already bounds the *count* and
 * `wallClockTimeoutMs` bounds a tight loop, so a rate would need a clock threaded through the tool path to
 * constrain something already constrained twice.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { TenantId } from "../core/ids.js";

/**
 * How many admissions a tenant gets, and over how long.
 *
 * `max: 0` and an absent policy both mean **unlimited** — see `createRateLimitGuard`. A deployment upgrading
 * into this feature must not find its runs refused because it has not configured a limit yet.
 */
export type RateLimitPolicy = {
  readonly max: number;
  readonly windowSeconds: number;
};

export type RateLimitDecision =
  /** `remaining` is after this admission, so zero means the next one refuses. */
  | { readonly admitted: true; readonly remaining: number; readonly resetsAt: string }
  | {
      readonly admitted: false;
      readonly limit: number;
      readonly windowSeconds: number;
      readonly used: number;
      readonly resetsAt: string;
      readonly retryAfterMs: number;
      readonly message: string;
    };

/**
 * The counter, as a port.
 *
 * `consume` must be **atomic** and must set the expiry in the same operation. An `INCR` followed by a separate
 * `EXPIRE` is the obvious implementation and it is wrong: a process dying between the two leaves a key with no
 * TTL, and that tenant is refused for ever. The Redis adapter uses one script.
 */
export interface RateLimitStore {
  consume(input: {
    readonly tenantId: TenantId;
    /** The truncated window start, in epoch milliseconds — the key's identity. */
    readonly windowStartMs: number;
    readonly windowSeconds: number;
  }): Promise<number>;
}

/** The window a moment belongs to. Pure, so every process agrees without coordinating. */
export const windowStartMs = (atMs: number, windowSeconds: number): number => {
  if (!Number.isFinite(atMs)) throw new AgentPlatformError({ code: "invalid_input", message: "rate limit: `at` must be a finite number of milliseconds", retryable: false });
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `rate limit: windowSeconds must be a positive integer, got ${windowSeconds}`,
      retryable: false,
    });
  const span = windowSeconds * 1_000;
  return Math.floor(atMs / span) * span;
};

/**
 * Told when a tenant is refused.
 *
 * A sink of its own rather than a `RunEvent`, and the reason is the one `QuotaObserver` already gives: a
 * `RunEvent` carries a `runId`, and this fires **before a run exists** — which is the whole point of refusing at
 * admission. Squeezing it into the run stream would mean inventing a run id for an event about not starting one.
 */
export interface RateLimitObserver {
  onRefusal(context: ExecutionContext, refusal: Extract<RateLimitDecision, { admitted: false }>): Promise<void> | void;
}

export type RateLimitGuardDeps = {
  readonly store: RateLimitStore;
  /**
   * The policy for this tenant, or undefined for unlimited.
   *
   * A function rather than a value, for the reason `QuotaGuardDeps` gives: limits are per tenant and change
   * without a redeploy, and a value captured at construction would be the limits of whoever booted the process.
   */
  readonly policyFor: (context: ExecutionContext) => Promise<RateLimitPolicy | undefined> | RateLimitPolicy | undefined;
  readonly observer?: RateLimitObserver;
  readonly now?: () => number;
};

export const createRateLimitGuard = (deps: RateLimitGuardDeps) => {
  const now = deps.now ?? Date.now;

  return {
    async admit(context: ExecutionContext): Promise<RateLimitDecision> {
      const policy = await deps.policyFor(context);
      /**
       * Unlimited, and this is the branch that matters most on the day this ships — AC-7.
       *
       * No policy, or a `max` of zero, means unlimited rather than deny-everything. A deployment that upgrades
       * into this feature and has configured nothing must keep working; the alternative is an outage caused by
       * adding a safety feature, which is how safety features get removed.
       */
      if (policy === undefined || policy.max <= 0)
        return { admitted: true, remaining: Number.POSITIVE_INFINITY, resetsAt: new Date(now()).toISOString() };

      const at = now();
      const start = windowStartMs(at, policy.windowSeconds);
      const resetsAtMs = start + policy.windowSeconds * 1_000;
      const resetsAt = new Date(resetsAtMs).toISOString();
      const used = await deps.store.consume({
        tenantId: context.tenantId,
        windowStartMs: start,
        windowSeconds: policy.windowSeconds,
      });

      if (used <= policy.max) return { admitted: true, remaining: policy.max - used, resetsAt };

      const refusal = {
        admitted: false as const,
        limit: policy.max,
        windowSeconds: policy.windowSeconds,
        used,
        resetsAt,
        // At least a millisecond: a window that has just closed must not tell a client to retry in zero, which
        // reads as "immediately" and puts it straight back into the same refusal.
        retryAfterMs: Math.max(1, resetsAtMs - at),
        message:
          `This workspace has used ${used} of ${policy.max} runs allowed per ${policy.windowSeconds}s. ` +
          `It resets at ${resetsAt}.`,
      };
      await deps.observer?.onRefusal(context, refusal);
      return refusal;
    },

    /** Throws the refusal, for a caller that would rather not branch. Same decision, different ergonomics. */
    async assertAdmitted(context: ExecutionContext): Promise<RateLimitDecision> {
      const decision = await this.admit(context);
      if (!decision.admitted)
        throw new AgentPlatformError({
          code: "admission_rate_limited",
          message: decision.message,
          /**
           * Retryable, and `retryAfterMs` is what makes that honest.
           *
           * The window resets, so a client that treated this as permanent would give up on a workspace that is
           * fine in a second. What must **not** happen is the engine's retry loop absorbing it — and it cannot:
           * this is thrown at admission, before a run exists, so `decideRetry` never sees it. The distinct error
           * code is what keeps it that way if the call site ever moves.
           */
          retryable: true,
          retryAfterMs: decision.retryAfterMs,
          details: {
            retryAfter: decision.resetsAt,
            retryAfterMs: decision.retryAfterMs,
            limit: decision.limit,
            used: decision.used,
            windowSeconds: decision.windowSeconds,
          },
        });
      return decision;
    },
  };
};

export type RateLimitGuard = ReturnType<typeof createRateLimitGuard>;
