/**
 * Model platform — `docs/03-intelligence-runtime.md`.
 *
 * Provider-neutral. Agents state a policy and a role; they never hardcode model IDs.
 */

import { AgentPlatformError } from "../core/errors.js";

/**
 * The providers that actually resolve — REQ-061 (#255), task #256.
 *
 * `"bedrock"` was here and threw `capability_unavailable` when selected. It is gone, and removing it rather
 * than wiring it is the decision:
 *
 * - **A declared provider that throws is worse than an absent one.** It typechecks, satisfies the exhaustive
 *   `switch`, and fails at runtime for whoever selects it first — and it survived precisely because a closed
 *   union reads as complete coverage. The type system guarantees every member is *mentioned*; only a call
 *   finds out whether it is *served*.
 * - **Wiring it could not be verified.** #256's AC-5 requires one real turn as evidence, and constructing a
 *   Bedrock model needs no network — so an unverified wiring would satisfy "resolves" while leaving its first
 *   user as its first tester. #268 settled that precedent.
 *
 * Nothing is lost today: nothing could select it and get a model. Adding it back is a one-line change plus a
 * `provider-coverage.test.ts` case, and that test is what will force the verification then rather than allow
 * the same gap again.
 *
 * Vertex is absent for a different reason, argued in `docs/03`: it serves the same Gemini models the `google`
 * provider does, differing in credentials rather than model family, so a second member would make every
 * `allowedProviders` policy name both to mean "Gemini".
 */
export const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "azure-openai",
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
  /**
   * How this model caches a repeated prompt prefix — task #247.
   *
   * Three values because the providers genuinely differ in a way that changes what this platform must *send*,
   * not merely what it can expect back:
   *
   * - `"automatic"` — the provider caches a matching prefix on its own, with no directive. OpenAI. Nothing to
   *   emit; the only thing that matters is that the prefix is byte-stable.
   * - `"explicit"` — the provider caches only what is marked. Anthropic, via `cache_control` breakpoints. A
   *   platform that emits nothing gets no caching at all here, which is how this was losing the discount.
   * - `"none"` — no prompt caching. Emitting a directive would be an unknown field at best and an error at worst.
   *
   * Optional, and absent means `"none"`: an existing catalogue entry keeps behaving exactly as it did, and a
   * provider that does cache has to be declared rather than assumed. Assuming the other way would send
   * breakpoints to providers that reject them.
   */
  readonly promptCaching?: "automatic" | "explicit" | "none";
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
  /**
   * How this provider charges for non-text input — REQ-036 (#185), AC-4.
   *
   * The field exists because getting it wrong is a wrong bill in **either** direction, and the two conventions
   * are indistinguishable from the token counts alone:
   *
   * - `"in-input-tokens"` (the default, and what OpenAI does): an image is converted to input tokens by the
   *   provider and already counted in `inputTokens`. Adding a per-image charge on top **double-bills**.
   * - `"per-unit"`: images and audio are billed separately, per image or per second, *in addition* to the text
   *   tokens. Not adding the charge **under-bills**, silently, and the shortfall scales with usage.
   *
   * Defaulting to `"in-input-tokens"` is the safe direction for the model catalogue we ship, and it means every
   * existing pricing record keeps costing exactly what it did.
   */
  readonly nonTextInput?: "in-input-tokens" | "per-unit";
  /** Minor units per image sent. Only consulted when `nonTextInput` is `"per-unit"`. */
  readonly perImageMinorUnits?: number;
  /** Minor units per second of audio input. Only consulted when `nonTextInput` is `"per-unit"`. */
  readonly perAudioSecondMinorUnits?: number;
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

/**
 * Why a model fails a policy's hard constraints, or `undefined` when it clears them all.
 *
 * A reason rather than a boolean since #286: a run that *names* a model has to be told why that model was
 * refused, and "not eligible" gives a person nothing to change. `eligible` below is this with the reason dropped,
 * so role resolution and per-run validation cannot come to disagree about what the constraints are.
 */
