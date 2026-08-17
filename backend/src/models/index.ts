/**
 * Model platform — `docs/03-intelligence-runtime.md`.
 *
 * Provider-neutral. Agents state a policy and a role; they never hardcode model IDs.
 */

import { AgentPlatformError } from "../core/errors.js";

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

/** Administrator/tenant policy: ordered candidate model IDs per role (most preferred first). */
export type ModelRoleAssignments = Readonly<Record<ModelRole, readonly string[]>>;

export type ModelRegistryConfig = {
  readonly models: readonly ModelDefinition[];
  readonly roles: ModelRoleAssignments;
};

const covers = (have: readonly string[], need: readonly string[]): boolean =>
  need.every((n) => have.includes(n));

/** A model is eligible when it clears every hard constraint in the policy. */
const eligible = (m: ModelDefinition, p: ModelPolicy): boolean => {
  if (m.lifecycle === "retired") return false;
  if (p.allowedProviders && !p.allowedProviders.includes(m.provider)) return false;
  if (p.requiredModalities && !covers(m.inputModalities, p.requiredModalities)) return false;
  if (p.dataResidency && !covers(m.dataResidency, p.dataResidency)) return false;
  if (p.requiredCapabilities) {
    for (const key of Object.keys(p.requiredCapabilities) as (keyof ModelCapabilities)[]) {
      if (p.requiredCapabilities[key] && !m.capabilities[key]) return false;
    }
  }
  // Cost ceiling is honored at resolution as an output-price ceiling; the per-run budget is
  // separately enforced at execution by the usage recorder.
  if (p.costCeilingMinorUnits !== undefined && m.pricing.outputPerMillion > p.costCeilingMinorUnits) {
    return false;
  }
  return true;
};

/**
 * Resolves a role + constraints to a concrete model using the administrator's role assignments.
 * Agents never name a model, so re-pointing a role here changes no agent code.
 */
export const createModelRegistry = (config: ModelRegistryConfig): ModelRegistry => {
  const byId = new Map(config.models.map((m) => [m.modelId, m]));
  return {
    list: () => config.models,
    resolve: (policy) => {
      for (const id of config.roles[policy.role] ?? []) {
        const m = byId.get(id);
        if (m && eligible(m, policy)) return m;
      }
      throw new AgentPlatformError({
        code: "capability_unavailable",
        message: `No model satisfies role '${policy.role}' with the requested constraints`,
        retryable: false,
      });
    },
  };
};

/**
 * Cost of a unit of usage, in the pricing currency's minor units. Prices are per-million tokens.
 * Cached input is billed at the cache-read rate when present. This is what feeds usage accounting.
 */
export const computeModelCostMinorUnits = (
  pricing: ModelPricing,
  usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number },
): number => {
  const cachedIn = usage.cachedInputTokens ?? 0;
  const freshIn = Math.max(0, usage.inputTokens - cachedIn);
  const perMillion = (tokens: number, price: number): number => (tokens * price) / 1_000_000;
  return Math.round(
    perMillion(freshIn, pricing.inputPerMillion) +
      perMillion(cachedIn, pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
      perMillion(usage.outputTokens, pricing.outputPerMillion),
  );
};
