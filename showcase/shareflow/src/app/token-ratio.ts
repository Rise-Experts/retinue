/**
 * How many characters a provider counts as one token, per conversation — #658.
 *
 * ## What was wrong
 *
 * Every estimate in this package was `chars ÷ 4`. That is the usual rule of thumb for English on OpenAI's and
 * Anthropic's tokenisers, and it is wrong for Gemini: the production evaluation of 2026-09-30 (one chat on
 * gemini-2.5-flash) sent 29k characters that Gemini billed as 4.85k tokens — **~6 characters per token**. So the
 * history estimate read 1.5x the real size, and a history budget planned at `COMPACT_AT` (85%) of the window
 * actually condensed at ~550k real tokens of a 1M window: ~53%, not 85%. The meter's "condenses here" line and
 * the compaction that fired disagreed by the same factor.
 *
 * ## What it is now
 *
 * The provider already tells us the answer on every call: `assistant_turn_steps.last_input_tokens` is the last
 * call's measured input (#518), and since this issue the same row's `prompt_fingerprint` carries how many
 * characters that call's prompt held (`promptChars`). Their quotient is the ratio the provider actually used on
 * this conversation's own text — its language, its tool records, its code — and the next turn plans with it.
 *
 * - **No previous turn** (a new chat), or a previous turn that cannot speak for this one, falls back to a
 *   per-model default: Gemini ≈ 6, Claude and OpenAI ≈ 4.
 * - **"Cannot speak for this one"** means: recorded before `promptChars` existed, carried an image or a file
 *   (tokens with no characters behind them — the quotient would read a picture as very dense prose), or was
 *   answered by a model with a different tokeniser (a chat switched from Gemini to Claude mid-way).
 * - **Clamped to `[MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN]`.** A ratio outside it is a measurement problem,
 *   not a language: a provider that reported only the uncached part of the input, or a prompt recorded for a
 *   different call than the one measured. The clamp bounds the damage of a bad reading to "a little early" or
 *   "a little late", never "never".
 *
 * Provider usage stays the ground truth; this only makes the estimate that decides *before* the call agree
 * with it.
 */

/** The rule of thumb this package used everywhere, and still the default for an unknown model. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * The densest text a learned ratio may claim. Below this the estimate would over-count by more than a third
 * against the default, which no tokeniser in `CHARS_PER_TOKEN_DEFAULTS` produces on prose.
 *
 * Also the ratio the history floor (`prompt-budget.ts`) is sized against, so a protected thread summary fits
 * the floor at *any* ratio this module can return.
 */
export const MIN_CHARS_PER_TOKEN = 3;

/** The sparsest. Gemini's measured ~6 sits well inside; past 8 the reading is almost certainly not prose. */
export const MAX_CHARS_PER_TOKEN = 8;

/**
 * Per-model defaults, by tokeniser family. Longest prefix wins, case-insensitive, provider prefixes ignored —
 * the same matching `context-window.ts` uses for windows.
 */
const CHARS_PER_TOKEN_DEFAULTS: readonly (readonly [prefix: string, family: TokenizerFamily, charsPerToken: number])[] = [
  // Measured: 29k characters → 4.85k tokens on gemini-2.5-flash (production, 2026-09-30).
  ["gemini", "gemini", 6],
  ["claude", "anthropic", 4],
  ["gpt", "openai", 4],
  ["o1", "openai", 4],
  ["o3", "openai", 4],
  ["o4", "openai", 4],
];

export type TokenizerFamily = "gemini" | "anthropic" | "openai" | "other";

const modelKey = (modelId: string): string => modelId.toLowerCase().replace(/^.*\//, "");

const defaultsFor = (modelId: string): readonly [string, TokenizerFamily, number] | undefined => {
  const id = modelKey(modelId);
  let best: readonly [string, TokenizerFamily, number] | undefined;
  for (const entry of CHARS_PER_TOKEN_DEFAULTS) {
    if (id.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
  }
  return best;
};

/** Which tokeniser a model uses — a learned ratio only carries over between models of one family. */
export const tokenizerFamily = (modelId: string): TokenizerFamily => defaultsFor(modelId)?.[1] ?? "other";

/** What a model's tokeniser is assumed to do before this conversation has told us. */
export const defaultCharsPerToken = (modelId: string): number => defaultsFor(modelId)?.[2] ?? DEFAULT_CHARS_PER_TOKEN;

const clamp = (ratio: number): number => Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));

