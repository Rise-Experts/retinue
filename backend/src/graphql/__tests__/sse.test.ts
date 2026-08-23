/**
 * SSE wire format (#111).
 *
 * `docs/extraction/twenty-sdk-comparison.md` records the decision: *"Match the `graphql-sse` framing
 * rather than inventing a bespoke SSE protocol"* — twenty-sdk already streams GraphQL over graphql-sse,
 * so a Twenty client should consume this unmodified.
 *
 * The frames are checked against `graphql-sse`'s own parser rather than only against string patterns,
 * because a test that asserts the shape I wrote proves I wrote what I wrote, not that a client can read
 * it. The library is a devDependency for exactly this and is absent at runtime.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../../core/ids.js";
import { createMemoryRunEventLog } from "../../adapters/memory/index.js";
import { createMemoryEventBus } from "../../runtime/index.js";
import type { RunEvent } from "../../core/events.js";
import {
  cursorFromLastEventId,
  openRunEventSse,
  SSE_COMPLETE_FRAME,
  SSE_RESULT_FIELD,
  sseErrorFrame,
  toSseFrame,
} from "../sse.js";

const T = asId<TenantId>("t1");
const RUN = asId<RunId>("run1");
const C1 = asId<ConversationId>("c1");
const ev = (sequence: number, type: RunEvent["type"], over: Record<string, unknown> = {}): RunEvent =>
  ({ type, runId: RUN, sequence, occurredAt: `t${sequence}`, ...over }) as RunEvent;

/** Parse a frame the way a client does: id / event / data lines. */
const parseFrame = (frame: string) => {
  const lines = frame.split("\n").filter((l) => l.length > 0);
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  const data = field("data");
  return {
    id: field("id"),
    event: field("event"),
    data: data === undefined || data === "" ? undefined : (JSON.parse(data) as Record<string, unknown>),
  };
};

/** AC-1. */
describe("graphql-sse framing", () => {
  it("emits event: next carrying an ExecutionResult", () => {
    const parsed = parseFrame(toSseFrame(ev(3, "part.added")));
    // Previously this was `event: part.added` with a raw RunEvent as data — a shape no graphql-sse
    // client understands, and the opposite of what the extraction doc recorded.
    expect(parsed.event).toBe("next");
    expect(parsed.data).toEqual({ data: { [SSE_RESULT_FIELD]: ev(3, "part.added") } });
  });

  it("keeps the id line carrying the run event sequence", () => {
    // AC-2. This is the whole resume mechanism: a browser resends the last id it saw, and
    // `cursorFromLastEventId` maps it straight back to a sequence.
    expect(parseFrame(toSseFrame(ev(7, "part.added"))).id).toBe("7");
    expect(cursorFromLastEventId("7")).toBe(7);
  });

  it("terminates the stream with event: complete", async () => {
    const log = createMemoryRunEventLog();
    const bus = createMemoryEventBus();
    await log.append({ tenantId: T, event: ev(1, "run.started") });
    await log.append({ tenantId: T, event: ev(2, "run.completed") });

    const frames: string[] = [];
    for await (const frame of openRunEventSse({
      tenantId: T,
      runId: RUN,
      conversationId: C1,
      after: 0,
      log,
      live: bus.live,
    })) {
      frames.push(frame);
    }

    // A stream that simply stops is indistinguishable from a truncated one, and a
    // distinct-connections client cannot tell whether to reconnect.
    expect(frames).toHaveLength(3);
    expect(parseFrame(frames[0]!).event).toBe("next");
    expect(parseFrame(frames[1]!).data).toEqual({ data: { [SSE_RESULT_FIELD]: ev(2, "run.completed") } });
    expect(frames[2]).toBe(SSE_COMPLETE_FRAME);
    expect(parseFrame(frames[2]!).event).toBe("complete");
  });

  it("sends complete even when the consumer stops early", async () => {
    const log = createMemoryRunEventLog();
    const bus = createMemoryEventBus();
    for (const n of [1, 2, 3]) await log.append({ tenantId: T, event: ev(n, "part.added") });

    const iterator = openRunEventSse({
      tenantId: T,
      runId: RUN,
      conversationId: C1,
      after: 0,
      log,
      live: bus.live,
    })[Symbol.asyncIterator]();

    await iterator.next();
    // Returned early. The `complete` frame comes from a `finally`, so a client that stopped reading
    // still gets told the response is over rather than being left to guess.
    const closing = await iterator.return?.(undefined);
    expect(closing?.value).toBe(SSE_COMPLETE_FRAME);
  });
});

