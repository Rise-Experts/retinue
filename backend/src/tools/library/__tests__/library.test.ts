/**
 * The standard tool provider — REQ-039 (#188).
 *
 * Two claims worth holding down here, because both are the kind that quietly stop being true:
 *
 * 1. **Wiring is the toggle.** A tool exists when its dependency was supplied, and not otherwise. The failure
 *    this prevents is a tool that is enabled and unwired — the "built, tested and unreachable" shape this repo
 *    keeps finding (#157, #159, #161, #163, #165, #185).
 * 2. **Effect classification is structural.** `http_write` cannot become un-gated by anyone editing a
 *    description, and `http_request` cannot send a mutating method, because its schema has no field for one.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STANDARD_TOOL_NAMES, createStandardToolProvider } from "../index.js";
import { createToolRegistry } from "../../registry.js";
import { createAuthorizationPolicy } from "../../../authorization/index.js";
import type { DelegatingToolDeps } from "../../delegating.js";
import type { ExecutionContext } from "../../../core/context.js";

/**
 * The real authorization policy, granting every standard tool to one role.
 *
 * Deliberately not `{ can: async () => true }`: a stub that always says yes passes whether or not the tools are
 * reachable through the real policy at all, which is the thing this file is trying to prove.
 */
const policy = createAuthorizationPolicy({
  roles: [{ roleId: "operator", permissions: [], tools: [...STANDARD_TOOL_NAMES] }],
});

const deps: DelegatingToolDeps = { authorization: policy };

const context = {
  tenantId: "t1",
  principalId: "p1",
  roleIds: ["operator"],
  locale: "en",
  timezone: "UTC",
  requestId: "r1",
} as unknown as ExecutionContext;

const names = async (config: Parameters<typeof createStandardToolProvider>[0], ctx = context) =>
  (await createStandardToolProvider(config).listTools(ctx)).map((t) => t.descriptor.name).sort();

describe("wiring is the toggle", () => {
  it("ships the tools that need nothing, with nothing wired", async () => {
    expect(await names({ deps })).toEqual(["calculate", "now", "parse_csv", "query_json"]);
  });

  it("adds the web tools only when an HTTP client is wired", async () => {
    const withHttp = await names({ deps, http: {} });
    expect(withHttp).toContain("fetch_url");
    expect(withHttp).toContain("fetch_json");
    expect(withHttp).toContain("http_request");
    expect(withHttp).toContain("http_write");
    // No provider configured, so there is no search tool at all rather than one that always refuses. A tool
    // that can only say "not configured" costs a model a turn to discover that.
    expect(withHttp).not.toContain("web_search");
  });

  it("adds web_search only when a provider is configured", async () => {
    const provider = { name: "test", endpoint: (q: string) => `https://search.example/?q=${q}`, parse: () => [] };
    expect(await names({ deps, http: {}, search: provider })).toContain("web_search");
    // And not without the client to run it through: a search provider with no egress-checked client is a
    // half-wiring, and half is the one that reads as working.
    expect(await names({ deps, search: provider })).not.toContain("web_search");
  });

  it("adds sql_query with a connection, and sql_schema only when schemas are named", async () => {
    const query = (async () => []) as never;
    const withoutSchemas = await names({ deps, sql: { query, readOnly: true } });
    expect(withoutSchemas).toContain("sql_query");
    expect(withoutSchemas).not.toContain("sql_schema");
    expect(await names({ deps, sql: { query, readOnly: true, schemas: ["app"] } })).toContain("sql_schema");
  });

  it("adds list_attachments only where the context has a conversation", async () => {
    const files = {} as never;
    expect(await names({ deps, files })).toContain("read_attachment");
    // A headless automation has no conversation to scope it to, so the tool does not exist for that run.
    expect(await names({ deps, files })).not.toContain("list_attachments");
    const withConversation = await names({ deps, files }, { ...context, conversationId: "c1" } as ExecutionContext);
    expect(withConversation).toContain("list_attachments");
  });

  it("excludes by name, and refuses a name that is not a tool", async () => {
    expect(await names({ deps, exclude: ["calculate"] })).not.toContain("calculate");
    // A typo in an exclusion is otherwise a tool that stays on while the deployment believes it is off.
    expect(() => createStandardToolProvider({ deps, exclude: ["calculater" as never] })).toThrow(/not a standard tool/);
  });

  it("lists every declared name across a fully wired provider", async () => {
    const query = (async () => []) as never;
    // A real directory pair for the filesystem tools, and a sandbox that runs nothing: this test is about the
    // *list*, and a tool that cannot be built is what it exists to catch.
    const root = mkdtempSync(join(tmpdir(), "retinue-library-read-"));
    const writable = mkdtempSync(join(tmpdir(), "retinue-library-write-"));
    const wired = await names(
      {
        deps,
        http: {},
        search: { name: "s", endpoint: () => "https://s.example/", parse: () => [] },
        sql: { query, readOnly: true, schemas: ["app"] },
        knowledge: { retriever: { retrieve: async () => ({ found: false, reason: "no-match", message: "", mode: "hybrid" }) }, authSubjects: () => [] },
        files: {} as never,
        documents: {} as never,
        filesystem: { root, writableRoot: writable },
        sandbox: { id: "test", run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 0 }) },
        shellEnabled: () => true,
      },
      { ...context, conversationId: "c1" } as ExecutionContext,
    );
    // If this fails, either a tool was added without being declared or a declared one cannot be built —
    // both of which are the list and the reality disagreeing.
    expect(wired).toEqual([...STANDARD_TOOL_NAMES].sort());
  });
});

