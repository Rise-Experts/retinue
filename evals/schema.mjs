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
];

export const EXPECT_KINDS = [
  "contains",           // value: string[] — output should mention these
  "tool-called",        // tool: string
  "tool-not-called",    // tool: string
  "requires-approval",  // tool: string
  "refuses",            // reason?: string
  "cites-source",       // value?: string[]
  "structured-valid",   // schema?: string
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
  }
  if (c.tags !== undefined && !Array.isArray(c.tags)) errs.push(`${at}: tags must be an array`);
  return errs;
}
