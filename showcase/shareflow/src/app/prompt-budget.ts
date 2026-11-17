/**
 * How the 120,000-token input ceiling is actually spent — and enforced.
 *
 * ## What was wrong
 *
 * `maxInputTokens: 120_000` was declared in `compose.ts` and enforced **nowhere**. The machinery for it
 * exists and was reached by nothing:
 *
 * - `assemblePrompt` — the platform's budgeter, which buckets sections, prunes by priority and refuses
 *   rather than silently truncating — has **zero callers**. Not in this package, not anywhere in
 *   `@retinue/agentkit`. Only `context/__tests__/providers.test.ts`, which is why five well-written
 *   tests could assert pruning behaviour that never ran: `createContextForTurn` went
 *   `gatherSections` → `renderContextBlock`, straight past the budget.
 * - `compactThread`, the intended history mechanism, also has zero callers.
 * - So `estimatedTokens`, `priority` and `pruneStage` were computed on every section and consulted by
 *   nothing, and `maxInputTokens` was read twice — both times in `main.ts`, both only to *display* the
 *   limit in the context meter.
 *
 * The two reads are the tell: the number was shown to the user as a denominator while nothing divided
 * anything by it.
 *
 * ## What it is spent on, measured
 *
 * Measured against the production workspace rather than estimated, because a budget derived from
 * guesses is a second source of truth that can disagree with the prompt:
 *
 *     system prompt                    1,296 tok
 *     tool declarations (22 tools)     3,335 tok
 *     skill catalogue                    542 tok
 *     five skill bodies (the per-run
 *       load cap, SKILL_LIMITS)        3,240 tok
 *     context block                      148 tok
 *     ------------------------------  ----------
 *     fixed subtotal                   8,561 tok   of 120,000
 *
 * And what runs actually cost, from `usage_records` over 139 production runs: **mean 17,245, p95
 * 25,478, max 38,559**. So the ceiling has never been approached, which is worth saying plainly — this
 * closes a latent hole rather than putting out a fire, and the allocations below are sized to be
 * invisible in normal use.
 *
 * ## Where the growth actually is
 *
 * Not the context block. That is 148 tokens today, and even a workspace that fills in every brand
 * field and carries twenty voice examples reaches a few thousand. **It is history.**
 * `conversationHistory` reads the most recent 400 messages and passes all of them, and 400 messages of
 * arbitrary length is the one input that can exceed the ceiling on its own. `HISTORY_READ_LIMIT`'s own
 * comment says so: *"The bound exists to keep one query bounded, not as a context policy — when
 * compaction is wired, it should fire long before this matters."* Compaction is not wired, so the
 * 400-message bound is the only thing standing between a long thread and the model's real limit.
 *
 * That is why the history allocation is the large one, and why it is enforced in tokens rather than in
 * messages. A message count cannot bound a token cost.
 *
 * ## Why the numbers below
 *
 * Each allocation is the measured figure with deliberate headroom, and the headroom is stated so a
 * future change can tell a sized allocation from a padded one. Nothing here is tuned for the current
 * workspace's data: a workspace that fills in what this one leaves blank must not start losing
 * sections.
 */
import { SOCIAL_ASSISTANT_LIMITS } from "./compose.js";
import { SUMMARY_MAX_CHARS } from "./thread-summary.js";
import { COMPACT_AT } from "./context-window.js";
import { MIN_CHARS_PER_TOKEN } from "./token-ratio.js";

import type { ContextBudget } from "@retinue/agentkit/context";

/**
 * The share of the window reserved for everything that is not history.
 *
 * The sum of the five non-history buckets below. Written as a derived value rather than a literal so
 * that changing an allocation cannot silently change what history gets — the two are one division of
 * one number, and the arithmetic belongs in code.
 */
