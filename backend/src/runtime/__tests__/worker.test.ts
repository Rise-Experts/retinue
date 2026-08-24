import { describe, expect, it } from "vitest";
import type { Message, MessagePart, TextPart } from "../../core/content-parts.js";
import type { ExecutionContext } from "../../core/context.js";
import type { RealtimePublisher, RunEvent } from "../../core/events.js";
import { asId } from "../../core/ids.js";
import type {
  ConversationId,
  MessageId,
  MessagePartId,
  RunId,
  TenantId,
  ToolCallId,
} from "../../core/ids.js";
import {
  createMemoryCheckpointStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
} from "../../adapters/memory/runtime.js";
import { createMemoryUsageStore } from "../../adapters/memory/usage.js";
import { createUsageRecorder, type PricingResolver } from "../../usage/index.js";
import type { CheckpointStore, MessageStore, RunStore } from "../../persistence/index.js";
import { createDurableWorker, deriveRunMessageId, type AgentEngine, type EngineEvent } from "../worker.js";
import { emptyCheckpoint } from "../checkpoint.js";

const TENANT = asId<TenantId>("t1");
const CONVO = asId<ConversationId>("c1");
const RUN = asId<RunId>("r1");

const ctx = (): ExecutionContext => ({
  tenantId: TENANT,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

const textPart = (id: string, text: string): TextPart => ({
  id: asId<MessagePartId>(id),
  type: "text",
  schemaVersion: 1,
  createdAt: "t",
  text,
});

const recordingPublisher = () => {
  const events: RunEvent[] = [];
  const publisher: RealtimePublisher = {
    async publish(_channel, event) {
      events.push(event);
    },
  };
  return { events, publisher };
};

/** A clock that advances by `stepMs` on each `now()` read, so leases and keepalive progress. */
const fakeClock = (startMs = Date.UTC(2020, 0, 1), stepMs = 1000) => {
  let t = startMs;
  return {
    now: () => (t += stepMs),
    peek: () => t,
    advance: (ms: number) => (t += ms),
  };
};

const baseDeps = (runs: RunStore, checkpoints: CheckpointStore, engine: AgentEngine, clock: ReturnType<typeof fakeClock>) => {
  const { events, publisher } = recordingPublisher();
  return {
    events,
    deps: {
      runs,
      checkpoints,
      publisher,
      engine,
      buildContext: () => ctx(),
      workerId: "worker-1",
      now: clock.now,
      leaseMs: 30_000,
    },
  };
};

/** Engine that emits a text part, runs one tool (recording the external action), then a final part. */
const toolEngine = (external: { count: number }): AgentEngine => ({
  async *run() {
    yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p1", "thinking") };
    const toolCallId = asId<ToolCallId>("tc1");
    yield { type: "tool.started", toolCallId, toolName: "publish" };
    external.count += 1; // the side effect
    yield { type: "tool.completed", toolCallId, toolName: "publish" };
    yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p2", "done") };
    yield { type: "usage.updated", inputTokens: 10, outputTokens: 5 };
  },
});

describe("durable worker — happy path & durability", () => {
  it("completes a run and checkpoints every part so a refresh loses nothing", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    const external = { count: 0 };
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { events, deps } = baseDeps(runs, checkpoints, toolEngine(external), clock);
    const worker = createDurableWorker(deps);

    const result = await worker.process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("completed");
    expect(external.count).toBe(1);

    // Refresh: the latest checkpoint holds the full assistant message, in order.
    const cp = await checkpoints.latest({ tenantId: TENANT, runId: RUN });
    expect(cp?.parts.map((p) => (p as TextPart).text).filter(Boolean)).toEqual(["thinking", "done"]);
    expect(cp?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });

    // Sequences are monotonic and run.completed is the final published event.
    const seqs = events.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(events.at(-1)?.type).toBe("run.completed");
    const run = await runs.findById({ tenantId: TENANT, id: RUN });
    expect(run?.status).toBe("completed");
  });

  it("persists partial output when the run fails mid-stream", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const engine: AgentEngine = {
      async *run() {
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p1", "one") };
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p2", "two") };
        throw new Error("provider exploded");
      },
    };
    const { deps } = baseDeps(runs, checkpoints, engine, clock);
    const result = await createDurableWorker(deps).process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("failed");
    const cp = await checkpoints.latest({ tenantId: TENANT, runId: RUN });
    // Both streamed parts survived the crash — nothing before the failure was lost.
    expect(cp?.parts.filter((p) => p.type === "text")).toHaveLength(2);
    const run = await runs.findById({ tenantId: TENANT, id: RUN });
    expect(run?.status).toBe("failed");
    expect(run?.error?.message).toBe("provider exploded");
  });
});

