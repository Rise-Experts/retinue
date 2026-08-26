/**
 * Prompt assembly & budgeting — `docs/03-intelligence-runtime.md` → Prompt assembly.
 *
 * Turns the sections gathered from context providers into a budgeted, previewable prompt. Each
 * section draws from an explicit budget bucket (base policy, user/app context, tools, skills,
 * knowledge, history) rather than one undifferentiated window. When the prompt exceeds the model's
 * limit, sections are pruned in a fixed order — old reasoning, old tool detail, old knowledge, old
 * turns — while recent semantic turns and open tool continuity (sections with no `pruneStage`) are
 * preserved. Base policy is never pruned: if it cannot fit, assembly fails loudly rather than
 * silently dropping critical instructions.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import { PRUNE_ORDER } from "./index.js";
import { type ContextBudget, type ContextKind, type ContextProvider, type ContextSection, type PromptPreview } from "./index.js";

const BUCKET_FIELD: Readonly<Record<ContextKind, keyof ContextBudget>> = {
  "base-policy": "basePolicyTokens",
  "user-context": "userContextTokens",
  tools: "toolTokens",
  skills: "skillTokens",
  knowledge: "knowledgeTokens",
  history: "historyTokens",
};

const kindOf = (section: ContextSection): ContextKind => section.kind ?? "user-context";

/** Gather sections from every provider, in provider order. Providers that fail are surfaced, not hidden. */
export const gatherSections = async (
  context: ExecutionContext,
  providers: readonly ContextProvider[],
): Promise<readonly ContextSection[]> => {
  const sections: ContextSection[] = [];
  for (const provider of providers) sections.push(...(await provider.provide(context)));
  return sections;
};

export type AssembledPrompt = {
  /** Included sections, highest priority first within each bucket. */
  readonly sections: readonly ContextSection[];
  readonly preview: PromptPreview;
  readonly totalTokens: number;
  /**
   * The model's hard input limit this prompt was assembled against — #168.
   *
   * Echoed back rather than left to the caller to remember. It is the denominator of every useful question about
   * a prompt — how full is the window, how much is left, is this turn near the edge — and a caller holding the
   * numerator while the limit lives somewhere else is a caller computing utilization against the wrong model the
   * first time a policy resolves a different one.
   */
  readonly modelContextTokens: number;
  /** Sections dropped, with why — for observability and the context inspector. */
  readonly pruned: readonly { readonly section: ContextSection; readonly reason: "bucket-overflow" | PromptPruneStage }[];
};

type PromptPruneStage = (typeof PRUNE_ORDER)[number];

const overflow = (message: string): AgentPlatformError =>
  new AgentPlatformError({ code: "context_overflow", message, retryable: false });

/**
 * Assemble a budgeted prompt from already-gathered sections. Pure and deterministic, so composition
 * is previewable: the returned `preview` lists every section with its token estimate and whether it
 * was included. `modelContextTokens` is the hard input limit the assembled prompt must fit within.
 */
