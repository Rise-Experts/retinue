/**
 * What a unit of usage costs — extracted from the models barrel (#199).
 *
 * Its own module because of what importing it used to drag in. `usage/recorder.ts` needs this one function, and
 * reaching it through `models/index.js` pulled `streaming.js` with it — and `streaming.js` imports `ai`. So the
 * in-memory usage adapter, which needs no model SDK and no network, transitively reached the AI SDK: a consumer
 * importing `@retinue/agentkit/persistence` for an in-memory prototype loaded a provider library to do it.
 *
 * Nothing about the pricing arithmetic connects it to streaming. The barrel was the only thing joining them.
 */

import type { ModelPricing } from "./index.js";

/**
 * Cost of a unit of usage, in the pricing currency's minor units. Prices are per-million tokens.
 * Cached input is billed at the cache-read rate when present. This is what feeds usage accounting.
 */
export const computeModelCostMinorUnits = (
  pricing: ModelPricing,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number;
    /** Tokens written into the cache — a subset of `inputTokens`, priced separately. See below. */
    readonly cacheWriteTokens?: number;
    /** Images sent with the turn — counted from the parts, not from the provider. See `NeutralUsage`. */
    readonly imageCount?: number;
    readonly audioSeconds?: number;
  },
): number => {
  /**
   * Three kinds of input token, and all three are inside `inputTokens` — task #247.
   *
   * Measured against a live provider: `noCacheTokens + cacheReadTokens + cacheWriteTokens === inputTokens`. So
   * fresh input is the remainder after both cache quantities, and adding them on top would double-bill — the
   * same trap `nonTextInput` exists for.
   *
   * A cache **write** is not a discount. Anthropic charges 1.25× a fresh input token to write an entry, so
   * folding writes into fresh input *under-bills* the first turn of every conversation — the direction that
   * looks like a saving and is not. `cacheWritePerMillion` existed in `ModelPricing` and was read by nothing
   * until now.
   */
  const cachedIn = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const freshIn = Math.max(0, usage.inputTokens - cachedIn - cacheWrite);
  const perMillion = (tokens: number, price: number): number => (tokens * price) / 1_000_000;

  const tokenCost =
    perMillion(freshIn, pricing.inputPerMillion) +
    perMillion(cachedIn, pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
    // Defaulting a write to the plain input rate is the conservative choice: it neither invents a premium a
    // provider does not charge nor silently discounts one it does.
    perMillion(cacheWrite, pricing.cacheWritePerMillion ?? pricing.inputPerMillion) +
    perMillion(usage.outputTokens, pricing.outputPerMillion);

  /**
   * Non-text input, charged **only** where the provider prices it separately — #185 AC-4.
   *
   * The default is `"in-input-tokens"`, which means the image is already inside `inputTokens` and there is
   * nothing to add. Adding it anyway is the double-bill this branch exists to prevent, and it would not show up
   * in any test that only ever passes text.
   */
  if (pricing.nonTextInput !== "per-unit") return Math.round(tokenCost);

  const images = Math.max(0, usage.imageCount ?? 0);
  const seconds = Math.max(0, usage.audioSeconds ?? 0);
  return Math.round(
    tokenCost +
      images * (pricing.perImageMinorUnits ?? 0) +
      seconds * (pricing.perAudioSecondMinorUnits ?? 0),
  );
};
