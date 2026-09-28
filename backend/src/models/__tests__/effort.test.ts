/**
 * Per-run reasoning effort — #286, AC-2: "`effort: high` reaches each supported provider's option (unit test per
 * provider); an unsupported provider reports 'effort ignored'".
 *
 * Two layers, and the second is the one that matters. The mapping table is easy to get right and easy to test; what
 * is easy to get wrong is the *name*. `ai@7` ignores an unknown provider-option key rather than rejecting it, so a
 * mapping that says `budget_tokens` where the SDK reads `budgetTokens` typechecks, passes every test written against
 * the table, and sends nothing — the `experimental_output` defect #243 met, in another field. So each supported
 * provider is also driven through its **real AI SDK provider** with a fetch that captures the HTTP body, and the
 * assertion is on the wire: the thing the vendor would actually receive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import {
  EFFORT_THINKING_BUDGETS,
  isReasoningEffort,
  mapReasoningEffort,
  mergeProviderOptions,
  providerOfModel,
  type EffortMapping,
} from "../effort.js";
import { streamModelTurn, type ResolvedModel } from "../streaming.js";
import type { ModelDefinition, ModelProvider } from "../index.js";

const definition = (provider: ModelProvider, reasoning = true): ModelDefinition => ({
  provider,
  modelId: `${provider}-model`,
  label: provider,
  lifecycle: "generally-available",
  inputModalities: ["text"],
  capabilities: { tools: true, structuredOutput: true, reasoning, nativeSearch: false },
  limits: { contextTokens: 100_000, maxOutputTokens: 4_096 },
  pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
  dataResidency: ["us"],
});

const applied = (m: EffortMapping) => {
  if (!m.applied) throw new Error(`expected the effort to apply, got: ${m.ignored}`);
  return m.providerOptions;
};

describe("the mapping, per provider", () => {
  it("Anthropic: effort becomes a thinking budget, which is what switches thinking on", () => {
    const options = applied(mapReasoningEffort({ effort: "high", provider: "anthropic" }));
    expect(options).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 16_384 } } });
    // The floor the API accepts, so `low` is never a request Anthropic refuses.
    expect(applied(mapReasoningEffort({ effort: "low", provider: "anthropic" }))).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 1_024 } },
    });
  });

  it("OpenAI: reasoningEffort, the same three words", () => {
    expect(applied(mapReasoningEffort({ effort: "high", provider: "openai" }))).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it("Azure OpenAI: both namespaces, because its two model kinds read different ones", () => {
    expect(applied(mapReasoningEffort({ effort: "medium", provider: "azure-openai" }))).toEqual({
      azure: { reasoningEffort: "medium" },
      openai: { reasoningEffort: "medium" },
    });
  });

  it("Google: a thinking budget under thinkingConfig", () => {
    expect(applied(mapReasoningEffort({ effort: "high", provider: "google" }))).toEqual({
      google: { thinkingConfig: { thinkingBudget: EFFORT_THINKING_BUDGETS.google.high } },
    });
  });

  it.each(["mistral", "openai-compatible"] as const)("%s has no such option, and says so", (provider) => {
    const m = mapReasoningEffort({ effort: "high", provider });
    expect(m.applied).toBe(false);
    expect(!m.applied && m.ignored).toMatch(/^effort ignored: provider .* has no reasoning-effort option$/);
  });

  it("an unknown provider is ignored with a reason, never guessed", () => {
    const m = mapReasoningEffort({ effort: "low", provider: undefined });
    expect(!m.applied && m.ignored).toMatch(/^effort ignored:.*unknown/);
  });

  it("a model that declares no reasoning is ignored even on a provider that has the option", () => {
    // Anthropic refuses a thinking block for a model without extended thinking; sending it would fail the turn.
    const m = mapReasoningEffort({ effort: "high", provider: "anthropic", definition: definition("anthropic", false) });
    expect(!m.applied && m.ignored).toBe("effort ignored: model anthropic-model does not declare the reasoning capability");
  });

  it("recognises exactly the three efforts", () => {
    expect(["low", "medium", "high"].every(isReasoningEffort)).toBe(true);
    for (const bad of ["max", "HIGH", "", undefined, 3]) expect(isReasoningEffort(bad)).toBe(false);
  });
});

describe("the provider, when the host gave no definition", () => {
  it("is read off the AI SDK model's own provider id", () => {
    const k = { apiKey: "k" };
    expect(providerOfModel(createAnthropic(k)("claude-x"))).toBe("anthropic");
    expect(providerOfModel(createOpenAI(k)("gpt-5"))).toBe("openai");
    expect(providerOfModel(createGoogleGenerativeAI(k)("gemini-2.5-flash"))).toBe("google");
    expect(providerOfModel(createAzure({ ...k, resourceName: "r" })("gpt-5"))).toBe("azure-openai");
    expect(providerOfModel(createMistral(k)("mistral-large"))).toBe("mistral");
    // A gateway string id or a wrapper with no provider: unknown, and effort is then reported as ignored.
    expect(providerOfModel("anthropic/claude")).toBeUndefined();
    expect(providerOfModel({})).toBeUndefined();
  });

  it("prefers the definition when there is one", () => {
    expect(providerOfModel(createOpenAI({ apiKey: "k" })("gpt-5"), definition("google"))).toBe("google");
  });
});

describe("merging with the prompt-cache directive", () => {
  it("keeps both when they share a namespace", () => {
    expect(
      mergeProviderOptions(
        { anthropic: { cacheControl: { type: "ephemeral" } } },
        { anthropic: { thinking: { type: "enabled", budgetTokens: 1_024 } } },
      ),
    ).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" }, thinking: { type: "enabled", budgetTokens: 1_024 } },
    });
    expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
  });
});

/**
 * A fetch that records the request body and answers 400, so the turn ends without a network and without a
 * retry (a 400 is not retryable). The body is the evidence; the error is incidental.
 */
