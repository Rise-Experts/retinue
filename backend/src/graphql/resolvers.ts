/**
 * Thin GraphQL resolvers — `docs/06` → "Resolvers are thin: authenticate, validate, construct
 * execution context and call platform services." The host's GraphQL server builds the execution
 * context (from its auth) and puts it on the resolver context; every resolver here just validates
 * shape and delegates to a service. No business logic lives in this layer.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ConversationId, RunId } from "../core/ids.js";
import { asId } from "../core/ids.js";
import type { ConversationStore, UsageStore } from "../persistence/index.js";
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
  readonly live: LiveEventSource;
  readonly channelFor?: (conversationId: ConversationId) => string;
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
