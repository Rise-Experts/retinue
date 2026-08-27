/**
 * `AgentManifest.toolPolicy.excluded` is a permission, enforced on every path — REQ-057 (#242), task #244 AC-4.
 *
 * The field read as a security control and enforced nothing: no code anywhere consumed `toolPolicy`, so an
 * operator writing `excluded: ["github_merge_pull_request"]` got no enforcement and no error. It shipped that way
 * in 0.2.0.
 *
 * Enforcing it only where the catalogue is built would be the shallow fix, and it is bypassed by the first caller
 * who already knows the tool's name — which includes a model that saw the name in an earlier turn, and every
 * route through `execute_tool`, `learn_tools` and `find_tools`. So the tests below call an excluded tool through
 * *every* path that can reach a tool and assert each one refuses. That breadth is the AC.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { createToolRegistry } from "../registry.js";
import type { Tool, ToolDescriptor, ToolProvider, ToolSearch } from "../index.js";

const T = asId<TenantId>("t1");

const ctx = (excluded: readonly string[] = []): ExecutionContext => ({
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  runId: asId<RunId>("run1"),
  ...(excluded.length === 0
    ? {}
    : { agentToolPolicy: { preloaded: [], categories: [], excluded } }),
});

const descriptor = (name: string, category = "general"): ToolDescriptor => ({
  name,
  label: name,
  description: `the ${name} tool`,
  category,
  inputSchema: {},
  outputSchema: {},
  effect: "read",
  approvalPolicy: "never",
  requiresIdempotencyKey: false,
});

const ran: string[] = [];
const provider: ToolProvider = {
  id: "test",
  async listTools(): Promise<readonly Tool[]> {
    return ["safe", "dangerous"].map((name) => ({
      descriptor: descriptor(name),
      execute: async () => {
        ran.push(name);
        return { ok: true, data: { name } };
      },
    }));
  },
};

/** A search that returns everything it is given, so filtering can only come from the registry. */
const search: ToolSearch = {
  async search({ tools }) {
    return { hits: tools.map((t) => ({ name: t.name, score: 1 })), modes: ["keyword"] };
  },
};

const allowAll = {
  async can() {
    return { allow: true as const };
  },
  async filterTools(_c: ExecutionContext, tools: readonly ToolDescriptor[]) {
    return tools;
  },
  async scope() {
    return {};
  },
};

const registry = () => createToolRegistry({ providers: [provider], authorization: allowAll, search });

describe("an excluded tool is unreachable, not merely unlisted", () => {
  it("is absent from the authorized list", async () => {
    const names = (await registry().listAuthorized(ctx(["dangerous"]))).map((d) => d.name);
    expect(names).toContain("safe");
    expect(names).not.toContain("dangerous");
  });

  it("is absent from the catalogue", async () => {
    const catalog = await registry().catalog(ctx(["dangerous"]), { preloaded: [], categories: [], excluded: [] });
    const all = [...catalog.preloaded.map((d) => d.name), ...catalog.discoverable.map((e) => e.name)];
    expect(all).toContain("safe");
    expect(all).not.toContain("dangerous");
  });

  it("cannot be called by name — the bypass a catalogue-only check leaves open", async () => {
    ran.length = 0;
    const result = await registry().execute(ctx(["dangerous"]), { name: "dangerous", input: {} });
    expect(result.ok).toBe(false);
    // And it did not run. A refusal that still performed the side effect would be worse than no refusal.
    expect(ran).toEqual([]);
  });

  it("cannot be reached through execute_tool", async () => {
    ran.length = 0;
    const result = await registry().execute(ctx(["dangerous"]), {
      name: "execute_tool",
      input: { name: "dangerous", input: {} },
    });
    expect(result.ok).toBe(false);
    expect(ran).toEqual([]);
  });

  it("is not returned by find_tools", async () => {
    const result = await registry().execute(ctx(["dangerous"]), {
      name: "find_tools",
      input: { query: "dangerous" },
    });
    expect(result.ok).toBe(true);
    const hits = (result as { data: { hits: readonly { name: string }[] } }).data.hits.map((h) => h.name);
    expect(hits).not.toContain("dangerous");
  });

  it("is not learnable through learn_tools", async () => {
    const result = await registry().execute(ctx(["dangerous"]), {
      name: "learn_tools",
      input: { names: ["dangerous", "safe"] },
    });
    expect(result.ok).toBe(true);
    const learned = (result as { data: { tools: readonly { name: string }[] } }).data.tools.map((t) => t.name);
    expect(learned).toContain("safe");
    expect(learned).not.toContain("dangerous");
  });

  it("still runs when nothing is excluded, so the filter is not simply breaking execution", async () => {
    ran.length = 0;
    const result = await registry().execute(ctx(), { name: "dangerous", input: {} });
    expect(result.ok).toBe(true);
    expect(ran).toEqual(["dangerous"]);
  });
});
