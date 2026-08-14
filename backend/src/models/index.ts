/**
 * Model platform — `docs/03-intelligence-runtime.md`.
 *
 * Provider-neutral. Agents state a policy and a role; they never hardcode model IDs.
 */

export const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "azure-openai",
  "bedrock",
  "openai-compatible",
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export type ModelLifecycle = "preview" | "generally-available" | "deprecated" | "retired";

export type InputModality = "text" | "image" | "audio" | "video" | "pdf";

export type ModelCapabilities = {
  readonly tools: boolean;
  readonly structuredOutput: boolean;
  readonly reasoning: boolean;
  readonly nativeSearch: boolean;
};

export type ModelLimits = {
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
};

/** Prices are per million tokens, in minor currency units, to avoid float drift. */
export type ModelPricing = {
  readonly currency: string;
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
};

export type ModelDefinition = {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly label: string;
  readonly lifecycle: ModelLifecycle;
  readonly inputModalities: readonly InputModality[];
  readonly capabilities: ModelCapabilities;
  readonly limits: ModelLimits;
  readonly pricing: ModelPricing;
  /** ISO 3166 regions the provider will process this model's data in. */
  readonly dataResidency: readonly string[];
};

/** `fast` and `smart` let an agent express intent without naming a model. */
export type ModelRole = "fast" | "smart";

export type ModelPolicy = {
  readonly role: ModelRole;
  readonly requiredCapabilities?: Partial<ModelCapabilities>;
  readonly requiredModalities?: readonly InputModality[];
  readonly allowedProviders?: readonly ModelProvider[];
  readonly dataResidency?: readonly string[];
  /** Ceiling per run, in the pricing currency's minor units. */
  readonly costCeilingMinorUnits?: number;
};

/**
 * Resolution considers administrator policy, tenant policy, required capabilities,
 * data residency, availability, cost ceiling and deprecation state.
 */
export interface ModelRegistry {
  list(): readonly ModelDefinition[];
  resolve(policy: ModelPolicy): ModelDefinition;
}
