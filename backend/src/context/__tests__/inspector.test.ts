import { describe, expect, it } from "vitest";
import { assemblePrompt, inspectAssembledPrompt } from "../index.js";
import { type ContextBudget, type ContextSection } from "../index.js";

const budget: ContextBudget = {
  basePolicyTokens: 100, userContextTokens: 100, toolTokens: 100, skillTokens: 100, knowledgeTokens: 100, historyTokens: 100,
};
const section = (over: Partial<ContextSection> & { title: string; estimatedTokens: number }): ContextSection => ({
  providerId: "p", body: over.title, priority: 1, provenance: "test", sensitivity: "internal", cacheable: false,
  // Required with no default: a section that does not say whether it may instruct is the case the field
  // exists to prevent. These fixtures are the platform's own text.
  origin: "platform",
  ...over,
});

describe("inspectAssembledPrompt", () => {
  it("reports included and pruned sections with provenance and reason", () => {
    const assembled = assemblePrompt({
      sections: [
        section({ title: "mem", kind: "user-context", estimatedTokens: 60, priority: 5, provenance: "principal-memory:m1" }),
        section({ title: "overflow", kind: "user-context", estimatedTokens: 80, priority: 1, provenance: "principal-memory:m2" }),
      ],
      budget,
      modelContextTokens: 10_000,
    });
    const inspection = inspectAssembledPrompt(assembled);
    const mem = inspection.sections.find((s) => s.title === "mem");
    const overflow = inspection.sections.find((s) => s.title === "overflow");
    expect(mem).toMatchObject({ included: true, provenance: "principal-memory:m1", kind: "user-context" });
    expect(overflow).toMatchObject({ included: false, prunedReason: "bucket-overflow" });
    expect(inspection.budget).toBe(budget);
  });
});
