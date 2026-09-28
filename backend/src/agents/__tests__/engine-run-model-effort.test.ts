/**
 * Per-run model and reasoning effort — #286. Also the engine half of #285: a run's memory scopes reach the context.
 *
 * The acceptance criteria, and the one rule under both of them:
 *
 * - **AC-1** Two runs in one conversation on different models each record their own model id — asserted through
 *   the durable worker and the usage recorder, because "recorded" means on the ledger a host prices from, not on
 *   an event somebody might read.
 * - **AC-2** `effort: high` reaches the provider's option; an unsupported provider reports "effort ignored". The
 *   per-provider wire assertions are in `models/__tests__/effort.test.ts`; here it is the engine's part: the
 *   mapped options reach `streamTurn`, and the outcome lands on the usage event and the usage row.
 * - **Never silently replaced.** A model outside the host's catalogue fails the run with a reason. Every refusal
 *   case below also asserts that `resolveModel` was *not* consulted and no turn was streamed — the fallback this
 *   issue rules out would pass a test that only checked for an error somewhere.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, RunId, TenantId } from "../../core/ids.js";
import type { ModelDefinition, ModelProvider, ModelTurnRequest, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import { createDurableWorker } from "../../runtime/index.js";
import { createMemoryCheckpointStore, createMemoryRunStore } from "../../adapters/memory/runtime.js";
import { createMemoryUsageStore } from "../../adapters/memory/usage.js";
import { createUsageRecorder } from "../../usage/index.js";
import { createDefaultEngine, type RunModelCatalogue } from "../engine.js";
import { defineAgent } from "../define.js";

const T = asId<TenantId>("t1");
const CONVO = asId<ConversationId>("c1");

const baseRun = (over: Partial<Run> = {}): Run => ({
  id: asId<RunId>("r1"),
  tenantId: T,
  conversationId: CONVO,
  agentId: asId<AgentId>("a1"),
  agentVersion: 1,
  status: "running",
  createdAt: "t",
  ...over,
});
const context: ExecutionContext = {
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: CONVO,
};
const signal = { isCancelled: () => false };

const agent = defineAgent({ id: "a1", name: "A", instructions: "chat", modelPolicy: { role: "smart" } });

const def = (modelId: string, provider: ModelProvider, over: Partial<ModelDefinition> = {}): ModelDefinition => ({
  provider,
  modelId,
  label: modelId,
  lifecycle: "generally-available",
  inputModalities: ["text"],
  capabilities: { tools: true, structuredOutput: false, reasoning: true, nativeSearch: false },
  limits: { contextTokens: 200_000, maxOutputTokens: 8_192 },
  pricing: { currency: "USD", inputPerMillion: 1_000, outputPerMillion: 2_000 },
  dataResidency: ["us"],
  ...over,
});

const CATALOGUE = [
  def("claude-opus-5", "anthropic"),
  def("gpt-5", "openai"),
  def("mistral-large", "mistral"),
  def("claude-legacy", "anthropic", { lifecycle: "retired" }),
];

/** A catalogue that builds each model as an opaque handle, tagged so a test can tell which one served the turn. */
const catalogue = (models: readonly ModelDefinition[] = CATALOGUE): RunModelCatalogue & { resolved: string[] } => {
  const resolved: string[] = [];
  return {
    resolved,
    models: () => models,
    resolve: (definition) => {
      resolved.push(definition.modelId);
      return {
        model: { tag: definition.modelId } as unknown as ResolvedModel,
        modelId: definition.modelId,
        currency: "USD",
        price: () => 7,
        definition,
      };
    },
  };
};

/** A streamTurn that records every request it was handed, then answers. */
const recordingTurn = () => {
  const requests: ModelTurnRequest[] = [];
  async function* streamTurn(req: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> {
    requests.push(req);
    yield { type: "text-delta", id: "t", text: "ok" };
    yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } };
  }
  return { requests, streamTurn };
};