const CONTEXT_BUCKETS = {
  /**
   * Claims and the untrusted-content warning. Measured: 132 tokens, all of it the warning.
   *
   * Sized far above that on purpose. This is the bucket `assemblePrompt` **throws** on rather than
   * prunes — "critical instructions must fit their budget; refuse rather than truncate" — and
   * `shareflow.claims` is workspace data. It emits nothing today only because `getClaimPolicy` has no
   * store and answers an empty policy; the day a store exists, a workspace with a long forbidden list
   * lands here, and a tight number would turn that into a refused turn.
   */
  basePolicyTokens: 4_000,
  /**
   * Brand, audience, destinations, examples, campaign, performance. Measured: 16 tokens on a workspace
   * with no brand profile filled in.
   *
   * The realistic ceiling is what a workspace can actually store: a voice and custom instructions with
   * no length guard on the write path, plus up to `MAX_VOICE_EXAMPLES` (20) excerpts. 12,000 tokens is
   * roughly 48,000 characters, which is more than any of those fields is likely to hold and still only
   * a tenth of the window.
   */
  userContextTokens: 12_000,
  /** Tool declarations. Measured 3,335 for 22 tools; sized at ~1.8x so the lazy catalogue can grow. */
  toolTokens: 6_000,
  /** Skill bodies. Measured 3,240 for the five largest — the per-run cap — at ~1.85x. */
  skillTokens: 6_000,
  /**
   * #644: "Documents in this chat" — the current text of the conversation's documents (three in full, ~96k
   * characters at most). Its own bucket so a long deck cannot push the brand or the project out of the prompt.
   */
  knowledgeTokens: 32_000,
} as const;

/** Reserved for the reply. `maxOutputTokens` is 8,000, and a provider that shares one window needs it. */
const OUTPUT_RESERVE_TOKENS = SOCIAL_ASSISTANT_LIMITS.maxOutputTokens;

/**
 * The smallest history worth sending: a thread summary, plus enough room for the exchange around it.
 *
 * **Derived from `SUMMARY_MAX_CHARS`, and that is the point.** A compacted thread's summary is
 * protected from trimming — it is what all the older turns were replaced by, so dropping it would
 * throw away the model call that produced it — and a protected value larger than the budget makes the
 * budget a suggestion rather than a guarantee. Measured while testing: a 4,000-character summary
 * against a 100-token budget produced a 1,083-token history.
 *
 * Deriving the floor removes the failure instead of handling it. The summary can never exceed
 * `SUMMARY_MAX_CHARS`, so a floor of "one whole summary plus room for the turn being answered and a
 * couple around it" means the protected part always fits, whatever `maxInputTokens` a deployment sets.
 * `historyBudgetFitsASummary` asserts the two cannot drift apart.
 *
 * Chosen as room-for-a-summary rather than a share of the ceiling, because a fraction of a small
 * ceiling shrinks to nothing, and below this the number stops being a budget and starts being a bug.
 */
export const HISTORY_FLOOR_TOKENS = Math.ceil(SUMMARY_MAX_CHARS / MIN_CHARS_PER_TOKEN) + 2_000;
/*
 * #658: sized at the *densest* ratio `token-ratio.ts` can return, not at chars ÷ 4. History is now estimated in
 * the answering provider's tokens, learned per conversation, and a summary that fits at 4 characters a token does
 * not fit at 3. The floor is a constant, so it has to hold for every ratio a conversation can learn.
 */

/**
 * Whether a history budget can hold a whole summary and still have room to be a history.
 *
 * Exported so a test can assert the relationship rather than restate the numbers, which is what lets
 * either constant move without the other silently becoming wrong.
 */
export const historyBudgetFitsASummary = (budget: number): boolean =>
  budget >= Math.ceil(SUMMARY_MAX_CHARS / MIN_CHARS_PER_TOKEN);

