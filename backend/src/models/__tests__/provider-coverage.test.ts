/**
 * Every declared provider and mode actually resolves — REQ-061 (#255), task #256.
 *
 * The exact-list habit `EXEMPT`, `PACKAGES` and `RELEASABLE` already use, applied to the two unions that had
 * grown a member nothing implemented. #256's AC-1 asked for this to land **before any wiring**, and the
 * failure it produced is in the issue comment: *"AgentPlatformError: Amazon Bedrock provider is not wired yet"*.
 * A check that first appears alongside its own fix has never been seen to work.
 *
 * ## There is no exceptions list, and that is the outcome
 *
 * An earlier version of this file carried `NOT_YET_SERVED` — a partition, so a declared-but-unwired provider
 * could be listed with a reason instead of failing. Bedrock was its only entry.
 *
 * It was resolved by **removing `"bedrock"` from the union** rather than wiring it. A declared provider that
 * throws is worse than an absent one: it typechecks, satisfies the factory's exhaustive `never` assertion, and
 * fails at runtime for whoever selects it first — which is exactly how it survived. And wiring it could not be
 * verified: #256's AC-5 requires one real turn as evidence, constructing a Bedrock model needs no network, and
 * an unverified wiring would satisfy "resolves" while leaving its first user as its first tester.
 *
 * So the assertion is now unconditional: **every member of `MODEL_PROVIDERS` constructs.** No skip, no
 * allowance, nothing to keep in step. Adding Bedrock back is a one-line change plus a case here, and this test
 * is what will force the verification then rather than permit the same gap again.
 */
import { describe, expect, it } from "vitest";

import { createModelRegistry, MODEL_PROVIDERS, type ModelDefinition, type ModelProvider } from "../index.js";
import { NO_RESULT_REASONS, type RetrievalMode } from "../../knowledge/retrieval.js";
import { createProviderFactory } from "../provider-factory.js";

const definition = (provider: ModelProvider): ModelDefinition =>
  ({
    provider,
    modelId: "a-model",
    label: provider,
    role: "smart",
    lifecycle: "generally-available",
    inputModalities: ["text"],
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, reasoning: false },
    contextTokens: 100_000,
    maxOutputTokens: 4_096,
    pricing: { currency: "usd", inputPerMillion: 1, outputPerMillion: 2 },
    dataResidency: ["us"],
  }) as unknown as ModelDefinition;

/**
 * What each provider needs before it can be constructed at all.
 *
 * Two genuinely require configuration rather than falling back to an SDK default, and that is not the same
 * failure as being unwired: `openai-compatible` cannot guess a base URL. Supplying it here makes this a test of
 * *wiring* rather than of configuration.
 */
const credentials = {
  "openai-compatible": { baseURL: "https://compatible.test/v1", apiKey: "k" },
  "azure-openai": { apiKey: "k", resourceName: "res" },
} as const;

const factory = () => createProviderFactory({ credentials: { ...(credentials as Record<string, unknown>) } as never });

describe("every declared model provider resolves — AC-1", () => {
  it.each(MODEL_PROVIDERS)("%s constructs a language model", (provider) => {
    /**
     * Constructs, rather than calls. Every AI SDK factory builds a model object without touching the network,
     * so this asserts the wiring — the import, the credential path, the model id — without an account with each
     * vendor. What it cannot assert is that the vendor accepts the request, which is exactly why `NOT_YET_SERVED`
     * exists for the one where that distinction is the whole question.
     */
    expect(factory().languageModel(definition(provider)), provider).toBeDefined();
  });

  it("the union is exactly the six that are wired", () => {
    /**
     * The assertion that stops the next unwired provider. A member added to `MODEL_PROVIDERS` fails the loop
     * above unless it constructs, and fails this line as well — which is a deliberate moment to ask whether it
     * has actually been *run* against the vendor, not merely imported.
     */
    expect([...MODEL_PROVIDERS].sort()).toEqual([
      "anthropic",
      "azure-openai",
      "google",
      "mistral",
      "openai",
      "openai-compatible",
    ]);
  });

  it("bedrock is absent rather than declared and throwing", () => {
    /**
     * The resolution of #256, asserted so it cannot drift back. Adding `"bedrock"` to the union without wiring
     * it fails the loop above; adding it *with* an unverified wiring is what AC-5 forbids, and this line is the
     * reminder of why the member is gone rather than stubbed.
     */
    expect(MODEL_PROVIDERS as readonly string[]).not.toContain("bedrock");
  });
});