export const ineligibilityReason = (m: ModelDefinition, p: Omit<ModelPolicy, "role">): string | undefined => {
  if (m.lifecycle === "retired") return `model ${m.modelId} is retired`;
  if (p.allowedProviders && !p.allowedProviders.includes(m.provider))
    return `provider ${m.provider} is not among the allowed providers (${p.allowedProviders.join(", ")})`;
  if (p.requiredModalities && !covers(m.inputModalities, p.requiredModalities))
    return `model ${m.modelId} does not accept ${p.requiredModalities.filter((x) => !m.inputModalities.includes(x)).join(", ")}`;
  if (p.dataResidency && !covers(m.dataResidency, p.dataResidency))
    return `model ${m.modelId} does not process data in ${p.dataResidency.filter((x) => !m.dataResidency.includes(x)).join(", ")}`;
  if (p.requiredCapabilities) {
    for (const key of Object.keys(p.requiredCapabilities) as (keyof ModelCapabilities)[]) {
      if (p.requiredCapabilities[key] && !m.capabilities[key]) return `model ${m.modelId} lacks the ${key} capability`;
    }
  }
  // Cost ceiling is honored at resolution as an output-price ceiling; the per-run budget is
  // separately enforced at execution by the usage recorder.
  if (p.costCeilingMinorUnits !== undefined && m.pricing.outputPerMillion > p.costCeilingMinorUnits) {
    return `model ${m.modelId} costs more per output token than the policy's ceiling allows`;
  }
  return undefined;
};

/** A model is eligible when it clears every hard constraint in the policy. */
const eligible = (m: ModelDefinition, p: ModelPolicy): boolean => ineligibilityReason(m, p) === undefined;

/**
 * The outcome of checking a per-run model choice — #286.
 *
 * A result rather than a throw, so a host can call this at **admission** and answer the request with a 400 and the
 * reason before a run row exists. The engine calls the same function again at execution, because a catalogue is
 * the host's and can change between the click and the turn.
 */
export type RunModelValidation =
  | { readonly ok: true; readonly definition: ModelDefinition }
  | { readonly ok: false; readonly reason: string };

/**
 * Check a model id a run asked for against the catalogue the host allows, and the agent's policy.
 *
 * **Refused, never replaced.** An unknown id is not rounded to the nearest known one and a disallowed one does not
 * fall back to the agent's role. A person who picked "Opus" and was silently served "Haiku" has been misled about
 * what they are paying for and what answered them; a refusal with a reason is the only honest outcome. This is the
 * silent-fallback failure #279 ended for tenant resolution, closed here for the per-run choice as well.
 *
 * The policy check reuses `ineligibilityReason`, minus the role: a run naming a model has already chosen, so the
 * role assignment is moot — but the agent's *hard* constraints (modalities, residency, required capabilities) are
 * properties of the agent, and a model picker must not be a way around them.
 */
export const validateRunModel = (input: {
  readonly modelId: string;
  readonly catalogue: readonly ModelDefinition[];
  readonly policy?: Omit<ModelPolicy, "role">;
}): RunModelValidation => {
  const definition = input.catalogue.find((m) => m.modelId === input.modelId);
  if (definition === undefined) {
    const allowed = input.catalogue.filter((m) => m.lifecycle !== "retired").map((m) => m.modelId);
    return {
      ok: false,
      reason:
        `model ${JSON.stringify(input.modelId)} is not in this deployment's allowed models` +
        (allowed.length === 0 ? " (the catalogue is empty)" : ` (${allowed.join(", ")})`),
    };
  }
  const reason = ineligibilityReason(definition, input.policy ?? {});
  return reason === undefined ? { ok: true, definition } : { ok: false, reason };
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
 * `provider-factory` is **not** re-exported here — #196.
 *
 * It statically imports six `@ai-sdk/*` packages, so anything that pulls this barrel pulled all six. Since they
 * are optional peers now, a root import must not reach them: a consumer using OpenAI would get a resolution
 * failure for Anthropic. It lives behind the `./providers` subpath instead.
 */

// `computeModelCostMinorUnits` moved to `./pricing.ts` (#199): reaching it through this barrel pulled
// `streaming.js`, and with it the AI SDK, into the in-memory usage adapter. Re-exported here so the models
// subpath still offers it in one place.
export { computeModelCostMinorUnits } from "./pricing.js";

export * from "./streaming.js";
export * from "./effort.js";
