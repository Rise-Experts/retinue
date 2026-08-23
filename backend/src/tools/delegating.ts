/**
 * The logic-function tool envelope — `docs/extraction/twenty-sdk-comparison.md` (#113).
 *
 * The extraction doc's central decision: *"a tool is a thin, agent-facing envelope over a
 * deterministic function"* that *"adds the permission filter, the approval gate for external writes
 * and the idempotency key, then delegates the actual side effect."* Until now that existed only as
 * prose — there was no `logic-function` reference anywhere in `src`.
 *
 * The point of putting it here rather than in each tool is that **a tool cannot forget**. A capability
 * author writes a `delegate` that does one thing; authorisation, the approval gate and the idempotency
 * key are applied by construction, in one place, in one order.
 *
 * **The delegate must not know any of this exists.** It receives validated input and a context and
 * returns data. It is not told whether an approval happened, and it never sees an idempotency key —
 * which is what makes a wrapped function still a plain function, testable on its own.
 */
import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import { assertToolAuthorized } from "../authorization/index.js";
import type { IdempotencyKey, IdempotencyStore } from "../idempotency/index.js";
import type { ApprovalGate } from "../hitl/service.js";
import { toPlatformError } from "../runtime/retry.js";
import { defineTool, type ToolSpec } from "./define.js";
import type { Tool, ToolEffect } from "./index.js";

/** Effects that require an approval decision before the side effect happens. */
const GATED_EFFECTS: ReadonlySet<ToolEffect> = new Set(["external-write", "destructive"]);

export type DelegatingToolSpec<I = unknown, O = unknown> = Omit<ToolSpec<I, O>, "execute"> & {
  /**
   * The function this capability wraps, named so a reviewer can see it (AC-6).
   *
   * **Required**, not optional. A comment does not survive review at scale, and "which existing
   * function does this delegate to" is the question the whole bridge exists to make answerable — so a
   * capability that does not say what it wraps cannot be defined.
   */
  readonly delegatesTo: string;
  /**
   * The deterministic function. Receives validated input and the execution context; returns data or
   * throws. Knows nothing about authorisation, approvals or idempotency.
   */
  delegate(input: I, context: ExecutionContext): Promise<O> | O;
};

export type DelegatingToolDeps = {
  readonly authorization: AuthorizationPolicy;
  /**
   * Consulted for gated effects. Absent means no capability with an external-write or destructive
   * effect can run — refusing is the safe default, since the alternative is performing an unapproved
   * side effect because a dependency was not wired.
   */
  readonly approvals?: ApprovalGate;
  /**
   * Where a first result is stored so a retry returns it. Absent means gated effects are refused for
   * the same reason: an external write with no replay protection is exactly the thing this envelope
   * exists to prevent. See the open question on #113.
   */
  readonly idempotency?: IdempotencyStore;
};

/**
 * A stable string for a value, for the fallback key.
 *
 * Object keys are sorted, because `{a, b}` and `{b, a}` are the same arguments and must not produce
 * two keys — the whole point of the key is that an identical call collides with itself.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

/**
 * The key used when the caller supplied none.
 *
 * **Weaker protection than the caller's key, and stronger collision behaviour — both worth knowing.**
 * `ToolExecutionInput.idempotencyKey` is documented as derived from tenant, run and tool-call identity,
 * which makes a *retry of one call* safe. This fallback is derived from tenant, conversation, tool and
 * normalised arguments, as the SPEC describes, which collides for *any* call with identical arguments
 * **across runs**: "publish this post" today and the same call next week produce the same key, so the
 * second would return the first result and never publish.
 *
 * That is suppression of an intended action rather than deduplication of a retry, so the caller's key
 * is always preferred. This exists only so a tool invoked without one is not left unprotected. See the
 * open question on #113 about whether the run belongs in it.
 */
export const fallbackIdempotencyKey = (input: {
  readonly context: ExecutionContext;
  readonly toolName: string;
  readonly args: unknown;
}): IdempotencyKey =>
  `${input.context.tenantId}:${input.context.conversationId ?? "-"}:${input.toolName}:${canonical(input.args)}` as IdempotencyKey;

