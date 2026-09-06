import { describe, expect, it } from "vitest";
import { type ModelDefinition, type ModelProvider } from "../models/index.js";
import { createProviderFactory } from "../models/provider-factory.js";
import { MODEL_PROVIDERS } from "../models/index.js";

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

  it("has no declared-but-unwired provider left to throw for", () => {
    /**
     * This case used to assert that `bedrock` threw `capability_unavailable`.
     *
     * It was removed from `MODEL_PROVIDERS` in #256 rather than wired, so there is nothing to assert about it:
     * a declared provider that throws is worse than an absent one — it typechecks, satisfies the factory's
     * exhaustive `never` assertion, and fails at runtime for whoever selects it first. The union is the
     * statement now, and `provider-coverage.test.ts` asserts every member of it constructs.
     *
     * `bedrock` is no longer assignable here, which is the compiler making the same point.
     */
    expect(MODEL_PROVIDERS as readonly string[]).not.toContain("bedrock");
  });
});
