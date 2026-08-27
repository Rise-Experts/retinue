/**
 * A token ceiling on a catalogue, and the rule that truncation is never quiet — REQ-045 (#204), task #210.
 *
 * The tool catalogue and the skill catalogue have the same problem: a compact entry per item, resident on every
 * turn, linear in how many exist. #221 measured ~35 tokens per tool entry, so 200 tools is ~7,000 tokens before
 * a word of the conversation. Two-tier loading bounded the *schemas* and left the entries.
 *
 * ## Truncation must be loud, and this is the whole guarantee
 *
 * A silently shortened catalogue is **indistinguishable from correct behaviour**. The model is not told an item
 * was withheld; it simply never uses it, and the transcript reads as a run where the model chose not to. Nobody
 * reviewing that run has anything to notice. So dropping is never quiet: the outcome names every dropped item,
 * the engine turns that into a run event, and #210's AC-7 is a test that removing the event fails the build.
 *
 * In `core/` because both callers need it and neither owns it — and because a second copy for skills would drift
 * from the first, which is the shape this repository keeps finding defects in.
 */

export type TokenBudget = {
  /** The ceiling. A catalogue at or under it is untouched and no event is emitted. */
  readonly maxTokens: number;
};

export type BudgetOutcome<T> = {
  readonly resident: readonly T[];
  /** Names, in the order they were dropped. Named rather than counted: a count is not actionable. */
  readonly dropped: readonly string[];
  readonly residentTokens: number;
  readonly budgetTokens: number;
  /**
   * True when the budget could not be met even after dropping everything droppable.
   *
   * Distinct from "it bound", because the two need different responses: a bound budget is the mechanism working,
   * while an unmeetable one is a misconfiguration — the protected set alone does not fit, and a deployment that
   * believes it capped its context has not.
   */
  readonly overBudget: boolean;
};

/**
 * Keep what fits, in the order given, and name what did not.
 *
 * **Order is the caller's priority**, not a ranking invented here. For tools that is the order the host's
 * providers were registered in, which is a deployment's own statement about what matters; inventing a relevance
 * order would mean guessing at the model's next need, and `find_tools` is the honest answer to that.
 *
 * `protect` names what may never be dropped. Meta-tools are the reason it exists: dropping `find_tools` or
 * `learn_tools` to save 35 tokens would remove the model's only route back to everything else, turning a budget
 * into a permanent amputation.
 */
export const applyTokenBudget = <T>(input: {
  readonly items: readonly T[];
  readonly budget: TokenBudget;
  readonly tokensOf: (item: T) => number;
  readonly nameOf: (item: T) => string;
  readonly protect?: (item: T) => boolean;
}): BudgetOutcome<T> => {
  const protectedItems: T[] = [];
  const droppable: T[] = [];
  for (const item of input.items) (input.protect?.(item) === true ? protectedItems : droppable).push(item);

  // Protected first, and counted even when they overrun: a report that omitted them would understate the
  // resident cost and hide precisely the misconfiguration `overBudget` exists to name.
  let spent = protectedItems.reduce((total, item) => total + input.tokensOf(item), 0);
  const resident: T[] = [...protectedItems];
  const dropped: string[] = [];

  for (const item of droppable) {
    const cost = input.tokensOf(item);
    if (spent + cost <= input.budget.maxTokens) {
      resident.push(item);
      spent += cost;
    } else dropped.push(input.nameOf(item));
  }

  return {
    resident,
    dropped,
    residentTokens: spent,
    budgetTokens: input.budget.maxTokens,
    overBudget: spent > input.budget.maxTokens,
  };
};

