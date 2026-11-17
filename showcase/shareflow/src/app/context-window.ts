/**
 * How much a turn's model can read, and how much of that the assistant should use — #630.
 *
 * ## The whole window — #644
 *
 * The model's window is what the provider accepts: Gemini 2.5 reads 1,048,576 tokens, gpt-4.1 1,047,576, Claude
 * 200,000, gpt-4o 128,000. The assistant plans against all of it, as Claude Code does: history grows turn by turn,
 * tool inputs and results included, and is condensed only near the limit (`COMPACT_AT`).
 *
 * #630 capped a 1M window at a 200k "working window", on the evidence that models degrade as input grows. The
 * owner's report on 2026-09-29 was the other side of that trade: an agent that forgot what it had done three
 * turns back and rebuilt a slide deck from memory rather than editing it. `working` stays in the type so the
 * callers keep one number to plan against; it now equals the window. Prompt caching keeps a long thread's
 * repeated prefix cheap.
 *
 * Before this, nothing declared a window (`contextTokens: 0` on every definition) and every model was
 * sized against the same fixed 120,000 — which is why the meter never passed ~20%.
 *
 * ## Unknown models
 *
 * A model this table does not know gets 128,000: the smallest window any current chat model offers. Too
 * small only condenses a thread earlier than it had to; too large hands the provider a request it rejects.
 */

/** What an unrecognised model is assumed to accept. */
export const UNKNOWN_MODEL_WINDOW = 128_000;

/** Longest match wins, so `gpt-4.1-mini` is not read as `gpt-4`. Case-insensitive, prefix of the model id. */
const WINDOWS: readonly (readonly [prefix: string, tokens: number])[] = [
  ["gemini-3", 1_048_576],
  ["gemini-2.5", 1_048_576],
  ["gemini-2.0", 1_048_576],
  ["gemini-1.5-pro", 2_097_152],
  ["gemini-1.5", 1_048_576],
  ["gpt-4.1", 1_047_576],
  ["gpt-5", 400_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["o1", 200_000],
  ["o3", 200_000],
  ["o4", 200_000],
  ["claude", 200_000],
  ["mistral-large", 128_000],
  ["mistral-medium", 128_000],
  ["mistral-small", 128_000],
  ["codestral", 256_000],
];

/** The model's own window, in tokens. Provider prefixes (`models/`, `openai/`) are ignored. */
export const modelContextWindow = (modelId: string): number => {
  const id = modelId.toLowerCase().replace(/^.*\//, "");
  let best: readonly [string, number] | undefined;
  for (const entry of WINDOWS) {
    if (id.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1] ?? UNKNOWN_MODEL_WINDOW;
};

export type ContextWindow = {
  /** What the provider accepts. */
  readonly window: number;
  /** What the assistant plans against: the meter's limit, and the base of every threshold below. */
  readonly working: number;
};

/** The model's windows — #644: the assistant plans against the whole of it, as Claude Code does. */
export const contextWindowFor = (modelId: string): ContextWindow => {
  const window = modelContextWindow(modelId);
  return { window, working: window };
};


/**
 * The share of the working window at which the older part of a thread is condensed.
 *
 * Claude Code condenses near the limit; this is a little earlier because the estimate that decides it is of
 * history alone, and the tool results a run adds on top are not known until it runs. #658: that estimate is in
 * the answering provider's tokens (`token-ratio.ts`) — at a flat chars ÷ 4, Gemini condensed at ~53%, not 85%.
 */
export const COMPACT_AT = 0.85;

/**
 * How much of the history budget stays verbatim after a condensation.
 *
 * Well under the budget on purpose — hysteresis. Keeping "whatever still fits" re-crossed the line a turn
 * or two later and condensed again, a model call and a broken prompt cache every few messages. Keeping
 * 40% means the next condensation is many turns away.
 */
export const KEEP_AFTER_COMPACT = 0.4;

/** In-run clearing: old tool outputs are replaced past this share of the working window… */
export const CLEAR_TOOL_RESULTS_AT = 0.6;
/** …until the prompt is back under this one, so a clear frees enough to be worth the cache it breaks. */
export const CLEAR_TOOL_RESULTS_TO = 0.45;
/** The most recent tool results a clear never touches. Anthropic's `clear_tool_uses` keeps 3 by default. */
export const KEEP_RECENT_TOOL_RESULTS = 4;
