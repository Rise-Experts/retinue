/**
 * The documentation tools are wired, and they reach an MCP client — REQ #291.
 *
 * `toolkit/__tests__/docs.test.ts` proves the reader reads. It cannot prove anything *serves* it, and this
 * repository has now been bitten twice by exactly that gap: a capability that is built, tested and connected to
 * nothing (`shareflow-unconnected-family`, and #288's absent listener). The whole point of this feature is that
 * a client can call it, so the last assertion here goes through the real MCP `tools/list` handler.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { asId } from "../../../core/ids.js";
import type { ExecutionContext } from "../../../core/context.js";
import type { TenantId } from "../../../core/ids.js";
import { createAuthorizationPolicy } from "../../../authorization/index.js";
import { createMemoryIdempotencyStore } from "../../../adapters/memory/index.js";
import { createStandardToolProvider } from "../index.js";
import { createToolRegistry } from "../../registry.js";
import { registerRetinueTools } from "../../../mcp-server/index.js";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "docs");

const T = asId<TenantId>("t1");
const context: ExecutionContext = {
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [asId("reader")],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
};

const authorization = createAuthorizationPolicy({
  roles: [
    {
      roleId: "reader",
      permissions: [
        { action: "execute", resourceType: "tool" },
        { action: "read", resourceType: "*" },
      ],
      tools: ["docs_list", "docs_search", "docs_read"],
    },
  ] as never,
});

const deps = () => ({ authorization, idempotency: createMemoryIdempotencyStore(), approvals: { isAllowed: async () => true } as never });
const provider = (over: Record<string, unknown> = {}) => createStandardToolProvider({ deps: deps(), ...over } as never);

describe("wiring", () => {
  it("the three tools are absent until a docs root is configured", async () => {
    // The same rule as `fs_*` and `shell_exec`: wiring is the switch, and an unconfigured tool is absent rather
    // than present-and-failing. A client that cannot see a tool cannot be tempted by it.
    const names = (await provider().listTools(context)).map((t) => t.descriptor.name);
    expect(names).not.toContain("docs_list");
    expect(names).not.toContain("docs_search");
    expect(names).not.toContain("docs_read");
  });

  it("all three appear once a root is configured", async () => {
    const names = (await provider({ docs: { root: DOCS } }).listTools(context)).map((t) => t.descriptor.name);
    expect(names).toEqual(expect.arrayContaining(["docs_list", "docs_search", "docs_read"]));
  });

  it("they are reads, so nothing about documentation is gated behind an approval", async () => {
    // An approval prompt on every documentation read is one people click through, and that habit is what makes
    // the approval on a write worthless.
    const tools = await provider({ docs: { root: DOCS } }).listTools(context);
    for (const name of ["docs_list", "docs_search", "docs_read"]) {
      const tool = tools.find((t) => t.descriptor.name === name);
      expect(tool?.descriptor.effect).toBe("read");
    }
  });
});

describe("through the registry", () => {
  const registry = () =>
    createToolRegistry({ ...deps(), providers: [provider({ docs: { root: DOCS } })] } as never);

  it("docs_list returns the table of contents, with titles", async () => {
    const outcome = await registry().execute(context, { name: "docs_list", input: {} });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { docs: { path: string; title: string }[] };
    expect(data.docs.length).toBeGreaterThan(20);
    expect(data.docs.some((d) => d.title === "Retrieval Quality, Measured")).toBe(true);
  });

  it("docs_read returns one section", async () => {
    const outcome = await registry().execute(context, {
      name: "docs_read",
      input: { path: "26-retrieval-quality.md", section: "Result" },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as { heading: string }).heading).toBe("Result");
  });
});

describe("through MCP, which is the point", () => {
  /** The smallest thing `registerRetinueTools` will accept: it records the two handlers it is given. */
  const server = () => {
    const handlers = new Map<unknown, (request: unknown) => Promise<Record<string, unknown>>>();
    return {
      handlers,
      setRequestHandler: (schema: unknown, handler: (request: unknown) => Promise<Record<string, unknown>>) => {
        handlers.set(schema, handler);
      },
    };
  };

  it("a client listing tools sees the documentation tools, with their schemas", async () => {
    const listTools = Symbol("list");
    const callTool = Symbol("call");
    const s = server();
    registerRetinueTools(s as never, { listTools, callTool }, {
      registry: createToolRegistry({ ...deps(), providers: [provider({ docs: { root: DOCS } })] } as never),
      context,
    } as never);

    const listed = (await (s.handlers.get(listTools) as (r: unknown) => Promise<{ tools: { name: string; inputSchema: unknown }[] }>)({})) as {
      tools: { name: string; inputSchema: unknown }[];
    };
    const names = listed.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["docs_list", "docs_search", "docs_read"]));
    // A tool advertised without a schema is one a client cannot call correctly.
    expect(listed.tools.find((t) => t.name === "docs_read")?.inputSchema).toBeTruthy();
  });

  it("a client calling docs_search gets matches carrying their heading", async () => {
    const listTools = Symbol("list");
    const callTool = Symbol("call");
    const s = server();
    registerRetinueTools(s as never, { listTools, callTool }, {
      registry: createToolRegistry({ ...deps(), providers: [provider({ docs: { root: DOCS } })] } as never),
      context,
    } as never);

    const result = (await (s.handlers.get(callTool) as (r: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)({
      params: { name: "docs_search", arguments: { query: "navigate (no vectors)" } },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}") as { matches: { heading?: string; title: string }[] };
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches[0]?.title).toBe("Retrieval Quality, Measured");
    expect(data.matches[0]?.heading).toBeTruthy();
  });
});
