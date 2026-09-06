/**
 * Audio as a modality — REQ-062 (#257), task #258, Part 1 and AC-8.
 *
 * The REQ said the vision machinery "is modality-generic in shape but only image exists in practice", and
 * checking that turned out to be most of Part 1: `InputModality` already lists `audio`, `modalitiesOf` already
 * maps an `audio/*` media type to it, `eligible()` already filters on `requiredModalities` generically, and
 * `perAudioSecondMinorUnits` already exists from REQ-036.
 *
 * So this file is not new capability. It is the tests that were missing — and writing them is what turns
 * "generic in shape" into "works for audio", which are different claims. Every assertion here mirrors an
 * existing image one deliberately, so the two modalities are held to the same standard rather than to whatever
 * each happened to get.
 */
import { describe, expect, it } from "vitest";

import { createModelRegistry, type ModelDefinition } from "../index.js";
import { modalitiesOf } from "../streaming.js";
import { computeModelCostMinorUnits } from "../pricing.js";

const pricing = { currency: "usd", inputPerMillion: 100, outputPerMillion: 200 } as const;

const model = (id: string, modalities: readonly string[], extra: Record<string, unknown> = {}): ModelDefinition =>
  ({
    provider: "openai",
    modelId: id,
    label: id,
    role: "smart",
    lifecycle: "generally-available",
    inputModalities: modalities,
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, reasoning: false },
    contextTokens: 100_000,
    maxOutputTokens: 4_096,
    pricing,
    dataResidency: ["us"],
    ...extra,
  }) as unknown as ModelDefinition;

describe("resolveModel honours the audio modality — AC-1", () => {
  /**
   * `roles` is an ordered candidate list, not a lookup — resolution walks it and takes the first eligible
   * model. `text-only` is first on purpose: if the modality filter were skipped, that is what would come back,
   * so the test would pass for the wrong reason if the order were the other way round.
   */
  const registry = createModelRegistry({
    models: [model("text-only", ["text"]), model("hears", ["text", "audio"])],
    roles: { smart: ["text-only", "hears"], fast: ["text-only"] },
  });

  it("resolves a model that accepts audio when the policy requires it", () => {
    // The image case's mirror. Generic code is not the same as tested code, which is why this exists.
    expect(registry.resolve({ role: "smart", requiredModalities: ["audio"] }).modelId).toBe("hears");
  });

  it("refuses when no model accepts audio, rather than handing back a text-only one", () => {
    /**
     * The assertion that matters. Silently returning `text-only` would send an audio attachment to a model
     * that cannot read it, and the provider's error names the request rather than the cause — which is how a
     * resolution bug becomes an afternoon of reading provider docs.
     */
    const deaf = createModelRegistry({ models: [model("text-only", ["text"])], roles: { smart: ["text-only"], fast: [] } });
    expect(() => deaf.resolve({ role: "smart", requiredModalities: ["audio"] })).toThrow(/No model/);
  });

  it("does not confuse audio with the other non-text modalities", () => {
    const seesOnly = createModelRegistry({ models: [model("sees", ["text", "image"])], roles: { smart: ["sees"], fast: [] } });
    expect(() => seesOnly.resolve({ role: "smart", requiredModalities: ["audio"] })).toThrow(/No model/);
    // And the converse, so the filter is not simply "any non-text modality will do".
    const hearsOnly = createModelRegistry({ models: [model("hears", ["text", "audio"])], roles: { smart: ["hears"], fast: [] } });
    expect(() => hearsOnly.resolve({ role: "smart", requiredModalities: ["image"] })).toThrow(/No model/);
  });

  it("requires every modality asked for, not any of them", () => {
    const hearsOnly = createModelRegistry({ models: [model("hears", ["text", "audio"])], roles: { smart: ["hears"], fast: [] } });
    expect(() => hearsOnly.resolve({ role: "smart", requiredModalities: ["audio", "image"] })).toThrow(/No model/);
  });
});

describe("a turn's modalities are read from its parts — AC-2", () => {
  it("recognises an audio attachment by its media type", () => {
    for (const mediaType of ["audio/mpeg", "audio/wav", "audio/webm", "audio/ogg", "audio/mp4"]) {
      expect(
        modalitiesOf([{ role: "user", content: [{ kind: "file", data: "…", mediaType }] }]),
        mediaType,
      ).toContain("audio");
    }
  });

  it("does not report audio for a turn that has none", () => {
    expect(modalitiesOf([{ role: "user", content: "just words" }])).toEqual([]);
    expect(
      modalitiesOf([{ role: "user", content: [{ kind: "file", data: "…", mediaType: "application/pdf" }] }]),
    ).not.toContain("audio");
  });

  it("reports audio alongside the other modalities in one turn", () => {
    const found = modalitiesOf([
      {
        role: "user",
        content: [
          { kind: "text", text: "what is in these?" },
          { kind: "file", data: "…", mediaType: "audio/mpeg" },
          { kind: "image", image: "…" },
        ],
      },
    ]);
    expect([...found].sort()).toEqual(["audio", "image"]);
  });
});

describe("audio is priced — AC-8", () => {
  /**
   * The failure this guards is silent and one-directional: **unpriced usage is billed as free.** A transcription
   * that costs money and reports zero is a revenue hole rather than a visible bug, and nothing in a test suite
   * that only checks token arithmetic would notice.
   *
   * The first version of these tests wrote `nonTextBilling` — a field that does not exist. The cost came back
   * zero and the assertion caught it, but it is worth naming why the *compiler* did not: the field arrives in a
   * spread (`{ ...pricing, nonTextBilling: … }`), and TypeScript permits excess properties through a spread.
   * So #276's test typechecking cannot catch this shape, and the arithmetic assertion is what does.
   */
  it("charges per second under the per-unit convention", () => {
    const cost = computeModelCostMinorUnits(
      { ...pricing, nonTextInput: "per-unit", perAudioSecondMinorUnits: 6 },
      { inputTokens: 0, outputTokens: 0, audioSeconds: 90 },
    );
    expect(cost).toBe(540);
  });

  it("charges nothing extra when the provider folds audio into input tokens", () => {
    /**
     * The other convention, and the reason the field exists: OpenAI converts audio to input tokens and counts
     * them in `inputTokens`. Adding a per-second charge on top would **double-bill**, and the two conventions
     * are indistinguishable from the token counts alone.
     */
    const cost = computeModelCostMinorUnits(
      { ...pricing, nonTextInput: "in-input-tokens", perAudioSecondMinorUnits: 6 },
      { inputTokens: 1_000, outputTokens: 0, audioSeconds: 90 },
    );
    // The tokens, and not one unit more.
    expect(cost).toBe(computeModelCostMinorUnits({ ...pricing }, { inputTokens: 1_000, outputTokens: 0 }));
  });

  it("a transcription of known duration is not free", () => {
    // Stated as its own case because "not zero" is the property that matters, independently of the arithmetic.
    const cost = computeModelCostMinorUnits(
      { ...pricing, nonTextInput: "per-unit", perAudioSecondMinorUnits: 1 },
      { inputTokens: 0, outputTokens: 0, audioSeconds: 30 },
    );
    expect(cost).toBeGreaterThan(0);
  });

  it("is free only when the deployment priced it at zero, which is a decision", () => {
    // No `perAudioSecondMinorUnits` at all means zero — correct, and the reason the pricing test above exists:
    // a provider added without pricing under-reports silently.
    expect(
      computeModelCostMinorUnits(
        { ...pricing, nonTextInput: "per-unit" },
        { inputTokens: 0, outputTokens: 0, audioSeconds: 3_600 },
      ),
    ).toBe(0);
  });
});