/**
 * The token budget for conversation history — the remainder, and the number that matters.
 *
 * 120,000 − 32,000 (buckets) − 8,000 (output) = **80,000 tokens**, which is 2x the largest total input
 * ever recorded on this deployment and 4.6x the mean. So it cannot bite a normal conversation, and it
 * does stop an unbounded one: a thread that would have grown past the model's real limit now drops its
 * oldest turns instead, visibly.
 *
 * Derived rather than written down, so it cannot drift out of step with the buckets above.
 */
export const historyTokenBudget = (maxInputTokens: number = SOCIAL_ASSISTANT_LIMITS.maxInputTokens): number => {
  const reserved =
    Object.values(CONTEXT_BUCKETS).reduce((sum, tokens) => sum + tokens, 0) + OUTPUT_RESERVE_TOKENS;
  /**
   * Never negative, and never zero.
   *
   * A deployment could set `maxInputTokens` below what the fixed parts need — a small local model, a
   * tightened policy — and a zero history budget would mean an assistant with no memory of the
   * sentence before, which is a stranger failure than a long prompt. The floor keeps the last few
   * turns and lets the model's own limit be the thing that complains.
   */
  return Math.max(HISTORY_FLOOR_TOKENS, maxInputTokens - reserved);
};

/**
 * The history budget for a turn's **model** — #630.
 *
 * `historyTokenBudget` sized every model against the same 120,000, so Claude (200k), gpt-4o (128k) and
 * Gemini (1M) all condensed at the same 80k. This takes the model's working window (`context-window.ts`)
 * and condenses at `COMPACT_AT` of it, less the same fixed allocation: a 200k working window gives
 * 160,000 − 40,000 = **120,000** of history, a 128k model 62,400.
 */
export const historyBudgetForWindow = (workingWindow: number): number =>
  Math.max(HISTORY_FLOOR_TOKENS, Math.floor(workingWindow * COMPACT_AT) - NON_HISTORY_TOKENS);

/** #657: everything in a prompt that is not history — the context buckets and the reply's reserve. */
export const NON_HISTORY_TOKENS = Object.values(CONTEXT_BUCKETS).reduce((sum, tokens) => sum + tokens, 0) + OUTPUT_RESERVE_TOKENS;

/**
 * The context-block budget, in the platform's own shape.
 *
 * `historyTokens` is set to the same figure `historyTokenBudget` returns, for consistency, but nothing
 * reads it: history reaches the engine as `TurnMessage[]` and never passes through `assemblePrompt`,
 * so its bound is enforced in `conversationHistory` instead. Setting it to zero would be a lie about
 * the division, and leaving it out is not allowed — `ContextBudget` requires every bucket.
 */
export const shareFlowContextBudget = (
  maxInputTokens: number = SOCIAL_ASSISTANT_LIMITS.maxInputTokens,
): ContextBudget => ({
  ...CONTEXT_BUCKETS,
  historyTokens: historyTokenBudget(maxInputTokens),
});

/**
 * What the whole context block may cost, for `assemblePrompt`'s global check.
 *
 * Passing the model's full 120,000 here would make that check dead — the per-bucket limits already cap
 * these sections far below it, so the global stage could never fire and `pruneStage` would go on being
 * decorative. The sum of the buckets that these sections can actually land in is the honest ceiling
 * for this call, and it makes the second pruning stage reachable.
 */
export const contextBlockCeiling = (): number =>
  // #644: the documents section lands in `knowledge`, so the ceiling holds it too.
  CONTEXT_BUCKETS.basePolicyTokens + CONTEXT_BUCKETS.userContextTokens + CONTEXT_BUCKETS.knowledgeTokens;

/**
 * #657: the most history a turn on the **platform's** key carries before older turns are condensed, in estimated
 * tokens. A 1M window is a ceiling, not a target: every message re-sends the whole thread, and after a break (cache
 * expired) that is paid in full. A workspace on its own key keeps the model's whole window — its key, its bill.
 */
export const PLATFORM_HISTORY_CAP = 200_000;
