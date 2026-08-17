import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../../core/ids.js";
import { createAuthorizationPolicy } from "../../authorization/index.js";
import {
  createMemoryConversationRunCoordinator,
  createMemoryConversationStore,
  createMemoryInteractionStore,
  createMemoryApprovalGrantStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
  createMemoryUsageStore,
} from "../../adapters/memory/index.js";
import { createMemoryEventBus } from "../../runtime/index.js";
import { createApprovalService, createQuestionService } from "../../hitl/index.js";
import { createToolRegistry } from "../../tools/index.js";
import { createResolvers, typeDefs, type GraphQLContext } from "../index.js";
import type { JobDispatcher } from "../../runtime/index.js";
import type { RunEvent } from "../../core/events.js";

const T = asId<TenantId>("t1");
const execution: ExecutionContext = {
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("r1"),
};
const ctx: GraphQLContext = { execution };

const build = () => {
  const conversations = createMemoryConversationStore();
  const runs = createMemoryRunStore();
  const usage = createMemoryUsageStore();
  const coordinator = createMemoryConversationRunCoordinator();
  const interactions = createMemoryInteractionStore();
  const grants = createMemoryApprovalGrantStore();
  const eventLog = createMemoryRunEventLog();
  const bus = createMemoryEventBus();
  const enqueued: RunId[] = [];
  const dispatcher: JobDispatcher = { async enqueueRun({ runId }) { enqueued.push(runId); } };
  const resolvers = createResolvers({
    conversations,
    runs,
    usage,
    toolRegistry: createToolRegistry({ providers: [], authorization: createAuthorizationPolicy({ roles: [] }) }),
    questions: createQuestionService({ interactions, dispatcher }),
    approvals: createApprovalService({ interactions, grants, dispatcher }),
    coordinator,
    dispatcher,
    eventLog,
    live: bus.live,
  });
  return { resolvers, runs, eventLog, bus, enqueued };
};

describe("graphql schema", () => {
  it("declares the core queries, mutations and subscription", () => {
    for (const decl of ["type Query", "type Mutation", "type Subscription", "sendMessage", "answerQuestion", "decideApproval", "runEvents"])
      expect(typeDefs).toContain(decl);
  });
});

describe("graphql resolvers — thin delegation", () => {
  it("create then read a conversation through the resolvers", async () => {
    const { resolvers } = build();
    await resolvers.Mutation.createConversation({}, { id: "c1", title: "Hello" }, ctx);
    const page = await resolvers.Query.conversations({}, { limit: 10 }, ctx);
    expect(page.items.map((c) => c.title)).toEqual(["Hello"]);
    const one = await resolvers.Query.conversation({}, { id: "c1" }, ctx);
    expect(one?.title).toBe("Hello");
  });

  it("sendMessage claims the conversation and enqueues the run", async () => {
    const { resolvers, runs, enqueued } = build();
    await runs.create({ tenantId: T, id: asId<RunId>("run1"), conversationId: asId<ConversationId>("c1"), agentId: asId("a1"), agentVersion: 1 });
    const run = await resolvers.Mutation.sendMessage({}, { conversationId: "c1", runId: "run1" }, ctx);
    expect(run.status).toBe("queued"); // memory run starts queued
    expect(enqueued).toEqual(["run1"]);
  });

  it("cancelRun requests durable cancellation", async () => {
    const { resolvers, runs } = build();
    await runs.create({ tenantId: T, id: asId<RunId>("run1"), conversationId: asId<ConversationId>("c1"), agentId: asId("a1"), agentVersion: 1 });
    expect(await resolvers.Mutation.cancelRun({}, { runId: "run1" }, ctx)).toBe(true);
    const run = await runs.findById({ tenantId: T, id: asId<RunId>("run1") });
    expect(run?.cancelRequestedAt).toBeDefined();
  });

  it("subscription replays catch-up from the event log", async () => {
    const { resolvers, eventLog } = build();
    const ev = (sequence: number, type: RunEvent["type"]): RunEvent => ({ type, runId: asId<RunId>("run1"), sequence, occurredAt: `t${sequence}` } as RunEvent);
    await eventLog.append({ tenantId: T, event: ev(1, "run.started") });
    await eventLog.append({ tenantId: T, event: ev(2, "run.completed") });
    const iterable = resolvers.Subscription.runEvents.subscribe({}, { runId: "run1", conversationId: "c1", after: 0 }, ctx);
    const seen: number[] = [];
    for await (const e of iterable) {
      const shaped = resolvers.Subscription.runEvents.resolve(e as never);
      seen.push(shaped.sequence);
    }
    expect(seen).toEqual([1, 2]); // terminal in catch-up ends the stream
  });
});
