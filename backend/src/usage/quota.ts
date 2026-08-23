/**
 * Rollup buckets and quota enforcement (#139).
 *
 * Phase 5 gave usage a recording hook and #100 made it durable. Nothing aggregated it and nothing enforced a
 * limit, so one customer's consumption was unbounded.
 *
 * Four decisions carry this module.
 *
 * **Buckets are identified by their start, truncated to the period.** Two writers asking "which bucket does T
 * belong to" must agree, and they do because truncation is a pure function of T rather than a range someone
 * chooses.
 *
 * **The quota check happens at admission, before any provider call.** AC-2's wording is "before work starts",
 * and the reason is what the alternative costs: a limit enforced mid-run leaves a half-written answer, a
 * partial charge, and a user who has to guess whether to retry. Refusing admission is a complete outcome.
 *
 * **The warning fires below the limit, not at it.** A customer told at 100% is told when work is already
 * failing. The threshold is a fraction so it scales with the limit rather than being a constant that is
 * meaningless at one plan size and useless at another.
 *
 * **Enforcement reads a rollup, not the ledger.** Admission is on the hot path of every message; a check that
 * scanned raw events would make the platform slower in exact proportion to how much it had been used.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { RollupPeriod, UsageRollupStore, UsageTotals } from "../persistence/index.js";

/** Zero, as a total. Named because "no usage" appears in several places and an object literal invites drift. */
export const NO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costMinorUnits: 0,
  eventCount: 0,
};

/**
 * The instant a period's bucket opens, for a given moment.
 *
 * Truncation in UTC, deliberately. A tenant-local day would make a bucket's identity depend on a timezone
 * setting that can change, and a rollup already written under the old offset would silently belong to a
 * different day than one written after — so "yesterday" would double-count an hour or lose one. Presenting
 * totals in local time is a display concern; *storing* them in one is a correctness bug.
 */
export const bucketStartFor = (period: RollupPeriod, at: string): string => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime()))
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `not a timestamp: ${JSON.stringify(at)}`,
      retryable: false,
    });
  const truncated = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      period === "hour" ? d.getUTCHours() : 0,
    ),
  );
  return truncated.toISOString();
};

/** The bucket after this one. For tiling a range without arithmetic at the call site. */
export const nextBucket = (period: RollupPeriod, bucketStart: string): string => {
  const d = new Date(bucketStart);
  const ms = period === "hour" ? 3_600_000 : 86_400_000;
  return new Date(d.getTime() + ms).toISOString();
};

/** Every bucket start covering `[from, to)`, in order. */
export const bucketsBetween = (period: RollupPeriod, from: string, to: string): readonly string[] => {
  const out: string[] = [];
  let cursor = bucketStartFor(period, from);
  const end = new Date(to).getTime();
  // Bounded so a bad range cannot loop forever: a year of hours is the most anyone charts at that resolution,
  // and a caller wanting more is asking the wrong question of the wrong period.
  for (let guard = 0; guard < 9000 && new Date(cursor).getTime() < end; guard += 1) {
    out.push(cursor);
    cursor = nextBucket(period, cursor);
  }
  return out;
};

/**
 * What a tenant may consume in a period.
 *
 * Every field optional, and an omitted field is *unbounded* rather than zero. That direction is deliberate: a
 * misconfigured quota that blocks everything is an outage, and a misconfigured quota that blocks nothing is a
 * bill — and the bill is visible in the rollups this module also provides, whereas the outage is only visible
 * to the customer it is happening to.
 */
export type QuotaLimits = {
  readonly period: RollupPeriod;
  readonly costMinorUnits?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * Fraction of a limit at which a warning fires. Defaults to 0.8.
   *
   * A fraction rather than an absolute, so it scales with the limit instead of being meaningless on a large
   * plan and constantly tripping on a small one.
   */
  readonly warnAt?: number;
};

export const DEFAULT_WARN_AT = 0.8;

/** Which limit was hit. Separate values because the sentence a user reads differs. */
export const QUOTA_DIMENSIONS = ["cost", "input-tokens", "output-tokens"] as const;
export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

/**
 * The admission answer.
 *
 * A union, so "refused" has no `allowed` shape to hide in: a caller cannot read a refusal as a permissive
 * default, which for a spend limit is the failure that costs money.
 */
export type QuotaDecision =
  | { readonly admitted: true; readonly usage: UsageTotals; readonly warnings: readonly QuotaWarning[] }
  | {
      readonly admitted: false;
      readonly dimension: QuotaDimension;
      readonly limit: number;
      readonly used: number;
      readonly message: string;
      readonly retryAfter: string;
    };

export type QuotaWarning = {
  readonly dimension: QuotaDimension;
  readonly limit: number;
  readonly used: number;
  readonly fraction: number;
  readonly message: string;
};

/**
 * Told when a tenant crosses a warning threshold.
 *
 * A sink of its own rather than a `RunEvent`, because a `RunEvent` carries a `runId` and a quota warning fires
 * *before* a run exists — which is the whole point of warning at admission. Squeezing it into the run stream
 * would mean inventing a run id for an event about not starting one.
 */
