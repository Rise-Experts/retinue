/**
 * The one place this deployment decides which model it uses — retinue REQ-041 (#190).
 *
 * Two things need a model: the engine, for the assistant's turns, and `structuredGenerateFrom`, for
 * content generation. They must agree. Two selections reading the same variables would agree by
 * coincidence until one gained a default the other did not, and the symptom would be a deployment
 * drafting with one vendor and conversing with another — both working, on one key, with nothing to
 * see.
 */

import type { ModelDefinition, ModelProvider, NeutralUsage } from "@retinue/agentkit";

import { modelContextWindow } from "./context-window.js";
import { optionalEnv } from "./env.js";
import { withEmptyCandidateRetry } from "./retry-empty-candidate.js";



/**
 * Published per-million prices, in USD minor units (cents × 100 — the platform's `pricing` unit).
 *
 * **Why this table exists at all.** `DEFAULT_MODEL_CATALOG` ships two Anthropic models and nothing
 * else, so a deployment on OpenAI or Google has no pricing to resolve. Without a `price` function the
 * engine emits `costMinorUnits: 0` on every `usage.updated`, and the usage ledger then records real
 * token counts against a cost of zero — which the spend view, the quota guard and the rollup all read
 * as free. Tokens without a price would be honest; tokens with a fabricated zero looks like a
 * measurement.
 *
 * **It is a hand-maintained list, which is a liability, and it is deliberately small.** Only the
 * default model of each provider is here. A model this does not know is not fatal — `resolveModel`
 * says so at boot and cost goes unrecorded rather than silently zero.
 *
 * Figures as published on 2026-09-08. They go stale; `RETINUE_MODEL_PRICE_INPUT_PER_MILLION` and
 * `RETINUE_MODEL_PRICE_OUTPUT_PER_MILLION` override without a release.
 */
export const PRICING: Readonly<Record<string, { readonly inputPerMillion: number; readonly outputPerMillion: number }>> =
  {
    "gpt-4o": { inputPerMillion: 250, outputPerMillion: 1_000 },
    "gemini-2.5-flash": { inputPerMillion: 30, outputPerMillion: 250 },
    "claude-sonnet-4-5": { inputPerMillion: 300, outputPerMillion: 1_500 },
    "mistral-large-latest": { inputPerMillion: 200, outputPerMillion: 600 },
  };

/** Pricing for a model id, preferring an explicit override over the table. */
export const pricingFor = (
  modelId: string,
  env: Readonly<Record<string, string | undefined>>,
): { readonly inputPerMillion: number; readonly outputPerMillion: number } | undefined => {
  const input = Number(env["RETINUE_MODEL_PRICE_INPUT_PER_MILLION"]);
  const output = Number(env["RETINUE_MODEL_PRICE_OUTPUT_PER_MILLION"]);
  // Both or neither: one half of a price is worse than none, because it under-reports rather than
  // reporting nothing, and an under-report is indistinguishable from a cheap month.
  if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
    return { inputPerMillion: input, outputPerMillion: output };
  }
  return PRICING[modelId];
};

export type ModelSelection = {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly apiKey: string;
};

/**
 * Defaulted per provider, because `gpt-4o` is not a model any of the others has.
 *
 * Only so the common cases need no extra variable; a deployment naming `RETINUE_MODEL_ID` still wins.
 */
export const DEFAULT_MODEL_IDS: Readonly<Record<string, string>> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
  mistral: "mistral-large-latest",
  "azure-openai": "gpt-4o",
  "openai-compatible": "gpt-4o",
};

/**
 * Read and validate the selection.
 *
 * The provider is checked against the platform's own exported list rather than a copy. An unrecognised
 * name is otherwise silent: `createProviderFactory` takes
 * `Partial<Record<ModelProvider, ProviderCredentials>>`, so a typo files the credential under a key
 * nothing reads, the factory looks configured, and the failure arrives inside the first model call.
 */
export const modelSelectionFrom = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ModelSelection> => {
  const apiKey = env["RETINUE_MODEL_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "RETINUE_MODEL_API_KEY is required: every turn is a model call, and a deployment without one " +
        "would admit work and fail inside it. The provider it belongs to is RETINUE_MODEL_PROVIDER " +
        "(default openai).",
    );
  }

  const { MODEL_PROVIDERS } = await import("@retinue/agentkit/runtime");
  /**
   * **Deliberately the raw read, not `optionalEnv`.** A blank provider is refused, not defaulted.
   *
   * The model id below defaults on blank, and these two variables genuinely differ. An absent model id
   * has a safe provider-specific default. An absent *provider* does not, because the key is already
   * set and provider-specific: defaulting to `openai` would send a Google key to OpenAI, which is the
   * exact hazard the compose file warns about — and it would fail inside the first model call instead
   * of at boot. `module.test.ts` asserts the refusal, and it caught this being "tidied" into a default.
   */
  const provider = env["RETINUE_MODEL_PROVIDER"] ?? "openai";
  if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `RETINUE_MODEL_PROVIDER must be one of ${MODEL_PROVIDERS.join(", ")} — got "${provider}". An ` +
        `unrecognised name would file the credential under a key nothing reads, and the deployment would ` +
        `look configured and fail inside its first model call.`,
    );
  }

  /**
   * **`optionalEnv`, not `??` on the raw read.** Compose passes an unset optional variable through as the
   * empty string, and `""` is not a model — see env.ts. This line resolved to `""` on the deployed
   * backend and every generation came back 404 Not Found.
   */
  const modelId = optionalEnv("RETINUE_MODEL_ID", env) ?? DEFAULT_MODEL_IDS[provider] ?? "gpt-4o";
  return { provider: provider as ModelProvider, modelId, apiKey };
};

