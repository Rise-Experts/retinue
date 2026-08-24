/**
 * Thin GraphQL resolvers — `docs/06` → "Resolvers are thin: authenticate, validate, construct
 * execution context and call platform services." The host's GraphQL server builds the execution
 * context (from its auth) and puts it on the resolver context; every resolver here just validates
 * shape and delegates to a service. No business logic lives in this layer.
 */

import type { ExecutionContext } from "../core/context.js";
import { DEFAULT_WARN_AT, describeWindow } from "../usage/index.js";
import type { QuotaGuard } from "../usage/index.js";
import type { UsageRollupStore } from "../persistence/index.js";
import type { ConversationId, RunId } from "../core/ids.js";
import { asId } from "../core/ids.js";
import type { ConversationStore, UsageStore } from "../persistence/index.js";
import type { ContextInspection } from "../context/index.js";
import type { ToolRegistry } from "../tools/index.js";
import { startOrEnqueueRun, type JobDispatcher } from "../runtime/index.js";
import { openRunEventStream, type LiveEventSource } from "../runtime/index.js";
import type { RunEventLog } from "../core/events.js";
import type { RunStore, ConversationRunCoordinator } from "../persistence/index.js";
import type { createQuestionService, createApprovalService } from "../hitl/index.js";

/** The resolver context the host supplies per request — the authenticated execution context. */
export type GraphQLContext = { readonly execution: ExecutionContext };

export type ResolverDeps = {
  readonly conversations: ConversationStore;
  readonly runs: RunStore;
  readonly usage: UsageStore;
  readonly toolRegistry: ToolRegistry;
  readonly questions: ReturnType<typeof createQuestionService>;
  readonly approvals: ReturnType<typeof createApprovalService>;
  readonly coordinator: ConversationRunCoordinator;
  readonly dispatcher: JobDispatcher;
  readonly eventLog: RunEventLog;
  /**
   * Quota enforcement at admission (#139).
   *
   * Optional: a deployment with no limits configured is valid, and its absence means unbounded — the same
   * direction `resolveLimits` takes, because a misconfigured quota that blocks everything is an outage and one
   * that blocks nothing is a bill the rollups make visible.
   */
  readonly quota?: QuotaGuard;
  /**
   * Rollups for the spend panel (#140).
   *
   * Optional for the same reason `quota` is: a deployment that has not run the rollup job yet should still
   * serve a usage query, from the ledger, rather than erroring. Its absence costs a chart, not the page.
   */
  readonly rollups?: UsageRollupStore;
  readonly live: LiveEventSource;
  readonly channelFor?: (conversationId: ConversationId) => string;
  /** Host-provided context assembly for the inspector (providers are app-specific). */
  readonly inspectContext?: (
    execution: ExecutionContext,
    input: { conversationId: ConversationId; runId?: RunId },
  ) => Promise<ContextInspection | null>;
};

/** Serialize a stored Run to the GraphQL RunStatus enum (underscores, not hyphens). */
const runStatus = (status: string): string => status.replace(/-/g, "_");
const toRun = (run: { id: string; conversationId: string; status: string; createdAt: string; finishedAt?: string }) => ({
  id: run.id,
  conversationId: run.conversationId,
  status: runStatus(run.status),
  createdAt: run.createdAt,
  finishedAt: run.finishedAt ?? null,
});

