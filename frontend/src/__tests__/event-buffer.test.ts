import { describe, expect, it } from "vitest";

import { createEventBuffer } from "../event-buffer.js";
import type { RunEvent } from "../types/index.js";

const event = (sequence: number): RunEvent =>
  ({
    type: "run.checkpointed",
    runId: "run_1",
    sequence,
    occurredAt: "2026-08-14T00:00:00.000Z",
  }) as RunEvent;

describe("createEventBuffer", () => {
  it("releases in-order events immediately", () => {
    const buffer = createEventBuffer();

    expect(buffer.push(event(1))).toHaveLength(1);
    expect(buffer.push(event(2))).toHaveLength(1);
    expect(buffer.lastSequence()).toBe(2);
  });

  it("drops replayed events after a reconnect", () => {
    const buffer = createEventBuffer();
    buffer.push(event(1));
    buffer.push(event(2));

    expect(buffer.push(event(1))).toEqual([]);
    expect(buffer.push(event(2))).toEqual([]);
    expect(buffer.lastSequence()).toBe(2);
  });

  it("holds a gap and flushes once it fills", () => {
    const buffer = createEventBuffer();

    expect(buffer.push(event(3))).toEqual([]);
    expect(buffer.push(event(4))).toEqual([]);
    expect(buffer.pendingCount()).toBe(2);

    expect(buffer.push(event(1))).toHaveLength(1);
    expect(buffer.pendingCount()).toBe(2);

    const flushed = buffer.push(event(2));
    expect(flushed.map((e) => e.sequence)).toEqual([2, 3, 4]);
    expect(buffer.pendingCount()).toBe(0);
    expect(buffer.lastSequence()).toBe(4);
  });

  it("resumes from a cursor without re-emitting earlier events", () => {
    const buffer = createEventBuffer(10);

    expect(buffer.push(event(9))).toEqual([]);
    expect(buffer.push(event(11))).toHaveLength(1);
    expect(buffer.lastSequence()).toBe(11);
  });
});