describe("effect classification is structural", () => {
  const descriptors = async () => {
    const tools = await createStandardToolProvider({
      deps,
      http: {},
      sql: { query: (async () => []) as never, readOnly: true },
    }).listTools(context);
    return new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
  };

  it("gates http_write, with an idempotency key required, and does not gate the reads", async () => {
    const map = await descriptors();
    expect(map.get("http_write")?.effect).toBe("external-write");
    // Both come from `defineTool`'s defaults for the effect, so they cannot drift apart from it.
    expect(map.get("http_write")?.approvalPolicy).toBe("always");
    expect(map.get("http_write")?.requiresIdempotencyKey).toBe(true);

    for (const name of ["fetch_url", "fetch_json", "http_request", "sql_query", "parse_csv", "now"]) {
      expect(map.get(name)?.effect, name).toBe("read");
      expect(map.get(name)?.approvalPolicy, name).toBe("never");
    }
  });

  it("gives http_request no way to name a mutating method", async () => {
    // The reason this is two tools rather than one with a `method` argument: the registry classifies by tool,
    // before it has seen the arguments, so a single tool could only be gated for every call or for none.
    const map = await descriptors();
    const schema = map.get("http_request")?.inputSchema as { safeParse?: (v: unknown) => { success: boolean } };
    expect(schema?.safeParse?.({ url: "https://example.com", method: "POST" })?.success).toBe(false);
    expect(schema?.safeParse?.({ url: "https://example.com", method: "GET" })?.success).toBe(true);
  });

  it("gives neither HTTP tool a field for a credential", async () => {
    const map = await descriptors();
    for (const name of ["http_request", "http_write"]) {
      const schema = map.get(name)?.inputSchema as { safeParse?: (v: unknown) => { success: boolean } };
      // `headers` exists, but the client strips authorization and cookie from it — asserted in the client's
      // own tests. What is asserted here is that no *dedicated* credential field was ever added.
      const shape = JSON.stringify(Object.keys((schema as unknown as { shape?: object })?.shape ?? {}));
      expect(shape).not.toMatch(/token|apiKey|api_key|credential|secret|auth\b/i);
    }
  });

  it("names every tool it delegates to", async () => {
    // `delegatesTo` is required by the envelope, and its value is what makes "which function does this wrap"
    // answerable in review rather than by reading the body.
    const map = await descriptors();
    for (const [name, descriptor] of map) {
      if (["read_attachment", "list_attachments", "read_document"].includes(name)) continue; // plain tools
      expect(descriptor.delegatesTo, name).toBeTruthy();
    }
  });
});

/**
 * Through the registry, which is where "by construction" is either true or a claim.
 *
 * The AC says every external write routes through approval and idempotency **by construction rather than by the
 * author remembering**. The tests above assert the descriptor says so; these assert the runtime acts on it —
 * including the case that matters most, which is the deployment that forgot to wire the gate.
 */
describe("the gate holds at execution", () => {
  const registryFor = async (over: Partial<Parameters<typeof createToolRegistry>[0]> = {}) => {
    const provider = createStandardToolProvider({ deps, http: { fetchImpl: neverCalled } });
    return createToolRegistry({
      providers: [provider],
      authorization: policy,
      ...over,
    });
  };

  let sent: string[] = [];
  const neverCalled = (async (url: string) => {
    sent.push(String(url));
    return { status: 200, headers: new Headers(), body: null, text: async () => "ok" } as unknown as Response;
  }) as unknown as typeof fetch;

  it("refuses an unapproved external write, and does not send the request", async () => {
    sent = [];
    // No `approval` and no `idempotency`: the shape of a deployment that wired the tools and forgot the gate.
    const registry = await registryFor();
    const result = await registry.execute(context, {
      name: "http_write",
      input: { url: "https://example.com/orders", method: "POST", body: "{}" },
      toolCallId: "call-1",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("capability_unavailable");
    // The refusal is what makes the classification real. A message about wiring while the POST went out
    // anyway would be the worst of both.
    expect(sent).toEqual([]);
  });

  it("lets an unGated read through the same registry", async () => {
    sent = [];
    const registry = await registryFor();
    const result = await registry.execute(context, {
      name: "http_request",
      input: { url: "https://example.com/thing" },
      toolCallId: "call-2",
    });
    expect(result.ok).toBe(true);
    expect(sent).toEqual(["https://example.com/thing"]);
  });
});