const engineWith = (over: Record<string, unknown> = {}) => {
  const turn = recordingTurn();
  let defaultResolutions = 0;
  const engine = createDefaultEngine({
    loadManifest: async () => agent,
    loadHistory: async () => [{ role: "user" as const, content: "hi" }],
    buildTools: async () => [],
    streamTurn: turn.streamTurn,
    resolveModel: () => {
      defaultResolutions += 1;
      return { model: {} as ResolvedModel, modelId: "agent-default", currency: "USD", price: () => 0 };
    },
    ...over,
  } as never);
  return { engine, turn, defaultResolutions: () => defaultResolutions };
};

const collect = async (engine: ReturnType<typeof createDefaultEngine>, run: Run): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const event of engine.run({ run, context, resume: null, signal })) out.push(event);
  return out;
};

const usageOf = (events: readonly EngineEvent[]) => {
  const event = events.find((e) => e.type === "usage.updated");
  if (event === undefined || event.type !== "usage.updated") throw new Error("no usage.updated event");
  return event;
};

describe("a run that names its model", () => {
  it("is served by that model, built by the host's catalogue — not by resolveModel", async () => {
    const models = catalogue();
    const { engine, turn, defaultResolutions } = engineWith({ runModels: models });
    const events = await collect(engine, baseRun({ model: "gpt-5" }));

    expect(models.resolved).toEqual(["gpt-5"]);
    expect(defaultResolutions()).toBe(0);
    expect((turn.requests[0]?.model as unknown as { tag: string }).tag).toBe("gpt-5");
    expect(usageOf(events).modelId).toBe("gpt-5");
  });

  it("without a model, resolves exactly as before and never touches the catalogue", async () => {
    const models = catalogue();
    const { engine, defaultResolutions } = engineWith({ runModels: models });
    const events = await collect(engine, baseRun());
    expect(defaultResolutions()).toBe(1);
    expect(models.resolved).toEqual([]);
    expect(usageOf(events).modelId).toBe("agent-default");
    // Nothing effort-shaped on a run that asked for nothing.
    expect(usageOf(events)).not.toHaveProperty("effort");
    expect(usageOf(events)).not.toHaveProperty("effortIgnored");
  });

  const refused = async (run: Run, over: Record<string, unknown>, reason: RegExp) => {
    const { engine, turn, defaultResolutions } = engineWith(over);
    await expect(collect(engine, run)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(reason) });
    // The rule the issue exists for: refused, and not served by anything else in its place.
    expect(defaultResolutions(), "fell back to resolveModel").toBe(0);
    expect(turn.requests, "streamed a turn on some other model").toHaveLength(0);
  };

  it("is refused, with the allowed list, when the id is not in the catalogue", async () => {
    await refused(
      baseRun({ model: "claude-opus-9" }),
      { runModels: catalogue() },
      /"claude-opus-9" is not in this deployment's allowed models \(claude-opus-5, gpt-5, mistral-large\)/,
    );
  });

  it("is refused when the model is retired, saying so rather than 'unknown'", async () => {
    await refused(baseRun({ model: "claude-legacy" }), { runModels: catalogue() }, /claude-legacy is retired/);
  });

  it("is refused when the agent's hard constraints exclude it — the picker is not a way around them", async () => {
    const needsImages = defineAgent({
      id: "a1",
      name: "A",
      instructions: "look",
      modelPolicy: { role: "smart", requiredModalities: ["image"] },
    });
    await refused(
      baseRun({ model: "gpt-5" }),
      { runModels: catalogue(), loadManifest: async () => needsImages },
      /gpt-5 does not accept image/,
    );
  });

  it("is refused when the runtime has no catalogue at all", async () => {
    await refused(baseRun({ model: "gpt-5" }), {}, /no run-model catalogue/);
  });
});

