import { describe, expect, it } from "vitest";
import { sectionsByProvenance, shapeContextPanel } from "../context-inspector.js";
import type { ContextInspection } from "../types/index.js";

const inspection: ContextInspection = {
  totalTokens: 90,
  budget: { basePolicyTokens: 100, userContextTokens: 100, toolTokens: 50, skillTokens: 50, knowledgeTokens: 50, historyTokens: 200 },
  sections: [
    { title: "policy", providerId: "sys", kind: "base-policy", provenance: "agent:1", estimatedTokens: 30, sensitivity: "internal", included: true },
    { title: "mem-1", providerId: "principal-memory", kind: "user-context", provenance: "principal-memory:m1", estimatedTokens: 20, sensitivity: "confidential", included: true },
    { title: "mem-2", providerId: "principal-memory", kind: "user-context", provenance: "principal-memory:m2", estimatedTokens: 80, sensitivity: "confidential", included: false, prunedReason: "bucket-overflow" },
  ],
};

describe("shapeContextPanel", () => {
  it("groups by bucket with per-group usage vs budget", () => {
    const panel = shapeContextPanel(inspection);
    expect(panel.groups.map((g) => g.kind)).toEqual(["base-policy", "user-context"]);
    const userCtx = panel.groups.find((g) => g.kind === "user-context")!;
    expect(userCtx.usedTokens).toBe(20); // only the included mem-1
    expect(userCtx.budgetTokens).toBe(100);
    expect(panel.includedCount).toBe(2);
    expect(panel.prunedCount).toBe(1);
  });

  it("attributes memory entries by provenance prefix", () => {
    const used = sectionsByProvenance(inspection, "principal-memory:");
    expect(used.map((s) => s.provenance)).toEqual(["principal-memory:m1"]); // only the one actually included
  });
});