/** AC-3. */
describe("errors", () => {
  it("delivers a failed run as a next frame carrying both data and errors", () => {
    const failed = ev(4, "run.failed", {
      error: { code: "provider_unavailable", message: "provider down", retryable: true },
    });
    const parsed = parseFrame(toSseFrame(failed));

    // Deliberately a `next` frame, not a protocol error frame. `run.failed` is a durable event with a
    // sequence: as an error frame it would carry no `id`, so Last-Event-ID could not resume past it and
    // a reconnecting client would never learn the run ended. An ExecutionResult may hold both, so the
    // event travels in `data` and the failure in `errors` — clients surface it through their normal
    // error path, which is what AC-3 is for.
    expect(parsed.event).toBe("next");
    expect(parsed.id).toBe("4");
    expect((parsed.data as { data: unknown }).data).toEqual({ [SSE_RESULT_FIELD]: failed });
    expect((parsed.data as { errors: { message: string; extensions: unknown }[] }).errors).toEqual([
      { message: "provider down", extensions: { code: "provider_unavailable", retryable: true } },
    ]);
  });

  it("uses a data-less error result for a stream-level failure", () => {
    // Distinct from a failed run: there is no sequence to preserve and nothing to resume to, so this
    // genuinely is a protocol error.
    const parsed = parseFrame(sseErrorFrame("could not read the event log"));
    expect(parsed.id).toBeUndefined();
    expect(parsed.data).toEqual({ errors: [{ message: "could not read the event log" }] });
  });

  it("does not attach errors to a successful event", () => {
    const parsed = parseFrame(toSseFrame(ev(1, "run.completed")));
    expect(parsed.data).not.toHaveProperty("errors");
  });
});

/** AC-4 — a framing change, not an API change. */
describe("signatures are unchanged", () => {
  it("maps Last-Event-ID to a resume cursor exactly as before", () => {
    expect(cursorFromLastEventId("5")).toBe(5);
    expect(cursorFromLastEventId(null)).toBe(0);
    expect(cursorFromLastEventId("garbage")).toBe(0);
    expect(cursorFromLastEventId("-1")).toBe(0);
  });

  it("resumes after a cursor under the new framing", async () => {
    const log = createMemoryRunEventLog();
    const bus = createMemoryEventBus();
    for (const n of [1, 2, 3]) await log.append({ tenantId: T, event: ev(n, "part.added") });
    await log.append({ tenantId: T, event: ev(4, "run.completed") });

    const ids: (string | undefined)[] = [];
    for await (const frame of openRunEventSse({
      tenantId: T,
      runId: RUN,
      conversationId: C1,
      after: cursorFromLastEventId("2"),
      log,
      live: bus.live,
    })) {
      const parsed = parseFrame(frame);
      if (parsed.event === "next") ids.push(parsed.id);
    }
    // Nothing before the cursor, nothing duplicated — the property the `id:` line exists to serve.
    expect(ids).toEqual(["3", "4"]);
  });
});

/** AC-5, and the assertion that makes AC-1 mean something. */
describe("interoperability", () => {
  it("produces frames graphql-sse's own validators accept", async () => {
    const { validateStreamEvent, parseStreamData } = await import("graphql-sse");

    const log = createMemoryRunEventLog();
    const bus = createMemoryEventBus();
    await log.append({ tenantId: T, event: ev(1, "part.added") });
    await log.append({ tenantId: T, event: ev(2, "run.completed") });

    const frames: string[] = [];
    for await (const frame of openRunEventSse({
      tenantId: T,
      runId: RUN,
      conversationId: C1,
      after: 0,
      log,
      live: bus.live,
    })) {
      frames.push(frame);
    }

    // Fed through the library's own validators rather than compared to a string I wrote. Asserting my
    // format back at myself would prove only that I wrote what I wrote; `validateStreamEvent` throws on
    // an event name the protocol does not define, and `parseStreamData` throws on a payload that is not
    // a valid ExecutionResult for that event.
    const parsed = frames.map((frame) => {
      const { event, data } = parseFrame(frame);
      const validated = validateStreamEvent(event);
      return { event: validated, data: parseStreamData(validated, data === undefined ? "" : JSON.stringify(data)) };
    });

    expect(parsed.map((p) => p.event)).toEqual(["next", "next", "complete"]);
    expect(parsed[0]?.data).toEqual({ data: { [SSE_RESULT_FIELD]: ev(1, "part.added") } });
    expect(parsed[1]?.data).toEqual({ data: { [SSE_RESULT_FIELD]: ev(2, "run.completed") } });
  });

  it("would reject the old bespoke framing", async () => {
    const { validateStreamEvent } = await import("graphql-sse");
    // The shape this SPEC replaced: `event: part.added` with a raw RunEvent. The library's validator
    // rejects it outright, which is what "an existing Twenty client cannot consume it" means concretely.
    expect(() => validateStreamEvent("part.added")).toThrow();
    expect(validateStreamEvent("next")).toBe("next");
    expect(validateStreamEvent("complete")).toBe("complete");
  });

  it("is a devDependency only, so the runtime does not depend on it", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // The adapter writes plain text frames and takes no server dependency; matching a wire format must
    // not change that.
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("graphql-sse");
    expect(Object.keys(pkg.devDependencies ?? {})).toContain("graphql-sse");
  });
});
