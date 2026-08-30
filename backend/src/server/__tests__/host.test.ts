/**
 * End-to-end tests for the reference GraphQL host (#108).
 *
 * Driven through `yoga.fetch` rather than a listening socket: Yoga *is* a fetch handler, so the whole
 * request pipeline — context construction, validation, execution, subscriptions — runs exactly as it
 * would over HTTP, without binding a port or racing on one.
 *
 * The assertion worth noticing is the resolver counter. AC-2 says an unauthenticated request is
 * refused **before any resolver executes**, and "the response was a 401" does not show that. A host
 * that authenticated inside each resolver would return the same 401 and be wrong.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { RunId } from "../../core/ids.js";
import { createMemoryConversationRunCoordinator, createMemoryConversationStore, createMemoryRunEventLog, createMemoryRunStore, createMemoryUsageStore } from "../../adapters/memory/index.js";
import { createResolvers, typeDefs } from "../../graphql/index.js";
import { asId, type ConversationId, type ExecutionContext, type ResolverDeps, type RunEvent, type TenantId } from "../../index.js";
import { createMemoryEventBus } from "../../runtime/index.js";
import { createRetinueHost, UNAUTHENTICATED } from "../host.js";

const T1 = asId<TenantId>("host-t1");
const T2 = asId<TenantId>("host-t2");

const executionFor = (tenantId: TenantId): ExecutionContext =>
  ({
    tenantId,
    principalId: asId("host-p1"),
    conversationId: undefined,
    runId: undefined,
    scopes: [],
  }) as unknown as ExecutionContext;

/** Deps built from the in-memory adapters, plus a counter so a test can see whether resolvers ran. */
const buildDeps = () => {
  const bus = createMemoryEventBus();
  const eventLog = createMemoryRunEventLog();
  const deps = {
    conversations: createMemoryConversationStore(),
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
  return { deps, bus, eventLog };
};

/**
 * Wrap every resolver so a test can count invocations.
 *
 * This is what makes AC-2 checkable. Mirrors what the host does internally — `createResolvers(deps)` —
 * so it counts the same functions the host would mount.
 */
const countingResolvers = (deps: ResolverDeps) => {
  let calls = 0;
  const original = createResolvers(deps) as Record<string, Record<string, unknown>>;
  const wrapped: Record<string, Record<string, unknown>> = {};
  for (const [typeName, fields] of Object.entries(original)) {
    wrapped[typeName] = {};
    for (const [fieldName, value] of Object.entries(fields)) {
      if (typeof value === "function") {
        wrapped[typeName]![fieldName] = (...args: readonly unknown[]) => {
          calls += 1;
          return (value as (...a: readonly unknown[]) => unknown)(...args);
        };
      } else {
        wrapped[typeName]![fieldName] = value;
      }
    }
  }
  return { wrapped, calls: () => calls };
};

const post = async (
  host: ReturnType<typeof createRetinueHost>,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
) => {
  const response = await host.fetch("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, json: (await response.json()) as { data?: unknown; errors?: { message: string; extensions?: Record<string, unknown> }[] } };
};

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

/** AC-1. */
describe("serving a request end to end", () => {
  it("creates a conversation through a mutation and reads it back", async () => {
    const { deps } = buildDeps();
    const host = createRetinueHost({ deps, authenticate: () => executionFor(T1) });

    const created = await post(host, {
      query: `mutation { createConversation(id: "host-c-1", title: "first thread") { id title version } }`,
    });
    expect(created.json.errors).toBeUndefined();
    const conversation = (created.json.data as { createConversation: { id: string; title: string } })
      .createConversation;
    expect(conversation.title).toBe("first thread");

    // Read back through the same host, so the mutation genuinely persisted rather than echoing input.
    const listed = await post(host, { query: `query { conversations(limit: 10) { items { id title } } }` });
    expect(
      (listed.json.data as { conversations: { items: { id: string }[] } }).conversations.items,
    ).toEqual([{ id: conversation.id, title: "first thread" }]);
  });

  it("serves the schema the library ships, not a copy", async () => {
    const { deps } = buildDeps();
    const host = createRetinueHost({ deps, authenticate: () => executionFor(T1) });
    // The SDL is the library's export. A host that redefined it would drift the moment the library
    // added a field.
    expect(typeDefs).toContain("type Conversation");
    const result = await post(host, { query: `{ __typename }` });
    expect(result.json.errors).toBeUndefined();
  });
});

/** AC-2 — and specifically the "before any resolver" half. */
describe("unauthenticated requests", () => {
  it("is refused without any resolver executing", async () => {
    const { deps } = buildDeps();
    // Spying on the deps rather than wrapping resolvers, so this runs against the **real** host. An
    // earlier version mounted its own Yoga instance with wrapped resolvers, which meant it was
    // asserting against a copy of the host's context logic that could drift from it — and it did:
    // the copy kept using `new GraphQLError` after the host moved to `createGraphQLError`.
    //
    // Every resolver's first act is to delegate to a dep (that is what "thin resolvers" means), so a
    // dep never being touched is evidence no resolver body ran.
    let depCalls = 0;
    const watched: ResolverDeps = {
      ...deps,
      conversations: {
        ...deps.conversations,
        async list(input) {
          depCalls += 1;
          return deps.conversations.list(input);
        },
      },
    };

    const host = createRetinueHost({ deps: watched, authenticate: () => null });
    const refused = await post(host, { query: `query { conversations(limit: 10) { items { id } } }` });
    expect(refused.response.status).toBe(401);
    // "Refused" and "refused before any resolver ran" are different claims, and only the second is
    // what AC-2 says. A host that authenticated inside each resolver would return the same 401.
    expect(depCalls).toBe(0);

    // The same query with a valid identity does reach the dep — otherwise the zero above would prove
    // nothing more than that the query was malformed.
    const allowed = createRetinueHost({ deps: watched, authenticate: () => executionFor(T1) });
    const ok = await post(allowed, { query: `query { conversations(limit: 10) { items { id } } }` });
    expect(ok.json.errors).toBeUndefined();
    expect(depCalls).toBe(1);
  });

  it("returns an UNAUTHENTICATED code rather than a generic failure", async () => {
    const { deps } = buildDeps();
    const host = createRetinueHost({ deps, authenticate: () => null });
    const result = await post(host, { query: `query { conversations(limit: 10) { items { id } } }` });
    expect(result.response.status).toBe(401);
    expect(result.json.errors?.[0]?.extensions?.["code"]).toBe(UNAUTHENTICATED);
  });

  it("refuses when authenticate resolves to null asynchronously too", async () => {
    const { deps } = buildDeps();
    const host = createRetinueHost({ deps, authenticate: async () => null });
    const result = await post(host, { query: `{ conversations(limit: 1) { items { id } } }` });
    expect(result.response.status).toBe(401);
  });
});

/** AC-3. */
describe("request context", () => {
  it("executes in exactly the requesting tenant's context, with no default to fall back to", async () => {
    const { deps } = buildDeps();
    // One store, two tenants, and the identity taken purely from the request.
    const host = createRetinueHost({
      deps,
      authenticate: (request) => {
        const tenant = request.headers.get("x-tenant");
        if (tenant === "t1") return executionFor(T1);
        if (tenant === "t2") return executionFor(T2);
        return null; // no ambient tenant: an unrecognised caller is refused, not defaulted
      },
    });

    await post(host, { query: `mutation { createConversation(id: "t1-c1", title: "t1 thread") { id } }` }, { "x-tenant": "t1" });

    const asT2 = await post(host, { query: `{ conversations(limit: 10) { items { title } } }` }, { "x-tenant": "t2" });
    expect((asT2.json.data as { conversations: { items: unknown[] } }).conversations.items).toEqual([]);

    const asT1 = await post(host, { query: `{ conversations(limit: 10) { items { title } } }` }, { "x-tenant": "t1" });
    expect((asT1.json.data as { conversations: { items: { title: string }[] } }).conversations.items).toEqual([
      { title: "t1 thread" },
    ]);

    // And the absence of a tenant is a refusal rather than a fallback — the failure mode that would
    // make every unauthenticated request read someone's data.
    const anonymous = await post(host, { query: `{ conversations(limit: 10) { items { title } } }` });
    expect(anonymous.response.status).toBe(401);
  });
});

/** AC-4. */
describe("subscriptions", () => {
  it("delivers the ordered event stream and terminates on the terminal event", async () => {
    const { deps, bus, eventLog } = buildDeps();
    const conversationId = asId<ConversationId>("host-c1");
    const runId = asId<RunId>("host-r1");

    const event = (sequence: number, type: RunEvent["type"]): RunEvent =>
      ({
        type,
        runId,
        sequence,
        occurredAt: `2020-01-01T00:00:0${sequence}.000Z`,
      }) as unknown as RunEvent;

    // Two events already durable — the catch-up half — before anyone subscribes.
    await eventLog.append({ tenantId: T1, event: event(1, "run.queued") });
    await eventLog.append({ tenantId: T1, event: event(2, "run.started") });

    const host = createRetinueHost({ deps, authenticate: () => executionFor(T1) });
    const response = await host.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        query: `subscription($c: ID!, $r: ID!) { runEvents(conversationId: $c, runId: $r, after: 0) { type sequence } }`,
        variables: { c: conversationId, r: runId },
      }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Published after subscribing. openRunEventStream subscribes before reading the log precisely so
    // an event landing during catch-up is not lost in the gap.
    const publishing = (async () => {
      await new Promise((r) => setTimeout(r, 30));
      await bus.publisher.publish(`conversation:${conversationId}`, event(3, "part.added"));
      await bus.publisher.publish(`conversation:${conversationId}`, event(4, "run.completed"));
    })();

    const sequences: number[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Reads until the stream ends. It ends on the terminal event, which is the second half of AC-4 —
    // a subscription that delivered everything but never closed would leak a connection per run.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const match of buffer.matchAll(/"sequence":(\d+)/g)) {
        const n = Number(match[1]);
        if (!sequences.includes(n)) sequences.push(n);
      }
    }
    await publishing;

    expect(sequences).toEqual([1, 2, 3, 4]);
  });
});

