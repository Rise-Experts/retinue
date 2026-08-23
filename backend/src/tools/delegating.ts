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
 * **The delegate is not told whether an approval happened.** It receives validated input, a context and
 * the call's idempotency key, and returns data — which is what makes a wrapped function still a plain
 * function, testable on its own.
 *
 * The key was originally withheld too, on the reasoning that a delegate should know nothing about any
 * of this. Writing the first capability that performs a write (#115) showed that to be wrong: the
 * downstream service needs the key threaded through so a *re-delivered job* is deduplicated, which is
 * a different guarantee from the one the store here provides. The envelope stops a second agent call;
 * the downstream key stops a second delivery of one accepted call. Either alone leaves a way to post
 * twice, and a delegate that cannot pass the key on cannot close that gap. It is still a plain
 * argument — the delegate remains a function of its inputs.
 */
import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import { assertToolAuthorized } from "../authorization/index.js";
import { canonicalizeArgs, type IdempotencyKey, type IdempotencyStore } from "../idempotency/index.js";
import type { ApprovalGate } from "../hitl/service.js";
import { toPlatformError } from "../runtime/retry.js";
import { defineTool, type ToolSpec } from "./define.js";
import { zodishValidator, type SchemaValidator } from "./registry.js";
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
   * The deterministic function. Receives validated input, the execution context and the call's
   * idempotency key; returns data or throws. Knows nothing about authorisation or approvals.
   */
  delegate(input: I, context: ExecutionContext, details: DelegateDetails): Promise<O> | O;
  /**
   * A check that runs **before the approval gate** (#119 AC-4).
   *
   * The general property, not a publishing one: *do not ask a person to authorise something that
   * cannot succeed*. Content validation placed inside the delegate runs after the gate, so a human
   * would already have approved something that then fails — which teaches them their approval does not
   * mean much.
   *
   * Throw to refuse. The thrown error is returned as-is, so a preflight that has structured findings
   * can carry them in `details` rather than flattening them into a sentence.
   *
   * It must be **read-only**. It runs on every call including one that is about to be refused for want
   * of an approval, so a preflight with a side effect would be a side effect that happens without
   * approval — the exact thing the gate exists to prevent.
   */
  preflight?(input: I, context: ExecutionContext): Promise<void> | void;
};

/**
 * What the envelope tells the delegate about the call itself.
 *
 * An object rather than a bare string so that adding a field later is additive — the same reason
 * `ShareFlowServices` is one object rather than four arguments.
 */
export type DelegateDetails = {
  /**
   * The key this call was deduplicated under.
   *
   * Passed on so a delegate can hand it to a downstream service whose own queue needs it. **Not** for
   * the delegate to check: the envelope has already looked it up, and a delegate that consulted it
   * would be doing the lookup twice with the second one unguarded.
   */
  readonly idempotencyKey: IdempotencyKey;
};

/**
 * What a shadow run records instead of doing.
 *
 * A port rather than a store, because what "recording" means differs by deployment: a parity harness wants
 * it in memory, a migration wants it durable and comparable to the old runtime's output.
 */
export type SuppressedWrite = {
  readonly runId?: string;
  readonly toolName: string;
  /** The function that would have been called. */
  readonly delegatesTo: string;
  readonly effect: ToolEffect;
  /** Validated input — what would have been sent. */
  readonly input: unknown;
  readonly idempotencyKey: IdempotencyKey;
  /**
   * Whether this action would have required a human's approval.
   *
   * Captured because suppression happens *before* the approval gate — a shadow run must not ask someone to
   * approve something that will not happen, since that teaches them approving is meaningless. Recording it
   * keeps the fact the parity report wants without asking the question.
   */
  readonly wouldRequireApproval: boolean;
};

export interface ShadowRecorder {
  record(context: ExecutionContext, write: SuppressedWrite): Promise<void> | void;
}

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
  /**
   * Validates `input` against the spec's `inputSchema` before the delegate is reached (#115 AC-5).
   *
   * Defaults to `zodishValidator`, which passes through anything that is not a zod-like schema — and
   * `inputSchema` itself defaults to `{}` — so a tool that declares no schema behaves exactly as it did
   * before this existed.
   *
   * The registry already re-validates at execution, which covers the production path. This covers
   * *every* path: a tool executed directly, from a test, or from a future caller that is not the
   * registry. The envelope's whole purpose is that a guarantee cannot be reached around.
   */
  readonly validator?: SchemaValidator;
  /**
   * Where a shadow run's suppressed writes go.
   *
   * Required *when the run says it is shadow*: `context.shadow === true` with no recorder is refused
   * rather than performed. Announcing a shadow run and having nowhere to record it is not a licence to
   * publish — the same fail-closed reasoning as the missing approval gate.
   */
  readonly shadow?: ShadowRecorder;
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
  `${input.context.tenantId}:${input.context.conversationId ?? "-"}:${input.toolName}:${canonicalizeArgs(input.args)}` as IdempotencyKey;

