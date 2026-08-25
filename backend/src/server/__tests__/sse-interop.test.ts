/**
 * Interop against the real `graphql-sse` client (#112).
 *
 * #111 validated the frames with graphql-sse's *validators*, which proves the bytes are well-formed
 * and nothing about whether the library's client can actually reach the endpoint. It could not: the
 * client POSTs a GraphQL operation and the route only read query parameters. That gap is closed here,
 * and this file is deliberately free of any parsing code of its own — every byte is handled by the
 * library, which is what AC-1 is really asking.
 *
 * **There is no listening socket.** The client takes a `fetchFn`, so it is pointed straight at the
 * host's own `fetch`. That exercises the whole request/response path — body, headers, status, stream —
 * without a port to bind or race on.
 */

import { describe, expect, it } from "vitest";
import {
  asId,
  createMemoryConversationRunCoordinator,
  createMemoryConversationStore,
  createMemoryEventBus,
  createMemoryRunEventLog,
  createMemoryRunStore,
  createMemoryUsageStore,
  type ConversationId,
  type ExecutionContext,
  type ResolverDeps,
  type RunEvent,
  type RunId,
  type TenantId,
} from "../../index.js";
import { createAgentkitHost } from "../host.js";

const T1 = asId<TenantId>("interop-t1");
const CONVO = asId<ConversationId>("interop-c1");
const RUN = asId<RunId>("interop-r1");

const event = (sequence: number, type: RunEvent["type"] = "part.added", over: Record<string, unknown> = {}): RunEvent =>
  ({ type, runId: RUN, sequence, occurredAt: `2020-01-01T00:00:0${sequence}.000Z`, ...over }) as unknown as RunEvent;

const SUBSCRIPTION = /* GraphQL */ `
  subscription RunEvents($runId: ID!, $conversationId: ID!, $after: Int) {
    runEvents(runId: $runId, conversationId: $conversationId, after: $after) {
      type
      sequence
    }
  }
`;

const build = async () => {
  const bus = createMemoryEventBus();
  const eventLog = createMemoryRunEventLog();
  const conversations = createMemoryConversationStore();
  await conversations.create({ tenantId: T1, id: CONVO, title: "thread" });

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

  const host = createAgentkitHost({
    deps,
    authenticate: () =>
      ({ tenantId: T1, principalId: asId("interop-p1"), scopes: [] }) as unknown as ExecutionContext,
    sse: { enabled: true },
  });

  return { host, bus, eventLog };
};

/** A real graphql-sse client aimed at the host's fetch handler. */
const clientFor = async (
  host: Awaited<ReturnType<typeof build>>["host"],
  options: { readonly onFetch?: (attempt: number) => void; readonly retryAttempts?: number } = {},
) => {
  const { createClient } = await import("graphql-sse");
  let attempts = 0;
  return createClient({
    url: "http://localhost/runs/events",
    retryAttempts: options.retryAttempts ?? 0,
    // The client's own fetch seam. No socket, and the full request path still runs.
    fetchFn: ((input: never, init: never) => {
      attempts += 1;
      options.onFetch?.(attempts);
      return (host.fetch as (i: never, n: never) => Promise<Response>)(input, init);
    }) as never,
  });
};

/** Collect a subscription to completion through the client's own sink. */
const consume = async (
  client: Awaited<ReturnType<typeof clientFor>>,
  variables: Record<string, unknown>,
) => {
  const events: { type: string; sequence: number }[] = [];
  const errors: unknown[] = [];
  let completed = false;

  await new Promise<void>((resolve) => {
    client.subscribe(
      { query: SUBSCRIPTION, variables },
      {
        next: (result) => {
          const data = (result as { data?: { runEvents?: { type: string; sequence: number } } }).data;
          if (data?.runEvents) events.push(data.runEvents);
          const resultErrors = (result as { errors?: unknown[] }).errors;
          if (resultErrors) errors.push(...resultErrors);
        },
        error: (error) => {
          errors.push(error);
          resolve();
        },
        complete: () => {
          completed = true;
          resolve();
        },
      },
    );
  });

  return { events, errors, completed };
};

/** AC-1 and AC-2. */
describe("a real graphql-sse client", () => {
  it("consumes a full run in order and completes, with no parsing code of ours", async () => {
    const { host, bus, eventLog } = await build();
    for (const n of [1, 2]) await eventLog.append({ tenantId: T1, event: event(n) });

    const client = await clientFor(host);
    const consuming = consume(client, { runId: RUN, conversationId: CONVO, after: 0 });

    await new Promise((r) => setTimeout(r, 30));
    await bus.publisher.publish(`conversation:${CONVO}`, event(3));
    await bus.publisher.publish(`conversation:${CONVO}`, event(4, "run.completed"));

    const { events, errors, completed } = await consuming;
    // The library did all the framing, parsing and dispatching. What this asserts is that a Twenty
    // client, which ships graphql-sse as a dependency, can consume this endpoint unmodified.
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(errors).toEqual([]);
    // AC-2: `complete` came from the terminating frame #111 added, not from a timeout or a socket close.
    expect(completed).toBe(true);
    client.dispose();
  });

  it("reaches the route by POSTing an operation, not by query parameters", async () => {
    const { host, bus, eventLog } = await build();
    await eventLog.append({ tenantId: T1, event: event(1, "run.completed") });

    let sawPost = false;
    const { createClient } = await import("graphql-sse");
    const client = createClient({
      url: "http://localhost/runs/events",
      retryAttempts: 0,
      fetchFn: ((input: never, init: { method?: string }) => {
        // This is the gap #111 left: the frames were compliant while the request side was not, so a
        // real client could not reach the endpoint at all.
        if (init?.method === "POST") sawPost = true;
        return (host.fetch as (i: never, n: never) => Promise<Response>)(input, init as never);
      }) as never,
    });

    void bus;
    const { completed } = await consume(client, { runId: RUN, conversationId: CONVO });
    expect(sawPost).toBe(true);
    expect(completed).toBe(true);
    client.dispose();
  });
});

