/**
 * What a tool costs a catalogue — REQ-045 (#204), task #210, AC-3.
 *
 * The budget itself is in `core/budget.ts`, shared with the skill catalogue. What is here is the part that knows
 * about tools: how many tokens one entry is, which is the only thing the generic algorithm cannot know.
 */

import { estimateTokens } from "../core/tokens.js";
import type { ToolCatalogEntry, ToolDescriptor } from "./index.js";

/**
 * Deliberately **not** re-exported here.
 *
 * `applyTokenBudget`, `TokenBudget` and `BudgetOutcome` live in `core/` and reach consumers through
 * `@retinue/agentkit/runtime`. Re-exporting them from `./tools` as well gave one name two homes, which
 * `public-surface.test.ts` fails on — and it is right to: a consumer reading two import paths for one function
 * has to guess which is canonical, and the two will not stay in step.
 */

/**
 * What a compact catalogue entry costs.
 *
 * The fields a model actually reads, plus a small per-entry allowance for the JSON or Markdown scaffolding the
 * assembler wraps them in — measured at ~35 tokens per entry in #221's harness, which is what this reproduces.
 * An estimate rather than a tokenizer call: the point is a stable ceiling, and a budget that shifted with the
 * model's tokenizer would make one deployment's 4,000 tokens another's 4,600.
 */
export const ENTRY_OVERHEAD_TOKENS = 6;

export const entryTokens = (entry: ToolCatalogEntry): number =>
  estimateTokens(`${entry.name} ${entry.label} ${entry.category} ${entry.effect} ${entry.description}`) +
  ENTRY_OVERHEAD_TOKENS;

/** A preloaded tool carries its schemas, which is usually most of its cost. */
export const descriptorTokens = (descriptor: ToolDescriptor): number =>
  entryTokens({
    name: descriptor.name,
    label: descriptor.label,
    description: descriptor.description,
    category: descriptor.category,
    effect: descriptor.effect,
  }) + estimateTokens(JSON.stringify(descriptor.inputSchema ?? {}));