describe("durable worker — atomic claim", () => {
  it("a second worker skips a run already claimed under a live lease", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    // worker-1 holds a live claim.
    const first = await runs.claim({ tenantId: TENANT, id: RUN, workerId: "worker-1", leaseMs: 30_000, now: new Date(clock.now()).toISOString() });
    expect(first).not.toBeNull();

    const checkpoints = createMemoryCheckpointStore();
    const { deps } = baseDeps(runs, checkpoints, toolEngine({ count: 0 }), clock);
    const worker = createDurableWorker({ ...deps, workerId: "worker-2" });
    const result = await worker.process({ tenantId: TENANT, runId: RUN });
    expect(result.outcome).toBe("skipped");
  });
});

describe("durable worker — crash recovery", () => {
  it("recovers a crashed run, finalizes the dangling tool call, and never re-fires the side effect", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    const external = { count: 1 }; // worker-1 already fired the external action once before dying.
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });

    // Simulate worker-1: claim, checkpoint a started-but-not-completed tool call, then crash (no terminal transition).
    await runs.claim({ tenantId: TENANT, id: RUN, workerId: "worker-1", leaseMs: 30_000, now: new Date(clock.now()).toISOString() });
    const crashedCp = {
      ...emptyCheckpoint(RUN, "t0"),
      sequence: 2,
      parts: [textPart("p1", "thinking") as MessagePart],
      pendingToolCalls: [{ toolCallId: asId<ToolCallId>("tc1"), toolName: "publish", startedAt: "t0" }],
    };
    await checkpoints.save({ tenantId: TENANT, checkpoint: crashedCp });

    // Lease expires; a resume-aware engine that does NOT re-run the tool takes over.
    clock.advance(60_000);
    const resumeEngine: AgentEngine = {
      async *run({ resume }) {
        expect(resume).not.toBeNull();
        // The dangling call was finalized as an interrupted error part before we were called.
        expect(resume?.pendingToolCalls).toHaveLength(0);
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p9", "recovered") };
      },
    };
    const { events, deps } = baseDeps(runs, checkpoints, resumeEngine, clock);
    const result = await createDurableWorker({ ...deps, workerId: "worker-2" }).process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("completed");
    expect(external.count).toBe(1); // no duplicate external action
    const cp = await checkpoints.latest({ tenantId: TENANT, runId: RUN });
    // Dangling tool finalized as an interrupted error part; recovery appended new output.
    const errorPart = cp?.parts.find((p) => p.type === "error");
    expect(errorPart).toBeDefined();
    expect(events.some((e) => e.type === "tool.failed")).toBe(true);
    expect(cp?.pendingToolCalls).toHaveLength(0);
  });

  it("reconciles from the event log when the checkpoint lags behind it (C1)", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    const eventLog = createMemoryRunEventLog();
    const external = { count: 1 }; // worker-1 already fired the tool once.
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    await runs.claim({ tenantId: TENANT, id: RUN, workerId: "worker-1", leaseMs: 30_000, now: new Date(clock.now()).toISOString() });

    // worker-1: the event LOG got the part (seq 1) and a tool.started (seq 2), but the CHECKPOINT was
    // only written at seq 1 (it lags the log) — then the worker crashed.
    const mk = (seq: number, e: Partial<RunEvent> & { type: RunEvent["type"] }) =>
      ({ runId: RUN, sequence: seq, occurredAt: `t${seq}`, ...e }) as RunEvent;
    await eventLog.append({ tenantId: TENANT, event: mk(1, { type: "part.added", messageId: asId<MessageId>("m1"), part: textPart("p1", "thinking") } as never) });
    await eventLog.append({ tenantId: TENANT, event: mk(2, { type: "tool.started", toolCallId: asId<ToolCallId>("tc1"), toolName: "publish" } as never) });
    await checkpoints.save({ tenantId: TENANT, checkpoint: { ...emptyCheckpoint(RUN, "t0"), sequence: 1, parts: [textPart("p1", "thinking") as MessagePart] } });

    clock.advance(60_000);
    const resumeEngine: AgentEngine = {
      async *run({ resume }) {
        // Reconciliation folded the logged tool.started, then finalized it — so no pending remains.
        expect(resume?.pendingToolCalls).toHaveLength(0);
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p9", "recovered") };
      },
    };
    const { events, deps } = baseDeps(runs, checkpoints, resumeEngine, clock);
    const result = await createDurableWorker({ ...deps, eventLog, workerId: "worker-2" }).process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("completed");
    expect(external.count).toBe(1); // the logged-but-uncheckpointed tool was finalized, never re-run
    // New events continue past the durable max (seq 2) — no sequence collides with the log.
    const logged = await eventLog.listAfter({ tenantId: TENANT, runId: RUN, after: 0 });
    const seqs = logged.map((e) => e.sequence);
    expect(new Set(seqs).size).toBe(seqs.length); // all sequences unique — no collision/drop
    expect(Math.max(...seqs)).toBeGreaterThan(2);
    expect(events.some((e) => e.type === "tool.failed")).toBe(true);
  });

  it("reapExpired surfaces runs whose lease has passed", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    await runs.claim({ tenantId: TENANT, id: RUN, workerId: "worker-1", leaseMs: 5_000, now: new Date(clock.now()).toISOString() });
    clock.advance(10_000);
    const expired = await runs.reapExpired({ now: new Date(clock.peek()).toISOString(), limit: 10 });
    expect(expired.map((r) => r.id)).toContain(RUN);
  });
});

