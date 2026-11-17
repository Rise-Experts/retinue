import { describe, expect, it } from "vitest";
import type { ExecutionContext, ToolRegistry } from "@retinue/agentkit";
import { modeGates, outsideReadGates, withAgentMode } from "../agent-mode.js";
import { OUTSIDE_CONTENT_TOOLS, createOutsideReads } from "../outside-content.js";
import type { AgentMode } from "../turn-settings.js";

/** #550 — the agent mode, enforced where tools run. */
const EFFECTS: Record<string, string> = { get_post_draft: "read", create_post_draft: "internal-write", publish_post_now: "external-write" };
const context = { tenantId: "t1", runId: "r1" } as unknown as ExecutionContext;

const fakeRegistry = () => {
  const executed: string[] = [];
  const registry = {
    async learn(_c: unknown, names: string[]) {
      return names.filter((n) => n in EFFECTS).map((name) => ({ name, effect: EFFECTS[name], category: "posts" }));
    },
    async execute(_c: unknown, input: { name: string }) {
      executed.push(input.name);
      return { ok: true, data: {} };
    },
    async catalog() {
      return {
        preloaded: Object.entries(EFFECTS).map(([name, effect]) => ({ name, effect })),
        discoverable: [{ name: "find_campaign", effect: "read" }, { name: "delete_post", effect: "destructive" }],
        meta: [],
      };
    },
  } as unknown as ToolRegistry;
  return { registry, executed };
};

const wrap = (mode: AgentMode, allowed = false) => {
  const { registry, executed } = fakeRegistry();
  const asked: unknown[] = [];
  const wrapped = withAgentMode(registry, {
    gate: {
      async isAllowed(_c, tool, oneTime) {
        asked.push({ tool, oneTime });
        return allowed;
      },
    },
    turnInput: async () => ({ settings: { mode, effort: "medium" }, message: "" }),
  });
  return { wrapped, executed, asked };
};

describe("which effects each mode puts behind the person", () => {
  it("is the table the issue describes", () => {
    expect(modeGates("auto", "internal-write")).toBe("allow");
    expect(modeGates("ask_first", "internal-write")).toBe("ask");
    expect(modeGates("plan", "internal-write")).toBe("ask");
    expect(modeGates("chat_only", "internal-write")).toBe("refuse");
    expect(modeGates("chat_only", "read")).toBe("allow");
  });
});