export const assemblePrompt = (input: {
  readonly sections: readonly ContextSection[];
  readonly budget: ContextBudget;
  readonly modelContextTokens: number;
}): AssembledPrompt => {
  const { budget, modelContextTokens } = input;
  const pruned: { section: ContextSection; reason: "bucket-overflow" | PromptPruneStage }[] = [];

  // 1. Per-bucket budgeting: within each bucket, keep the highest-priority sections that fit.
  const byKind = new Map<ContextKind, ContextSection[]>();
  for (const section of input.sections) {
    const list = byKind.get(kindOf(section)) ?? [];
    list.push(section);
    byKind.set(kindOf(section), list);
  }

  let included: ContextSection[] = [];
  for (const [kind, sections] of byKind) {
    const limit = budget[BUCKET_FIELD[kind]];
    const ordered = [...sections].sort((a, b) => b.priority - a.priority);
    let used = 0;
    for (const section of ordered) {
      if (used + section.estimatedTokens <= limit) {
        used += section.estimatedTokens;
        included.push(section);
      } else if (kind === "base-policy") {
        // Critical instructions must fit their budget; refuse rather than truncate.
        throw overflow(`Base policy needs more than its ${limit}-token budget`);
      } else {
        pruned.push({ section, reason: "bucket-overflow" });
      }
    }
  }

  // 2. Global limit: if still over the model's window, prune in the fixed stage order.
  let total = included.reduce((sum, s) => sum + s.estimatedTokens, 0);
  for (const stage of PRUNE_ORDER) {
    if (total <= modelContextTokens) break;
    // Drop lowest-priority sections tagged for this stage first. Base policy is never eligible,
    // even if a section carried a pruneStage — critical instructions are never dropped.
    const eligible = included
      .filter((s) => s.pruneStage === stage && s.kind !== "base-policy")
      .sort((a, b) => a.priority - b.priority);
    for (const section of eligible) {
      if (total <= modelContextTokens) break;
      included = included.filter((s) => s !== section);
      pruned.push({ section, reason: stage });
      total -= section.estimatedTokens;
    }
  }

  if (total > modelContextTokens) {
    throw overflow(
      `Prompt needs ${total} tokens but the model allows ${modelContextTokens}, and nothing further is prunable`,
    );
  }

  const includedSet = new Set(included);
  const preview: PromptPreview = {
    sections: input.sections.map((s) => ({
      title: s.title,
      estimatedTokens: s.estimatedTokens,
      included: includedSet.has(s),
    })),
    totalTokens: total,
    budget,
  };

  return { sections: included, preview, totalTokens: total, pruned, modelContextTokens };
};

/** A section's inspector view — enough for the Context panel to explain what shaped a turn. */
export type InspectedSection = {
  readonly title: string;
  readonly providerId: string;
  readonly kind: ContextKind;
  readonly provenance: string;
  readonly estimatedTokens: number;
  readonly sensitivity: ContextSection["sensitivity"];
  readonly included: boolean;
  /** Set when the section was dropped: why. */
  readonly prunedReason?: string;
};

export type ContextInspection = {
  readonly sections: readonly InspectedSection[];
  readonly totalTokens: number;
  readonly budget: ContextBudget;
  /** The model's hard input limit — the denominator for utilization (#168). */
  readonly modelContextTokens: number;
  /**
   * What is left for history and the model's reply.
   *
   * Derived here rather than by each client, because `max(0, limit - used)` is the kind of arithmetic that gets
   * written twice and clamped once. Never negative: the assembler refuses to overflow, so a negative remainder
   * would be a bug reported as a number.
   */
  readonly remainingTokens: number;
};

/**
 * Derive the context-inspector view from an assembled prompt: every section (included and pruned)
 * with its bucket, provenance and token cost — so the UI can attribute which context (and which
 * memory entries, via provenance) influenced a turn, and show what was dropped and why.
 */
export const inspectAssembledPrompt = (assembled: AssembledPrompt): ContextInspection => {
  const prunedReason = new Map(assembled.pruned.map((p) => [p.section, p.reason] as const));
  const view = (section: ContextSection, included: boolean): InspectedSection => ({
    title: section.title,
    providerId: section.providerId,
    kind: section.kind ?? "user-context",
    provenance: section.provenance,
    estimatedTokens: section.estimatedTokens,
    sensitivity: section.sensitivity,
    included,
    ...(prunedReason.has(section) ? { prunedReason: prunedReason.get(section)! } : {}),
  });
  return {
    sections: [
      ...assembled.sections.map((s) => view(s, true)),
      ...assembled.pruned.map((p) => view(p.section, false)),
    ],
    totalTokens: assembled.totalTokens,
    budget: assembled.preview.budget,
    modelContextTokens: assembled.modelContextTokens,
    // Clamped at zero. The assembler refuses to overflow, so a negative remainder would be a bug reported as a
    // number — and a UI drawing a negative bar is a UI nobody believes again.
    remainingTokens: Math.max(0, assembled.modelContextTokens - assembled.totalTokens),
  };
};
