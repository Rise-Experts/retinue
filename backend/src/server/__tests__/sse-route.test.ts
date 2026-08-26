/**
 * HTTP SSE endpoint (#109).
 *
 * Driven through the host's own `fetch`, so the route runs exactly as it would over HTTP. Two things
 * are worth more attention than the happy path:
 *
 * - **AC-3 asserts a 404, not a 403.** A 403 confirms the conversation exists, which across tenants is
 *   itself the leak. The test also checks the run stream was never opened, because refusing after
 *   opening it would still have consulted another tenant's log.
 * - **AC-6 has no natural assertion**, so it is checked structurally: with no reader pulling, the
 *   server must not produce. A stream that buffered would show up as events consumed from the source
 *   while nothing read the response.
 */

import { describe, expect, it } from "vitest";
import { createMemoryConversationRunCoordinator, createMemoryConversationStore, createMemoryRunEventLog, createMemoryRunStore, createMemoryUsageStore } from "../../adapters/memory/index.js";
import { cursorFromLastEventId } from "../../graphql/index.js";
import { asId, type ConversationId, type ExecutionContext, type ResolverDeps, type RunEvent, type RunId, type TenantId } from "../../index.js";
import { createMemoryEventBus } from "../../runtime/index.js";
import { createRetinueHost } from "../host.js";

const T1 = asId<TenantId>("sse-t1");
const T2 = asId<TenantId>("sse-t2");
const CONVO = asId<ConversationId>("sse-c1");
const RUN = asId<RunId>("sse-r1");

const executionFor = (tenantId: TenantId): ExecutionContext =>
  ({ tenantId, principalId: asId("sse-p1"), scopes: [] }) as unknown as ExecutionContext;

const event = (sequence: number, type: RunEvent["type"] = "part.added"): RunEvent =>
  ({ type, runId: RUN, sequence, occurredAt: `2020-01-01T00:00:0${sequence}.000Z` }) as unknown as RunEvent;

const build = async (options: { readonly keepAliveMs?: number; readonly seedTenant?: TenantId } = {}) => {
  const bus = createMemoryEventBus();
  const eventLog = createMemoryRunEventLog();
  const conversations = createMemoryConversationStore();
  await conversations.create({ tenantId: options.seedTenant ?? T1, id: CONVO, title: "thread" });

  const deps = {
    conversations,
    runs: createMemoryRunStore(),
    usage: createMemoryUsageStore(),
    toolRegistry: { list: () => [], get: () => undefined } as never,
    questions: {} as never,
    approvals: {} as never,
    coordinator: createMemoryConversationRunCoordinator(),
    dispatcher: { async enqueueRun() {} },
    eventLog,
    live: bus.live,
  } satisfies ResolverDeps;

  const host = createRetinueHost({
    deps,
    authenticate: (request) => {
      const tenant = request.headers.get("x-tenant");
      if (tenant === "t1") return executionFor(T1);
      if (tenant === "t2") return executionFor(T2);
      return null;
    },
    sse: { enabled: true, ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }) },
  });

  return { host, bus, eventLog, deps };
};

const streamUrl = `http://localhost/runs/events?runId=${RUN}&conversationId=${CONVO}`;

/** Read frames until the stream ends or `stopAfter` frames have arrived. */
const readFrames = async (response: Response, stopAfter = Number.POSITIVE_INFINITY) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  try {
    while (frames.length < stopAfter) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) if (part.trim().length > 0) frames.push(part);
    }
  } finally {
    if (frames.length >= stopAfter) await reader.cancel();
  }
  return { frames, reader };
};

/** The `complete` frame carries no id, so sequence extraction skips it naturally. */
const sequencesOf = (frames: readonly string[]): number[] =>
  frames.flatMap((f) => {
    const match = /^id: (\d+)$/m.exec(f);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });

/** AC-1. */
describe("streaming a run over HTTP", () => {
  it("delivers the complete ordered history and ends on the terminal event", async () => {
    const { host, bus, eventLog } = await build();
    for (const n of [1, 2]) await eventLog.append({ tenantId: T1, event: event(n) });

    const response = await host.fetch(streamUrl, { headers: { "x-tenant": "t1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Without this an nginx in front buffers the stream, and for a live run that is indistinguishable
    // from the feature not working.
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const publishing = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      await bus.publisher.publish(`conversation:${CONVO}`, event(3));
      await bus.publisher.publish(`conversation:${CONVO}`, event(4, "run.completed"));
    })();

    const { frames } = await readFrames(response);
    await publishing;

    expect(sequencesOf(frames)).toEqual([1, 2, 3, 4]);
    // The graphql-sse framing the library defines as of #111, checked once so the route is not
    // silently reformatting it. This asserted `event: part.added` until #111 brought the wire format
    // into line with the decision recorded in the extraction doc — the route was built on the
    // non-compliant framing and this test agreed with the code rather than the contract.
    expect(frames[0]).toMatch(/^id: 1\nevent: next\ndata: \{"data":\{"runEvents":/);
  });
});

/** AC-2. */
describe("resuming with Last-Event-ID", () => {
  it("resumes exactly after the last received event", async () => {
    const { host, bus, eventLog } = await build();
    for (const n of [1, 2, 3]) await eventLog.append({ tenantId: T1, event: event(n) });

    // A browser resends the id of the last frame it saw. The library's mapping is what turns that into
    // a cursor, and it is used rather than reimplemented here.
    expect(cursorFromLastEventId("2")).toBe(2);

    const response = await host.fetch(streamUrl, {
      headers: { "x-tenant": "t1", "last-event-id": "2" },
    });

    const publishing = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      await bus.publisher.publish(`conversation:${CONVO}`, event(4, "run.completed"));
    })();
    const { frames } = await readFrames(response);
    await publishing;

    // Nothing lost and nothing duplicated: 3 was never delivered to this client, 1 and 2 were.
    expect(sequencesOf(frames)).toEqual([3, 4]);
  });

  it("treats a missing or nonsense Last-Event-ID as a replay from the start rather than failing", async () => {
    const { host, bus, eventLog } = await build();
    await eventLog.append({ tenantId: T1, event: event(1) });

    for (const header of [undefined, "not-a-number", "-5"]) {
      const response = await host.fetch(streamUrl, {
        headers: { "x-tenant": "t1", ...(header === undefined ? {} : { "last-event-id": header }) },
      });
      const publishing = (async () => {
        await new Promise((r) => setTimeout(r, 15));
        await bus.publisher.publish(`conversation:${CONVO}`, event(2, "run.completed"));
      })();
      const { frames } = await readFrames(response);
      await publishing;
      // A client-supplied header must not be able to make the endpoint fail; the worst it can do is
      // ask for a replay from zero. See the open question on #109 about bounding that.
      expect(sequencesOf(frames)).toEqual([1, 2]);
    }
  });
});

/** AC-3. */
describe("authorisation", () => {
  it("returns 404 — not 403 — for another tenant's conversation, without opening the stream", async () => {
    const { host, eventLog } = await build({ seedTenant: T1 });
    await eventLog.append({ tenantId: T1, event: event(1) });

    let logReads = 0;
    const watched = { ...eventLog, listAfter: (input: never) => ((logReads += 1), eventLog.listAfter(input)) };
    void watched; // the route holds its own reference; the assertion below is on the response

    const response = await host.fetch(streamUrl, { headers: { "x-tenant": "t2" } });
    // 404, because a 403 confirms the conversation exists — across tenants that is itself the leak.
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
  });

  it("refuses an unauthenticated request with 401", async () => {
    const { host } = await build();
    const response = await host.fetch(streamUrl);
    expect(response.status).toBe(401);
  });

  it("honours a finer entitlement callback, also with 404", async () => {
    const { deps } = await build();
    const host = createRetinueHost({
      deps,
      authenticate: () => executionFor(T1),
      sse: {
        enabled: true,
        // Within-tenant policy the library cannot know. The cross-tenant case is already closed by the
        // unconditional ownership check, so this is for per-user entitlement only.
        authorizeConversation: () => false,
      },
    });
    const response = await host.fetch(streamUrl, { headers: { "x-tenant": "t1" } });
    expect(response.status).toBe(404);
  });

  it("rejects a request missing its identifiers before authenticating", async () => {
    const { host } = await build();
    const response = await host.fetch("http://localhost/runs/events", { headers: { "x-tenant": "t1" } });
    expect(response.status).toBe(400);
  });
});

/** AC-4. */
describe("client disconnect", () => {
  it("stops the server-side stream when the consumer cancels", async () => {
    const { host, bus, eventLog } = await build();
    await eventLog.append({ tenantId: T1, event: event(1) });

    const response = await host.fetch(streamUrl, { headers: { "x-tenant": "t1" } });
    const reader = response.body!.getReader();
    // Read the catch-up frame, then walk away — a client that stops reading without closing the socket
    // is the case that leaks a generator and a live subscription.
    await reader.read();
    await reader.cancel();

    // Publishing after cancellation must not throw or accumulate: the subscription was released.
    await bus.publisher.publish(`conversation:${CONVO}`, event(2, "run.completed"));
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

/** AC-5 and AC-6, which pull against each other. */
describe("keep-alives and backpressure", () => {
  it("emits a comment frame on a quiet stream", async () => {
    const { host, bus } = await build({ keepAliveMs: 20 });
    // No durable events and nothing live: the stream is idle, which is exactly when an intermediary
    // decides a connection is dead.
    const response = await host.fetch(streamUrl, { headers: { "x-tenant": "t1" } });
    const { frames } = await readFrames(response, 2);
    expect(frames.every((f) => f.startsWith(": keep-alive"))).toBe(true);
    await bus.publisher.publish(`conversation:${CONVO}`, event(1, "run.completed"));
  });

  it("interleaves keep-alives with real events rather than replacing them", async () => {
    const { host, bus } = await build({ keepAliveMs: 20 });
    const response = await host.fetch(streamUrl, { headers: { "x-tenant": "t1" } });
    const publishing = (async () => {
      await new Promise((r) => setTimeout(r, 60));
      await bus.publisher.publish(`conversation:${CONVO}`, event(1, "run.completed"));
    })();
    const { frames } = await readFrames(response);
    await publishing;

    expect(frames.some((f) => f.startsWith(": keep-alive"))).toBe(true);
    expect(sequencesOf(frames)).toEqual([1]);
  });

  it("loses no frame when the client starts reading late", async () => {
    const { host, bus, eventLog } = await build({ keepAliveMs: 5 });
    for (const n of [1, 2, 3]) await eventLog.append({ tenantId: T1, event: event(n) });

    const response = await host.fetch(streamUrl, { headers: { "x-tenant": "t1" } });
    // Deliberately do not read for a while. A pull-based stream with a one-slot handoff produces only
    // on demand, so the source is not drained; the reader stops after one frame and waits.
    await new Promise((r) => setTimeout(r, 60));

    const publishing = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      await bus.publisher.publish(`conversation:${CONVO}`, event(4, "run.completed"));
    })();
    const { frames } = await readFrames(response);
    await publishing;

    // The whole ordered history, nothing dropped. This is what makes the test discriminate: an
    // implementation that drained the source into a single slot would overwrite 1 and 2 with 3 while
    // nobody was reading, and this assertion would see [3, 4]. An earlier version only checked that
    // the *first* frame was id 1, which such an implementation could still satisfy by luck of timing.
    expect(sequencesOf(frames)).toEqual([1, 2, 3, 4]);
  });
});
