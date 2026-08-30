/**
 * The inbound MCP server — REQ-059 (#249), task #250.
 *
 * `backend/src/mcp/` is the outbound direction, and its header points at an inbound server that lives in the
 * *old Chorus repository*. So this package could consume an MCP server and could not be one, and a deployment
 * was unreachable from Claude Code, Cursor and everything else that speaks MCP.
 *
 * The tests that matter are the trust ones. Outbound, `mcp/index.ts` says a remote server's hints are advisory
 * and untrusted and "a remote server cannot talk its way down to" a weaker effect. Inbound, this package **is**
 * the remote server, so the obligation is the mirror image: advertise only what is enforced, and trust nothing
 * the client sends.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { TOOL_EFFECTS, type ToolDescriptor, type ToolEffect, type Tool, type ToolProvider } from "../../tools/index.js";
import { createToolRegistry } from "../../tools/registry.js";
import { annotationsFor, describeForMcp, registerRetinueTools, toMcpResult } from "../index.js";

const ctx = (tenant: string, excluded: readonly string[] = []): ExecutionContext => ({
  tenantId: asId<TenantId>(tenant),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  runId: asId<RunId>("run1"),
  ...(excluded.length === 0 ? {} : { agentToolPolicy: { preloaded: [], categories: [], excluded } }),
});

const descriptor = (name: string, over: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  label: name,
  description: `the ${name} tool`,
  category: "general",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  outputSchema: {},
  effect: "read",
  approvalPolicy: "never",
  requiresIdempotencyKey: false,
  ...over,
});

const ran: string[] = [];
const provider = (descriptors: readonly ToolDescriptor[]): ToolProvider => ({
  id: "test",
  async listTools(): Promise<readonly Tool[]> {
    return descriptors.map((d) => ({
      descriptor: d,
      execute: async () => {
        ran.push(d.name);
        return { ok: true as const, data: { did: d.name } };
      },
    }));
  },
});

const allowAll = {
  async can() {
    return { allow: true as const };
  },
  async filterTools(_c: ExecutionContext, tools: readonly ToolDescriptor[]) {
    return tools;
  },
  async scope(context: ExecutionContext) {
    return { tenantId: String(context.tenantId), roleIds: [] };
  },
};

/** A stand-in for the SDK's `Server`, capturing the two handlers. */
const fakeServer = () => {
  const handlers = new Map<string, (request: never) => Promise<unknown>>();
  return {
    server: {
      setRequestHandler(schema: unknown, handler: (request: never) => Promise<unknown>) {
        handlers.set(schema as string, handler);
      },
      async connect() {},
    },
    list: () => handlers.get("list")!({} as never),
    call: (name: string, args: unknown = {}) =>
      handlers.get("call")!({ params: { name, arguments: args } } as never),
  };
};

const SCHEMAS = { listTools: "list", callTool: "call" };

const wire = (descriptors: readonly ToolDescriptor[], context: ExecutionContext) => {
  const registry = createToolRegistry({ providers: [provider(descriptors)], authorization: allowAll });
  const fake = fakeServer();
  registerRetinueTools(fake.server, SCHEMAS, { registry, context });
  return fake;
};