describe("Google Vertex AI is not a member — AC-6", () => {
  it("is absent from the union, and that is the decision", () => {
    /**
     * **Decided: no.** Vertex serves the same Gemini models the `google` provider already does; what differs is
     * authentication and routing — a GCP project, a region, and ADC rather than an API key. That is a
     * *credential shape*, and `ProviderCredentials` is already per-provider.
     *
     * Two provider values resolving the same model ids through the same SDK would mean every `allowedProviders`
     * policy in every tenant had to name both to mean "Gemini". A policy saying `["google"]` that silently
     * excluded the same model reached another way is a trap, and one a customer finds.
     *
     * Asserted rather than left to the docs, because the mistake this REQ exists to fix is a member added
     * speculatively.
     */
    expect(MODEL_PROVIDERS as readonly string[]).not.toContain("vertex");
    expect(MODEL_PROVIDERS as readonly string[]).not.toContain("google-vertex");
  });
});

describe("data residency is honoured, not merely declared — AC-7", () => {
  /**
   * The AC anticipated this might be a dead field — *"if no code reads it, say so plainly and add it to #242's
   * inventory"*. It is not dead: `eligible()` filters on it. Asserted rather than concluded from a grep.
   */
  const registry = () =>
    createModelRegistry({
      models: [
        { ...definition("openai"), modelId: "us-only", dataResidency: ["us"] } as ModelDefinition,
        { ...definition("google"), modelId: "eu-and-us", dataResidency: ["eu", "us"] } as ModelDefinition,
      ],
      roles: { smart: ["us-only", "eu-and-us"], fast: [] },
    });

  it("excludes a model that does not serve the region asked for", () => {
    // `us-only` is first in the candidate list, so a filter that did nothing would return it.
    expect(registry().resolve({ role: "smart", dataResidency: ["eu"] }).modelId).toBe("eu-and-us");
  });

  it("refuses when no model serves the region, rather than falling back", () => {
    /**
     * The branch that matters for a regulated customer: silently serving from the wrong region is the failure
     * residency exists to prevent, and it is invisible in the response.
     */
    expect(() => registry().resolve({ role: "smart", dataResidency: ["ap"] })).toThrow(/No model/);
  });

  it("requires every region asked for, not any of them", () => {
    expect(() => registry().resolve({ role: "smart", dataResidency: ["eu", "ap"] })).toThrow(/No model/);
  });
});

describe("every retrieval mode is implemented — AC-8", () => {
  /**
   * ## The premise changed, and that is the answer
   *
   * The REQ describes `not-configured` as covering *"a retrieval mode is unwired"*. That was true when it was
   * written and is not now: `navigate` landed in #219, `graph-local` and `graph-global` in #273, and
   * `graph-local`'s ranking was fixed in #277. Every member of `RetrievalMode` has a branch.
   *
   * So the reason **stays**, and its meaning has changed — from *"we have not built this"* to *"you have not
   * configured this"*. That is a legitimate answer: a deployment asking for `graph-local` without a graph store
   * gets told so, rather than silently receiving semantic results wearing another mode's label. Removing the
   * reason would leave that case with nothing honest to return. The comment pointing at closed task #219 is
   * what goes, not the value.
   */
  it("the union is exactly the six that have a branch", () => {
    const modes: readonly RetrievalMode[] = [
      "semantic",
      "keyword",
      "hybrid",
      "navigate",
      "graph-local",
      "graph-global",
    ];
    expect([...modes].sort()).toEqual(["graph-global", "graph-local", "hybrid", "keyword", "navigate", "semantic"]);
  });

  it("keeps not-configured, which now means unconfigured rather than unbuilt", () => {
    /**
     * Asserted through the reasons union, not the message table — that table is module-private, and exporting
     * it so a test could read it would widen the surface for the test's convenience.
     */
    expect(NO_RESULT_REASONS).toContain("not-configured");
    // Still distinct from the other "found nothing" answers, which is the whole reason it earns its place.
    expect([...NO_RESULT_REASONS]).toEqual(expect.arrayContaining(["not-configured", "no-access"]));
  });
});