/** One measured call: what was sent, in characters, and what the provider billed it as. */
export type MeasuredPrompt = {
  /** The model that answered the measured call. */
  readonly modelId?: string;
  /** Characters in that call's prompt (`PromptFingerprint.promptChars`). */
  readonly promptChars?: number;
  /** True when the prompt carried an image or a file — tokens with no characters behind them. */
  readonly hasMedia?: boolean;
  /** The provider's input tokens for the same call (`last_input_tokens`). */
  readonly inputTokens: number;
};

/**
 * The ratio one measured call implies, or undefined when it cannot speak for prose. Clamped.
 *
 * Pure. Exported so the meter (`main.ts`) can rescale a turn's breakdown with the ratio *that turn* showed.
 */
export const measuredCharsPerToken = (measured: MeasuredPrompt | undefined): number | undefined => {
  if (measured === undefined || measured.hasMedia === true) return undefined;
  const chars = measured.promptChars ?? 0;
  if (!(chars > 0) || !(measured.inputTokens > 0)) return undefined;
  return clamp(chars / measured.inputTokens);
};

/**
 * The ratio to plan this turn with: the previous turn's measurement when it is of the same tokeniser, else the
 * model's default.
 */
export const charsPerTokenFor = (input: { readonly modelId: string; readonly previous?: MeasuredPrompt | undefined }): number => {
  const learned = measuredCharsPerToken(input.previous);
  const sameTokenizer =
    input.previous?.modelId === undefined || tokenizerFamily(input.previous.modelId) === tokenizerFamily(input.modelId);
  return learned !== undefined && sameTokenizer ? learned : defaultCharsPerToken(input.modelId);
};

/**
 * Tokens for `text` at `charsPerToken`, rounded up so an estimate never under-counts. A non-positive or
 * non-finite ratio is read as the default, so a caller that passes nothing sensible gets the old behaviour.
 */
export const estimateTokensAt = (text: string, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number =>
  Math.ceil(text.length / (Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN));

/**
 * The previous turn's measurement, out of the conversation's latest measured `assistant_turn_steps` row
 * (`readTurnSteps`). Undefined when the row is missing or predates `promptChars`.
 */
export const measuredPromptOf = (
  steps: { readonly lastInputTokens: number; readonly promptFingerprint?: unknown; readonly model?: { readonly modelId: string } } | null | undefined,
): MeasuredPrompt | undefined => {
  if (steps === null || steps === undefined) return undefined;
  const fingerprint = (steps.promptFingerprint ?? {}) as { readonly promptChars?: unknown; readonly hasMedia?: unknown };
  if (typeof fingerprint.promptChars !== "number") return undefined;
  return {
    inputTokens: steps.lastInputTokens,
    promptChars: fingerprint.promptChars,
    hasMedia: fingerprint.hasMedia === true,
    ...(steps.model === undefined ? {} : { modelId: steps.model.modelId }),
  };
};

/**
 * A turn's recorded prompt make-up (#552), restated at the ratio the provider showed.
 *
 * The sections were sized at chars ÷ 4 when the prompt was assembled — before anything was measured — and the
 * meter draws the conversation as "measured input minus the sections". On Gemini that overstated every section
 * by half and shrank the chat bar by the same amount. Rescaling by `4 / charsPerToken` puts the sections in the
 * provider's tokens, the same unit as the measured total they are subtracted from.
 */
export const rescaleContextSections = (summary: unknown, charsPerToken: number | undefined): unknown => {
  if (charsPerToken === undefined || charsPerToken === DEFAULT_CHARS_PER_TOKEN) return summary;
  if (summary === null || typeof summary !== "object") return summary;
  const s = summary as { readonly instructionsTokens?: unknown; readonly sections?: unknown };
  const scale = (tokens: unknown): unknown => (typeof tokens === "number" ? Math.round((tokens * DEFAULT_CHARS_PER_TOKEN) / charsPerToken) : tokens);
  return {
    ...(summary as object),
    ...(s.instructionsTokens === undefined ? {} : { instructionsTokens: scale(s.instructionsTokens) }),
    ...(Array.isArray(s.sections)
      ? {
          sections: s.sections.map((section: unknown) =>
            section !== null && typeof section === "object" && "tokens" in section
              ? { ...(section as object), tokens: scale((section as { tokens: unknown }).tokens) }
              : section,
          ),
        }
      : {}),
  };
};
