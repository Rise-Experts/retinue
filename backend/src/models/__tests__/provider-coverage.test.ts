/**
 * Every `ModelProvider` resolves to a `LanguageModel` — REQ-061 (#255), task #256, AC-1.
 *
 * The AC asks for this check to land **before** any wiring, and to be shown failing first: *"a check that
 * first appears alongside its own fix has never been seen to work."* That is the right instinct and this file
 * honours it — the failure it produced on arrival is pasted into #256.
 *
 * ## What it is really guarding
 *
 * `ModelProvider` is a closed union, and `provider-factory.ts` switches on it with an exhaustiveness check. So
 * TypeScript already guarantees every member is *mentioned*. What it cannot guarantee is that the arm does
 * anything: `bedrock` compiled, typechecked, satisfied the `never` assertion, and threw
 * `capability_unavailable` at runtime. A closed union with an exhaustive switch reads as complete coverage and
 * was not.
 *
 * That is this repository's most repeated defect wearing a different hat — "built, tested and unreachable",
 * except here it is "declared, exhaustive and unimplemented". The type system says the list is handled; only a
 * call finds out whether it is served.
 */
import { describe, expect, it } from "vitest";

import { MODEL_PROVIDERS } from "../index.js";
import type { ModelDefinition, ModelProvider } from "../index.js";
import { createProviderFactory } from "../provider-factory.js";

/**
 * Providers that are *declared* and deliberately not served yet, with the reason.
 *
 * An allowlist rather than a skip, so adding a member to `ModelProvider` without either wiring it or listing
 * it here fails this test. The list is the thing that has to shrink; a test that quietly tolerated a new
 * unwired provider would be the check the AC is warning about.
 */
const NOT_YET_SERVED: Readonly<Partial<Record<ModelProvider, string>>> = {
  bedrock:
    "Wiring needs @ai-sdk/amazon-bedrock and AWS credentials, and #256 AC-5 requires one real turn against " +
    "Bedrock as evidence. There is no AWS account available to this work, and #268 established the rule: " +
    "shipping an untested provider behind a seam that looks tested is worse than shipping none, because the " +
    "first person to select it is the first to run it.",
};

/** The minimum a factory needs. `capabilities` and pricing are not consulted by `languageModel`. */
const definitionFor = (provider: ModelProvider): ModelDefinition =>
  ({
    provider,
    modelId: provider === "openai-compatible" ? "some-local-model" : "some-model",
    role: "smart",
    lifecycle: "generally-available",
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, reasoning: false },
    modalities: ["text"],
  }) as unknown as ModelDefinition;

/**
 * Credentials good enough to *construct* a client, and no more.
 *
 * Nothing here makes a network call: `languageModel` builds a client and returns a model handle. So a fake key
 * is the right input — a test that needed real credentials for six providers would never run, and this check
 * is about whether the arm is implemented rather than about whether a key works.
 */
const credentials = {
  openai: { apiKey: "sk-test" },
  anthropic: { apiKey: "sk-ant-test" },
  google: { apiKey: "test" },
  mistral: { apiKey: "test" },
  "azure-openai": { apiKey: "test", resourceName: "test-resource" },
  bedrock: { apiKey: "test", region: "eu-central-1" },
  "openai-compatible": { baseURL: "http://127.0.0.1:1234/v1", name: "local" },
} as const;

describe("every declared model provider resolves — AC-1", () => {
  const factory = createProviderFactory({ credentials: credentials as never });

  const served = MODEL_PROVIDERS.filter((provider) => NOT_YET_SERVED[provider] === undefined);
  const unserved = MODEL_PROVIDERS.filter((provider) => NOT_YET_SERVED[provider] !== undefined);

  it.each(served)("%s resolves to a language model", (provider) => {
    const model = factory.languageModel(definitionFor(provider));
    // A handle, not a promise and not a throw. `specificationVersion` is what every AI SDK model carries.
    expect(model).toBeDefined();
    expect(typeof model === "object" || typeof model === "string").toBe(true);
  });

  it("covers the whole union, so a new member cannot arrive unnoticed", () => {
    /**
     * The assertion that makes the rest meaningful. `MODEL_PROVIDERS` is the source of truth; this test
     * enumerates it rather than a hand-written list, so a provider added to the union is either wired or
     * listed as unserved — and either way somebody had to decide.
     */
    expect([...served, ...unserved].sort()).toEqual([...MODEL_PROVIDERS].sort());
    expect(served.length + unserved.length).toBe(MODEL_PROVIDERS.length);
  });

  it.each(unserved)("%s is declared but not served, and says so precisely", (provider) => {
    /**
     * Asserted, not skipped. An unwired provider must fail with `capability_unavailable` — a code a caller can
     * branch on — rather than with a generic error, and the message must name the provider so an operator who
     * selected it learns why from the failure instead of from the source.
     */
    let thrown: unknown;
    try {
      factory.languageModel(definitionFor(provider));
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `${provider} unexpectedly resolved — remove it from NOT_YET_SERVED`).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("capability_unavailable");
    expect(String((thrown as Error).message).toLowerCase()).toContain(provider);
    // And the reason is written down where a reader will find it.
    expect(NOT_YET_SERVED[provider]).toBeTruthy();
  });

  it("the unserved list is the thing that has to shrink", () => {
    /**
     * A deliberate tripwire. When Bedrock is wired, this number changes and this test fails — which is the
     * moment to delete the entry rather than to leave a stale excuse behind.
     */
    expect(Object.keys(NOT_YET_SERVED)).toEqual(["bedrock"]);
  });
});