/** AC-3. */
describe("run errors", () => {
  it("surfaces a failed run through the client's own result errors", async () => {
    const { host, bus, eventLog } = await build();
    await eventLog.append({ tenantId: T1, event: event(1) });

    const client = await clientFor(host);
    const consuming = consume(client, { runId: RUN, conversationId: CONVO, after: 0 });

    await new Promise((r) => setTimeout(r, 30));
    await bus.publisher.publish(
      `conversation:${CONVO}`,
      event(2, "run.failed", {
        error: { code: "provider_unavailable", message: "provider down", retryable: true },
      }),
    );

    const { events, errors, completed } = await consuming;
    // #111's choice paying off: a failed run arrives as a `next` frame carrying both data and errors,
    // so the client reports it through its normal path *and* the event keeps its sequence. As a
    // protocol error frame it would have had no id, and resume past it would be impossible.
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toBe("provider down");
    expect(completed).toBe(true);
    client.dispose();
  });
});

/**
 * AC-4, and the finding that changes what it can mean.
 *
 * The client **never sends `Last-Event-ID`** — it is absent from its source entirely. On a broken
 * connection it retries with exponential backoff and **re-subscribes from the beginning**. So
 * "recovers with no lost or duplicated events" is not something this client does unaided: nothing is
 * lost, and everything already seen arrives again.
 */
describe("reconnect", () => {
  it("re-subscribes from the start rather than resuming from a cursor", async () => {
    const { host, eventLog } = await build();
    for (const n of [1, 2]) await eventLog.append({ tenantId: T1, event: event(n) });
    await eventLog.append({ tenantId: T1, event: event(3, "run.completed") });

    const seenCursors: (string | null)[] = [];
    const { createClient } = await import("graphql-sse");
    let attempt = 0;
    const client = createClient({
      url: "http://localhost/runs/events",
      retryAttempts: 2,
      retry: async () => undefined,
      fetchFn: (async (input: never, init: { headers?: Record<string, string>; body?: string }) => {
        attempt += 1;
        seenCursors.push(init?.headers?.["last-event-id"] ?? null);
        // Break the first attempt the way a dropped connection does.
        if (attempt === 1) throw new Error("connection reset");
        return (host.fetch as (i: never, n: never) => Promise<Response>)(input, init as never);
      }) as never,
    });

    const { events, completed } = await consume(client, { runId: RUN, conversationId: CONVO, after: 0 });

    expect(attempt).toBeGreaterThan(1); // it did retry
    // The finding, asserted rather than assumed: no Last-Event-ID on any attempt. A browser
    // `EventSource` would have sent one automatically; this client has no cursor to send.
    expect(seenCursors.every((c) => c === null)).toBe(true);
    // And it replayed the whole run, which is "no loss" and full duplication.
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(completed).toBe(true);
    client.dispose();
  });

  it("resumes exactly when the consumer supplies a cursor in variables", async () => {
    const { host, eventLog } = await build();
    for (const n of [1, 2, 3]) await eventLog.append({ tenantId: T1, event: event(n) });
    await eventLog.append({ tenantId: T1, event: event(4, "run.completed") });

    const client = await clientFor(host);
    // The accommodation, and the whole of AC-6: because the client will not resume for you, a consumer
    // that wants resume passes `after` itself. Supported by the route reading it from the operation
    // variables, which is exactly the shape a graphql-sse client already sends.
    const { events, completed } = await consume(client, {
      runId: RUN,
      conversationId: CONVO,
      after: 2,
    });

    expect(events.map((e) => e.sequence)).toEqual([3, 4]);
    expect(completed).toBe(true);
    client.dispose();
  });

  it("still honours Last-Event-ID for consumers that send it", async () => {
    const { host, eventLog } = await build();
    for (const n of [1, 2, 3]) await eventLog.append({ tenantId: T1, event: event(n) });
    await eventLog.append({ tenantId: T1, event: event(4, "run.completed") });

    // A browser EventSource sends this automatically; the header path must keep working for it even
    // though the graphql-sse client never uses it.
    const response = await host.fetch(
      `http://localhost/runs/events?runId=${RUN}&conversationId=${CONVO}`,
      { headers: { "last-event-id": "2" } },
    );
    const text = await new Response(response.body).text();
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([3, 4]);
  });

  it("prefers Last-Event-ID over a variables cursor when both are present", async () => {
    const { host, eventLog } = await build();
    for (const n of [1, 2, 3]) await eventLog.append({ tenantId: T1, event: event(n) });
    await eventLog.append({ tenantId: T1, event: event(4, "run.completed") });

    // The header wins because it is the transport's own mechanism and reflects what the client actually
    // received; a stale `after` baked into a retried operation would otherwise replay delivered events.
    const response = await host.fetch("http://localhost/runs/events", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": "3" },
      body: JSON.stringify({
        query: SUBSCRIPTION,
        variables: { runId: RUN, conversationId: CONVO, after: 0 },
      }),
    });
    const text = await new Response(response.body).text();
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([4]);
  });
});
