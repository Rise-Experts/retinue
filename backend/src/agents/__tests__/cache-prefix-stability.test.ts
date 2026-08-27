/**
 * The cacheable prefix is byte-stable across turns — REQ-058 (#246), task #247 AC-7.
 *
 * Every other part of prompt caching is arithmetic. This is the *property*, and if it does not hold the arithmetic
 * is about a discount nobody receives: a provider caches a prefix by matching it byte for byte, so one reordered
 * tool definition on turn 2 means a full-price turn and nothing in the platform says so.
 *
 * Measured against a live model, which is why this test exists rather than being taken on trust. The same 9,700
 * token prefix, sent twice unchanged and once with its lines reversed:
 *
 *     turn 2 (same prefix)      cacheReadTokens: 9472
 *     turn 4 (prefix reordered) cacheReadTokens: 0
 *
 * So the guard is not theoretical. Reordering costs the entire discount.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId } from "../../core/ids.js";
import type { ModelTurnRequest, ModelTurnTool, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import type { Run } from "../../runtime/index.js";
import { createDefaultEngine } from "../engine.js";
import { defineAgent } from "../define.js";

const RUN = asId<RunId>("r1");
const run: Run = {
  id: RUN,
  tenantId: asId("t1"),
  conversationId: asId("c1"),
  agentId: asId("a1"),
  agentVersion: 1,
  status: "running",
  createdAt: "t",
};
const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
  runId: RUN,
};
const signal = { isCancelled: () => false };

async function* reply(): AsyncIterable<NeutralStreamChunk> {
  yield { type: "text-delta", id: "t", text: "ok" };
  yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
}

const tool = (name: string): ModelTurnTool => ({
  name,
  category: "general",
  description: `the ${name} tool, which does a thing`,
  inputSchema: { type: "object", properties: { target: { type: "string" } } },
  execute: async () => ({ ok: true, data: name }),
});

const manifest = defineAgent({ id: "a1", name: "A", instructions: "be helpful", modelPolicy: { role: "smart" } });

/**
 * What a provider matches on: the system prompt, then every tool's name, description and schema, in order.
 *
 * Serialised here rather than compared field by field because the property is *byte* stability — a difference the
 * provider would see must be a difference this function sees, and vice versa.
 */
const cacheablePrefix = (req: ModelTurnRequest): string =>
  JSON.stringify({
    system: req.system,
    tools: (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  });

const runTurns = async (buildTools: () => Promise<readonly ModelTurnTool[]>, turns = 3): Promise<string[]> => {
  const seen: ModelTurnRequest[] = [];
  const engine = createDefaultEngine({
    loadManifest: async () => manifest,
    resolveModel: () => ({ model: {} as ResolvedModel, modelId: "m", currency: "USD", price: () => 0 }),
    loadHistory: async () => [{ role: "user" as const, content: "hello" }],
    streamTurn: (req: ModelTurnRequest) => {
      seen.push(req);
      return reply();
    },
    buildTools,
  });
  for (let i = 0; i < turns; i += 1) {
    for await (const _ of engine.run({ run, context, resume: null, signal })) void _;
  }
  return seen.map(cacheablePrefix);
};

const TOOLS = ["alpha", "bravo", "charlie", "delta"].map(tool);

describe("the prefix a provider would match on", () => {
  it("is identical across turns of one conversation", async () => {
    const prefixes = await runTurns(async () => TOOLS);
    expect(new Set(prefixes).size).toBe(1);
  });

  it("is identical when the tool list is rebuilt each turn from the same source", async () => {
    // The realistic case: `buildTools` runs per turn and maps over registry descriptors. Any nondeterminism
    // there — a `Set` iteration order, a `Date.now()` in a description, a re-sorted array — destroys the hit
    // rate and shows up nowhere except the bill.
    const prefixes = await runTurns(async () => ["alpha", "bravo", "charlie", "delta"].map(tool));
    expect(new Set(prefixes).size).toBe(1);
  });

  it("changes when the tool order changes — the sabotage AC-7 asks for", async () => {
    // Proves the check has teeth. A guard that cannot fail when the order is perturbed would pass on a platform
    // that reorders its catalogue every turn, which is exactly the state it exists to detect.
    let turn = 0;
    const prefixes = await runTurns(async () => {
      turn += 1;
      return turn % 2 === 0 ? [...TOOLS].reverse() : TOOLS;
    });
    expect(new Set(prefixes).size).toBeGreaterThan(1);
  });

  it("changes when a tool's description changes", async () => {
    // The subtler version, and the one most likely to happen by accident: interpolating anything per-turn into a
    // description — a count, a timestamp, a tenant name — silently disables caching.
    let turn = 0;
    const prefixes = await runTurns(async () => {
      turn += 1;
      return [{ ...tool("alpha"), description: `the alpha tool, invoked ${turn} times` }];
    });
    expect(new Set(prefixes).size).toBeGreaterThan(1);
  });

  it("changes when a tool is dropped, so a per-turn budget is visible here", async () => {
    // A catalogue budget whose selection varies per turn destroys caching. It is off by default — #210 measured
    // it costing 19-23 points of accuracy — but this is where that second cost would show up.
    let turn = 0;
    const prefixes = await runTurns(async () => {
      turn += 1;
      return TOOLS.slice(0, turn % 2 === 0 ? 2 : 4);
    });
    expect(new Set(prefixes).size).toBeGreaterThan(1);
  });
});
