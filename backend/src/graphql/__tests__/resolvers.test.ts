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
import type { QuestionSpec } from "../../hitl/service.js";
import { createResolvers, typeDefs } from "../index.js";
import { type GraphQLContext } from "../index.js";
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
  return { resolvers, runs, eventLog, bus, enqueued, interactions };
};

describe("graphql schema", () => {
  it("declares the core queries, mutations and subscription", () => {
    for (const decl of ["type Query", "type Mutation", "type Subscription", "sendMessage", "answerQuestion", "pendingQuestion", "decideApproval", "runEvents"])
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

/**
 * Reading the question a run is parked on — #163.
 *
 * `answerQuestion` existed with no counterpart, so a client could answer a question it had no way to display.
 * The example's picker showed an empty text box under "The assistant has a question", because the suspending
 * event carries only an interaction id and nothing exposed the stored spec.
 */
describe("graphql resolvers — pendingQuestion (#163)", () => {
  const ask = async (
    interactions: ReturnType<typeof createMemoryInteractionStore>,
    questions: readonly QuestionSpec[],
  ) => {
    await interactions.createQuestion({
      tenantId: execution.tenantId,
      question: {
        id: asId<InteractionId>("int-1"),
        tenantId: execution.tenantId,
        runId: asId<RunId>("run-1"),
        questions,
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    });
  };

  it("returns null when a run was never asked anything", async () => {
    const { resolvers } = build();
    expect(await resolvers.Query.pendingQuestion({}, { runId: "run-1" }, ctx)).toBeNull();
  });

  it("renders options, multiple and allowOther for a client to draw", async () => {
    const { resolvers, interactions } = build();
    await ask(interactions, [
      { key: "keep", prompt: "Which notes?", options: ["a", "b"], multiple: true, allowOther: true },
    ]);
    const result = await resolvers.Query.pendingQuestion({}, { runId: "run-1" }, ctx);
    expect(result).toMatchObject({ interactionId: "int-1", runId: "run-1" });
    expect(result?.questions).toEqual([
      { key: "keep", prompt: "Which notes?", options: ["a", "b"], multiple: true, allowOther: true },
    ]);
  });

  /**
   * The optionals are resolved to real booleans and a real array. A client forced to treat `null`, `undefined`
   * and `false` as the same thing will eventually treat one of them as `true`.
   */
  it("fills in the optional fields rather than passing absence through", async () => {
    const { resolvers, interactions } = build();
    await ask(interactions, [{ key: "channel", prompt: "Which channel?", options: ["x"] }]);
    const result = await resolvers.Query.pendingQuestion({}, { runId: "run-1" }, ctx);
    // A closed list is single-select and closed unless it says otherwise.
    expect(result?.questions[0]).toEqual({
      key: "channel",
      prompt: "Which channel?",
      options: ["x"],
      multiple: false,
      allowOther: false,
    });
  });

  it("treats a question with no options as free text", async () => {
    const { resolvers, interactions } = build();
    await ask(interactions, [{ key: "why", prompt: "Why?" }]);
    const result = await resolvers.Query.pendingQuestion({}, { runId: "run-1" }, ctx);
    // Otherwise the client would render a closed list of nothing — a question that cannot be answered.
    expect(result?.questions[0]).toMatchObject({ options: [], allowOther: true, multiple: false });
  });

  it("does not serve one tenant's question to another", async () => {
    const { resolvers, interactions } = build();
    await ask(interactions, [{ key: "why", prompt: "Why?" }]);
    const other: GraphQLContext = { execution: { ...execution, tenantId: asId("t2") } };
    expect(await resolvers.Query.pendingQuestion({}, { runId: "run-1" }, other)).toBeNull();
  });

  it("stops offering a question once it has been answered", async () => {
    const { resolvers, interactions } = build();
    await ask(interactions, [{ key: "why", prompt: "Why?" }]);
    await resolvers.Mutation.answerQuestion(
      {},
      { input: { interactionId: "int-1", runId: "run-1", answers: { why: "because" } } },
      ctx,
    );
    // A picker still on screen after the run resumed would let someone answer twice.
    expect(await resolvers.Query.pendingQuestion({}, { runId: "run-1" }, ctx)).toBeNull();
  });
});

/** The mirror for approvals — #163. Same gap, milder: the card fell back to a generic "Run a tool?". */
describe("graphql resolvers — pendingApproval (#163)", () => {
  const raise = async (interactions: ReturnType<typeof createMemoryInteractionStore>) => {
    await interactions.createApproval({
      tenantId: execution.tenantId,
      approval: {
        id: asId<InteractionId>("int-a"),
        tenantId: execution.tenantId,
        runId: asId<RunId>("run-1"),
        toolName: "share_note",
        normalizedInput: { noteId: "n1" },
        riskCategory: "external-write",
        summary: "Share note n1 externally",
        expiresAt: "2020-01-02T00:00:00.000Z",
        idempotencyKey: "idem-1",
      },
    });
  };

  it("returns null when nothing is awaiting a decision", async () => {
    const { resolvers } = build();
    expect(await resolvers.Query.pendingApproval({}, { runId: "run-1" }, ctx)).toBeNull();
  });

  it("names the tool and the arguments the decision is about", async () => {
    const { resolvers, interactions } = build();
    await raise(interactions);
    const result = await resolvers.Query.pendingApproval({}, { runId: "run-1" }, ctx);
    expect(result).toMatchObject({
      interactionId: "int-a",
      toolName: "share_note",
      summary: "Share note n1 externally",
      riskCategory: "external-write",
    });
    // The arguments matter: what runs must be what was shown, or the approval was for something else.
    expect(result?.normalizedInput).toEqual({ noteId: "n1" });
  });

  it("does not serve one tenant's approval to another", async () => {
    const { resolvers, interactions } = build();
    await raise(interactions);
    const other: GraphQLContext = { execution: { ...execution, tenantId: asId("t2") } };
    expect(await resolvers.Query.pendingApproval({}, { runId: "run-1" }, other)).toBeNull();
  });

  it("stops offering an approval once it has been decided", async () => {
    const { resolvers, interactions } = build();
    await raise(interactions);
    await resolvers.Mutation.decideApproval(
      {},
      { input: { interactionId: "int-a", runId: "run-1", decision: "allow-once" } },
      ctx,
    );
    // A card still on screen after the run resumed would let someone approve the same act twice.
    expect(await resolvers.Query.pendingApproval({}, { runId: "run-1" }, ctx)).toBeNull();
  });
});
