/**
 * Prompt caching: the arithmetic, and the property the whole saving rests on — REQ-058 (#246), task #247.
 *
 * `docs/24` measured that going from 20 to 200 tools leaves selection accuracy flat and multiplies catalogue
 * tokens by **12.5×**. That cost is paid on every turn, against an input that is byte-identical every turn — which
 * is exactly what prompt caching exists for, and the platform had none.
 *
 * The defect this file pins down was worse than "not implemented". `NeutralUsage.cachedInputTokens` was read from
 * `totalUsage.cachedInputTokens`, **a field the AI SDK does not send**. Measured against a live model: a turn
 * reusing a 9,700-token prefix reported
 *
 *     inputTokenDetails: { noCacheTokens: 222, cacheReadTokens: 9472, cacheWriteTokens: 0 }
 *
 * and this platform recorded `cachedInputTokens: 0` — so `computeModelCostMinorUnits` billed 9,472 discounted
 * tokens at the full input rate. Reading the wrong field name is invisible to any test that goes through a fake,
 * which is why these tests assert against the provider's real shape.
 */
import { describe, expect, it } from "vitest";
import { cacheRead, cacheWrite } from "../streaming.js";
import { computeModelCostMinorUnits } from "../pricing.js";
import type { ModelPricing } from "../index.js";

/** The shape a live `gpt-4o` turn actually returned, copied from the measurement. */
const LIVE_CACHED_TURN = {
  inputTokens: 9694,
  inputTokenDetails: { noCacheTokens: 222, cacheReadTokens: 9472, cacheWriteTokens: 0 },
  outputTokens: 3,
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
  totalTokens: 9697,
};

const LIVE_COLD_TURN = {
  inputTokens: 9693,
  inputTokenDetails: { noCacheTokens: 9693, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 3,
  totalTokens: 9696,
};

describe("the cache counts are read from where the provider actually puts them", () => {
  it("reads cacheReadTokens out of inputTokenDetails", () => {
    // The bug, directly: `usage.cachedInputTokens` is absent from this object, and reading it yielded zero.
    expect(LIVE_CACHED_TURN).not.toHaveProperty("cachedInputTokens");
    expect(cacheRead(LIVE_CACHED_TURN)).toBe(9472);
    expect(cacheRead(LIVE_COLD_TURN)).toBe(0);
  });

  it("reads cacheWriteTokens too, and distinguishes absent from zero", () => {
    expect(cacheWrite(LIVE_CACHED_TURN)).toBe(0);
    // A provider that reports no breakdown at all: not zero, unknown. A zero would claim we know it wrote none.
    expect(cacheWrite({ inputTokens: 10, outputTokens: 1 })).toBeUndefined();
  });

  it("still honours a top-level field, for a host-supplied streamTurn", () => {
    expect(cacheRead({ inputTokens: 100, cachedInputTokens: 40 })).toBe(40);
    expect(cacheWrite({ inputTokens: 100, cacheWriteTokens: 10 })).toBe(10);
  });

  it("prefers the detailed breakdown when both are present", () => {
    // The detailed one is what a real provider fills in; a stale top-level value must not win.
    expect(cacheRead({ inputTokens: 100, cachedInputTokens: 1, inputTokenDetails: { cacheReadTokens: 40 } })).toBe(40);
  });
});

describe("the three kinds of input token are priced apart", () => {
  // Anthropic's published ratios, and the numbers now in DEFAULT_MODEL_CATALOG for Sonnet.
  const sonnet: ModelPricing = {
    currency: "USD",
    inputPerMillion: 3_000,
    outputPerMillion: 15_000,
    cacheReadPerMillion: 300,
    cacheWritePerMillion: 3_750,
  };

  it("charges a cache read at the read rate, not the input rate", () => {
    const fresh = computeModelCostMinorUnits(sonnet, { inputTokens: 1_000_000, outputTokens: 0 });
    const cached = computeModelCostMinorUnits(sonnet, {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(fresh).toBe(3_000);
    expect(cached).toBe(300);
    // The whole point: a 90% discount that was being thrown away by reading the wrong field name.
    expect(cached / fresh).toBeCloseTo(0.1, 5);
  });

  it("charges a cache write MORE than fresh input — the trap in this feature", () => {
    // A cache write is not a discount. Folding writes into fresh input under-bills the first turn of every
    // conversation, which is the direction that looks like a saving and is not.
    const written = computeModelCostMinorUnits(sonnet, {
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(written).toBe(3_750);
    expect(written).toBeGreaterThan(computeModelCostMinorUnits(sonnet, { inputTokens: 1_000_000, outputTokens: 0 }));
  });

  it("treats both cache quantities as subsets of inputTokens, never additions", () => {
    // Measured against the live provider: noCache + read + write === inputTokens. Adding them on top would
    // double-bill, the same trap `nonTextInput` exists for.
    const cost = computeModelCostMinorUnits(sonnet, {
      inputTokens: 1_000_000,
      cachedInputTokens: 600_000,
      cacheWriteTokens: 200_000,
      outputTokens: 0,
    });
    // 200k fresh @3000 + 600k read @300 + 200k write @3750 = 600 + 180 + 750
    expect(cost).toBe(1_530);
  });

  it("never goes negative when a provider reports counts exceeding inputTokens", () => {
    // Defensive: a provider whose breakdown does not sum must not produce a negative fresh count and a
    // nonsensical credit.
    const cost = computeModelCostMinorUnits(sonnet, {
      inputTokens: 100,
      cachedInputTokens: 200,
      cacheWriteTokens: 200,
      outputTokens: 0,
    });
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("falls back to the input rate when a model declares no cache prices", () => {
    // A catalogue entry without cache rates must keep costing exactly what it did — neither inventing a premium
    // nor silently discounting.
    const plain: ModelPricing = { currency: "USD", inputPerMillion: 1_000, outputPerMillion: 2_000 };
    expect(
      computeModelCostMinorUnits(plain, { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(1_000);
    expect(
      computeModelCostMinorUnits(plain, { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(1_000);
  });
});