const refuse = (code: "approval_required" | "capability_unavailable", message: string) =>
  new AgentPlatformError({ code, message, retryable: false });

/**
 * Build a `Tool` whose execute path is: authorise → validate → derive key → look up → preflight → shadow →
 * approval gate → delegate → store.
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
    async execute({ context, input, idempotencyKey, approval }) {
      try {
        // Re-authorised here even though discovery already filtered the catalog: the governing
        // principle is that tools are filtered before discovery *and* re-authorised during execution,
        // because a role can change between the two and a stale catalog must not be a permission.
        await assertToolAuthorized(deps.authorization, context, {
          name: spec.name,
          category: descriptor.category,
        });

        // Validated *before* the key is derived, not after.
        //
        // Because a schema may normalise — an LLM passes "LinkedIn" where the store keeps "linkedin" —
        // deriving the fallback key from the raw arguments would give one logical call two different
        // keys, and the second would not see the first's result. Normalising first makes the key a
        // property of the call rather than of the model's capitalisation.
        //
        // After authorisation, so a caller with no permission learns nothing about the schema.
        const validated = (deps.validator ?? zodishValidator).validate(descriptor.inputSchema, input);
        if (!validated.ok)
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `Invalid input for ${spec.name}: ${validated.message}`,
            retryable: false,
          });

        // The caller's key is preferred — it is derived from tool-call identity, which is what makes a
        // *retry* safe. The fallback is broader and can suppress an intended repeat; see its docstring.
        const key =
          (idempotencyKey as IdempotencyKey | undefined) ??
          fallbackIdempotencyKey({ context, toolName: spec.name, args: validated.value });

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

        // Before the gate, and after the idempotency lookup: a call whose result is already stored has
        // already run, so re-validating it could refuse a legitimate replay on content that has since
        // changed underneath it.
        if (spec.preflight) await spec.preflight(validated.value as I, context);

        // Shadow mode, and **before** the approval gate.
        //
        // A shadow run must not ask a human to approve something that will not happen; doing so teaches
        // people that approving is meaningless, which is the one thing an approval gate cannot survive.
        //
        // Only gated effects are suppressed — `external-write` and `destructive`. docs/07 says "shadow
        // execution performs no external *writes*", so an internal write still happens, and that is worth
        // knowing: a shadow run does create real drafts. See the note on #126.
        if (gated && context.shadow === true) {
          if (!deps.shadow)
            throw refuse(
              "capability_unavailable",
              `${spec.name} is a ${effect} and this run is in shadow mode with no recorder configured`,
            );
          await deps.shadow.record(context, {
            ...(context.runId === undefined ? {} : { runId: context.runId }),
            toolName: spec.name,
            delegatesTo: spec.delegatesTo,
            effect,
            input: validated.value,
            idempotencyKey: key,
            wouldRequireApproval: descriptor.approvalPolicy !== "never",
          });
          // Marked truthfully, and this is the least-bad of three bad options. A fake success would teach
          // the agent to report a publish that never happened; a hard failure would change the trajectory
          // parity measurement is trying to observe; this changes it too, but honestly.
          //
          // The limitation is inherent and worth stating rather than hiding: shadow mode measures
          // everything up to the external write and nothing after it. What an agent does *after*
          // publishing cannot be observed without publishing.
          //
          // Not stored under the idempotency key: a suppressed call must not become the cached answer for
          // a later real one.
          return { ok: true, data: { suppressed: true, reason: "shadow-mode", wouldHaveCalled: spec.delegatesTo } as O };
        }

        if (gated) {
          if (!deps.approvals) {
            throw refuse(
              "capability_unavailable",
              `${spec.name} performs a ${effect} and no approval gate is configured`,
            );
          }
          // The ticket, when the call carries one, is handed to the gate rather than interpreted here:
          // this envelope decides *whether* approval applies, `hitl/service.ts` decides whether a
          // given approval is real. An envelope that read the ticket itself would be a second place
          // that could get "is this approved" wrong.
          const allowed = await deps.approvals.isAllowed(
            context,
            {
              name: spec.name,
              category: descriptor.category,
              approvalPolicy: descriptor.approvalPolicy,
            },
            approval,
          );
          // The delegate is never reached. It is not told an approval was needed, refused or granted —
          // this envelope decides *whether* approval applies; `hitl/service.ts` decides *how*.
          if (!allowed) {
            throw refuse("approval_required", `${spec.name} requires approval before it can run`);
          }
        }

        const data = await spec.delegate(validated.value as I, context, { idempotencyKey: key });
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