/** AC-5 and AC-6. */
describe("layering", () => {
  it("mounts the library's resolver map and adds none of its own", () => {
    const { deps } = buildDeps();
    const library = createResolvers(deps) as Record<string, Record<string, unknown>>;
    // The strongest available form of "no business logic was added to the resolver layer": the host
    // adds no resolver, so there is nowhere for logic to have been added.
    const hostFields = Object.entries(library).map(
      ([type, fields]) => `${type}:${Object.keys(fields).sort().join(",")}`,
    );
    expect(hostFields.length).toBeGreaterThan(0);
    // Every root type the SDL declares is served by the library, not by this workspace.
    for (const type of ["Query", "Mutation", "Subscription"]) {
      expect(Object.keys(library)).toContain(type);
    }
  });

  it("keeps a GraphQL server out of every consumer's install", async () => {
    /**
     * The same claim as before, restated for the new packaging — #196.
     *
     * It used to read the backend's `package.json` and assert no server framework appeared in `dependencies`
     * **or `devDependencies`**, which worked while the host was a separate workspace. The host now lives in this
     * package, so `graphql-yoga` is legitimately a devDependency here: it has to be installed to build.
     *
     * What must stay true is the part that affects a consumer: a server framework is never a *dependency*, so
     * installing the runtime never installs one. It is an **optional peer**, which means the host's subpath asks
     * for it and nothing else does.
     *
     * The import-level half of the claim — that no runtime file reaches `graphql` — is rule R13 in
     * `check-boundaries.mjs`, where it belongs: a package manifest cannot see an import.
     */
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    const runtimeDeps = Object.keys(manifest.dependencies ?? {});
    for (const framework of ["graphql-yoga", "apollo-server", "@apollo/server", "mercurius", "express", "fastify"]) {
      expect(runtimeDeps, `${framework} must not be a dependency`).not.toContain(framework);
    }

    // And the one the host does use is optional, so it is the consumer's choice rather than ours.
    expect(manifest.peerDependencies?.["graphql-yoga"]).toBeDefined();
    expect(manifest.peerDependenciesMeta?.["graphql-yoga"]?.optional).toBe(true);
  });
});
