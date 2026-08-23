/**
 * The approval loop's two missing halves — `docs/04-durable-runtime-and-hitl.md` → Approvals.
 *
 * `service.ts` had everything except a path from one end to the other. The gate refused a gated tool,
 * `request` could persist a pending approval with the exact normalized call, `decide` recorded the
 * decision and re-enqueued the run — and nothing joined them. Nothing raised an approval when the gate
 * refused, and nothing read `normalizedInput` back to execute it. So the safe direction held (no
 * external write without a standing grant) while the *default* decision, `allow-once`, could not
 * proceed at all: the model re-requested, the gate refused again, the run looped.
 *
 * This module is that path, and it is deliberately one module rather than a rule spread across the
 * engine and the registry:
 *
 * - **`runTool`** is what a run calls instead of the registry directly. A refusal for want of approval
 *   becomes a durable ask rather than an error the model has to interpret.
 * - **`resume`** is what a re-enqueued run calls before it does anything else. It claims the single
 *   execution the decision authorizes and runs the **stored** tool and input.
 *
 * **Why the dependency points this way.** `hitl` → `tools`, never the reverse: the tools layer keeps
 * its approval check structural (`ApprovalCheck`) precisely so that the knowledge of what an approval
 * *is* lives here. A registry that understood interactions would be a second place where "is this
 * approved" could be decided, and two such places is one too many.
 *
 * **What is not here.** No grant is issued for `allow-once`, ever. A grant is standing by definition,
 * so turning a one-time decision into one would broaden the authority a human gave — the opposite of
 * what they chose. The single execution is claimed off the interaction instead
 * (`InteractionStore.claimApproval`), which is both narrower and durable across a restart.
 */

import type { ExecutionContext } from "../core/context.js";
import type { RunId } from "../core/ids.js";
import { deriveCallIdempotencyKey } from "../idempotency/index.js";
import type { InteractionStore } from "../persistence/index.js";
import { zodishValidator, type SchemaValidator } from "../tools/registry.js";
import type { OneTimeApprovalRef, ToolDescriptor, ToolResult } from "../tools/index.js";
import { isAllowDecision, type ApprovalRequest } from "./service.js";
import type { PendingApproval } from "./index.js";

/** A day. Long enough for a human to come back to it, short enough that a stale ask expires. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What this module needs from the tool layer — the registry satisfies it.
 *
 * Structural rather than `ToolRegistry` so the coupling is exactly two methods wide, and so a host
 * that runs tools some other way can still use the loop.
 */
export interface ApprovalToolRunner {
  execute(
    context: ExecutionContext,
    input: {
      readonly name: string;
      readonly input: unknown;
      readonly idempotencyKey?: string;
      readonly approval?: OneTimeApprovalRef;
    },
  ): Promise<ToolResult>;
  /** Resolves descriptors for names the caller is authorized to use; unauthorized names are absent. */
  learn(context: ExecutionContext, names: readonly string[]): Promise<readonly ToolDescriptor[]>;
}

/** Just the part of the approval service this needs, so a host can substitute its own. */
export interface ApprovalRequester {
  request(context: ExecutionContext, runId: RunId, request: ApprovalRequest): Promise<PendingApproval>;
}

export type GatedCallOutcome =
  /** The call ran (or failed on its own terms) — the ordinary path, approval or no approval. */
  | { readonly outcome: "result"; readonly result: ToolResult }
  /** The call needs a human. The run should pause; the approval is durable until decided. */
  | { readonly outcome: "approval-requested"; readonly approval: PendingApproval };

export type ApprovalResumeOutcome =
  /** Nothing to resume: no decision yet, or the decision was already acted on. */
  | { readonly outcome: "none" }
  | { readonly outcome: "executed"; readonly approval: PendingApproval; readonly result: ToolResult }
  | { readonly outcome: "denied"; readonly approval: PendingApproval }
  /** Decided too late to act on. Claimed all the same, so the run does not loop on it. */
  | { readonly outcome: "expired"; readonly approval: PendingApproval };

export type RunApprovalDeps = {
  readonly interactions: InteractionStore;
  readonly approvals: ApprovalRequester;
  readonly tools: ApprovalToolRunner;
  readonly clock?: () => string;
  /** Normalizes a call's arguments before they are stored. Defaults to the registry's validator. */
  readonly validator?: SchemaValidator;
  /** How long a raised approval stays actionable. Default 24h. */
  readonly ttlMs?: number;
  /** The human-facing one-liner on the approval card. Override for a domain-specific rendering. */
  readonly summarize?: (input: { readonly descriptor: ToolDescriptor; readonly input: unknown }) => string;
};

const APPROVAL_REQUIRED = "approval_required";

const refusedForApproval = (result: ToolResult): boolean =>
  !result.ok && result.error.code === APPROVAL_REQUIRED;