export const createResolvers = (deps: ResolverDeps) => {
  const channelFor = deps.channelFor ?? ((id: ConversationId) => `conversation:${id}`);
  const tid = (ctx: GraphQLContext) => ctx.execution.tenantId;

  /**
   * The quota state, from the guard rather than recomputed.
   *
   * Asking the guard means the panel's warning and the admission decision are the same computation. A UI that
   * recomputed a threshold would eventually show "you are fine" while a run is being refused, which is worse
   * than showing nothing.
   */
  const quotaViewFor = async (guard: QuotaGuard, execution: ExecutionContext) => {
    const decision = await guard.admit(execution);
    const limits = await guard.limits(execution);
    if (limits.length === 0) return null;
    /**
     * The **binding** limit, which is the first — shortest span (#182).
     *
     * Several limits can apply at once and this view describes one, because that is the shape the schema has and
     * a client rendering "you have used X of Y" wants the Y that will stop them soonest. `usageReport` is the
     * wrong place to widen: a caller that wants all of them should ask for all of them.
     */
    const binding = limits[0]!;
    return {
      window: describeWindow(binding.window),
      // Null for a rolling window: no calendar period describes one, and naming the closest would be wrong
      // rather than approximate.
      period: binding.window.kind === "calendar" ? binding.window.period : null,
      modelId: binding.modelId ?? null,
      costLimitMinorUnits: binding.costMinorUnits ?? null,
      inputTokenLimit: binding.inputTokens ?? null,
      outputTokenLimit: binding.outputTokens ?? null,
      warnAt: binding.warnAt ?? DEFAULT_WARN_AT,
      warning: decision.admitted && decision.warnings.length > 0,
      exceeded: !decision.admitted,
    };
  };

  return {
    Query: {
      async conversations(_: unknown, args: { limit: number; cursor?: string }, ctx: GraphQLContext) {
        return deps.conversations.list({ tenantId: tid(ctx), limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}) });
      },
      async conversation(_: unknown, args: { id: string }, ctx: GraphQLContext) {
        return deps.conversations.findById({ tenantId: tid(ctx), id: asId<ConversationId>(args.id) });
      },
      async run(_: unknown, args: { id: string }, ctx: GraphQLContext) {
        const run = await deps.runs.findById({ tenantId: tid(ctx), id: asId<RunId>(args.id) });
        return run ? toRun(run) : null;
      },
      async toolCatalog(_: unknown, args: { preloaded: string[]; categories: string[]; excluded: string[] }, ctx: GraphQLContext) {
        return deps.toolRegistry.catalog(ctx.execution, args);
      },
      async usage(_: unknown, args: { runId?: string }, ctx: GraphQLContext) {
        return deps.usage.totals({ tenantId: tid(ctx), ...(args.runId ? { runId: asId<RunId>(args.runId) } : {}) });
      },
      /**
       * The spend panel's one query (#140).
       *
       * Headline totals and buckets come from the **rollups**, so a page load never scans raw records however
       * much a tenant has used. Breakdowns come from the ledger over the same bounded range — a deliberate
       * trade documented on `UsageStore.breakdown`.
       *
       * Everything in one resolver so a panel cannot show a total from one moment and a breakdown from another;
       * the discrepancy would look like a bug in the numbers rather than in the fetching.
       */
      async usageReport(
        _: unknown,
        args: { period: string; from: string; to: string; breakdownLimit?: number },
        ctx: GraphQLContext,
      ) {
        const period = args.period === "hour" ? ("hour" as const) : ("day" as const);
        const limit = Math.min(Math.max(1, args.breakdownLimit ?? 10), 50);
        const scope = { tenantId: tid(ctx), period, from: args.from, to: args.to };

        // Absent rollup support is not an error: a deployment can run without the rollup job and still answer
        // from the ledger. Reported as empty buckets rather than a failure, because a panel with no chart is
        // usable and a panel with an error is not.
        const buckets = deps.rollups === undefined ? { items: [] } : await deps.rollups.list({ ...scope, limit: 400 });
        const totals =
          deps.rollups === undefined
            ? await deps.usage.totals({ tenantId: tid(ctx) })
            : await deps.rollups.sum(scope);

        const [byModel, byConversation] = await Promise.all([
          deps.usage.breakdown({ tenantId: tid(ctx), from: args.from, to: args.to, by: "model", limit }),
          deps.usage.breakdown({ tenantId: tid(ctx), from: args.from, to: args.to, by: "conversation", limit }),
        ]);

        // The quota state as the *server* computes it, so a UI cannot disagree with the enforcement. Absent
        // when no limit is configured, which means unbounded — a UI must show "no limit" rather than a full bar.
        const quota = deps.quota === undefined ? null : await quotaViewFor(deps.quota, ctx.execution);

        return {
          period,
          from: args.from,
          to: args.to,
          totals,
          buckets: buckets.items.map((b) => ({
            bucketStart: b.bucketStart,
            currency: b.currency,
            totals: b,
          })),
          byModel,
          byConversation,
          quota,
          // The currency of the buckets in range. Empty when there is no usage — a period with no spend has no
          // currency, and claiming one would be inventing a fact for a UI to format with.
          currency: buckets.items.find((b) => b.currency !== "")?.currency ?? "",
        };
      },
      /**
       * #163. Shaped for rendering: the optional fields are filled in rather than passed through, because a
       * client that has to treat `null` as "one choice" and `undefined` as "one choice" and `false` as "one
       * choice" will eventually treat one of them as "several".
       */
      async pendingQuestion(_: unknown, args: { runId: string }, ctx: GraphQLContext) {
        const question = await deps.questions.pending({ tenantId: tid(ctx), runId: asId<RunId>(args.runId) });
        if (question === null) return null;
        return {
          interactionId: question.id,
          runId: question.runId,
          createdAt: question.createdAt,
          questions: question.questions.map((q) => ({
            key: q.key,
            prompt: q.prompt,
            options: q.options ?? [],
            multiple: q.multiple === true,
            // Free text with no options is the only sensible reading of a question that offers no choices, so
            // it is implied there rather than left to each client to infer.
            allowOther: q.allowOther === true || (q.options ?? []).length === 0,
          })),
        };
      },
      /** #163, the mirror of `pendingQuestion`. Wired the same way so the two cannot drift. */
      async pendingApproval(_: unknown, args: { runId: string }, ctx: GraphQLContext) {
        const approval = await deps.approvals.pending({ tenantId: tid(ctx), runId: asId<RunId>(args.runId) });
        if (approval === null) return null;
        return {
          interactionId: approval.id,
          runId: approval.runId,
          toolName: approval.toolName,
          summary: approval.summary,
          riskCategory: approval.riskCategory,
          expiresAt: approval.expiresAt,
          normalizedInput: approval.normalizedInput,
        };
      },
      async conversationContext(_: unknown, args: { conversationId: string; runId?: string }, ctx: GraphQLContext) {
        if (!deps.inspectContext) return null;
        return deps.inspectContext(ctx.execution, {
          conversationId: asId<ConversationId>(args.conversationId),
          ...(args.runId ? { runId: asId<RunId>(args.runId) } : {}),
        });
      },
    },

    Mutation: {
      async createConversation(_: unknown, args: { id: string; title: string }, ctx: GraphQLContext) {
        return deps.conversations.create({ tenantId: tid(ctx), id: asId<ConversationId>(args.id), title: args.title });
      },
      async renameConversation(_: unknown, args: { id: string; expectedVersion: number; title: string }, ctx: GraphQLContext) {
        return deps.conversations.update({ tenantId: tid(ctx), id: asId<ConversationId>(args.id), expectedVersion: args.expectedVersion, patch: { title: args.title } });
      },
      async archiveConversation(_: unknown, args: { id: string; expectedVersion: number }, ctx: GraphQLContext) {
        return deps.conversations.update({ tenantId: tid(ctx), id: asId<ConversationId>(args.id), expectedVersion: args.expectedVersion, patch: { archivedAt: new Date().toISOString() } });
      },
      async deleteConversation(_: unknown, args: { id: string }, ctx: GraphQLContext) {
        await deps.conversations.softDelete({ tenantId: tid(ctx), id: asId<ConversationId>(args.id) });
        return true;
      },
      async sendMessage(_: unknown, args: { conversationId: string; runId: string }, ctx: GraphQLContext) {
        const conversationId = asId<ConversationId>(args.conversationId);
        const runId = asId<RunId>(args.runId);
        // #139, AC-2: the quota check is *here*, before the conversation is claimed and before anything is
        // enqueued — so a refused run leaves no slot held, no job on the queue, and no partial answer. A limit
        // enforced mid-run leaves a half-written response and a user who has to guess whether to retry.
        //
        // Optional, because a deployment with no limits configured is valid; when it is absent nothing is
        // checked, which is the same as an unbounded limit.
        if (deps.quota !== undefined) await deps.quota.assertAdmitted(ctx.execution);
        const started = await startOrEnqueueRun(deps.coordinator, { tenantId: tid(ctx), conversationId, runId });
        if (started === "started") await deps.dispatcher.enqueueRun({ tenantId: tid(ctx), runId });
        const run = await deps.runs.findById({ tenantId: tid(ctx), id: runId });
        return run ? toRun(run) : { id: runId, conversationId, status: started === "started" ? "running" : "queued", createdAt: new Date().toISOString(), finishedAt: null };
      },
      async cancelRun(_: unknown, args: { runId: string }, ctx: GraphQLContext) {
        await deps.runs.requestCancel({ tenantId: tid(ctx), id: asId<RunId>(args.runId), now: new Date().toISOString() });
        return true;
      },
      async answerQuestion(_: unknown, args: { input: { interactionId: string; runId: string; answers: Record<string, string> } }, ctx: GraphQLContext) {
        const { resumed } = await deps.questions.answer({
          tenantId: tid(ctx),
          interactionId: asId(args.input.interactionId),
          runId: asId<RunId>(args.input.runId),
          answers: args.input.answers,
        });
        return resumed;
      },
      async decideApproval(_: unknown, args: { input: { interactionId: string; runId: string; decision: string } }, ctx: GraphQLContext) {
        const { resumed } = await deps.approvals.decide({
          tenantId: tid(ctx),
          interactionId: asId(args.input.interactionId),
          runId: asId<RunId>(args.input.runId),
          decision: args.input.decision as never,
        });
        return resumed;
      },
    },

    Subscription: {
      runEvents: {
        subscribe(_: unknown, args: { runId: string; conversationId: string; after?: number }, ctx: GraphQLContext) {
          return openRunEventStream({
            tenantId: tid(ctx),
            runId: asId<RunId>(args.runId),
            channel: channelFor(asId<ConversationId>(args.conversationId)),
            after: args.after ?? 0,
            log: deps.eventLog,
            live: deps.live,
          });
        },
        // The transport delivers each event as { runEvents: { type, runId, sequence, occurredAt, payload } }.
        resolve: (event: { type: string; runId: string; sequence: number; occurredAt: string }) => ({
          type: event.type,
          runId: event.runId,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          payload: event,
        }),
      },
    },
  };
};

export type AgentkitResolvers = ReturnType<typeof createResolvers>;
