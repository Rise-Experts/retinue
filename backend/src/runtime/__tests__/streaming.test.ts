import { describe, expect, it } from "vitest";
import type { TextPart } from "../../core/content-parts.js";
import {
  EMPTY_RUN_STREAM_STATE,
  reduceRunEvents,
  type RunEvent,
} from "../../core/events.js";
import { asId } from "../../core/ids.js";
import type { ConversationId, MessageId, MessagePartId, RunId, TenantId } from "../../core/ids.js";
import { createMemoryRunEventLog } from "../../adapters/memory/runtime.js";
import { createMemoryEventBus, openRunEventStream, reconnectSnapshot } from "../streaming.js";

const TENANT = asId<TenantId>("t1");
const RUN = asId<RunId>("r1");
const CHANNEL = `conversation:${asId<ConversationId>("c1")}`;

const partEvent = (sequence: number, text: string): RunEvent => ({
  type: "part.added",
  runId: RUN,
  sequence,
  occurredAt: `t${sequence}`,
  messageId: asId<MessageId>("m1"),
  part: { id: asId<MessagePartId>(`p${sequence}`), type: "text", schemaVersion: 1, createdAt: "t", text } as TextPart,
});

const completed = (sequence: number): RunEvent => ({ type: "run.completed", runId: RUN, sequence, occurredAt: `t${sequence}` });

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("reduceRunEvents — canonical projection", () => {
  it("folds parts in order and accumulates usage", () => {
    const state = reduceRunEvents([
      partEvent(1, "a"),
      partEvent(2, "b"),
      { type: "usage.updated", runId: RUN, sequence: 3, occurredAt: "t3", inputTokens: 7, outputTokens: 4 },
      completed(4),
    ]);
    expect(state.parts.map((p) => (p as TextPart).text)).toEqual(["a", "b"]);
    expect(state.usage).toMatchObject({ inputTokens: 7, outputTokens: 4 });
    expect(state.terminal).toBe(true);
    expect(state.sequence).toBe(4);
  });

  it("shows a retry banner between attempts and clears it on progress", () => {
    const err = { code: "rate_limited" as const, message: "429", retryable: true };
    const retrying = reduceRunEvents([
      partEvent(1, "a"),
      { type: "run.retry-pending", runId: RUN, sequence: 2, occurredAt: "t2", attempt: 1, maxAttempts: 5, nextAttemptAt: "t9", error: err },
    ]);
    expect(retrying.retry).toMatchObject({ attempt: 1, maxAttempts: 5 });
    const resumed = reduceRunEvents([partEvent(3, "b")], retrying);
    expect(resumed.retry).toBeUndefined();
  });

  it("ignores an event whose sequence was already folded (idempotent replay)", () => {
    const once = reduceRunEvents([partEvent(1, "a"), partEvent(2, "b")]);
    const twice = reduceRunEvents([partEvent(2, "b")], once); // replayed duplicate
    expect(twice.parts).toHaveLength(2);
    expect(twice).toEqual(once);
  });
});

describe("reconnect — no missing or duplicated parts", () => {
  it("replays catch-up after the cursor then follows live", async () => {
    const log = createMemoryRunEventLog();
    const bus = createMemoryEventBus();
    // First connection produced events 1..3 (persisted in the log).
    for (const e of [partEvent(1, "a"), partEvent(2, "b"), partEvent(3, "c")]) {
      await log.append({ tenantId: TENANT, event: e });
    }

    // Client had already seen event 1; it reconnects with cursor after=1.
    const collected: number[] = [];
    const streaming = (async () => {
      for await (const e of openRunEventStream({ tenantId: TENANT, runId: RUN, channel: CHANNEL, after: 1, log, live: bus.live })) {
        collected.push(e.sequence);
      }
    })();

    await tick(); // let the stream subscribe and drain catch-up

    // Live continues: 4, 5, and terminal 6. Event 3 is re-published live too (the reconnect race).
    for (const e of [partEvent(3, "c"), partEvent(4, "d"), partEvent(5, "e"), completed(6)]) {
      await bus.publisher.publish(CHANNEL, e);
    }
    await streaming;

    // 2,3 from catch-up; 4,5,6 live; the duplicate 3 is dropped. Contiguous, unique.
    expect(collected).toEqual([2, 3, 4, 5, 6]);
  });

  it("catch-up alone completes a stream for a run that finished before reconnect", async () => {
    const log = createMemoryRunEventLog();
    const bus = createMemoryEventBus();
    for (const e of [partEvent(1, "a"), partEvent(2, "b"), completed(3)]) {
      await log.append({ tenantId: TENANT, event: e });
    }
    const collected: number[] = [];
    for await (const e of openRunEventStream({ tenantId: TENANT, runId: RUN, channel: CHANNEL, after: 0, log, live: bus.live })) {
      collected.push(e.sequence);
    }
    expect(collected).toEqual([1, 2, 3]); // terminal in catch-up ends the stream without blocking on live
  });

  it("a reconnecting client rebuilds identical state from snapshot + deltas", async () => {
    const log = createMemoryRunEventLog();
    const full = [partEvent(1, "a"), partEvent(2, "b"), partEvent(3, "c"), completed(4)];
    for (const e of full) await log.append({ tenantId: TENANT, event: e });

    const authoritative = reduceRunEvents(full);
    const { state: snapshot, after } = await reconnectSnapshot({ tenantId: TENANT, runId: RUN, log });
    // A client that took the snapshot at some earlier point and replays the rest lands in the same place.
    const partial = reduceRunEvents(full.slice(0, 2));
    const deltas = await log.listAfter({ tenantId: TENANT, runId: RUN, after: partial.sequence });
    const rebuilt = reduceRunEvents(deltas, partial);
    expect(rebuilt).toEqual(authoritative);
    expect(snapshot).toEqual(authoritative);
    expect(after).toBe(4);
  });
});