const capturing = () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: "captured", type: "invalid_request_error" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
};

const sendWithEffort = async (
  model: ResolvedModel,
  provider: ModelProvider,
  extra: { promptCaching?: "explicit" } = {},
): Promise<void> => {
  const mapping = mapReasoningEffort({ effort: "high", provider });
  const chunks = streamModelTurn({
    model,
    system: "You are terse.",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
    ...(mapping.applied ? { providerOptions: mapping.providerOptions } : {}),
  });
  // Drained for its side effect on the fetch; the 400 surfaces as an error chunk or a throw, both expected.
  try {
    for await (const _ of chunks) void _;
  } catch {
    /* the captured 400 */
  }
};

describe("effort: high reaches the wire — AC-2, per provider", () => {
  // `streamText` logs every provider error by default, and every call here ends in the captured 400 on purpose.
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("Anthropic sends thinking.budget_tokens", async () => {
    const { bodies, fetch } = capturing();
    await sendWithEffort(createAnthropic({ apiKey: "k", fetch })("claude-sonnet-5"), "anthropic");
    expect(bodies[0]?.["thinking"]).toEqual({ type: "enabled", budget_tokens: 16_384 });
  });

  it("Anthropic keeps the cache breakpoint alongside it", async () => {
    // The regression a shallow merge would cause: caching silently off whenever effort is on.
    const { bodies, fetch } = capturing();
    await sendWithEffort(createAnthropic({ apiKey: "k", fetch })("claude-sonnet-5"), "anthropic", {
      promptCaching: "explicit",
    });
    expect(bodies[0]?.["thinking"]).toEqual({ type: "enabled", budget_tokens: 16_384 });
    // Where the SDK puts the call-level directive today: the request's top-level `cache_control`.
    expect(bodies[0]?.["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("OpenAI sends reasoning.effort", async () => {
    const { bodies, fetch } = capturing();
    await sendWithEffort(createOpenAI({ apiKey: "k", fetch })("gpt-5"), "openai");
    expect(bodies[0]?.["reasoning"]).toMatchObject({ effort: "high" });
  });

  it("Azure OpenAI sends reasoning.effort", async () => {
    const { bodies, fetch } = capturing();
    await sendWithEffort(createAzure({ apiKey: "k", resourceName: "r", fetch })("gpt-5"), "azure-openai");
    expect(bodies[0]?.["reasoning"]).toMatchObject({ effort: "high" });
  });

  it("Google sends generationConfig.thinkingConfig.thinkingBudget", async () => {
    const { bodies, fetch } = capturing();
    await sendWithEffort(createGoogleGenerativeAI({ apiKey: "k", fetch })("gemini-2.5-flash"), "google");
    expect((bodies[0]?.["generationConfig"] as Record<string, unknown> | undefined)?.["thinkingConfig"]).toMatchObject({
      thinkingBudget: EFFORT_THINKING_BUDGETS.google.high,
    });
  });

  it("Mistral sends nothing effort-shaped, because nothing was mapped", async () => {
    const { bodies, fetch } = capturing();
    await sendWithEffort(createMistral({ apiKey: "k", fetch })("mistral-large-latest"), "mistral");
    const body = JSON.stringify(bodies[0] ?? {});
    for (const key of ["reasoning", "thinking", "effort"]) expect(body).not.toContain(key);
  });
});
