/**
 * Human-in-the-loop services — `docs/04-durable-runtime-and-hitl.md` → Questions & Approvals.
 *
 * `ask`/`request` persist a durable interaction (surviving restart/deploy) and pause the run into
 * `waiting-for-question` / `waiting-for-approval`. `answer`/`decide` record the outcome idempotently
 * and queue the continuation exactly once — a duplicate call is a safe no-op, so a run never resumes
 * twice. An approval stores the exact normalized tool name + input; resumption executes that stored
 * input, never a model-regenerated version. The `ApprovalGate` makes the approval unbypassable: a
 * policy-classified tool cannot execute directly without a standing grant.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ConversationId, InteractionId, RunId, TenantId } from "../core/ids.js";
import { asId } from "../core/ids.js";
import type { ApprovalGrantStore, InteractionStore } from "../persistence/index.js";
import type { JobDispatcher } from "../runtime/index.js";
import type {
  ApprovalDecision,
  ApprovalGrant,
  ApprovalScope,
  PendingApproval,
  PendingQuestion,
} from "./index.js";

type Clock = () => string;
type IdFactory = () => string;

const defaults = (clock?: Clock, idFactory?: IdFactory) => ({
  clock: clock ?? (() => new Date().toISOString()),
  newId: idFactory ?? (() => `int-${Math.round(Math.random() * 1e9)}`),
});

export type QuestionSpec = { readonly key: string; readonly prompt: string; readonly options?: readonly string[] };

export const createQuestionService = (deps: {
  readonly interactions: InteractionStore;
  readonly dispatcher: JobDispatcher;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
}) => {
  const { clock, newId } = defaults(deps.clock, deps.idFactory);
  return {
    /** Persist a pending question. The run is paused into waiting-for-question by the worker. */
    async ask(context: ExecutionContext, runId: RunId, questions: readonly QuestionSpec[]): Promise<PendingQuestion> {
      const question: PendingQuestion = {
        id: asId<InteractionId>(newId()),
        tenantId: context.tenantId,
        runId,
        questions,
        createdAt: clock(),
      };
      await deps.interactions.createQuestion({ tenantId: context.tenantId, question });
      return question;
    },

    /**
     * Record answers and queue the continuation — exactly once. A second answer to the same
     * interaction is a no-op and does NOT re-enqueue, so the run never resumes twice.
     */
    async answer(
      input: TenantScopeInput & { interactionId: InteractionId; runId: RunId; answers: Readonly<Record<string, string>> },
    ): Promise<{ resumed: boolean }> {
      const { alreadyResolved } = await deps.interactions.answerQuestion({
        tenantId: input.tenantId,
        interactionId: input.interactionId,
        answers: input.answers,
        at: clock(),
      });
      if (alreadyResolved) return { resumed: false };
      await deps.dispatcher.enqueueRun({ tenantId: input.tenantId, runId: input.runId });
      return { resumed: true };
    },
  };
};

type TenantScopeInput = { tenantId: TenantId };

export type ApprovalRequest = {
  readonly toolName: string;
  readonly normalizedInput: unknown;
  readonly riskCategory: string;
  readonly summary: string;
  readonly estimatedCostMinorUnits?: number;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
};

const grantScopeFor = (decision: ApprovalDecision): ApprovalScope | null =>
  decision === "allow-conversation" ? "conversation" : decision === "allow-always" ? "tenant" : null;

export const createApprovalService = (deps: {
  readonly interactions: InteractionStore;
  readonly grants: ApprovalGrantStore;
  readonly dispatcher: JobDispatcher;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
}) => {
  const { clock, newId } = defaults(deps.clock, deps.idFactory);
  return {
    /** Persist a pending approval storing the exact normalized tool + input. Run pauses to waiting. */
    async request(context: ExecutionContext, runId: RunId, req: ApprovalRequest): Promise<PendingApproval> {
      const approval: PendingApproval = {
        id: asId<InteractionId>(newId()),
        tenantId: context.tenantId,
        runId,
        toolName: req.toolName,
        normalizedInput: req.normalizedInput,
        riskCategory: req.riskCategory,
        summary: req.summary,
        ...(req.estimatedCostMinorUnits === undefined ? {} : { estimatedCostMinorUnits: req.estimatedCostMinorUnits }),
        expiresAt: req.expiresAt,
        idempotencyKey: req.idempotencyKey,
      };
      await deps.interactions.createApproval({ tenantId: context.tenantId, approval });
      return approval;
    },

    /**
     * Record a decision (once), issue a standing grant for allow-conversation/allow-always, and queue
     * the continuation exactly once. Resumption re-runs the engine, which executes the *stored*
     * normalized input from the pending approval — never a regenerated one.
     */
    async decide(
      input: TenantScopeInput & { interactionId: InteractionId; runId: RunId; conversationId?: ConversationId; decision: ApprovalDecision },
    ): Promise<{ resumed: boolean; grant?: ApprovalGrant }> {
      const { approval, alreadyResolved } = await deps.interactions.decideApproval({
        tenantId: input.tenantId,
        interactionId: input.interactionId,
        decision: input.decision,
        at: clock(),
      });
      if (alreadyResolved) return { resumed: false };

      let grant: ApprovalGrant | undefined;
      const scope = grantScopeFor(input.decision);
      // A conversation-scoped grant needs a conversationId; without one, skip the standing grant
      // (the run still resumes once) rather than silently widening it to the whole tenant.
      if (scope && !(scope === "conversation" && input.conversationId === undefined)) {
        grant = {
          id: asId(newId()),
          tenantId: input.tenantId,
          scope,
          toolNameOrCategory: approval.toolName,
          ...(scope === "conversation" && input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          grantedAt: clock(),
        };
        await deps.grants.grant({ tenantId: input.tenantId, grant });
      }
      // Both allow and deny queue a continuation; the resumed engine reads the decision and acts.
      await deps.dispatcher.enqueueRun({ tenantId: input.tenantId, runId: input.runId });
      return grant ? { resumed: true, grant } : { resumed: true };
    },
  };
};

/**
 * The gate that makes approval unbypassable. A policy-classified tool (`approvalPolicy` other than
 * `never`, or an external/destructive effect under `policy`) may only execute directly when a
 * standing grant covers it; otherwise the caller must go through `request_approval`.
 */
export const createApprovalGate = (deps: { readonly grants: ApprovalGrantStore; readonly clock?: Clock }) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  return {
    async isAllowed(
      context: ExecutionContext,
      tool: { readonly name: string; readonly category: string; readonly approvalPolicy: "never" | "policy" | "always" },
    ): Promise<boolean> {
      if (tool.approvalPolicy === "never") return true;
      const now = clock();
      const conversationId = context.conversationId;
      const scope = { tenantId: context.tenantId, now, ...(conversationId ? { conversationId } : {}) };
      const byName = await deps.grants.findActive({ ...scope, toolNameOrCategory: tool.name });
      if (byName) return true;
      const byCategory = await deps.grants.findActive({ ...scope, toolNameOrCategory: tool.category });
      return byCategory !== null;
    },
  };
};

export type ApprovalGate = ReturnType<typeof createApprovalGate>;