export const createRunApprovals = (deps: RunApprovalDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const validator = deps.validator ?? zodishValidator;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const summarize =
    deps.summarize ?? (({ descriptor }: { descriptor: ToolDescriptor }) => `${descriptor.label}: ${descriptor.description}`);

  const expiresAt = (): string => {
    const base = Date.parse(clock());
    return new Date((Number.isNaN(base) ? Date.now() : base) + ttlMs).toISOString();
  };

  /**
   * Unparseable timestamps mean "not expired" rather than "expired".
   *
   * Deliberate, and the safer of the two: a false *expired* silently drops an approval a human gave,
   * and the run reports success having done nothing. A false *not expired* still has to get past the
   * claim and the gate, both of which check the decision itself.
   */
  const isExpired = (approval: PendingApproval): boolean => {
    const at = Date.parse(approval.expiresAt);
    const now = Date.parse(clock());
    return !Number.isNaN(at) && !Number.isNaN(now) && at <= now;
  };

  /** The run's context, with the run pinned — the gate checks a ticket against the approval's run. */
  const inRun = (context: ExecutionContext, runId: RunId): ExecutionContext =>
    context.runId === runId ? context : { ...context, runId };

  return {
    /**
     * Run a tool on behalf of the model, raising a durable approval if the gate refuses it.
     *
     * The order matters. Arguments are resolved and normalized *before* the call, so that the key is a
     * property of the call rather than of the model's capitalization, and so that an approval — if one
     * is needed — stores what will actually run. Invalid input is refused here rather than turned into
     * an approval: asking a person to authorize a call that cannot succeed teaches them their approval
     * is theatre.
     */
    async runTool(
      context: ExecutionContext,
      runId: RunId,
      call: { readonly name: string; readonly input: unknown },
    ): Promise<GatedCallOutcome> {
      const ctx = inRun(context, runId);
      const [descriptor] = await deps.tools.learn(ctx, [call.name]);
      // Unknown or unauthorized: hand it to the runner, whose refusal is the canonical one. Producing
      // our own here would mean two different answers to "may I use this tool".
      if (!descriptor) return { outcome: "result", result: await deps.tools.execute(ctx, call) };

      const validated = validator.validate(descriptor.inputSchema, call.input);
      if (!validated.ok) {
        return {
          outcome: "result",
          result: {
            ok: false,
            error: {
              code: "invalid_input",
              message: `Invalid input for ${call.name}: ${validated.message}`,
              retryable: false,
            },
          },
        };
      }

      const idempotencyKey = deriveCallIdempotencyKey({
        tenantId: ctx.tenantId,
        runId,
        toolName: call.name,
        args: validated.value,
      });
      const result = await deps.tools.execute(ctx, { name: call.name, input: validated.value, idempotencyKey });
      if (!refusedForApproval(result)) return { outcome: "result", result };

      /**
       * A shadow run asks for nothing.
       *
       * The envelope suppresses a gated write *before* its own gate, on the reasoning that a shadow run
       * must not ask a human to approve something that will not happen — that teaches people approving
       * is meaningless, which is the one thing an approval gate cannot survive. The registry's gate
       * fires earlier than the envelope's suppression, so a suppressed call can still surface here as a
       * refusal, and raising an approval on it would ask exactly that question.
       *
       * Refusing rather than asking. Nothing executed — the gate already stopped it — so the run is no
       * less safe; it simply does not park a real human decision on a hypothetical action.
       *
       * **The gap this guarded is now closed**, and this is belt and braces rather than the mechanism.
       * Suppression moved into `registry.ts`, *before* its gate — for a reason larger than the missing
       * parity record: the delegating envelope covers delegating tools only, so a gated tool that is not
       * one (every MCP-imported external write) reached its own execute in a shadow run. With the registry
       * suppressing, a gated call in a shadow run no longer refuses here, so this branch is unreachable
       * through `deps.tools`. It stays as a fail-safe if suppression is ever moved again, and is labelled
       * as one rather than left looking load-bearing.
       */
      if (ctx.shadow === true) return { outcome: "result", result };

      // The model asking again for a call already awaiting a decision must not stack a second
      // interaction — the human would see the same request twice and the unique index on
      // (tenant, idempotency_key) would refuse the insert anyway.
      const pending = await deps.interactions.findPendingApproval({ tenantId: ctx.tenantId, runId });
      if (pending && pending.toolName === call.name && pending.idempotencyKey === idempotencyKey) {
        return { outcome: "approval-requested", approval: pending };
      }

      const approval = await deps.approvals.request(ctx, runId, {
        toolName: call.name,
        normalizedInput: validated.value,
        riskCategory: descriptor.category,
        summary: summarize({ descriptor, input: validated.value }),
        expiresAt: expiresAt(),
        idempotencyKey,
      });
      return { outcome: "approval-requested", approval };
    },

    /**
     * Act on a decision, once. Called by a resumed run before it gives the model another turn.
     *
     * The claim comes first — before the decision is even read — because it is the only step that can
     * fail exclusively. A denial and an expiry are claimed too: an unclaimed one would be found again
     * on the next resumption, and the run would spin on a decision it has already honoured.
     *
     * The tool and the input come off the stored approval and nowhere else. That is the whole
     * guarantee: a model-regenerated call after approval means the human approved content that is not
     * what runs.
     */
    async resume(context: ExecutionContext, runId: RunId): Promise<ApprovalResumeOutcome> {
      const ctx = inRun(context, runId);
      const decided = await deps.interactions.findDecidedApproval({ tenantId: ctx.tenantId, runId });
      if (!decided) return { outcome: "none" };

      const { approval, claimed } = await deps.interactions.claimApproval({
        tenantId: ctx.tenantId,
        interactionId: decided.id,
        at: clock(),
      });
      // Lost the race, or already run. Either way this worker owes no execution.
      if (!claimed) return { outcome: "none" };

      if (!isAllowDecision(approval.decision)) return { outcome: "denied", approval };
      if (isExpired(approval)) return { outcome: "expired", approval };

      const result = await deps.tools.execute(ctx, {
        name: approval.toolName,
        input: approval.normalizedInput,
        idempotencyKey: approval.idempotencyKey,
        // The claim is what the gate verifies: it proves this execution is the one the decision bought.
        approval: { interactionId: approval.id },
      });
      return { outcome: "executed", approval, result };
    },
  };
};

export type RunApprovals = ReturnType<typeof createRunApprovals>;
