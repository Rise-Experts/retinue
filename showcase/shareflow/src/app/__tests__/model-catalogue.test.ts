import { describe, expect, it } from "vitest";
import { deploymentChoices, effortOptions, withEffort, workspaceChoice } from "../model-catalogue.js";

/** #551 — the models a chat may pick, and what effort means for each. */
describe("the catalogue", () => {
  it("is the deployment's model, then RETINUE_MODEL_CHOICES on the same key", () => {
    const choices = deploymentChoices({ provider: "google", modelId: "gemini-2.5-flash" }, { RETINUE_MODEL_CHOICES: "gemini-2.5-pro|Gemini Pro, bad id!,gemini-2.5-flash" });
    expect(choices.map((c) => c.id)).toEqual(["chorus:gemini-2.5-flash", "chorus:gemini-2.5-pro"]);
    expect(choices[1]!.label).toBe("Gemini Pro");
  });

  it("names the workspace's own key as its own source", () => {
    expect(workspaceChoice({ provider: "anthropic", modelId: "claude-sonnet-4-5" })).toMatchObject({ id: "workspace:claude-sonnet-4-5", source: "workspace" });
  });
});

describe("effort", () => {
  it("sends nothing at medium, whatever the model", () => {
    expect(effortOptions({ provider: "google", modelId: "gemini-2.5-flash" }, "medium")).toEqual({ applied: true });
  });

  it("maps to each provider's own knob", () => {
    expect(effortOptions({ provider: "google", modelId: "gemini-2.5-flash" }, "high").providerOptions).toEqual({ google: { thinkingConfig: { thinkingBudget: 8192 } } });
    expect(effortOptions({ provider: "openai", modelId: "gpt-5" }, "low").providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
    const claude = effortOptions({ provider: "anthropic", modelId: "claude-sonnet-4-5" }, "high", { maxOutputTokens: 1000 });
    expect(claude.providerOptions).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } } });
    expect(claude.maxOutputTokens).toBeGreaterThan(4096);
  });

  it("is ignored — and says so — for a model with no reasoning setting", () => {
    expect(effortOptions({ provider: "openai", modelId: "gpt-4o" }, "high")).toEqual({ applied: false });
    expect(effortOptions({ provider: "google", modelId: "gemini-1.5-pro" }, "low")).toEqual({ applied: false });
  });

  it("merges into the call without dropping options already there", () => {
    const params = { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }, maxOutputTokens: 100 };
    const merged = withEffort(params, { applied: true, providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } } }, maxOutputTokens: 6144 });
    expect(merged.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" }, thinking: { type: "enabled", budgetTokens: 4096 } } });
    expect(merged.maxOutputTokens).toBe(6144);
  });
});
