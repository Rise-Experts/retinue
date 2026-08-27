/**
 * A token ceiling on the skill catalogue — REQ-045 (#204), task #210, AC-5.
 *
 * Skills have exactly the tool catalogue's problem: a compact entry per skill sits in context on every turn, and
 * the bodies already load on demand, so what is left is linear in how many skills a tenant has. 25 skills at
 * `descriptionMaxLength` is a page of prompt before the conversation starts.
 *
 * The budget is `core/budget.ts` — the same one the tool catalogue uses, not a second copy.
 *
 * ## The notice is part of the catalogue, not part of the log
 *
 * The tool path can be loud in a run event because the engine assembles the tool list and the engine owns the
 * event stream. The skill catalogue is assembled by a *context provider*, which has no event stream, so the same
 * report reaches the same place by a different route: `truncationNotice` puts it in the text the model reads.
 *
 * That is arguably the stronger channel of the two. A run event tells whoever reviews the run afterwards; this
 * tells the model *during* the turn, so it can say "there are more skills than I was shown" instead of
 * confidently reporting that no skill exists for the job. Callers still get the report, and a host with an event
 * stream to hand should log it too.
 */

/**
 * The specific core modules, **not** `core/index.js`.
 *
 * The barrel re-exports `core/validation.ts`, which imports `zod`. Importing it from here put zod into the
 * dependency graph of `@retinue/agentkit/persistence` — a subpath whose whole claim is that it reaches nothing
 * outside the standard library, so a test or a prototype needs no install beyond the package. Caught by
 * `root-import-weight.test.ts`, which walks the graph transitively; a barrel import is how that guarantee gets
 * lost, and it is invisible in review.
 */
import { applyTokenBudget, type BudgetOutcome, type TokenBudget } from "../core/budget.js";
import { estimateTokens } from "../core/tokens.js";
import type { SkillCatalogEntry } from "./index.js";

/**
 * Per-entry scaffolding: the bullet, the name emphasis, the version.
 *
 * Slightly larger than the tool catalogue's because a skill entry is rendered as prose in Markdown rather than
 * as a JSON tool definition.
 */
export const SKILL_ENTRY_OVERHEAD_TOKENS = 8;

export const skillEntryTokens = (entry: SkillCatalogEntry): number =>
  estimateTokens(`${entry.name} v${entry.version} ${entry.description}`) + SKILL_ENTRY_OVERHEAD_TOKENS;

export const budgetSkillCatalogue = (
  entries: readonly SkillCatalogEntry[],
  budget: TokenBudget,
): BudgetOutcome<SkillCatalogEntry> =>
  applyTokenBudget({
    items: entries,
    budget,
    tokensOf: skillEntryTokens,
    nameOf: (entry) => entry.name,
  });

/**
 * What the model is told when the catalogue was shortened.
 *
 * Names the skills rather than counting them, for the same reason the run event does: "3 more skills exist" is
 * something a model can only ignore, while a name is something it can ask for. Empty string when nothing was
 * dropped, so a caller can concatenate unconditionally.
 */
export const truncationNotice = (outcome: BudgetOutcome<SkillCatalogEntry>): string =>
  outcome.dropped.length === 0
    ? ""
    : [
        "",
        `Not every skill is listed above: ${outcome.dropped.length} more exist but did not fit this turn's`,
        `catalogue budget (${outcome.dropped.join(", ")}). If one of them is what the task needs, say so rather`,
        "than concluding there is no skill for it.",
      ].join("\n");