/**
 * A `ModelDefinition` for the selected model.
 *
 * `contextTokens` is the model's real window from `context-window.ts` (#630). It was 0 ("no declared
 * ceiling"), which left every model sized against the same fixed 120,000; the table errs small for a model
 * it does not know, since too small only condenses a thread early while too large is a rejected request.
 */
export const definitionFor = (
  selection: ModelSelection,
  pricing: { readonly inputPerMillion: number; readonly outputPerMillion: number } | undefined,
): ModelDefinition =>
  ({
    id: selection.modelId,
    provider: selection.provider,
    modelId: selection.modelId,
    displayName: selection.modelId,
    capabilities: { tools: true, streaming: true, structuredOutput: true },
    limits: { contextTokens: modelContextWindow(selection.modelId), maxOutputTokens: 8_192 },
    ...(pricing === undefined
      ? {}
      : { pricing: { currency: "USD", inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion } }),
  }) as unknown as ModelDefinition;

/**
 * The model, resolved for a turn, with cost attribution when it can be attributed.
 *
 * **When it cannot, that is said out loud.** Without a `price` the engine emits `costMinorUnits: 0` on
 * every usage event, so the ledger records real tokens against zero cost and the spend view reads as
 * free. That is not a number to ship silently, so an unpriced model warns once at boot and names the
 * two variables that fix it — legible rather than blocking, because a deployment with no public users
 * should not be unable to start over a price table.
 */
export const resolveModelForTurn = async (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const selection = await modelSelectionFrom(env);
  const pricing = pricingFor(selection.modelId, env);
  if (pricing === undefined) {
    console.warn(
      `[shareflow] no pricing for "${selection.modelId}" — usage will be recorded with a cost of zero. ` +
        `Set RETINUE_MODEL_PRICE_INPUT_PER_MILLION and RETINUE_MODEL_PRICE_OUTPUT_PER_MILLION, or add it ` +
        `to PRICING in src/app/model.ts. Known: ${Object.keys(PRICING).join(", ")}.`,
    );
  }

  const { createProviderFactory } = await import("@retinue/agentkit/providers");
  const { computeModelCostMinorUnits } = await import("@retinue/agentkit/runtime");
  const factory = createProviderFactory({
    credentials: { [selection.provider]: { apiKey: selection.apiKey, name: "shareflow" } },
  } as never);
  const definition = definitionFor(selection, pricing);

  return {
    /**
     * Wrapped, so a candidate with **no content in it** is asked again before the engine sees it.
     *
     * The provider does that occasionally on ordinary requests, and the platform's `finish` handler
     * reads `totalUsage` without looking at `finishReason` — so an empty candidate becomes a completed
     * run with zero parts, which from the app is a message sent and nothing at all in reply.
     * `retry-empty-candidate.ts` has the recorded response and the measurements.
     */
    model: withEmptyCandidateRetry(
      (factory as { languageModel: (definition: unknown) => never }).languageModel(definition),
    ),
    modelId: selection.modelId,
    currency: "USD",
    definition,
    ...(pricing === undefined
      ? {}
      : {
          /**
           * The platform's own arithmetic, so the spend view's figure and a quota ceiling's figure
           * cannot disagree about what a million tokens costs.
           *
           * Cached and multimodal counts are forwarded because whether they change the figure is the
           * *pricing record's* decision, not this app's: `computeModelCostMinorUnits` ignores them
           * unless the record says the provider charges separately. Passing them is free where it does
           * not apply and correct where it does — and dropping them would be a silent shortfall that
           * scales with every image anyone sends.
           */
          price: (usage: NeutralUsage) =>
            computeModelCostMinorUnits(definition.pricing, {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
              ...(usage.imageCount === undefined ? {} : { imageCount: usage.imageCount }),
              ...(usage.audioSeconds === undefined ? {} : { audioSeconds: usage.audioSeconds }),
            }),
        }),
  };
};

/**
 * Other models on the deployment's own key — #551, `RETINUE_MODEL_CHOICES`.
 *
 * Same provider, same credential, a different model id; built once per id and wrapped in the same
 * empty-candidate retry as the default, so picking another model never loses that protection.
 */
export const deploymentModelFactory = async (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const selection = await modelSelectionFrom(env);
  const { createProviderFactory } = await import("@retinue/agentkit/providers");
  const factory = createProviderFactory({
    credentials: { [selection.provider]: { apiKey: selection.apiKey, name: "shareflow" } },
  } as never);
  const built = new Map<string, unknown>();
  return {
    provider: selection.provider as string,
    modelId: selection.modelId,
    modelFor: async (modelId: string): Promise<unknown> => {
      const existing = built.get(modelId);
      if (existing !== undefined) return existing;
      const model = withEmptyCandidateRetry(
        (factory as { languageModel: (definition: unknown) => never }).languageModel(definitionFor({ ...selection, modelId }, pricingFor(modelId, env))),
      );
      built.set(modelId, model);
      return model;
    },
  };
};
