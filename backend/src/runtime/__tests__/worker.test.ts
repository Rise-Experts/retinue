import { describe, expect, it } from "vitest";
import type { MessagePart, TextPart } from "../../core/content-parts.js";
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
import { createMemoryCheckpointStore, createMemoryRunStore } from "../../adapters/memory/runtime.js";
import type { CheckpointStore, RunStore } from "../../persistence/index.js";
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
