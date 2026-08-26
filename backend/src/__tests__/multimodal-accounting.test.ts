/**
 * What a multimodal turn costs, and what it records — REQ-036 (#185), AC-4.
 *
 * "A multimodal turn that bills as text is a bill that is wrong" cuts both ways, and the two errors are
 * indistinguishable from the token counts alone:
 *
 * - A provider that folds images into `inputTokens` (OpenAI) and a platform that *also* charges per image
 *   **double-bills**, and the overcharge scales with every picture anyone sends.
 * - A provider that charges separately and a platform that ignores it **under-bills**, silently, forever.
 *
 * So the pricing record says which convention applies and these tests pin both branches. The default is the
 * folded-in one, which means every pricing record that existed before this costs exactly what it did.
 */

import { describe, expect, it } from "vitest";
import { computeModelCostMinorUnits } from "../models/pricing.js";
import { nonTextCounts } from "../models/streaming.js";
import type { ModelPricing } from "../models/index.js";
import type { TurnMessage } from "../models/streaming.js";

const TEXT: ModelPricing = { currency: "USD", inputPerMillion: 250, outputPerMillion: 1_000 };

describe("pricing a turn that carried images", () => {
  it("charges nothing extra when the provider folds images into input tokens", () => {
    // The default, and the reason it is the default: this is what OpenAI does, so the safe direction for the
    // catalogue we ship is the one that cannot double-charge.
    const cost = computeModelCostMinorUnits(TEXT, { inputTokens: 4_000, outputTokens: 500, imageCount: 3 });
    const withoutImages = computeModelCostMinorUnits(TEXT, { inputTokens: 4_000, outputTokens: 500 });
    expect(cost).toBe(withoutImages);
  });

  it("does not double-bill even when a per-image rate is set but the convention is folded-in", () => {
    /**
     * The trap. A pricing record can carry `perImageMinorUnits` for documentation, or because someone filled in
     * every field, and it must not take effect unless `nonTextInput` says it should. A platform that charged
     * whenever the field was *present* would overcharge on exactly the records that look most complete.
     */
    const pricing: ModelPricing = { ...TEXT, perImageMinorUnits: 50 };
    expect(computeModelCostMinorUnits(pricing, { inputTokens: 4_000, outputTokens: 500, imageCount: 3 })).toBe(
      computeModelCostMinorUnits(TEXT, { inputTokens: 4_000, outputTokens: 500 }),
    );
  });

  it("charges per image when the provider prices them separately", () => {
    const pricing: ModelPricing = { ...TEXT, nonTextInput: "per-unit", perImageMinorUnits: 50 };
    const cost = computeModelCostMinorUnits(pricing, { inputTokens: 4_000, outputTokens: 500, imageCount: 3 });
    const text = computeModelCostMinorUnits(TEXT, { inputTokens: 4_000, outputTokens: 500 });
    expect(cost).toBe(text + 150);
  });

  it("charges per audio second when the provider prices that separately", () => {
    const pricing: ModelPricing = { ...TEXT, nonTextInput: "per-unit", perAudioSecondMinorUnits: 2 };
    const cost = computeModelCostMinorUnits(pricing, { inputTokens: 1_000, outputTokens: 100, audioSeconds: 30 });
    expect(cost).toBe(computeModelCostMinorUnits(TEXT, { inputTokens: 1_000, outputTokens: 100 }) + 60);
  });

  it("charges nothing extra for a per-unit provider on a text-only turn", () => {
    // A `per-unit` model that was sent no images must cost the same as a text model. Otherwise switching a
    // catalogue entry's convention changes the price of every text turn.
    const pricing: ModelPricing = { ...TEXT, nonTextInput: "per-unit", perImageMinorUnits: 50 };
    expect(computeModelCostMinorUnits(pricing, { inputTokens: 4_000, outputTokens: 500 })).toBe(
      computeModelCostMinorUnits(TEXT, { inputTokens: 4_000, outputTokens: 500 }),
    );
  });

  it("treats a per-unit provider with no rate as free rather than throwing", () => {
    // A half-filled pricing record is a configuration mistake, and the failure direction has to be a smaller
    // bill rather than a refused run: nobody wants a turn to fail because a price is missing.
    const pricing: ModelPricing = { ...TEXT, nonTextInput: "per-unit" };
    expect(computeModelCostMinorUnits(pricing, { inputTokens: 1_000, outputTokens: 0, imageCount: 5 })).toBe(
      computeModelCostMinorUnits(TEXT, { inputTokens: 1_000, outputTokens: 0 }),
    );
  });

  it("still discounts cached input, which the image branch must not disturb", () => {
    const pricing: ModelPricing = { ...TEXT, cacheReadPerMillion: 25, nonTextInput: "per-unit", perImageMinorUnits: 10 };
    const cost = computeModelCostMinorUnits(pricing, {
      inputTokens: 2_000,
      cachedInputTokens: 1_000,
      outputTokens: 0,
      imageCount: 1,
    });
    // 1000 fresh at 250/M + 1000 cached at 25/M + one image at 10.
    expect(cost).toBe(Math.round((1_000 * 250) / 1_000_000 + (1_000 * 25) / 1_000_000) + 10);
  });
});

describe("counting what was sent", () => {
  const text = (content: string): TurnMessage => ({ role: "user", content });
  const withImage = (images: number): TurnMessage => ({
    role: "user",
    content: [
      { kind: "text", text: "what is this" },
      ...Array.from({ length: images }, () => ({ kind: "image" as const, image: "data:image/png;base64,AA" })),
    ],
  });

  it("counts one per image part, across messages", () => {
    expect(nonTextCounts([withImage(2), text("and this?"), withImage(1)])).toEqual({ imageCount: 3 });
  });

  it("reports nothing at all for a text-only turn", () => {
    /**
     * `{}`, not `{ imageCount: 0 }`.
     *
     * A zero is a claim that nobody sent an image; an absent field is "not counted". They look the same until a
     * pricing record charges per image, at which point a zero from a layer that never looked reads as a fact.
     */
    expect(nonTextCounts([text("hello"), { role: "assistant", content: "hi" }])).toEqual({});
    expect(nonTextCounts([{ role: "user", content: [{ kind: "text", text: "hello" }] }])).toEqual({});
  });

  it("does not count a file part as an image", () => {
    // A PDF is priced as tokens by every provider that accepts one, so counting it as an image would charge a
    // per-image rate against a thing no per-image rate applies to.
    expect(
      nonTextCounts([
        { role: "user", content: [{ kind: "file", data: "data:application/pdf;base64,AA", mediaType: "application/pdf" }] },
      ]),
    ).toEqual({});
  });
});