describe("durable worker — usage recording", () => {
  const pricing: PricingResolver = { resolve: () => ({ currency: "USD", inputPerMillion: 1000, outputPerMillion: 2000 }) };

  it("records usage for realized steps in the completion path", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    const usageStore = createMemoryUsageStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const engine: AgentEngine = {
      async *run() {
        yield { type: "usage.updated", inputTokens: 100, outputTokens: 50, modelId: "m1", costMinorUnits: 30, currency: "USD" };
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p1", "done") };
      },
    };
    const { deps } = baseDeps(runs, checkpoints, engine, clock);
    const worker = createDurableWorker({ ...deps, usage: createUsageRecorder({ store: usageStore, pricing }) });
    const result = await worker.process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("completed");
    const totals = await usageStore.totals({ tenantId: TENANT, runId: RUN });
    expect(totals).toMatchObject({ inputTokens: 100, outputTokens: 50, costMinorUnits: 30, eventCount: 1 });
  });

  it("keeps usage that was realized before a mid-run failure", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    const usageStore = createMemoryUsageStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const engine: AgentEngine = {
      async *run() {
        yield { type: "usage.updated", inputTokens: 80, outputTokens: 20, modelId: "m1", costMinorUnits: 12, currency: "USD" };
        throw new Error("provider exploded after the billed call");
      },
    };
    const { deps } = baseDeps(runs, checkpoints, engine, clock);
    const worker = createDurableWorker({ ...deps, usage: createUsageRecorder({ store: usageStore, pricing }) });
    const result = await worker.process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("failed");
    // The provider call happened and consumed tokens — usage must survive the failure.
    const totals = await usageStore.totals({ tenantId: TENANT, runId: RUN });
    expect(totals).toMatchObject({ inputTokens: 80, costMinorUnits: 12, eventCount: 1 });
  });
});

