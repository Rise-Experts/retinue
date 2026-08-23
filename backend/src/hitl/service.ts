/**
 * Human-in-the-loop services — `docs/04-durable-runtime-and-hitl.md` → Questions & Approvals.
 *
 * `ask`/`request` persist a durable interaction (surviving restart/deploy) and pause the run into
 * `waiting-for-question` / `waiting-for-approval`. `answer`/`decide` record the outcome idempotently
 * and queue the continuation exactly once — a duplicate call is a safe no-op, so a run never resumes
 * twice. An approval stores the exact normalized tool name + input. The `ApprovalGate` makes the
 * approval unbypassable: a policy-classified tool cannot execute directly without either a standing
 * grant or a one-time approval a human has decided and the runtime has claimed.
 *
 * **This file is the *what*, not the *when*.** Requesting, deciding and gating live here; the run path
 * that raises an approval on a refusal and executes the stored input on resumption is
 * `./approved-execution.ts`, and the engine calls it (`../agents/engine.ts`). That path did not
 * exist until the loop was wired, and this docstring described a resumption nothing performed.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ConversationId, InteractionId, RunId, TenantId } from "../core/ids.js";
import { asId } from "../core/ids.js";
import type { ApprovalGrantStore, InteractionStore, RunStore } from "../persistence/index.js";
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
  /**
   * The run store, so answering can put the run back to `queued` (#144).
   *
   * Optional only so an existing caller keeps compiling; without it the resume enqueues a run the worker cannot
   * claim, and the run waits forever. See `resumeRun` below.
   */
  readonly runs?: RunStore;
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
      await resumeRun(deps, { tenantId: input.tenantId, runId: input.runId, at: clock() });
      return { resumed: true };
    },
  };
};

/**
 * Put a paused run back on the queue — status *then* job.
 *
 * **A bug the load harness found (#144).** `decide` and `answer` used to enqueue and nothing else. But
 * `RunStore.claim` accepts only `queued` or a `running` run with an expired lease, and pausing a run for a human
 * leaves it in `waiting-for-approval` — so the enqueued job was handed to a worker, the claim matched no row, the
 * run was skipped, and it waited forever. Sixty-five of a hundred and sixty runs in one load step, silently.
 *
 * It survived because the unit tests assert `resumed: true` and that a job was enqueued, which was exactly true
 * and not the same as the run resuming. Only driving a real worker against a real store showed it.
 *
 * The transition comes **first**: enqueueing before it lets a worker pick the job up while the run is still
 * paused, fail the claim, and drop the only job that would have resumed it.
 *
 * `workerId` is the actor's name rather than a worker's. `transition` guards on `claimedBy`, and pausing a run
 * releases the claim — so the field is unconstrained here and the honest value is who is doing this.
 */
const resumeRun = async (
  deps: { readonly runs?: RunStore; readonly dispatcher: JobDispatcher },
  input: { readonly tenantId: TenantId; readonly runId: RunId; readonly at: string },
): Promise<void> => {
  await deps.runs?.transition({
    tenantId: input.tenantId,
    id: input.runId,
    workerId: "hitl",
    to: "queued",
    now: input.at,
  });
  await deps.dispatcher.enqueueRun({ tenantId: input.tenantId, runId: input.runId });
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

/**
 * Decisions that authorize the approved call to run.
 *
 * A whitelist rather than `!== "deny"`: a decision added later — a deferral, an escalation — would
 * read as permission under the negative form, which is the wrong direction to be wrong in.
 */
export const ALLOW_DECISIONS = ["allow-once", "allow-conversation", "allow-always"] as const;

export const isAllowDecision = (decision: ApprovalDecision | undefined): boolean =>
  decision !== undefined && (ALLOW_DECISIONS as readonly string[]).includes(decision);

const grantScopeFor = (decision: ApprovalDecision): ApprovalScope | null =>
  decision === "allow-conversation" ? "conversation" : decision === "allow-always" ? "tenant" : null;

export const createApprovalService = (deps: {
  readonly interactions: InteractionStore;
  readonly grants: ApprovalGrantStore;
  readonly dispatcher: JobDispatcher;
  /** As on `createQuestionService`: without it the resumed run is never claimable. See `resumeRun`. */
  readonly runs?: RunStore;
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
     * the continuation exactly once. The resumed run executes the *stored* normalized input from the
     * pending approval — never a regenerated one; see `./approved-execution.ts`.
     *
     * `allow-once` deliberately issues **no grant**. A grant is standing by definition, so minting one
     * for a one-time decision would hand over authority the human did not give. Its single execution is
     * claimed off the interaction instead (`InteractionStore.claimApproval`).
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
      await resumeRun(deps, { tenantId: input.tenantId, runId: input.runId, at: clock() });
      return grant ? { resumed: true, grant } : { resumed: true };
    },
  };
};

