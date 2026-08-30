/**
 * The manifest's four policy fields do something — REQ-057 (#242), task #244.
 *
 * All four were declared and read by nothing. The engine is the only layer holding both halves — the manifest
 * (per agent) and the registry, providers and policies (per deployment) — so it is where three of them are
 * connected, and `createAgent` is where the fourth is.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, RunId } from "../../core/ids.js";
import type { ModelTurnRequest, ModelTurnTool, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import type { ContextProvider } from "../../context/index.js";
import { createDefaultEngine, turnToolTokens } from "../engine.js";
import { defineAgent } from "../define.js";
import { selectAuthorization, selectContextProviders } from "../agent.js";

const RUN = asId<RunId>("r1");
const run: Run = {
  id: RUN,
  tenantId: asId("t1"),
  conversationId: asId<ConversationId>("c1"),
  agentId: asId<AgentId>("a1"),
  agentVersion: 1,
  status: "running",
  createdAt: "t",
};
const hostContext: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
  runId: RUN,
};
const signal = { isCancelled: () => false };

async function* oneWord(): AsyncIterable<NeutralStreamChunk> {
  yield { type: "text-delta", id: "t", text: "fine" };
  yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
}

const turnTool = (name: string, category = "general"): ModelTurnTool => ({
  name,
  category,
  description: `the ${name} tool, which does a thing worth about the same as every other tool here`,
  inputSchema: { type: "object", properties: { target: { type: "string" }, note: { type: "string" } } },
  execute: async () => ({ ok: true, data: name }),
});

const collect = async (engine: ReturnType<typeof createDefaultEngine>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context: hostContext, resume: null, signal })) out.push(e);
  return out;
};

const deps = (manifest: ReturnType<typeof defineAgent>, over: Record<string, unknown> = {}) => ({
  loadManifest: async () => manifest,
  resolveModel: () => ({ model: {} as ResolvedModel, modelId: "m", currency: "USD", price: () => 0 }),
  loadHistory: async () => [{ role: "user" as const, content: "do the thing" }],
  streamTurn: oneWord,
  buildTools: async () => [turnTool("alpha"), turnTool("bravo")],
  ...over,
});

describe("toolPolicy travels on the context, where a model cannot reach it", () => {
  it("is set from the manifest for everything downstream", async () => {
    // The field's whole purpose. Before this nothing read `toolPolicy`, so the context handed to `buildTools`
    // and to every tool execution carried no trace of it.
    const seen: ExecutionContext[] = [];
    const manifest = defineAgent({
      id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" },
      toolPolicy: { preloaded: ["alpha"], categories: ["general"], excluded: ["charlie"] },
    });
    await collect(
      createDefaultEngine(
        deps(manifest, {
          buildTools: async (c: ExecutionContext) => {
            seen.push(c);
            return [];
          },
        }),
      ),
    );
    expect(seen[0]?.agentToolPolicy).toEqual({
      preloaded: ["alpha"],
      categories: ["general"],
      excluded: ["charlie"],
    });
  });

  it("overrides a policy the host put on the context", async () => {
    // The manifest is what the run's `agentVersion` pins, so a stored definition decides what this agent may
    // reach — not whoever built the context. Otherwise a caller could widen `excluded` by constructing one.
    const seen: ExecutionContext[] = [];
    const manifest = defineAgent({
      id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" },
      toolPolicy: { preloaded: [], categories: [], excluded: ["dangerous"] },
    });
    const engine = createDefaultEngine(
      deps(manifest, {
        buildTools: async (c: ExecutionContext) => {
          seen.push(c);
          return [];
        },
      }),
    );
    const wider: ExecutionContext = {
      ...hostContext,
      agentToolPolicy: { preloaded: [], categories: [], excluded: [] },
    };
    for await (const _ of engine.run({ run, context: wider, resume: null, signal })) void _;
    expect(seen[0]?.agentToolPolicy?.excluded).toEqual(["dangerous"]);
  });
});

describe("preloaded and categories survive a catalogue budget", () => {
  const ONE = turnToolTokens(turnTool("alpha"));

  it("keeps a preloaded tool the budget would otherwise drop", async () => {
    // "Loaded into context up front" means *resident* in this architecture, so the honest reading of the field
    // is that a budget may not drop it.
    const seen: ModelTurnRequest[] = [];
    const manifest = defineAgent({
      id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" },
      toolPolicy: { preloaded: ["bravo"], categories: [], excluded: [] },
    });
    await collect(
      createDefaultEngine(
        deps(manifest, {
          streamTurn: (req: ModelTurnRequest) => {
            seen.push(req);
            return oneWord();
          },
          // Room for one ordinary tool; without protection `bravo` is the one that goes.
          catalogBudget: { maxTokens: ONE + 1 },
        }),
      ),
    );
    expect(seen[0]?.tools?.map((t) => t.name)).toContain("bravo");
  });

  it("keeps a whole protected category", async () => {
    const seen: ModelTurnRequest[] = [];
    const manifest = defineAgent({
      id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" },
      toolPolicy: { preloaded: [], categories: ["special"], excluded: [] },
    });
    await collect(
      createDefaultEngine(
        deps(manifest, {
          buildTools: async () => [turnTool("alpha"), turnTool("zeta", "special")],
          streamTurn: (req: ModelTurnRequest) => {
            seen.push(req);
            return oneWord();
          },
          catalogBudget: { maxTokens: 1 },
        }),
      ),
    );
    expect(seen[0]?.tools?.map((t) => t.name)).toContain("zeta");
  });

  it("does not resurrect an excluded tool named as preloaded", async () => {
    // Exclusion is a permission and residency is a budget. The permission wins — and an excluded tool never
    // reaches the engine at all, because the registry removed it.
    const seen: ModelTurnRequest[] = [];
    const manifest = defineAgent({
      id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" },
      toolPolicy: { preloaded: ["gone"], categories: [], excluded: ["gone"] },
    });
    await collect(
      createDefaultEngine(
        deps(manifest, {
          buildTools: async () => [turnTool("alpha")],
          streamTurn: (req: ModelTurnRequest) => {
            seen.push(req);
            return oneWord();
          },
        }),
      ),
    );
    expect(seen[0]?.tools?.map((t) => t.name)).not.toContain("gone");
  });
});

describe("contextProviderIds selects, orders, and fails loudly", () => {
  const provider = (id: string): ContextProvider => ({ id, async provide() { return []; } });
  const wired = [provider("memory"), provider("notes"), provider("attachments")];
  const m = (ids: readonly string[]) =>
    defineAgent({ id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" }, contextProviderIds: ids });

  it("treats an empty list as every wired provider, not none", () => {
    // `defineAgent` defaults it to `[]`. Reading empty as "no context" would silently strip memory, notes and
    // attachments from every agent already written against the default.
    expect(selectContextProviders(wired, m([]))).toEqual(wired);
  });

  it("selects only what was asked for, in the order asked", () => {
    // Section order is prompt order, and the manifest is where an author can see it.
    expect(selectContextProviders(wired, m(["notes", "memory"])).map((p) => p.id)).toEqual(["notes", "memory"]);
  });

  it("throws for an id nothing supplies", () => {
    // The failure worth preventing: an agent asking for `principal-memory`, a typo, and an assistant that
    // quietly remembers nothing — indistinguishable from a model choosing not to use its memory.
    expect(() => selectContextProviders(wired, m(["memory", "principal-memroy"]))).toThrow(/principal-memroy/);
  });

  it("names what is wired, so the fix is in the message", () => {
    expect(() => selectContextProviders(wired, m(["nope"]))).toThrow(/"memory", "notes", "attachments"/);
  });
});

describe("authorizationPolicyId selects a registered policy, or refuses", () => {
  const policy = (tag: string) =>
    ({
      tag,
      async can() { return { allow: true as const }; },
      async filterTools(_c: ExecutionContext, t: readonly unknown[]) { return t; },
      async scope(context: ExecutionContext) { return { tenantId: String(context.tenantId), roleIds: [] }; },
    }) as never;
  const m = (id: string) =>
    defineAgent({ id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" }, authorizationPolicyId: id });

  it("picks the named policy out of the map", () => {
    const chosen = selectAuthorization(
      { authorizationPolicies: { default: policy("d"), restricted: policy("r") } },
      m("restricted"),
    );
    expect((chosen as unknown as { tag: string }).tag).toBe("r");
  });

  it("refuses an id the deployment did not register — never falls back to permissive", () => {
    // The worst possible reading of this field, and the reading it had: an agent asking for a narrow policy and
    // silently getting allow-all.
    expect(() =>
      selectAuthorization({ authorizationPolicies: { default: policy("d") } }, m("restricted")),
    ).toThrow(/no such policy is registered/);
  });

  it("refuses a non-default id when no map is registered at all", () => {
    expect(() => selectAuthorization({}, m("restricted"))).toThrow(/none is registered/);
  });

  it("uses the single wired policy for the default id — the normal case stays a one-liner", () => {
    const single = policy("single");
    expect((selectAuthorization({ authorization: single }, m("default")) as unknown as { tag: string }).tag).toBe(
      "single",
    );
  });

  it("falls back to the permissive default only for the default id with nothing wired", () => {
    expect(selectAuthorization({}, m("default"))).toBeDefined();
  });
});