describe("what it advertises is what it enforces — AC-7", () => {
  it("derives every annotation from the effect, in one place", () => {
    // One mapping, so the advertised hint and the enforced effect cannot drift. Two tables would be two chances
    // to disagree, and the disagreement would be a client told a tool is read-only calling something that writes.
    expect(annotationsFor("read")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(annotationsFor("internal-write")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(annotationsFor("external-write")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(annotationsFor("destructive")).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("claims read-only for exactly one effect, and never over-claims", () => {
    // Over-claiming read-only is the dangerous direction: a client may skip a confirmation on it. An exact list
    // over the closed union, so a fifth effect cannot default into `readOnlyHint: true`.
    const readOnly = TOOL_EFFECTS.filter((e) => annotationsFor(e).readOnlyHint);
    expect(readOnly).toEqual(["read"]);
    const destructive = TOOL_EFFECTS.filter((e: ToolEffect) => annotationsFor(e).destructiveHint);
    expect(destructive).toEqual(["destructive"]);
  });

  it("advertises the registry's own schema, not a copy", async () => {
    // It is what execution validates against, so advertising anything else would be advertising a contract
    // nothing enforces.
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const fake = wire([descriptor("search", { inputSchema: schema })], ctx("t1"));
    const listed = (await fake.list()) as { tools: readonly { inputSchema: unknown }[] };
    expect(listed.tools[0]?.inputSchema).toEqual(schema);
  });

  it("every listed tool's annotation matches its effect", async () => {
    const descriptors = TOOL_EFFECTS.map((effect) =>
      descriptor(`tool_${effect.replace("-", "_")}`, { effect, requiresIdempotencyKey: false, approvalPolicy: "never" }),
    );
    const fake = wire(descriptors, ctx("t1"));
    const listed = (await fake.list()) as { tools: readonly { name: string; annotations: { readOnlyHint: boolean } }[] };
    for (const tool of listed.tools) {
      const source = descriptors.find((d) => d.name === tool.name);
      if (source) expect(tool.annotations).toEqual(annotationsFor(source.effect));
    }
  });
});

describe("the caller's toolset, never the whole registry — AC-2", () => {
  it("lists only what this principal is authorized for", async () => {
    const registry = createToolRegistry({
      providers: [provider([descriptor("alpha"), descriptor("secret")])],
      authorization: {
        ...allowAll,
        async filterTools(_c: ExecutionContext, tools: readonly ToolDescriptor[]) {
          return tools.filter((t) => t.name !== "secret");
        },
      },
    });
    const fake = fakeServer();
    registerRetinueTools(fake.server, SCHEMAS, { registry, context: ctx("t1") });
    const listed = (await fake.list()) as { tools: readonly { name: string }[] };
    expect(listed.tools.map((t) => t.name)).toEqual(["alpha"]);
  });

  it("refuses a tool the caller cannot see, even called by exact name", async () => {
    // The sabotage: a client that already knows the name. Discovery filtering that execution does not repeat is
    // not a boundary, and a client is exactly the caller most likely to have seen a name elsewhere.
    ran.length = 0;
    const registry = createToolRegistry({
      providers: [provider([descriptor("alpha"), descriptor("secret")])],
      authorization: {
        ...allowAll,
        async filterTools(_c: ExecutionContext, tools: readonly ToolDescriptor[]) {
          return tools.filter((t) => t.name !== "secret");
        },
      },
    });
    const fake = fakeServer();
    registerRetinueTools(fake.server, SCHEMAS, { registry, context: ctx("t1") });
    const result = (await fake.call("secret")) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(ran).toEqual([]);
  });

  it("honours the agent's tool policy, so an excluded tool is unreachable here too", async () => {
    ran.length = 0;
    const fake = wire([descriptor("alpha"), descriptor("dangerous")], ctx("t1", ["dangerous"]));
    const listed = (await fake.list()) as { tools: readonly { name: string }[] };
    expect(listed.tools.map((t) => t.name)).not.toContain("dangerous");
    expect(((await fake.call("dangerous")) as { isError?: boolean }).isError).toBe(true);
    expect(ran).toEqual([]);
  });
});

describe("a gated tool does not execute — AC-3", () => {
  it("refuses a tool requiring approval and does not perform the side effect", async () => {
    ran.length = 0;
    const fake = wire(
      [descriptor("publish", { effect: "external-write", approvalPolicy: "always", requiresIdempotencyKey: true })],
      ctx("t1"),
    );
    const result = (await fake.call("publish", { q: "x" })) as { isError?: boolean; content: readonly { text: string }[] };
    expect(result.isError).toBe(true);
    // The assertion that matters: the gate is not advisory.
    expect(ran).toEqual([]);
  });
});

describe("a refusal is a tool error, not a protocol error", () => {
  it("returns isError with the reason as text", () => {
    // A protocol error tells the client the server is broken; a tool refusal is a normal outcome the model
    // should see and respond to. Same decision `streamModelTurn` makes for `tool-error`.
    const refused = toMcpResult({ ok: false, error: { code: "forbidden", message: "not yours" } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toBe("forbidden: not yours");
  });

  it("returns the data as text on success", () => {
    const ok = toMcpResult({ ok: true, data: { hits: 2 } });
    expect((ok as { isError?: boolean }).isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text)).toEqual({ hits: 2 });
  });

  it("does not trust an unknown tool name into an exception", async () => {
    const fake = wire([descriptor("alpha")], ctx("t1"));
    expect(((await fake.call("nope")) as { isError?: boolean }).isError).toBe(true);
  });
});

describe("nothing the client sends is trusted", () => {
  it("ignores an effect or annotation the client supplies", async () => {
    // The mirror of the outbound rule: "a remote server cannot talk its way down to" a weaker effect. Here the
    // *client* cannot talk its way past the gate by claiming the tool is read-only.
    ran.length = 0;
    const fake = wire(
      [descriptor("publish", { effect: "external-write", approvalPolicy: "always", requiresIdempotencyKey: true })],
      ctx("t1"),
    );
    const result = (await fake.call("publish", {
      q: "x",
      annotations: { readOnlyHint: true },
      effect: "read",
      approved: true,
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(ran).toEqual([]);
  });

  it("validates arguments against the advertised schema", async () => {
    const fake = wire([descriptor("search", { inputSchema: z.object({ q: z.string() }) })], ctx("t1"));
    expect(((await fake.call("search", { q: 42 })) as { isError?: boolean }).isError).toBe(true);
  });
});

describe("describeForMcp", () => {
  it("falls back to an object schema rather than advertising nothing", () => {
    // A tool with no schema would otherwise be advertised with `inputSchema: undefined`, which some clients
    // reject outright and others read as "takes anything".
    expect(describeForMcp(descriptor("x", { inputSchema: undefined })).inputSchema).toEqual({ type: "object" });
  });
});