describe("durable worker — cancellation", () => {
  it("stops the engine cooperatively and finalizes as cancelled", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });

    let cleanedUp = false;
    let emitted = 0;
    const engine: AgentEngine = {
      async *run({ signal }) {
        try {
          for (let i = 0; i < 20; i += 1) {
            if (signal.isCancelled()) return;
            emitted += 1;
            yield {
              type: "part.added",
              messageId: deriveRunMessageId(RUN) as MessageId,
              part: textPart(`p${i}`, `chunk ${i}`),
            } satisfies EngineEvent;
          }
        } finally {
          cleanedUp = true; // cancellation propagated to the engine (would abort provider/tools here)
        }
      },
    };

    const { events, publisher } = recordingPublisher();
    // After the 3rd published event, request cancellation out-of-band.
    let published = 0;
    const cancelOnThird: RealtimePublisher = {
      async publish(channel, event) {
        await publisher.publish(channel, event);
        published += 1;
        if (published === 3) await runs.requestCancel({ tenantId: TENANT, id: RUN, now: new Date(clock.peek()).toISOString() });
      },
    };
    const worker = createDurableWorker({
      runs,
      checkpoints,
      publisher: cancelOnThird,
      engine,
      buildContext: () => ctx(),
      workerId: "worker-1",
      now: clock.now,
      leaseMs: 30_000,
      keepaliveEveryMs: 0, // observe the cancel on the next iteration
    });

    const result = await worker.process({ tenantId: TENANT, runId: RUN });
    expect(result.outcome).toBe("cancelled");
    expect(cleanedUp).toBe(true);
    expect(emitted).toBeLessThan(20); // stopped early
    expect(events.at(-1)?.type).toBe("run.cancelled");
    const run = await runs.findById({ tenantId: TENANT, id: RUN });
    expect(run?.status).toBe("cancelled");
  });
});

/**
 * AC-5 of #107: "heartbeats continue during long tool calls, so a slow tool is not mistaken for a dead
 * worker."
 *
 * The existing `heartbeat()` runs on every engine *event*, throttled — which keeps a tool-*heavy* run
 * alive (many short tools, an event between each) but says nothing about a *single* long tool call.
 * While the engine awaits one tool it yields nothing, so nothing calls keepalive, and a tool slower
 * than the lease loses its claim: the run gets reaped and re-executed while it is still running.
 *
 * That is a production failure for any genuinely slow tool — a large render, a slow third-party API —
 * so the worker now keeps a timer-based heartbeat for the duration of the run, independent of events.
 */
describe("durable worker — heartbeat during a long tool call (#107 AC-5)", () => {
  /** An engine whose single tool call takes longer than the lease, emitting nothing while it waits. */
  const slowToolEngine = (holdMs: number): AgentEngine => ({
    async *run() {
      const toolCallId = asId<ToolCallId>("slow-1");
      yield { type: "tool.started", toolCallId, toolName: "render" };
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      yield { type: "tool.completed", toolCallId, toolName: "render" };
      yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p1", "done") };
    },
  });

  /**
   * Real time, deliberately — and this matters. The shared `fakeClock` advances 1000ms on *every*
   * `now()` read, which makes the keepalive throttle pass unconditionally and the lease look freshly
   * extended no matter when it was last touched. A first version of these tests used it and passed
   * while proving nothing: heartbeats still only happened *between* events, and the fake clock hid it.
   */
  const realClock = { now: () => Date.now(), iso: () => new Date().toISOString() };

  it("keeps the lease alive while a single tool call outlives it", async () => {
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });

    const keepalives: string[] = [];
    const spying: RunStore = {
      ...runs,
      async keepalive(input) {
        keepalives.push(input.now);
        return runs.keepalive(input);
      },
    };

    const { publisher } = recordingPublisher();
    const worker = createDurableWorker({
      runs: spying,
      checkpoints,
      publisher,
      engine: slowToolEngine(300),
      buildContext: () => ctx(),
      workerId: "worker-1",
      now: realClock.now,
      clock: realClock.iso,
      // A short lease with a heartbeat well inside it, so the single tool call spans several beats.
      leaseMs: 150,
      keepaliveEveryMs: 40,
    });

    const result = await worker.process({ tenantId: TENANT, runId: RUN });

    // The engine emits `tool.started`, then nothing for 300ms. An event-driven heartbeat alone has
    // nothing to run on across that gap, so a slow tool loses its claim and the run is reaped and
    // re-executed while the first call is still in flight.
    expect(keepalives.length).toBeGreaterThan(2);
    expect(result.outcome).toBe("completed");
  });

  it("does not leave the run reapable while the slow tool is still running", async () => {
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });

    const { publisher } = recordingPublisher();
    const worker = createDurableWorker({
      runs,
      checkpoints,
      publisher,
      engine: slowToolEngine(400),
      buildContext: () => ctx(),
      workerId: "worker-1",
      now: realClock.now,
      clock: realClock.iso,
      leaseMs: 150,
      keepaliveEveryMs: 40,
    });

    const processing = worker.process({ tenantId: TENANT, runId: RUN });
    // Mid-tool and well past the original lease. A reaper sweeping now must not see this run as a
    // candidate: reclaiming it would run the tool a second time while the first call is in flight.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const reapable = await runs.reapExpired({ now: realClock.iso(), limit: 10 });
    expect(reapable.map((r) => r.id)).not.toContain(RUN);

    expect((await processing).outcome).toBe("completed");
  });
});

