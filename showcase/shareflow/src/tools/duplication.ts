/**
 * Near-duplicate detection against recent posts — #123 AC-5.
 *
 * **Net-new, because nothing in ShareFlow does this.** `getVoiceExamples` dedupes its own corpus on
 * `s.toLowerCase().slice(0, 80)`, which is a fingerprint of a *prefix*: enough to avoid showing the same
 * example twice, not enough to notice that a new post is a rewrite of last week's.
 *
 * ## The heuristic, and it is a judgement
 *
 * Normalise, then two tests:
 *
 * 1. **Exact match on the normalised text.** Catches the common case — the same post pasted again, or
 *    regenerated identically — and has no false positives worth worrying about.
 * 2. **Shingle overlap.** Three-word windows, compared as sets by Jaccard similarity. Catches a rewrite
 *    that changes the opening and keeps the body, which is what a model asked twice for the same brief
 *    actually produces.
 *
 * `DEFAULT_SIMILARITY_THRESHOLD` is 0.6 and that number is not measured. It is chosen so that two posts
 * sharing most of their phrasing match while two posts about the same product do not, and it is
 * configurable precisely because a workspace posting daily variations on one offer will want it higher
 * than one posting about unrelated things.
 *
 * ## What it cannot do
 *
 * It compares words, not meaning. A genuine paraphrase — same claim, different vocabulary — passes. It is
 * a check against accidental repetition, not a semantic novelty test, and calling it the second thing
 * would be the failure mode: someone trusting it to catch a rewrite it cannot see.
 */
import type { ValidationIssue } from "../services/index.js";

/** The code a duplication finding is reported under. */
export const DUPLICATE_CONTENT_CODE = "duplicate-content" as const;

/**
 * Similarity above which two captions are treated as the same post.
 *
 * Not measured — see the note above. 0.6 means "most of the phrasing is shared".
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

/** Window size for shingling. Three is the usual choice: single words are too common, five too brittle. */
const SHINGLE = 3;

/**
 * Lower-case, strip punctuation, collapse whitespace.
 *
 * Deliberately aggressive: the differences this removes — a changed emoji, a moved hashtag, different
 * quote marks — are exactly the differences a duplicate post has.
 */
export const normaliseCaption = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Three-word windows.
 *
 * A caption shorter than the window yields an empty set, and that is correct rather than a gap: two
 * identical short captions are already caught by the exact-match check in `captionSimilarity`, and two
 * *different* short captions have nothing meaningful to overlap.
 *
 * The first version special-cased them, treating a short caption as one token "so short captions still
 * compare to each other". Sabotage showed that branch was unreachable in effect — every case it claimed
 * to handle was already decided by the exact-match short-circuit, or produced the same zero. Dead code
 * with a confident comment is worse than no code, so it is gone.
 */
const shingles = (normalised: string): ReadonlySet<string> => {
  const words = normalised.split(" ").filter((w) => w !== "");
  const out = new Set<string>();
  for (let i = 0; i <= words.length - SHINGLE; i += 1) out.add(words.slice(i, i + SHINGLE).join(" "));
  return out;
};

/** Jaccard similarity of two shingle sets: shared windows over total distinct windows. */
export const captionSimilarity = (a: string, b: string): number => {
  const left = normaliseCaption(a);
  const right = normaliseCaption(b);
  if (left === "" || right === "") return 0;
  if (left === right) return 1;
  const x = shingles(left);
  const y = shingles(right);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const s of x) if (y.has(s)) shared += 1;
  return shared / (x.size + y.size - shared);
};

/**
 * Findings for a caption that repeats something recent.
 *
 * `repairable: true` — unlike a forbidden claim. A duplicate is a *writing* problem, and rewriting it is
 * exactly what a repair attempt is for; refusing outright would send the user back to ask for the same
 * thing in different words.
 *
 * The finding names the post it duplicates, so the assistant can say which one rather than "this is
 * similar to something".
 */
export const findDuplicateContent = (
  caption: string,
  recent: readonly { readonly postDraftId: string; readonly caption: string }[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): readonly ValidationIssue[] => {
  let worst: { id: string; score: number } | null = null;
  for (const post of recent) {
    const score = captionSimilarity(caption, post.caption);
    if (score < threshold) continue;
    if (worst === null || score > worst.score) worst = { id: post.postDraftId, score };
  }
  if (worst === null) return [];
  return [
    {
      code: DUPLICATE_CONTENT_CODE,
      // Rounded, because a similarity to three decimal places implies a precision the heuristic does not
      // have — and an assistant repeating "0.734 similar" to a user is worse than "very similar".
      message: `this closely repeats an existing post (${worst.id}); rewrite it rather than reposting`,
      repairable: true,
    },
  ];
};
