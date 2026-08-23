/**
 * The token estimate, in one place (#135).
 *
 * Five copies of `Math.ceil(text.length / 4)` had accumulated — in `files/context.ts`, `knowledge/chunking.ts`,
 * `context/compaction.ts`, `usage/recorder.ts` and `principal-memory/index.ts`. Two of them exported the same
 * name, which is what surfaced it: the package barrel refused to re-export both, the same collision
 * `DEFAULT_SESSION_STATE_MAX_BYTES` caused before #97 moved it to its port.
 *
 * They agreed by coincidence rather than by construction, and the coincidence mattered: a chunk sized against
 * one estimate and budgeted against a different one is a chunk that does not fit the budget it was measured
 * for. One definition, in the lowest layer, so agreement is structural.
 *
 * **Deliberately not a real tokeniser.** A tokeniser is a dependency, it is model-specific, and it is wrong the
 * moment the model changes. Every caller here uses the estimate to size something — a chunk boundary, a budget
 * bucket, a cost projection — where being 10% out moves a boundary rather than breaking anything. Where an
 * exact count matters, the provider's own reported usage is authoritative and this is not consulted.
 */

/** Characters over four — the industry rule of thumb for English text with a BPE tokeniser. */
export const CHARS_PER_TOKEN = 4;

/** An estimate of how many tokens `text` occupies. Never negative, never fractional. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);
