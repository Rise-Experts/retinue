import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import { assemblePrompt, gatherSections } from "../index.js";
import { type ContextBudget, type ContextProvider, type ContextSection } from "../index.js";

const budget: ContextBudget = {
  basePolicyTokens: 100,
  userContextTokens: 100,
  toolTokens: 100,
  skillTokens: 100,
  knowledgeTokens: 100,
  historyTokens: 100,
};

const section = (over: Partial<ContextSection> & { title: string; estimatedTokens: number }): ContextSection => ({
  providerId: "p",
  body: over.title,
  priority: 1,
  provenance: "test",
  sensitivity: "internal",
  cacheable: false,
  ...over,
});

describe("prompt assembly — budgeting", () => {
  it("keeps the highest-priority sections that fit a bucket and prunes the overflow", async () => {
    const result = assemblePrompt({
      sections: [
        section({ title: "keep-a", kind: "knowledge", estimatedTokens: 60, priority: 5 }),
        section({ title: "keep-b", kind: "knowledge", estimatedTokens: 30, priority: 3 }),
        section({ title: "drop", kind: "knowledge", estimatedTokens: 40, priority: 1 }), // would exceed 100
      ],
      budget,
      modelContextTokens: 10_000,
    });
    expect(result.sections.map((s) => s.title).sort()).toEqual(["keep-a", "keep-b"]);
    expect(result.pruned).toEqual([expect.objectContaining({ reason: "bucket-overflow" })]);
    expect(result.totalTokens).toBe(90);
  });
});

describe("prompt assembly — staged pruning under the model limit", () => {
  it("prunes in PRUNE_ORDER and preserves recent turns (no pruneStage)", () => {
    const result = assemblePrompt({
      sections: [
        section({ title: "base", kind: "base-policy", estimatedTokens: 20, priority: 100 }),
        section({ title: "recent-turn", kind: "history", estimatedTokens: 30, priority: 50 }), // preserved
        section({ title: "old-turn", kind: "history", estimatedTokens: 30, priority: 10, pruneStage: "old-turns" }),
        section({ title: "old-reasoning", kind: "history", estimatedTokens: 30, priority: 20, pruneStage: "old-reasoning" }),
      ],
      budget,
      modelContextTokens: 60, // forces pruning: total would be 110
    });
    const kept = result.sections.map((s) => s.title);
    // old-reasoning goes first (earliest stage), then old-turns, until it fits. base + recent-turn survive.
    expect(kept).toContain("base");
    expect(kept).toContain("recent-turn");
    expect(kept).not.toContain("old-reasoning");
    expect(result.totalTokens).toBeLessThanOrEqual(60);
    // Reasoning was pruned before turns.
    const reasons = result.pruned.map((p) => `${p.section.title}:${p.reason}`);
    expect(reasons).toContain("old-reasoning:old-reasoning");
  });

  it("fails loudly when base policy alone cannot fit its budget", () => {
    expect(() =>
      assemblePrompt({
        sections: [section({ title: "huge-policy", kind: "base-policy", estimatedTokens: 500, priority: 100 })],
        budget,
        modelContextTokens: 10_000,
      }),
    ).toThrow(/base policy/i);
  });

  it("fails loudly when nothing further is prunable but the prompt still overflows", () => {
    expect(() =>
      assemblePrompt({
        sections: [
          section({ title: "base", kind: "base-policy", estimatedTokens: 90, priority: 100 }),
          section({ title: "recent", kind: "history", estimatedTokens: 90, priority: 50 }), // no pruneStage → unprunable
        ],
        budget,
        modelContextTokens: 100,
      }),
    ).toThrow(/allows 100/);
  });
});

describe("prompt assembly — previewable", () => {
  it("reports every section with a token estimate and whether it was included", () => {
    const result = assemblePrompt({
      sections: [
        section({ title: "in", kind: "tools", estimatedTokens: 40, priority: 5 }),
        section({ title: "out", kind: "tools", estimatedTokens: 80, priority: 1 }),
      ],
      budget,
      modelContextTokens: 10_000,
    });
    expect(result.preview.sections).toEqual([
      { title: "in", estimatedTokens: 40, included: true },
      { title: "out", estimatedTokens: 80, included: false },
    ]);
    expect(result.preview.budget).toBe(budget);
  });
});

describe("gatherSections", () => {
  it("aggregates sections from every provider in order", async () => {
    const ctx: ExecutionContext = {
      tenantId: asId("t1"),
      principalId: asId("p1"),
      roleIds: [],
      locale: "en",
      timezone: "UTC",
      requestId: asId("r1"),
    };
    const providers: ContextProvider[] = [
      { id: "a", provide: async () => [section({ title: "a1", estimatedTokens: 1 })] },
      { id: "b", provide: async () => [section({ title: "b1", estimatedTokens: 1 })] },
    ];
    const gathered = await gatherSections(ctx, providers);
    expect(gathered.map((s) => s.title)).toEqual(["a1", "b1"]);
  });
});
