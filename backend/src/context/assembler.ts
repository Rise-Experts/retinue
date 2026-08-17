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
import {
  PRUNE_ORDER,
  type ContextBudget,
  type ContextKind,
  type ContextProvider,
  type ContextSection,
  type PromptPreview,
} from "./index.js";

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
    // Drop lowest-priority sections tagged for this stage first.
    const eligible = included
      .filter((s) => s.pruneStage === stage)
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

  return { sections: included, preview, totalTokens: total, pruned };
};