const refuse = (code: "approval_required" | "capability_unavailable", message: string) =>
  new AgentPlatformError({ code, message, retryable: false });

/**
 * Build a `Tool` whose execute path is: authorise → derive key → look up → approval gate → delegate →
 * store.
 *
 * The lookup sits **before** the approval gate deliberately. A call whose result is already stored has
 * already been approved and executed, so re-gating it would either block a legitimate replay or ask a
 * human to approve one action twice.
 *
 * The descriptor comes from `defineTool` and the error envelope from the same `toPlatformError` a
 * delegating tool's shape is the existing `ToolResult` **by construction** rather than by resemblance
 * (AC-5). The execute path is written out here rather than passed to `defineTool`, because the
 * idempotency key arrives on `ToolExecutionInput` and `defineTool`'s `execute(input, context)` does not
 * carry it — bridging that with a side table keyed by context worked but read like a trick.
 */
export const defineDelegatingTool = <I = unknown, O = unknown>(
  deps: DelegatingToolDeps,
  spec: DelegatingToolSpec<I, O>,
): Tool<O> => {
  const effect: ToolEffect = spec.effect ?? "read";
  const gated = GATED_EFFECTS.has(effect);

  // Descriptor defaults — approval policy and idempotency requirement — come from `defineTool`, so a
  // delegating tool and a plain one classify an effect identically.
  const defaults = defineTool<I, O>({
    ...spec,
    execute: () => {
      throw new Error("unreachable: the delegating envelope owns execution");
    },
  });
  const descriptor = { ...defaults.descriptor, delegatesTo: spec.delegatesTo };

  return {
    descriptor,
    async execute({ context, input, idempotencyKey }) {
      try {
        // Re-authorised here even though discovery already filtered the catalog: the governing
        // principle is that tools are filtered before discovery *and* re-authorised during execution,
        // because a role can change between the two and a stale catalog must not be a permission.
        await assertToolAuthorized(deps.authorization, context, {
          name: spec.name,
          category: descriptor.category,
        });

        // The caller's key is preferred — it is derived from tool-call identity, which is what makes a
        // *retry* safe. The fallback is broader and can suppress an intended repeat; see its docstring.
        const key =
          (idempotencyKey as IdempotencyKey | undefined) ??
          fallbackIdempotencyKey({ context, toolName: spec.name, args: input });

        if (deps.idempotency) {
          const stored = await deps.idempotency.get<O>({ tenantId: context.tenantId, key });
          // A hit means this call already ran. Returning the stored result *is* the guarantee: the
          // delegate is not called again, so the side effect does not happen twice.
          if (stored) return { ok: true, data: stored.result };
        } else if (gated) {
          // Refusing rather than proceeding. An external write with no replay protection is precisely
          // what this envelope exists to prevent, and an unwired dependency is not a reason to do it.
          throw refuse(
            "capability_unavailable",
            `${spec.name} performs a ${effect} and no idempotency store is configured`,
          );
        }

        if (gated) {
          if (!deps.approvals) {
            throw refuse(
              "capability_unavailable",
              `${spec.name} performs a ${effect} and no approval gate is configured`,
            );
          }
          const allowed = await deps.approvals.isAllowed(context, {
            name: spec.name,
            category: descriptor.category,
            approvalPolicy: descriptor.approvalPolicy,
          });
          // The delegate is never reached. It is not told an approval was needed, refused or granted —
          // this envelope decides *whether* approval applies; `hitl/service.ts` decides *how*.
          if (!allowed) {
            throw refuse("approval_required", `${spec.name} requires approval before it can run`);
          }
        }

        const data = await spec.delegate(input as I, context);
        // Stored only after the delegate succeeds, so a failed attempt can be retried rather than
        // having its own failure permanently cached as the answer.
        if (deps.idempotency) {
          await deps.idempotency.put<O>({ tenantId: context.tenantId, key, result: data });
        }
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: toPlatformError(error) };
      }
    },
  };
};
