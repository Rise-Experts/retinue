/**
 * A structured agent gets a structured answer, or the run fails — REQ-057 (#242), task #243.
 *
 * `ResponseFormat` had a `structured` variant from the day the manifest existed and **nothing ever read it**:
 * `defineAgent` set a default, a test asserted that default, and the engine — which owns the model call — never
 * looked. So `defineAgent({ responseFormat: { kind: "structured", schema } })` typechecked, shipped in 0.2.0, and
 * silently returned prose. `DEFAULT_MODEL_CATALOG` compounded it by advertising `structuredOutput: true` on
 * models the runtime could not ask.
 *
 * The tests that matter here are the refusals, not the happy path. A structured request that degrades to text is
 * indistinguishable from a successful one unless something fails loudly, and that indistinguishability is exactly
 * how this hid for months.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, RunId } from "../../core/ids.js";
import type { ModelDefinition, ModelTurnRequest, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import { createDefaultEngine } from "../engine.js";
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
const signal = { isCancelled: () => false };

const SCHEMA = z.object({ sentiment: z.enum(["positive", "negative"]), score: z.number() });

const structuredAgent = defineAgent({
  id: "a1",
  name: "A",
  instructions: "classify",
  modelPolicy: { role: "smart" },
  responseFormat: { kind: "structured", schema: SCHEMA },
});
const textAgent = defineAgent({ id: "a2", name: "B", instructions: "chat", modelPolicy: { role: "smart" } });

/** A definition that declares the capability, and one that does not. */
const definition = (structuredOutput: boolean): ModelDefinition => ({
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  label: "Claude Sonnet 5",
  lifecycle: "generally-available",
  inputModalities: ["text"],
  capabilities: { tools: true, structuredOutput, reasoning: false, nativeSearch: false },
  limits: { contextTokens: 200_000, maxOutputTokens: 8_192 },
  pricing: { currency: "USD", inputPerMillion: 3_000, outputPerMillion: 15_000 },
  dataResidency: ["us"],
});

async function* structuredTurn(): AsyncIterable<NeutralStreamChunk> {
  yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
  yield { type: "structured-output", value: { sentiment: "positive", score: 0.9 } };
}

/** The defect, reproduced: a turn that answers in prose when a schema was asked for. */
async function* proseTurn(): AsyncIterable<NeutralStreamChunk> {
  yield { type: "text-delta", id: "t", text: "It seems fairly positive to me!" };
  yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
}

const deps = (over: Record<string, unknown> = {}) => ({
  loadManifest: async () => structuredAgent,
  resolveModel: () => ({
    model: {} as ResolvedModel,
    modelId: "claude-sonnet-5",
    currency: "USD",
    price: () => 0,
    definition: definition(true),
  }),
  loadHistory: async () => [{ role: "user" as const, content: "how do people feel?" }],
  streamTurn: structuredTurn,
  buildTools: async () => [],
  ...over,
});

const collect = async (engine: ReturnType<typeof createDefaultEngine>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context, resume: null, signal })) out.push(e);
  return out;
};

describe("the manifest's responseFormat is read", () => {
  it("passes the schema to the model layer — the field is no longer inert", async () => {
    // The whole task in one assertion: before this, nothing in the codebase read `responseFormat`, so the
    // request reaching the model carried no trace of it.
    const seen: ModelTurnRequest[] = [];
    const streamTurn = (req: ModelTurnRequest) => {
      seen.push(req);
      return structuredTurn();
    };
    await collect(createDefaultEngine(deps({ streamTurn })));
    expect(seen[0]?.structuredOutput).toEqual({ schema: SCHEMA });
  });

  it("sends nothing for a text agent, so an ordinary turn is unchanged", async () => {
    const seen: ModelTurnRequest[] = [];
    const streamTurn = (req: ModelTurnRequest) => {
      seen.push(req);
      return proseTurn();
    };
    await collect(createDefaultEngine(deps({ loadManifest: async () => textAgent, streamTurn })));
    expect(seen[0]?.structuredOutput).toBeUndefined();
  });

  it("emits the validated value as a structured part", async () => {
    const events = await collect(createDefaultEngine(deps()));
    const parts = events.filter((e) => e.type === "part.added");
    const structured = parts.find((e) => (e as { part: { type: string } }).part.type === "structured");
    expect(structured).toBeDefined();
    expect((structured as { part: { value: unknown } }).part.value).toEqual({ sentiment: "positive", score: 0.9 });
  });
});

describe("a structured request that cannot be honoured fails, rather than degrading", () => {
  it("refuses at resolution when the model does not declare the capability — AC-3", async () => {
    // Before a token is spent. The alternative is discovering it mid-turn, having paid for a generation that
    // cannot satisfy the contract.
    await expect(
      collect(
        createDefaultEngine(
          deps({
            resolveModel: () => ({
              model: {} as ResolvedModel,
              modelId: "claude-sonnet-5",
              currency: "USD",
              price: () => 0,
              definition: definition(false),
            }),
          }),
        ),
      ),
    ).rejects.toThrow(/does not declare the `structuredOutput` capability/);
  });

  it("still runs when the host supplied no definition — the #185 rule, not a new one", async () => {
    // A host that did not say what the model can do has not said it cannot do this. Refusing every structured
    // agent from every not-yet-updated host would be an outage dressed as a safety check.
    const events = await collect(
      createDefaultEngine(
        deps({
          resolveModel: () => ({ model: {} as ResolvedModel, modelId: "m", currency: "USD", price: () => 0 }),
        }),
      ),
    );
    expect(events.some((e) => e.type === "part.added")).toBe(true);
  });

  it("fails the run when a structured turn produced prose instead — AC-2", async () => {
    // The sabotage that matters. A host may supply its own `streamTurn`; if the guarantee lived only in the
    // shipped model layer, replacing that layer would silently restore the original defect through a documented
    // extension point.
    await expect(collect(createDefaultEngine(deps({ streamTurn: proseTurn })))).rejects.toThrow(
      /asks for a structured response format and the turn produced none/,
    );
  });

  it("does not fail a text agent for having produced no structured part", async () => {
    const events = await collect(createDefaultEngine(deps({ loadManifest: async () => textAgent, streamTurn: proseTurn })));
    expect(events.some((e) => e.type === "part.added")).toBe(true);
  });
});

describe("tools and structured output coexist — AC-4", () => {
  it("keeps tool calls streaming around a single final structured answer", async () => {
    async function* withTool(): AsyncIterable<NeutralStreamChunk> {
      yield { type: "tool-call", toolCallId: "c1", toolName: "alpha", input: {} };
      yield { type: "tool-result", toolCallId: "c1", toolName: "alpha", output: { ok: true } };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      yield { type: "structured-output", value: { sentiment: "negative", score: 0.2 } };
    }
    const events = await collect(createDefaultEngine(deps({ streamTurn: withTool })));
    const types = events
      .filter((e) => e.type === "part.added")
      .map((e) => (e as { part: { type: string } }).part.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).toContain("structured");
  });
});