export interface QuotaObserver {
  onWarning(context: ExecutionContext, warning: QuotaWarning): Promise<void> | void;
  onRefusal?(
    context: ExecutionContext,
    refusal: Extract<QuotaDecision, { admitted: false }>,
  ): Promise<void> | void;
}

export type QuotaGuardDeps = {
  readonly rollups: UsageRollupStore;
  /**
   * The limits for this tenant, or undefined for unlimited.
   *
   * A function rather than a value: limits are per tenant and change without a redeploy, and a value captured
   * at construction would be the limits of whoever booted the process.
   */
  readonly resolveLimits: (context: ExecutionContext) => Promise<QuotaLimits | undefined> | QuotaLimits | undefined;
  readonly observer?: QuotaObserver;
  readonly clock?: () => string;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

const DIMENSION_LABEL: Readonly<Record<QuotaDimension, string>> = {
  cost: "spend",
  "input-tokens": "input tokens",
  "output-tokens": "output tokens",
};

export const createQuotaGuard = (deps: QuotaGuardDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});

  return {
    /**
     * Decide whether a run may start — AC-2.
     *
     * Reads the current period's rollup, not the ledger: admission is on the hot path of every message, and a
     * check that scanned raw events would make the platform slower in proportion to how much it had been used.
     */
    async admit(context: ExecutionContext, at: string = clock()): Promise<QuotaDecision> {
      const limits = await deps.resolveLimits(context);
      // No limits configured is unbounded, not zero. A misconfigured quota that blocks everything is an
      // outage; one that blocks nothing is a bill, and the bill is visible in these very rollups.
      if (limits === undefined) return { admitted: true, usage: NO_USAGE, warnings: [] };

      const bucketStart = bucketStartFor(limits.period, at);
      const rollup = await deps.rollups.get({
        tenantId: context.tenantId,
        period: limits.period,
        bucketStart,
      });
      const usage: UsageTotals = rollup ?? NO_USAGE;
      const warnAt = limits.warnAt ?? DEFAULT_WARN_AT;

      const checks: readonly { dimension: QuotaDimension; limit?: number; used: number }[] = [
        { dimension: "cost", ...(limits.costMinorUnits === undefined ? {} : { limit: limits.costMinorUnits }), used: usage.costMinorUnits },
        { dimension: "input-tokens", ...(limits.inputTokens === undefined ? {} : { limit: limits.inputTokens }), used: usage.inputTokens },
        { dimension: "output-tokens", ...(limits.outputTokens === undefined ? {} : { limit: limits.outputTokens }), used: usage.outputTokens },
      ];

      // Refusals first, across every dimension, before any warning is emitted. Emitting a warning and then
      // refusing would tell a customer they are approaching a limit they have already passed.
      for (const check of checks) {
        if (check.limit === undefined) continue;
        if (check.used >= check.limit) {
          const refusal = {
            admitted: false as const,
            dimension: check.dimension,
            limit: check.limit,
            used: check.used,
            // Actionable: names the dimension, the figure, the limit and when it resets. "Quota exceeded"
            // leaves a user with nothing to do.
            message: `This workspace has used ${check.used} of its ${check.limit} ${DIMENSION_LABEL[check.dimension]} limit for the ${limits.period}. It resets at ${nextBucket(limits.period, bucketStart)}.`,
            retryAfter: nextBucket(limits.period, bucketStart),
          };
          try {
            await deps.observer?.onRefusal?.(context, refusal);
          } catch (error) {
            // A refusal must not depend on an observer succeeding: the point is to stop work, and a broken
            // notification is not a reason to let it through.
            log("quota refusal observer failed", { error });
          }
          return refusal;
        }
      }

      const warnings: QuotaWarning[] = [];
      for (const check of checks) {
        if (check.limit === undefined || check.limit === 0) continue;
        const fraction = check.used / check.limit;
        if (fraction < warnAt) continue;
        warnings.push({
          dimension: check.dimension,
          limit: check.limit,
          used: check.used,
          fraction,
          message: `This workspace has used ${Math.round(fraction * 100)}% of its ${DIMENSION_LABEL[check.dimension]} limit for the ${limits.period}.`,
        });
      }
      for (const warning of warnings) {
        try {
          await deps.observer?.onWarning(context, warning);
        } catch (error) {
          // Logged, not thrown. A failed warning must not refuse a run that is inside its limit — that would
          // turn a notification outage into a service outage.
          log("quota warning observer failed", { error });
        }
      }
      return { admitted: true, usage, warnings };
    },

    /** Throws the refusal, for a caller that would rather not branch. Same decision, different ergonomics. */
    async assertAdmitted(context: ExecutionContext, at?: string): Promise<QuotaDecision> {
      const decision = await this.admit(context, at);
      if (!decision.admitted)
        throw new AgentPlatformError({
          code: "budget_exceeded",
          message: decision.message,
          // Retryable: the limit resets. A caller that treats this as permanent would give up on a workspace
          // that is fine again in an hour.
          retryable: true,
        });
      return decision;
    },
  };
};

export type QuotaGuard = ReturnType<typeof createQuotaGuard>;
