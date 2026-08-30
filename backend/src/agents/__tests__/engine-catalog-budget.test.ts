/**
 * The tool list handed to the model is bounded, and never quietly — REQ-045 (#204), task #210, AC-3 and AC-7.
 *
 * The last test in this file is AC-7 itself: it asserts the run event, and it is the only thing standing between
 * this mechanism and the worst kind of failure. A model given a shortened tool list is not told; it simply never
 * calls the missing tool, and the transcript is identical to a run where it decided not to. Delete the event and
 * the platform still "works" — which is why the AC asks for a test that fails when it is deleted, rather than a
 * test that the budget arithmetic is right.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, RunId } from "../../core/ids.js";
import type { ModelTurnRequest, ModelTurnTool, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import { createDefaultEngine, turnToolTokens } from "../engine.js";
import { defineAgent } from "../define.js";

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
const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
  runId: RUN,
};
const manifest = defineAgent({ id: "a1", name: "A", instructions: "be helpful", modelPolicy: { role: "smart" } });
const signal = { isCancelled: () => false };

async function* oneWord(): AsyncIterable<NeutralStreamChunk> {
  yield { type: "text-delta", id: "t", text: "fine" };
  yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
}

/** A tool with a schema, because a schema is most of what a tool costs the model's context. */
const turnTool = (name: string): ModelTurnTool => ({
  name,
  description: `the ${name} tool, which does a thing worth about the same as every other tool here`,
  inputSchema: { type: "object", properties: { target: { type: "string" }, note: { type: "string" } } },
  execute: async () => ({ ok: true, data: name }),
});

const TOOLS = ["alpha", "bravo", "charlie", "delta", "echo"].map(turnTool);
const ONE = turnToolTokens(TOOLS[0] as ModelTurnTool);

const collect = async (engine: ReturnType<typeof createDefaultEngine>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context, resume: null, signal })) out.push(e);
  return out;
};

const deps = (over: Record<string, unknown> = {}) => ({
  loadManifest: async () => manifest,
  resolveModel: () => ({ model: {} as ResolvedModel, modelId: "claude-sonnet-5", currency: "USD", price: () => 0 }),
  loadHistory: async () => [{ role: "user" as const, content: "do the thing" }],
  streamTurn: oneWord,
  buildTools: async () => TOOLS,
  ...over,
});

describe("the budget binds on what the model is actually given", () => {
  it("hands the model only what fits", async () => {
    const seen: ModelTurnRequest[] = [];
    const streamTurn = (req: ModelTurnRequest) => {
      seen.push(req);
      return oneWord();
    };
    await collect(createDefaultEngine(deps({ streamTurn, catalogBudget: { maxTokens: ONE * 2 + 1 } })));
    expect(seen[0]?.tools?.map((t) => t.name)).toEqual(["alpha", "bravo"]);
  });

  it("changes nothing when no budget is configured", async () => {
    const seen: ModelTurnRequest[] = [];
    const streamTurn = (req: ModelTurnRequest) => {
      seen.push(req);
      return oneWord();
    };
    await collect(createDefaultEngine(deps({ streamTurn })));
    expect(seen[0]?.tools).toHaveLength(TOOLS.length);
  });

  it("leaves a list that fits completely alone, and emits nothing", async () => {
    const events = await collect(createDefaultEngine(deps({ catalogBudget: { maxTokens: 100_000 } })));
    expect(events.filter((e) => e.type === "catalog.truncated")).toEqual([]);
  });

  it("never drops a meta-tool, because that is the way back to what was dropped", async () => {
    const seen: ModelTurnRequest[] = [];
    const streamTurn = (req: ModelTurnRequest) => {
      seen.push(req);
      return oneWord();
    };
    await collect(
      createDefaultEngine(
        deps({
          streamTurn,
          // `find_tools` is last, so a budget that keeps the first two would drop it if it were droppable.
          buildTools: async () => [...TOOLS, turnTool("find_tools")],
          catalogBudget: { maxTokens: ONE * 2 + 1 },
        }),
      ),
    );
    expect(seen[0]?.tools?.map((t) => t.name)).toContain("find_tools");
  });
});

describe("AC-7 — truncation is visible, and this is the test that proves it", () => {
  it("emits a run event naming every dropped tool and the budget that bound", async () => {
    const events = await collect(createDefaultEngine(deps({ catalogBudget: { maxTokens: ONE * 2 + 1 } })));
    const truncated = events.filter((e) => e.type === "catalog.truncated");

    // One event, not one per dropped tool: the reader wants the set, and five events describing one decision is
    // a log that has to be reassembled before it can be read.
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({
      catalog: "tools",
      dropped: ["charlie", "delta", "echo"],
      budgetTokens: ONE * 2 + 1,
      findable: false,
    });
  });

  it("says the truncation is recoverable when find_tools is in the model's hands", async () => {
    const events = await collect(
      createDefaultEngine(
        deps({
          buildTools: async () => [turnTool("find_tools"), ...TOOLS],
          catalogBudget: { maxTokens: ONE * 2 + 1 },
        }),
      ),
    );
    const truncated = events.find((e) => e.type === "catalog.truncated");
    // Derived from the list, not configured: whether truncation is a deferral or an amputation is a fact about
    // this turn, and a host declaring it separately could declare it wrongly.
    expect(truncated).toMatchObject({ findable: true });
  });

  it("reports overBudget when the protected set alone does not fit", async () => {
    const events = await collect(
      createDefaultEngine(
        deps({
          buildTools: async () => [turnTool("find_tools"), turnTool("learn_tools"), ...TOOLS],
          catalogBudget: { maxTokens: 1 },
        }),
      ),
    );
    expect(events.find((e) => e.type === "catalog.truncated")).toMatchObject({ overBudget: true });
  });

  it("emits the event before the model is called, so a trace shows the cause and then the turn", async () => {
    // Ordering matters for the reader: an event after the turn reads as a consequence of it.
    let calledAt = -1;
    const streamTurn = vi.fn(() => {
      calledAt = order.length;
      return oneWord();
    });
    const order: string[] = [];
    const engine = createDefaultEngine(deps({ streamTurn, catalogBudget: { maxTokens: ONE * 2 + 1 } }));
    for await (const e of engine.run({ run, context, resume: null, signal })) order.push(e.type);
    const truncatedAt = order.indexOf("catalog.truncated");
    expect(truncatedAt).toBeGreaterThanOrEqual(0);
    expect(truncatedAt).toBeLessThanOrEqual(calledAt);
  });
});
