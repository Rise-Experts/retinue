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
  usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number },
): number => {
  const cachedIn = usage.cachedInputTokens ?? 0;
  const freshIn = Math.max(0, usage.inputTokens - cachedIn);
  const perMillion = (tokens: number, price: number): number => (tokens * price) / 1_000_000;
  return Math.round(
    perMillion(freshIn, pricing.inputPerMillion) +
      perMillion(cachedIn, pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
      perMillion(usage.outputTokens, pricing.outputPerMillion),
  );
};