/**
 * #157 — the assistant's turn reaches the message store.
 *
 * Before this, `MessageStore` was read-only and `DurableWorkerDeps` took no message store, so a host persisted
 * the user's turn and nothing ever persisted the assistant's. Every host had to fold the run event log to
 * reconstruct what the agent said, or ship an agent with amnesia between runs.
 */
describe("durable worker — assistant turn persistence (#157)", () => {
  const recordingMessages = () => {
    const appended: Message[] = [];
    const store: MessageStore = {
      async append({ message }) {
        // Idempotent like every real adapter, so a second write of the same id is not a second row.
        if (appended.some((m) => m.id === message.id)) return;
        appended.push(message);
      },
      async findById() {
        return null;
      },
      async listByConversation() {
        return { items: [], nextCursor: undefined };
      },
    };
    return { appended, store };
  };

  it("records the assistant's parts under the streamed message id when a run completes", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { appended, store } = recordingMessages();
    const { deps } = baseDeps(runs, createMemoryCheckpointStore(), toolEngine({ count: 0 }), clock);

    const result = await createDurableWorker({ ...deps, messages: store }).process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("completed");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.role).toBe("assistant");
    expect(appended[0]?.conversationId).toBe(CONVO);
    expect(appended[0]?.runId).toBe(RUN);
    // The same id the client saw on every `part.added` — not a second convention for the persisted row.
    expect(appended[0]?.id).toBe(deriveRunMessageId(RUN));
    expect(appended[0]?.parts.map((p) => (p as TextPart).text)).toEqual(["thinking", "done"]);
  });

  /**
   * The gate is `isTerminal`, not `status === "completed"`. A run that failed still streamed text the user
   * read; dropping it would show them a reply that vanishes on reload.
   */
  it("records what was streamed before a failure", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { appended, store } = recordingMessages();
    const engine: AgentEngine = {
      async *run() {
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p1", "partial") };
        throw new Error("model exploded");
      },
    };
    const { deps } = baseDeps(runs, createMemoryCheckpointStore(), engine, clock);

    const result = await createDurableWorker({ ...deps, messages: store }).process({ tenantId: TENANT, runId: RUN });

    expect(result.outcome).toBe("failed");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.parts.some((p) => (p as TextPart).text === "partial")).toBe(true);
  });

  /**
   * The one that matters most. A run waiting for approval is **not** terminal — it goes back to `queued` and
   * finishes later. Writing at the pause would take the id first, and because the write is idempotent on that
   * id the completed turn would then be silently discarded as a duplicate: the user would be left looking at
   * the half of the answer that came before the approval, permanently.
   */
  it("writes nothing while a run is paused for approval, so the completed turn is not lost to its own partial", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { appended, store } = recordingMessages();
    let resumed = false;
    const engine: AgentEngine = {
      // Emits only what is new on the second pass — the worker restores the earlier parts from the checkpoint,
      // so an engine that re-yielded them would be duplicating, not replaying.
      async *run() {
        if (!resumed) {
          resumed = true;
          yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p1", "before") };
          yield { type: "approval.requested", toolCallId: asId<ToolCallId>("tc1"), toolName: "publish", requestId: "req-1" };
          return;
        }
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p2", "after") };
      },
    };
    const { deps } = baseDeps(runs, createMemoryCheckpointStore(), engine, clock);
    const worker = createDurableWorker({ ...deps, messages: store });

    const paused = await worker.process({ tenantId: TENANT, runId: RUN });
    expect(paused.outcome).toBe("paused");
    expect(appended).toHaveLength(0);

    // The continuation: back to queued, then driven to completion.
    await runs.transition({ tenantId: TENANT, id: RUN, workerId: "worker-1", to: "queued", now: new Date(clock.now()).toISOString() });
    const done = await worker.process({ tenantId: TENANT, runId: RUN });

    expect(done.outcome).toBe("completed");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.parts.map((p) => (p as TextPart).text)).toEqual(["before", "after"]);
  });

  it("stays absent when no message store is supplied", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { deps } = baseDeps(runs, createMemoryCheckpointStore(), toolEngine({ count: 0 }), clock);

    // No throw, no silent requirement — the store is optional for hosts that read history from the event log.
    expect((await createDurableWorker(deps).process({ tenantId: TENANT, runId: RUN })).outcome).toBe("completed");
  });
});

