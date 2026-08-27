/**
 * Declaring an agent — the half of `agent.ts` that needs no provider (#196).
 *
 * `defineAgent`, the execution defaults and the starter catalog are **declarations**: data describing what an
 * agent is. They stay reachable from the package root because nothing about writing one requires a model SDK.
 *
 * `createAgent` — the embedded facade that builds a provider factory from credentials — stayed in `agent.ts` and
 * moved behind the `providers` entry. That convenience is the one thing here that costs six optional peers, and
 * the cost belongs in the import path rather than being paid by everyone who imports the root.
 */

import type { ModelDefinition, ModelRoleAssignments } from "../models/index.js";
import type { AgentManifest } from "./index.js";

/** The subset a caller must supply; everything else gets a sensible default. */
export type AgentManifestInput = Pick<AgentManifest, "id" | "name" | "instructions" | "modelPolicy"> &
  Partial<AgentManifest>;

export const DEFAULT_EXECUTION_LIMITS: AgentManifest["limits"] = {
  maxSteps: 8,
  maxToolCalls: 16,
  wallClockTimeoutMs: 120_000,
  maxInputTokens: 100_000,
  maxOutputTokens: 4_096,
  costCeilingMinorUnits: 100_000,
  maxRetries: 5,
  retryBackoffMs: 500,
  maxInlineToolOutputBytes: 8_192,
};

/** Fill a partial manifest with defaults so the common case is a few fields. */
export const defineAgent = (input: AgentManifestInput): AgentManifest => ({
  version: 1,
  description: "",
  responseFormat: { kind: "text" },
  toolPolicy: { preloaded: [], categories: [], excluded: [] },
  skillPolicy: { assigned: [], allowTenantSkills: false },
  authorizationPolicyId: "default",
  contextProviderIds: [],
  limits: DEFAULT_EXECUTION_LIMITS,
  ...input,
});

/** A small default catalog so `modelPolicy: { role: "smart" }` resolves out of the box. */
export const DEFAULT_MODEL_CATALOG: readonly ModelDefinition[] = [
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    lifecycle: "generally-available",
    inputModalities: ["text", "image"],
    capabilities: { tools: true, structuredOutput: true, reasoning: true, nativeSearch: false, promptCaching: "explicit" },
    limits: { contextTokens: 200_000, maxOutputTokens: 8_192 },
    /**
     * Cache rates, added by #247.
     *
     * Anthropic's published ratios: a cache **read** is 0.1× a fresh input token and a cache **write** is
     * **1.25×** — a write costs *more*. `cacheWritePerMillion` was in `ModelPricing` and read by nothing, so a
     * cache write was billed as ordinary input and the first turn of every conversation was under-billed.
     */
    pricing: {
      currency: "USD",
      inputPerMillion: 3_000,
      outputPerMillion: 15_000,
      cacheReadPerMillion: 300,
      cacheWritePerMillion: 3_750,
    },
    dataResidency: ["us"],
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    lifecycle: "generally-available",
    inputModalities: ["text", "image"],
    capabilities: { tools: true, structuredOutput: true, reasoning: false, nativeSearch: false, promptCaching: "explicit" },
    limits: { contextTokens: 200_000, maxOutputTokens: 8_192 },
    pricing: {
      currency: "USD",
      inputPerMillion: 800,
      outputPerMillion: 4_000,
      // Same ratios as Sonnet above: read 0.1×, write 1.25×.
      cacheReadPerMillion: 80,
      cacheWritePerMillion: 1_000,
    },
    dataResidency: ["us"],
  },
];

export const DEFAULT_ROLE_ASSIGNMENTS: ModelRoleAssignments = {
  smart: ["claude-sonnet-5"],
  fast: ["claude-haiku-4-5-20251001"],
};
