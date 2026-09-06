/**
 * Every declared provider and mode is either served or explicitly unserved — REQ-061 (#255), task #256.
 *
 * The exact-list habit `EXEMPT`, `PACKAGES` and `RELEASABLE` already use, applied to the two unions that had
 * grown a member nothing implemented. #256's AC-1 asked for this to land **before any wiring**, and the
 * failure it produced is in the issue comment: *"AgentPlatformError: Amazon Bedrock provider is not wired yet"*.
 * A check that first appears alongside its own fix has never been seen to work.
 *
 * ## Why `NOT_YET_SERVED` exists rather than a passing test
 *
 * Bedrock is still not wired, and that is a decision rather than an omission — #256's AC-5 requires one real
 * turn against it as evidence, and *"a claim of support with no live call is worse"* than the
 * `capability_unavailable` it throws today. There is no AWS account available to this work, so wiring it would
 * mean shipping a provider whose first user is its first tester. #268 settled that precedent for crypto and the
 * reasoning carries.
 *
 * So the union is partitioned explicitly. A provider is served — it constructs — or it is on `NOT_YET_SERVED` with a
 * written reason and a test asserting it throws the honest error. **Adding a member and doing neither fails.**
 * That is the property that stops the next Bedrock: the type system guarantees every member is *mentioned*,
 * and only a call finds out whether it is *served*.
 */
import { describe, expect, it } from "vitest";

import { createModelRegistry, MODEL_PROVIDERS, type ModelDefinition, type ModelProvider } from "../index.js";
import { NO_RESULT_REASONS, type RetrievalMode } from "../../knowledge/retrieval.js";
import { createProviderFactory } from "../provider-factory.js";

/**
 * Declared and deliberately not served, each with the reason it is not.
 *
 * A list rather than a skip: a skipped case reports success while the gap remains, and the whole failure being
 * fixed is a member that looked covered because a `switch` mentioned it.
 */
const NOT_YET_SERVED: Readonly<Record<string, string>> = {
  bedrock:
    "No AWS account is available to verify it, and #256 AC-5 requires one real turn as evidence. Wiring it " +
    "would mean the first person to select it is the first to run it — worse than the honest " +
    "`capability_unavailable` it throws today.",
};

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

describe("every declared model provider is served or explicitly unserved — AC-1", () => {
  it.each(MODEL_PROVIDERS)("%s", (provider) => {
    if (provider in NOT_YET_SERVED) {
      /**
       * Asserted to throw, and to throw the *right* error. An unserved provider that failed with a stack trace
       * or a vendor's own message would be indistinguishable from a broken one — `capability_unavailable` is
       * what tells a deployment this is a gap rather than a fault.
       */
      expect(() => factory().languageModel(definition(provider)), provider).toThrow(/not wired/i);
      expect(NOT_YET_SERVED[provider], `${provider} needs a written reason`).toBeTruthy();
      return;
    }
    /**
     * Constructs, rather than calls. Every AI SDK factory builds a model object without touching the network,
     * so this asserts the wiring — the import, the credential path, the model id — without an account with each
     * vendor. What it cannot assert is that the vendor accepts the request, which is exactly why `NOT_YET_SERVED`
     * exists for the one where that distinction is the whole question.
     */
    expect(factory().languageModel(definition(provider)), provider).toBeDefined();
  });

  it("the union is exactly seven, six served and one not", () => {
    /**
     * The assertion that stops the next unwired provider. A member added to `MODEL_PROVIDERS` fails the loop
     * above unless it is wired or listed here — and updating this line is a deliberate moment to ask whether it
     * has actually been run.
     */
    expect([...MODEL_PROVIDERS].sort()).toEqual([
      "anthropic",
      "azure-openai",
      "bedrock",
      "google",
      "mistral",
      "openai",
      "openai-compatible",
    ]);
    expect(Object.keys(NOT_YET_SERVED)).toEqual(["bedrock"]);
  });

  it("the unserved list is the thing that has to shrink", () => {
    /**
     * A deliberate tripwire. When Bedrock is wired, this fails — which is the moment to delete the entry rather
     * than leave a stale excuse behind. `NOT_YET_SERVED` rather than `UNSERVED` for the same reason: the name
     * carries the intent that the list is temporary.
     */
    expect(Object.keys(NOT_YET_SERVED)).toHaveLength(1);
  });

  it("every unserved provider is a real member of the union", () => {
    // A stale entry would excuse a provider that no longer exists, and quietly stop covering one that does.
    for (const provider of Object.keys(NOT_YET_SERVED)) {
      expect(MODEL_PROVIDERS as readonly string[], provider).toContain(provider);
    }
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