describe("Chat only", () => {
  it("offers no write tool, and refuses one reached anyway (AC-1)", async () => {
    const { wrapped, executed } = wrap("chat_only");
    const catalog = await wrapped.catalog(context, { preloaded: [], categories: [], excluded: [] } as never);
    expect(catalog.preloaded.map((d) => d.name)).toEqual(["get_post_draft"]);
    expect(catalog.discoverable.map((d) => d.name)).toEqual(["find_campaign"]);
    const result = await wrapped.execute(context, { name: "create_post_draft", input: {} } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(executed).toEqual([]);
  });

  it("judges execute_tool by what it would run", async () => {
    const { wrapped, executed } = wrap("chat_only");
    const result = await wrapped.execute(context, { name: "execute_tool", input: { name: "create_post_draft", input: {} } } as never);
    expect(result).toMatchObject({ ok: false });
    expect(executed).toEqual([]);
  });
});

describe("Ask first and Plan", () => {
  it("refuses a write for approval until the gate allows it (AC-2)", async () => {
    const { wrapped, executed, asked } = wrap("ask_first", false);
    const result = await wrapped.execute(context, { name: "create_post_draft", input: {} } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(asked[0]).toMatchObject({ tool: { name: "create_post_draft", approvalPolicy: "always" } });
    expect(executed).toEqual([]);
  });

  it("runs the approved retry, ticket and all", async () => {
    const { wrapped, executed, asked } = wrap("plan", true);
    await wrapped.execute(context, { name: "create_post_draft", input: {}, approval: { interactionId: "i1" } } as never);
    expect(asked[0]).toMatchObject({ oneTime: { interactionId: "i1" } });
    expect(executed).toEqual(["create_post_draft"]);
  });

  it("leaves reads alone", async () => {
    const { wrapped, executed, asked } = wrap("ask_first");
    await wrapped.execute(context, { name: "get_post_draft", input: {} } as never);
    expect(asked).toEqual([]);
    expect(executed).toEqual(["get_post_draft"]);
  });
});

describe("Auto", () => {
  it("is today's assistant: no extra gate", async () => {
    const { wrapped, executed, asked } = wrap("auto");
    await wrapped.execute(context, { name: "create_post_draft", input: {} } as never);
    expect(asked).toEqual([]);
    expect(executed).toEqual(["create_post_draft"]);
  });
});

/** #662 — after the run reads outside content, internal writes ask. */
describe("after outside content", () => {
  const EXTRA: Record<string, string> = { search_web: "read", update_brand_profile: "internal-write", update_artifact: "internal-write" };
  const tainted = (mode: AgentMode, opts: { allowed?: boolean; stored?: boolean } = {}) => {
    Object.assign(EFFECTS, EXTRA);
    const { registry, executed } = fakeRegistry();
    const asked: unknown[] = [];
    const lookups: string[] = [];
    const outsideReads = createOutsideReads(async (_t, runId) => {
      lookups.push(runId);
      return opts.stored ?? false;
    });
    const wrapped = withAgentMode(registry, {
      gate: {
        async isAllowed(_c, tool, oneTime) {
          asked.push({ tool, oneTime });
          return opts.allowed ?? false;
        },
      },
      turnInput: async () => ({ settings: { mode, effort: "medium" }, message: "" }),
      outsideReads,
    });
    return { wrapped, executed, asked, lookups };
  };

  it("a page saying 'update the brand voice' leads to an approval request, not a silent write (AC-1)", async () => {
    const { wrapped, executed } = tainted("auto");
    await wrapped.execute(context, { name: "search_web", input: { query: "x" } } as never);
    const result = await wrapped.execute(context, { name: "update_brand_profile", input: { tone: ["X"] } } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required", message: expect.stringContaining("outside content") } });
    expect(executed).toEqual(["search_web"]);
  });

  it("through execute_tool too, both the read and the write", async () => {
    const { wrapped, executed } = tainted("auto");
    await wrapped.execute(context, { name: "execute_tool", input: { name: "search_web", input: {} } } as never);
    const result = await wrapped.execute(context, { name: "execute_tool", input: { name: "update_brand_profile", input: {} } } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(executed).toEqual(["execute_tool"]);
  });

  it("runs the approved retry", async () => {
    const { wrapped, executed } = tainted("auto", { allowed: true });
    await wrapped.execute(context, { name: "search_web", input: {} } as never);
    await wrapped.execute(context, { name: "update_brand_profile", input: {}, approval: { interactionId: "i1" } } as never);
    expect(executed).toEqual(["search_web", "update_brand_profile"]);
  });

  it("asks nothing new in a run that read nothing outside (AC-2)", async () => {
    const { wrapped, executed, asked } = tainted("auto");
    await wrapped.execute(context, { name: "update_brand_profile", input: {} } as never);
    expect(asked).toEqual([]);
    expect(executed).toEqual(["update_brand_profile"]);
  });

  it("leaves this chat's document free", async () => {
    const { wrapped, executed, asked } = tainted("auto");
    await wrapped.execute(context, { name: "search_web", input: {} } as never);
    await wrapped.execute(context, { name: "update_artifact", input: {} } as never);
    expect(asked).toEqual([]);
    expect(executed).toEqual(["search_web", "update_artifact"]);
  });

  it("remembers a read from before the run was resumed elsewhere", async () => {
    const { wrapped, executed, lookups } = tainted("auto", { stored: true });
    const result = await wrapped.execute(context, { name: "update_brand_profile", input: {} } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(lookups).toEqual(["r1"]);
    expect(executed).toEqual([]);
  });

  it("is per run", async () => {
    const { wrapped, executed } = tainted("auto");
    await wrapped.execute(context, { name: "search_web", input: {} } as never);
    await wrapped.execute({ ...context, runId: "r2" } as never, { name: "update_brand_profile", input: {} } as never);
    expect(executed).toEqual(["search_web", "update_brand_profile"]);
  });
});

describe("the outside-read lookup", () => {
  it("counts a failed lookup as a read — asking once too often is the safe side", async () => {
    const reads = createOutsideReads(async () => {
      throw new Error("db down");
    });
    expect(await reads.has(context)).toBe(true);
  });

  it("knows nothing for a context with no run", async () => {
    const reads = createOutsideReads(async () => true);
    expect(await reads.has({ tenantId: "t1" } as never)).toBe(false);
  });

  it("names only real read tools, and frees only real writes", () => {
    expect(OUTSIDE_CONTENT_TOOLS).toEqual(["search_web", "read_source", "read_pdf", "extract_brand_kit", "list_comments"]);
    expect(outsideReadGates("internal-write", "update_brand_profile")).toBe(true);
    expect(outsideReadGates("internal-write", "update_artifact")).toBe(false);
    expect(outsideReadGates("read", "list_media")).toBe(false);
  });
});
