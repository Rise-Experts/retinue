import { describe, expect, it } from "vitest";
import {
  computeModelCostMinorUnits,
  createModelRegistry,
  type ModelDefinition,
} from "../models/index.js";

const base = {
  label: "m",
  lifecycle: "generally-available" as const,
  inputModalities: ["text"] as const,
  limits: { contextTokens: 128000, maxOutputTokens: 4096 },
};

const fast: ModelDefinition = {
  ...base, provider: "openai", modelId: "gpt-fast",
  capabilities: { tools: true, structuredOutput: true, reasoning: false, nativeSearch: false },
  pricing: { currency: "usd", inputPerMillion: 15, outputPerMillion: 60 },
  dataResidency: ["us"],
};
const smart: ModelDefinition = {
  ...base, provider: "openai", modelId: "gpt-smart",
  capabilities: { tools: true, structuredOutput: true, reasoning: true, nativeSearch: false },
  pricing: { currency: "usd", inputPerMillion: 300, outputPerMillion: 1500 },
  dataResidency: ["us", "eu"],
};
const euCheap: ModelDefinition = {
  ...base, provider: "mistral", modelId: "mistral-eu",
  capabilities: { tools: true, structuredOutput: true, reasoning: true, nativeSearch: false },
  pricing: { currency: "usd", inputPerMillion: 20, outputPerMillion: 40 },
  dataResidency: ["eu"],
};

describe("model resolution", () => {
  const registry = createModelRegistry({
    models: [fast, smart, euCheap],
    roles: { fast: ["gpt-fast"], smart: ["gpt-smart", "mistral-eu"] },
  });

  it("resolves a role to a concrete model", () => {
    expect(registry.resolve({ role: "fast" }).modelId).toBe("gpt-fast");
    expect(registry.resolve({ role: "smart" }).modelId).toBe("gpt-smart");
  });

  it("re-pointing a role changes the model with no change to the agent's policy", () => {
    const policy = { role: "smart" as const }; // the agent's policy is unchanged
    const rerouted = createModelRegistry({
      models: [fast, smart, euCheap],
      roles: { fast: ["gpt-fast"], smart: ["mistral-eu"] },
    });
    expect(rerouted.resolve(policy).modelId).toBe("mistral-eu");
  });

  it("honors data residency", () => {
    // smart candidate order is [gpt-smart(us,eu), mistral-eu(eu)]; requiring US-only excludes mistral
    expect(registry.resolve({ role: "smart", dataResidency: ["us"] }).modelId).toBe("gpt-smart");
    expect(() => registry.resolve({ role: "fast", dataResidency: ["eu"] })).toThrow(/No model/);
  });

  it("honors the cost ceiling by skipping over-budget models", () => {
    // gpt-smart output 1500 > 100 → skipped; mistral-eu output 40 ≤ 100 → chosen
    expect(registry.resolve({ role: "smart", costCeilingMinorUnits: 100 }).modelId).toBe("mistral-eu");
  });

  it("honors required capabilities", () => {
    expect(() => registry.resolve({ role: "fast", requiredCapabilities: { reasoning: true } })).toThrow(/No model/);
  });

  it("throws capability_unavailable when nothing fits", () => {
    expect(() => registry.resolve({ role: "smart", allowedProviders: ["google"] })).toThrow(/No model/);
  });
});

describe("cost computation", () => {
  it("computes cost from per-million pricing", () => {
    expect(
      computeModelCostMinorUnits(smart.pricing, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(1800); // 300 + 1500
  });

  it("bills cached input at the cache-read rate", () => {
    const pricing = { currency: "usd", inputPerMillion: 300, outputPerMillion: 1500, cacheReadPerMillion: 30 };
    expect(
      computeModelCostMinorUnits(pricing, { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 500_000 }),
    ).toBe(1665); // fresh 500k*300/M=150 + cached 500k*30/M=15 + output 1500
  });
});
