/**
 * EvalCase schema + zero-dependency validator (SPEC #13).
 *
 * A case is `input` (what the agent receives) + a single graded `expect`ation. The grading
 * engine that runs these against a live runtime is Phase 12 (SPEC-050); this file only defines
 * and validates the shape.
 */

export const DIMENSIONS = [
  "task-completion",
  "tool-selection",
  "authorization",
  "external-action-safety",
  "groundedness",
  /**
   * Retrieval quality — REQ-050 (#209), task #219.
   *
   * A sixth dimension rather than a file of its own, because "versioned with the others" is what makes it get
   * re-run: a dataset nothing counts is a dataset that goes stale, and `coverage.mjs` fails on an empty
   * dimension.
   *
   * These cases are scored by `retrieval-quality.mjs` rather than by the agent grader — the subject is the
   * retriever, not a model's answer — so `input.message` carries the query and `expect.relevant` carries the
   * judgements.
   */
  "retrieval",
];

export const EXPECT_KINDS = [
  "contains",           // value: string[] — output should mention these
  "tool-called",        // tool: string
  "tool-not-called",    // tool: string
  "requires-approval",  // tool: string
  "refuses",            // reason?: string
  "cites-source",       // value?: string[]
  "structured-valid",   // schema?: string
  /**
   * relevant: { source, mustContain }[] — task #219.
   *
   * A **predicate**, not a chunk id: a relevant result is one whose chunk comes from a named document *and*
   * contains a required phrase. Judging by chunk id would break the dataset every time the chunker changed its
   * boundaries, which is exactly the change somebody would want to evaluate. It also states *why* a chunk is
   * relevant, in a form a reader can check against the document.
   */
  "retrieves",
];

const isStr = (v) => typeof v === "string" && v.length > 0;

/** Returns an array of human-readable problems; empty means the case is valid. */
export function validateCase(c) {
  const errs = [];
  const at = c && c.id ? `case ${c.id}` : "case";
  if (!c || typeof c !== "object") return ["case is not an object"];
  if (!isStr(c.id)) errs.push(`${at}: missing id`);
  if (!DIMENSIONS.includes(c.dimension)) errs.push(`${at}: bad dimension "${c.dimension}"`);
  if (!isStr(c.title)) errs.push(`${at}: missing title`);
  if (!c.input || !isStr(c.input.message)) errs.push(`${at}: missing input.message`);
  if (!c.expect || !EXPECT_KINDS.includes(c.expect.kind)) {
    errs.push(`${at}: bad expect.kind "${c.expect && c.expect.kind}"`);
  } else {
    const e = c.expect;
    if ((e.kind === "tool-called" || e.kind === "tool-not-called" || e.kind === "requires-approval") && !isStr(e.tool))
      errs.push(`${at}: expect.kind ${e.kind} needs a "tool"`);
    if (e.kind === "contains" && !(Array.isArray(e.value) && e.value.length))
      errs.push(`${at}: expect.kind contains needs a non-empty "value" array`);
    if (e.kind === "retrieves") {
      if (!(Array.isArray(e.relevant) && e.relevant.length)) {
        errs.push(`${at}: expect.kind retrieves needs a non-empty "relevant" array`);
      } else {
        for (const judgement of e.relevant) {
          // Both halves, because either alone is a weaker judgement than it looks: a document without a phrase
          // counts any chunk of it as relevant, and a phrase without a document counts a passing mention
          // anywhere in the corpus.
          if (!isStr(judgement?.source) || !isStr(judgement?.mustContain))
            errs.push(`${at}: every "relevant" entry needs a "source" and a "mustContain"`);
        }
      }
    }
  }
  if (c.tags !== undefined && !Array.isArray(c.tags)) errs.push(`${at}: tags must be an array`);
  return errs;
}