/**
 * A single approved execution, presented at the moment of the call.
 *
 * The ticket is just the interaction id, and it is **not** a credential — the gate below verifies it
 * against the stored interaction rather than believing it. That is deliberate: the alternative to a
 * ticket was issuing a grant for `allow-once`, and a grant is standing by definition, so a one-time
 * decision would have silently become a permanent one.
 *
 * Per-call rather than carried on the `ExecutionContext`: a context is reused for every call in a
 * turn, so an approval living on it would authorise all of them.
 */
export type OneTimeApproval = { readonly interactionId: InteractionId | string };

/**
 * The gate that makes approval unbypassable. A policy-classified tool (`approvalPolicy` other than
 * `never`, or an external/destructive effect under `policy`) may only execute directly when a
 * standing grant covers it, or when the call presents a one-time approval a human has decided and the
 * runtime has claimed.
 *
 * Both paths fail closed. A tool with no grant and no ticket is refused; a ticket presented with no
 * `interactions` store to check it against is refused too, because an unwired dependency must never
 * be the reason something was allowed.
 */
export const createApprovalGate = (deps: {
  readonly grants: ApprovalGrantStore;
  /**
   * Where one-time approvals are verified. Optional so a caller that only uses standing grants need
   * not wire it — with it absent, every ticket is refused rather than trusted.
   */
  readonly interactions?: InteractionStore;
  readonly clock?: Clock;
}) => {
  const clock = deps.clock ?? (() => new Date().toISOString());

  /**
   * Whether this ticket really authorises *this* call.
   *
   * Every clause is a way the loop could otherwise be widened, and each is checked against what was
   * stored at request time rather than against anything the caller supplied:
   *
   * - the interaction exists in this tenant — a forged or foreign id authorises nothing;
   * - it belongs to this run, so a ticket cannot be carried into another run;
   * - the decision is an allow — a denial can never read as permission;
   * - the tool is the one the human saw, so an approval for `publish` cannot run `delete`;
   * - it has been claimed. The claim is the at-most-once counter (`InteractionStore.claimApproval`),
   *   and requiring it here is what keeps a merely *decided* approval from being executable by
   *   anything that has not first taken the single execution it grants.
   */
  const oneTimeAllows = async (
    context: ExecutionContext,
    tool: { readonly name: string },
    oneTime: OneTimeApproval,
  ): Promise<boolean> => {
    if (!deps.interactions) return false;
    const approval = await deps.interactions.findApproval({
      tenantId: context.tenantId,
      interactionId: asId<InteractionId>(String(oneTime.interactionId)),
    });
    if (!approval) return false;
    if (approval.runId !== context.runId) return false;
    if (approval.toolName !== tool.name) return false;
    if (!isAllowDecision(approval.decision)) return false;
    return approval.consumedAt !== undefined;
  };

  return {
    async isAllowed(
      context: ExecutionContext,
      tool: { readonly name: string; readonly category: string; readonly approvalPolicy: "never" | "policy" | "always" },
      oneTime?: OneTimeApproval,
    ): Promise<boolean> {
      if (tool.approvalPolicy === "never") return true;
      const now = clock();
      const conversationId = context.conversationId;
      const scope = { tenantId: context.tenantId, now, ...(conversationId ? { conversationId } : {}) };
      const byName = await deps.grants.findActive({ ...scope, toolNameOrCategory: tool.name });
      if (byName) return true;
      const byCategory = await deps.grants.findActive({ ...scope, toolNameOrCategory: tool.category });
      if (byCategory) return true;
      return oneTime === undefined ? false : oneTimeAllows(context, tool, oneTime);
    },
  };
};

export type ApprovalGate = ReturnType<typeof createApprovalGate>;