/**
 * A run the host cannot build a context for — #172.
 *
 * `buildContext` throwing escaped `drive` before the try that marks a run failed, so the run stayed `running`,
 * its lease expired, the reaper re-claimed it, and it threw again. Forever. Found in the wild the moment
 * `buildContext` began refusing runs with no recorded principal (#164): every older run became an unkillable
 * reap loop, reported once per sweep and never resolved.
 */
describe("durable worker — a context that cannot be built (#172)", () => {
  const refuses = (): never => {
    throw new Error("this run carries no principal");
  };

  it("fails the run instead of leaving it to be reaped forever", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { deps } = baseDeps(runs, createMemoryCheckpointStore(), toolEngine({ count: 0 }), clock);

    const result = await createDurableWorker({ ...deps, buildContext: refuses }).process({
      tenantId: TENANT,
      runId: RUN,
    });

    expect(result.outcome).toBe("failed");
    // Terminal, so `claim` will never match it again — which is what ends the loop.
    const stored = await runs.findById({ tenantId: TENANT, id: RUN });
    expect(stored?.status).toBe("failed");
    // And the reason is recorded, not just the status: "failed" with no error is a run nobody can diagnose.
    expect(stored?.error?.message).toContain("no principal");
  });

  it("tells a watching client why, rather than leaving the stream open forever", async () => {
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const eventLog = createMemoryRunEventLog();
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { deps } = baseDeps(runs, createMemoryCheckpointStore(), toolEngine({ count: 0 }), clock);

    await createDurableWorker({ ...deps, eventLog, buildContext: refuses }).process({ tenantId: TENANT, runId: RUN });

    const events = await eventLog.listAfter({ tenantId: TENANT, runId: RUN, after: 0 });
    expect(events.map((e) => e.type)).toContain("run.failed");
  });

  it("does not touch the engine", async () => {
    // The whole point: nothing ran, so nothing has to be undone. A side effect fired before the context was
    // rejected would be a side effect performed under no identity at all.
    const clock = fakeClock();
    const runs = createMemoryRunStore();
    const external = { count: 0 };
    await runs.create({ tenantId: TENANT, id: RUN, conversationId: CONVO, agentId: asId("a1"), agentVersion: 1 });
    const { deps } = baseDeps(runs, createMemoryCheckpointStore(), toolEngine(external), clock);

    await createDurableWorker({ ...deps, buildContext: refuses }).process({ tenantId: TENANT, runId: RUN });

    expect(external.count).toBe(0);
  });
});
