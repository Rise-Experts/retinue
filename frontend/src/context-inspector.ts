/**
 * Context inspector — `docs/06` → Context inspector (#39). The framework-free shaping the Context
 * panel renders: groups the backend's `ContextInspection` by budget bucket, computes per-bucket
 * usage vs budget, and preserves each section's provenance so the panel can attribute which context
 * — including which memory entries — influenced a turn. The `useSessionContext` React hook lives in
 * `hooks/hooks.ts`; keeping this module react-free makes the shaping trivially testable.
 */

import type { ContextBudget, ContextInspection, ContextKind, InspectedSection } from "./types/index.js";

const BUDGET_FIELD: Readonly<Record<ContextKind, keyof ContextBudget>> = {
  "base-policy": "basePolicyTokens",
  "user-context": "userContextTokens",
  tools: "toolTokens",
  skills: "skillTokens",
  knowledge: "knowledgeTokens",
  history: "historyTokens",
};

export type ContextPanelGroup = {
  readonly kind: ContextKind;
  readonly sections: readonly InspectedSection[];
  readonly usedTokens: number;
  readonly budgetTokens: number;
};

export type ContextPanelData = {
  readonly groups: readonly ContextPanelGroup[];
  readonly totalTokens: number;
  readonly includedCount: number;
  readonly prunedCount: number;
};

const KIND_ORDER: readonly ContextKind[] = ["base-policy", "user-context", "tools", "skills", "knowledge", "history"];

/** Shape a `ContextInspection` into grouped, budget-annotated panel data. Pure. */
export const shapeContextPanel = (inspection: ContextInspection): ContextPanelData => {
  const byKind = new Map<ContextKind, InspectedSection[]>();
  for (const section of inspection.sections) {
    const list = byKind.get(section.kind) ?? [];
    list.push(section);
    byKind.set(section.kind, list);
  }
  const groups: ContextPanelGroup[] = [];
  for (const kind of KIND_ORDER) {
    const sections = byKind.get(kind);
    if (!sections || sections.length === 0) continue;
    const usedTokens = sections.filter((s) => s.included).reduce((sum, s) => sum + s.estimatedTokens, 0);
    groups.push({ kind, sections, usedTokens, budgetTokens: inspection.budget[BUDGET_FIELD[kind]] });
  }
  return {
    groups,
    totalTokens: inspection.totalTokens,
    includedCount: inspection.sections.filter((s) => s.included).length,
    prunedCount: inspection.sections.filter((s) => !s.included).length,
  };
};

/** All sections tagged with a given provenance prefix — e.g. every `principal-memory:` entry used. */
export const sectionsByProvenance = (inspection: ContextInspection, prefix: string): readonly InspectedSection[] =>
  inspection.sections.filter((s) => s.included && s.provenance.startsWith(prefix));
