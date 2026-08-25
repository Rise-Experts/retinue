/**
 * The model, from configuration — #155.
 *
 * Any OpenAI-compatible endpoint: `api.openai.com` when `AGENTKIT_MODEL_BASE_URL` is unset, or a local server
 * (Ollama, llama.cpp, Unsloth Studio, vLLM) when it is set. The provider factory in `models/` already handles
 * both, so this file is configuration reading and nothing else.
 *
 * **It refuses to start without a key.** Every other option has a defensible default; this one does not. A
 * fallback would mean an example that boots and then fails on the first turn with a provider error, which is a
 * much worse message than "you did not set the key".
 *
 * A note on model choice from testing this: an agent needs **tool calling**. A local 8B GGUF returned an empty
 * message with `tool_calls: null` for a request a hosted model answered with a correct call, so the example
 * defaults to a model known to support it rather than to whatever happens to be running.
 */

import { createProviderFactory } from "@agentkit/backend/providers";
import type { ModelDefinition, ModelPricing, ResolvedModel } from "@agentkit/backend";

export const MODEL_API_KEY_VARIABLE = "AGENTKIT_MODEL_API_KEY";
export const MODEL_ID_VARIABLE = "AGENTKIT_MODEL_ID";
export const MODEL_BASE_URL_VARIABLE = "AGENTKIT_MODEL_BASE_URL";

/**
 * The default model.
 *
 * `gpt-4o`, not `gpt-4o-mini`. Mini is enough to verify that the plumbing works — tool calls, streaming, the
 * approval gate — and that is what it was chosen for while the platform was being wired up. It is visibly weaker
 * at *conversation*: shorter, flatter answers, and it drops instructions from a long system prompt more often.
 *
 * Cost is the trade, and for an example the right side of it is the one that makes the platform look like itself
 * rather than like the cheapest model available. Override with `AGENTKIT_MODEL_ID` — `gpt-5` is a further step up
 * again, and any OpenAI-compatible endpoint works via `AGENTKIT_MODEL_BASE_URL`.
 */
export const DEFAULT_MODEL_ID = "gpt-4o";

export class ModelNotConfigured extends Error {
  constructor() {
    super(
      `${MODEL_API_KEY_VARIABLE} is required. Set it to an OpenAI key, or to any key your ` +
        `${MODEL_BASE_URL_VARIABLE} endpoint accepts. There is no default: an example that booted without one ` +
        `would fail on the first turn with a provider error instead of telling you what is missing.`,
    );
    this.name = "ModelNotConfigured";
  }
}

export type ExampleModel = {
  readonly model: ResolvedModel;
  readonly modelId: string;
  /** Where it points, for the startup banner. Never the key — see #145 SEC-001. */
  readonly endpoint: string;
  readonly definition: ModelDefinition;
};

export const resolveExampleModel = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExampleModel => {
  const apiKey = env[MODEL_API_KEY_VARIABLE]?.trim();
  if (apiKey === undefined || apiKey === "") throw new ModelNotConfigured();

  const modelId = env[MODEL_ID_VARIABLE]?.trim() || DEFAULT_MODEL_ID;
  const baseURL = env[MODEL_BASE_URL_VARIABLE]?.trim();

  // `openai-compatible` rather than `openai` whenever a base URL is given: the dedicated OpenAI provider assumes
  // endpoints a local server may not implement, and the failure is a 404 on a path nobody chose.
  const provider = baseURL === undefined || baseURL === "" ? "openai" : "openai-compatible";
  const factory = createProviderFactory({
    credentials: {
      [provider]: { apiKey, ...(baseURL !== undefined && baseURL !== "" ? { baseURL } : {}), name: "example" },
    },
  });

  return {
    model: factory.languageModel(definitionFor({ provider, modelId })),
    modelId,
    endpoint: baseURL === undefined || baseURL === "" ? "https://api.openai.com/v1" : baseURL,
    definition: definitionFor({ provider, modelId }),
  };
};

/**
 * A `ModelDefinition` for a configured model id.
 *
 * The platform's definition carries pricing, limits and capabilities — real facts about a real model, and this
 * file cannot know them for an arbitrary id the operator typed. So the numbers are **deliberately zero** and the
 * example does not pretend otherwise: a usage panel showing a cost derived from invented prices is worse than
 * one showing zero, because zero is obviously not a measurement and a plausible number is not obviously wrong.
 *
 * `tools: true` is the one capability asserted rather than zeroed, because the example's whole point is the tool
 * path — and if the configured model cannot call tools, failing on the first turn is the correct outcome.
 */
/**
 * Prices, only if the operator supplied them — #155 AC-5.
 *
 * `AGENTKIT_MODEL_PRICE_INPUT` and `_OUTPUT`, in minor units per million tokens (so `250` is $2.50/M). Absent
 * means **zero**, and zero is the honest answer: this file cannot know what an arbitrary model id the operator
 * typed costs, and a usage panel showing a cost derived from invented prices is worse than one showing zero.
 * Zero is obviously not a measurement; a plausible number is not obviously wrong.
 *
 * Tokens are recorded either way. How many a run consumed is a fact whether or not anyone knows the price, so
 * the panel is useful with no prices set — it simply has no money in it.
 */
export const examplePricing = (env: Readonly<Record<string, string | undefined>> = process.env): ModelPricing => {
  const read = (name: string): number => {
    const raw = Number(env[name]);
    // Non-finite and negative both mean "not a price". Silently treating them as zero beats failing to boot
    // over a cosmetic panel — but a *negative* price would make spend fall as usage rises, so it is rejected
    // rather than passed through.
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  };
  return {
    currency: env["AGENTKIT_MODEL_PRICE_CURRENCY"] ?? "USD",
    inputPerMillion: read("AGENTKIT_MODEL_PRICE_INPUT"),
    outputPerMillion: read("AGENTKIT_MODEL_PRICE_OUTPUT"),
  };
};

export const definitionFor = (input: { readonly provider: string; readonly modelId: string }): ModelDefinition => ({
  provider: input.provider as ModelDefinition["provider"],
  modelId: input.modelId,
  label: `example:${input.modelId}`,
  lifecycle: "generally-available",
  inputModalities: ["text"],
  capabilities: { tools: true, structuredOutput: true, reasoning: false, nativeSearch: false },
  // Generous but finite. A context limit of zero would make the assembler refuse every prompt, and an
  // unbounded one would remove the budgeting the platform does on purpose.
  limits: { contextTokens: 128_000, maxOutputTokens: 4_096 },
  // Zero, and honest about it. See above.
  pricing: examplePricing(),
  dataResidency: [],
});
