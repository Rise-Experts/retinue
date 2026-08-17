import { describe, expect, it } from "vitest";
import { createProviderFactory, type ModelDefinition, type ModelProvider } from "../models/index.js";

const def = (provider: ModelProvider, modelId: string): ModelDefinition => ({
  provider, modelId, label: "m", lifecycle: "generally-available",
  inputModalities: ["text"],
  capabilities: { tools: true, structuredOutput: true, reasoning: false, nativeSearch: false },
  limits: { contextTokens: 1, maxOutputTokens: 1 },
  pricing: { currency: "usd", inputPerMillion: 1, outputPerMillion: 1 },
  dataResidency: ["us"],
});

const factory = createProviderFactory({
  credentials: {
    openai: { apiKey: "k" },
    anthropic: { apiKey: "k" },
    google: { apiKey: "k" },
    mistral: { apiKey: "k" },
    "azure-openai": { apiKey: "k", resourceName: "res" },
    "openai-compatible": { baseURL: "https://example.test/v1", apiKey: "k" },
  },
});

describe("provider factory", () => {
  it("builds a language model for the SDK-backed providers", () => {
    for (const p of ["openai", "anthropic", "google", "mistral", "azure-openai"] as const) {
      expect(factory.languageModel(def(p, "some-model"))).toBeTruthy();
    }
  });

  it("builds an openai-compatible model when a baseURL is provided", () => {
    expect(factory.languageModel(def("openai-compatible", "local"))).toBeTruthy();
  });

  it("requires a baseURL for openai-compatible", () => {
    expect(() => createProviderFactory().languageModel(def("openai-compatible", "x"))).toThrow(/baseURL/);
  });

  it("throws capability_unavailable for the not-yet-wired Bedrock provider", () => {
    expect(() => factory.languageModel(def("bedrock", "x"))).toThrow(/Bedrock/);
  });
});
