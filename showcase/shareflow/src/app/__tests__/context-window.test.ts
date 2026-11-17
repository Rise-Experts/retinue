import { describe, expect, it } from "vitest";

import { UNKNOWN_MODEL_WINDOW, contextWindowFor, modelContextWindow } from "../context-window.js";
import { HISTORY_FLOOR_TOKENS, historyBudgetForWindow, historyTokenBudget } from "../prompt-budget.js";
import { definitionFor } from "../model.js";

/** #630 — the meter divided every model by a fixed 120,000. These are the windows it now uses. */
describe("modelContextWindow", () => {
  it("knows the models this deployment offers, longest prefix first", () => {
    expect(modelContextWindow("gemini-2.5-flash")).toBe(1_048_576);
    expect(modelContextWindow("gemini-2.5-pro")).toBe(1_048_576);
    expect(modelContextWindow("gpt-4.1")).toBe(1_047_576);
    expect(modelContextWindow("gpt-4.1-mini")).toBe(1_047_576);
    expect(modelContextWindow("gpt-4o")).toBe(128_000);
    expect(modelContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(modelContextWindow("gpt-5")).toBe(400_000);
    expect(modelContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(modelContextWindow("o3-mini")).toBe(200_000);
    expect(modelContextWindow("mistral-large-latest")).toBe(128_000);
  });

  it("ignores a provider prefix and case", () => {
    expect(modelContextWindow("models/Gemini-2.5-Flash")).toBe(1_048_576);
    expect(modelContextWindow("openai/gpt-4o")).toBe(128_000);
  });

  it("errs small for a model it does not know: early condensing beats a rejected request", () => {
    expect(modelContextWindow("some-new-model")).toBe(UNKNOWN_MODEL_WINDOW);
    expect(UNKNOWN_MODEL_WINDOW).toBeLessThanOrEqual(128_000);
  });
});

describe("contextWindowFor", () => {
  it("plans against the whole window, as Claude Code does (#644)", () => {
    expect(contextWindowFor("gemini-2.5-flash")).toEqual({ window: 1_048_576, working: 1_048_576 });
    expect(contextWindowFor("gpt-4.1")).toEqual({ window: 1_047_576, working: 1_047_576 });
  });

  it("uses the whole window when it is under the cap", () => {
    expect(contextWindowFor("claude-sonnet-4-5")).toEqual({ window: 200_000, working: 200_000 });
    expect(contextWindowFor("gpt-4o")).toEqual({ window: 128_000, working: 128_000 });
  });
});

describe("historyBudgetForWindow", () => {
  it("condenses at 85% of the window, less the fixed allocation", () => {
    // 68k is set aside: 4k policy, 12k context, 6k tools, 6k skills, 32k documents (#644), 8k reply.
    expect(historyBudgetForWindow(1_047_576)).toBe(Math.floor(1_047_576 * 0.85) - 68_000);
    expect(historyBudgetForWindow(200_000)).toBe(102_000);
    expect(historyBudgetForWindow(128_000)).toBe(40_800);
  });

  it("gives a bigger model more history than the old fixed budget, and a smaller one less", () => {
    expect(historyBudgetForWindow(200_000)).toBeGreaterThan(historyTokenBudget());
    expect(historyBudgetForWindow(128_000)).toBeLessThan(historyTokenBudget());
  });

  it("never falls below the floor that holds a summary", () => {
    expect(historyBudgetForWindow(8_000)).toBe(HISTORY_FLOOR_TOKENS);
  });
});

describe("the model definition", () => {
  it("declares the real window instead of 0", () => {
    const definition = definitionFor({ provider: "google", modelId: "gemini-2.5-flash", apiKey: "k" } as never, undefined) as unknown as {
      limits: { contextTokens: number };
    };
    expect(definition.limits.contextTokens).toBe(1_048_576);
  });
});
