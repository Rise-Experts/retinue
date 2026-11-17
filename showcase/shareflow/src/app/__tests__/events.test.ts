/**
 * The event stream, polled from the log.
 *
 * The design decision worth testing is that the **log** is the source, not a Redis subscription: a
 * subscriber that joins after a run started has missed everything before it, so a resumable stream
 * needs the log anyway. Building on the log makes resume and first-connect one code path rather than
 * two, and the one exercised less is the one that breaks.
 */
import { describe, expect, it } from "vitest";

import { createOpenEvents } from "../events.js";

const context = { tenantId: "t1", principalId: "p1", roleIds: ["editor"] } as never;

/** A log that returns each batch in turn, then nothing. */
const log = (batches: readonly (readonly { sequence: number; type: string }[])[]) => {
  const asked: { after: number }[] = [];
  let call = 0;
  return {
    asked,
    log: {
      async listAfter(input: { after: number }) {
        asked.push({ after: input.after });
        return batches[call++] ?? [];
      },
    } as never,
  };
};

const drain = async (source: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const event of source) out.push(event);
  return out;
};

describe("openEvents", () => {
  it("stops at a terminal event rather than polling forever", async () => {
    /**
     * The stream has to end, or the connection is held until the client gives up — and the UI reads an
     * open stream as the assistant still working.
     */
    const { log: l } = log([[
      { sequence: 1, type: "run.started" },
      { sequence: 2, type: "run.completed" },
    ]]);
    const events = await drain(createOpenEvents(l, { pollMs: 1, maxMs: 5_000 })({ context, runId: "r1" as never, conversationId: "c1" }));
    expect(events).toHaveLength(2);
  });

  it("ends on a failure too, not only on success", async () => {
    // A failed run whose stream stayed open would look exactly like a slow one.
    const { log: l } = log([[{ sequence: 1, type: "run.failed" }]]);
    expect(await drain(createOpenEvents(l, { pollMs: 1, maxMs: 5_000 })({ context, runId: "r1" as never, conversationId: "c1" }))).toHaveLength(1);
  });

  it("advances the cursor, so an event is delivered once", async () => {
    /**
     * A cursor that did not advance would re-read the same batch for ever: the client would see the
     * first token repeated until the deadline.
     */
    const { log: l, asked } = log([
      [{ sequence: 1, type: "part.added" }],
      [{ sequence: 2, type: "run.completed" }],
    ]);
    const events = await drain(createOpenEvents(l, { pollMs: 1, maxMs: 5_000 })({ context, runId: "r1" as never, conversationId: "c1" }));
    expect(events).toHaveLength(2);
    expect(asked.map((a) => a.after)).toEqual([0, 1]);
  });

  it("resumes from the caller's cursor", async () => {
    // What makes the stream resumable: a client that reconnects names what it already has.
    const { log: l, asked } = log([[{ sequence: 8, type: "run.completed" }]]);
    await drain(createOpenEvents(l, { pollMs: 1, maxMs: 5_000 })({ context, runId: "r1" as never, conversationId: "c1", after: 7 }));
    expect(asked[0]?.after).toBe(7);
  });

  it("gives up after the bound rather than holding the connection for ever", async () => {
    /**
     * A worker killed mid-run leaves a run `running` with no further events. Without a bound the stream
     * waits on it until the client gives up, holding a connection the whole time.
     */
    const { log: l } = log([]);
    const events = await drain(createOpenEvents(l, { pollMs: 1, maxMs: 20 })({ context, runId: "r1" as never, conversationId: "c1" }));
    expect(events).toEqual([]);
  });

  it("does not sleep between full batches", async () => {
    /**
     * A busy run must not be paced by the poll interval. With a 50ms interval and three batches,
     * sleeping between them would take 150ms; only the empty read should wait.
     */
    const { log: l } = log([
      [{ sequence: 1, type: "part.added" }],
      [{ sequence: 2, type: "part.updated" }],
      [{ sequence: 3, type: "run.completed" }],
    ]);
    const started = Date.now();
    await drain(createOpenEvents(l, { pollMs: 50, maxMs: 5_000 })({ context, runId: "r1" as never, conversationId: "c1" }));
    expect(Date.now() - started).toBeLessThan(40);
  });
});