describe("a run that asks for an effort", () => {
  it("reaches the provider as its own option, and the usage event says it was applied", async () => {
    const { engine, turn } = engineWith({ runModels: catalogue() });
    const events = await collect(engine, baseRun({ model: "claude-opus-5", effort: "high" }));
    expect(turn.requests[0]?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16_384 } },
    });
    expect(usageOf(events).effort).toBe("high");
    expect(usageOf(events)).not.toHaveProperty("effortIgnored");
  });

  it("maps for OpenAI too — the provider decides the option, not the run", async () => {
    const { engine, turn } = engineWith({ runModels: catalogue() });
    await collect(engine, baseRun({ model: "gpt-5", effort: "low" }));
    expect(turn.requests[0]?.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
  });

  it("on a provider without the concept, sends nothing and reports 'effort ignored'", async () => {
    const { engine, turn } = engineWith({ runModels: catalogue() });
    const events = await collect(engine, baseRun({ model: "mistral-large", effort: "high" }));
    expect(turn.requests[0]).not.toHaveProperty("providerOptions");
    expect(usageOf(events).effortIgnored).toBe("effort ignored: provider mistral has no reasoning-effort option");
    // Not recorded as served at "high": the host must not price a step at a rate it was never given.
    expect(usageOf(events)).not.toHaveProperty("effort");
  });

  it("works on the agent's own model too, read off the model handle when there is no definition", async () => {
    const { engine, turn } = engineWith({
      resolveModel: () => ({
        model: { provider: "google.generative-ai" } as unknown as ResolvedModel,
        modelId: "gemini-2.5-flash",
      }),
    });
    const events = await collect(engine, baseRun({ effort: "medium" }));
    expect(turn.requests[0]?.providerOptions).toEqual({ google: { thinkingConfig: { thinkingBudget: 8_192 } } });
    expect(usageOf(events).effort).toBe("medium");
  });

  it("refuses an effort that is not one of the three", async () => {
    const { engine, turn } = engineWith();
    await expect(collect(engine, baseRun({ effort: "max" as never }))).rejects.toMatchObject({ code: "invalid_input" });
    expect(turn.requests).toHaveLength(0);
  });
});

describe("a run's memory scopes — #285", () => {
  it("reach the context every provider and tool sees, from the run row", async () => {
    let seen: readonly string[] | undefined;
    const { engine } = engineWith({
      systemPrompt: (_m: unknown, ctx: ExecutionContext) => {
        seen = ctx.memoryScopes;
        return "chat";
      },
    });
    await collect(engine, baseRun({ memoryScopes: ["project:p-1"] }));
    expect(seen).toEqual(["project:p-1"]);
  });

  it("are absent when the run named none", async () => {
    let seen: readonly string[] | undefined = ["sentinel"];
    const { engine } = engineWith({
      systemPrompt: (_m: unknown, ctx: ExecutionContext) => {
        seen = ctx.memoryScopes;
        return "chat";
      },
    });
    await collect(engine, baseRun());
    expect(seen).toBeUndefined();
  });
});

describe("AC-1 — two runs in one conversation, two models, two records", () => {
  it("each usage row carries the model and effort that actually served it", async () => {
    const runs = createMemoryRunStore();
    const checkpoints = createMemoryCheckpointStore();
    const usage = createMemoryUsageStore();
    const { engine } = engineWith({ runModels: catalogue() });
    const worker = createDurableWorker({
      runs,
      checkpoints,
      publisher: { publish: async () => undefined },
      engine,
      buildContext: (run: Run) => ({ ...context, runId: run.id }),
      workerId: "w1",
      usage: createUsageRecorder({ store: usage, pricing: { resolve: () => null } }),
    });

    const first = asId<RunId>("run-a");
    const second = asId<RunId>("run-b");
    const admit = (id: RunId, over: { model: string; effort?: "low" | "medium" | "high" }) =>
      runs.create({ tenantId: T, id, conversationId: CONVO, agentId: asId<AgentId>("a1"), agentVersion: 1, ...over });
    await admit(first, { model: "claude-opus-5", effort: "high" });
    await admit(second, { model: "mistral-large", effort: "high" });

    expect((await worker.process({ tenantId: T, runId: first })).outcome).toBe("completed");
    expect((await worker.process({ tenantId: T, runId: second })).outcome).toBe("completed");

    const a = (await usage.listByRun({ tenantId: T, runId: first, limit: 10 })).items;
    const b = (await usage.listByRun({ tenantId: T, runId: second, limit: 10 })).items;
    expect(a.map((u) => [u.modelId, u.effort, u.conversationId])).toEqual([["claude-opus-5", "high", CONVO]]);
    // Same conversation, its own model — and no effort, because Mistral could not honour it.
    expect(b.map((u) => [u.modelId, u.effort, u.conversationId])).toEqual([["mistral-large", undefined, CONVO]]);
  });
});
