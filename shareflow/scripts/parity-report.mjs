/**
 * The parity report — #128 AC-2, and the AC-4 gate in front of the removal.
 *
 * `evaluateParity` and `canRemoveOldRuntime` were library functions with nothing that ran them. A gate nobody can
 * execute is a gate that gets satisfied by assertion at the moment it matters most, so this is the runnable form:
 * it reads shadow runs, prints a verdict per workflow against the recorded gate, and exits non-zero while any
 * measurable gate is unpassed.
 *
 * **Input is real shadow data, and its absence is an error.** `--shadow <file>` is a JSON array of
 * `{ workflow, old: ShadowRun, new: ShadowRun }` pairs, as a shadow deployment would dump them. Run with no file
 * and it reports what is missing rather than evaluating an empty set — an empty set makes every measurable gate
 * `insufficient-sample`, which reads like a result and is not one.
 *
 * Exit codes, chosen so a checklist can branch on them:
 *   0  every measurable gate passed
 *   1  at least one gate is unpassed, or the removal is blocked
 *   2  could not evaluate — no input, unreadable input, malformed input
 *
 * Usage:
 *   node scripts/parity-report.mjs --shadow shadow-runs.json
 *   node scripts/parity-report.mjs --shadow runs.json --removal --signed-off-by "Name" --references 0
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DATA_DISPOSITION,
  PARITY_GATES,
  VERDICTS,
  canRemoveOldRuntime,
  diffShadowRuns,
  evaluateParity,
} from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const die = (message, detail) => {
  console.error(`✗ ${message}`);
  for (const [k, v] of Object.entries(detail ?? {})) console.error(`  ${k}: ${v}`);
  process.exit(2);
};

const shadowPath = flag("shadow");
if (shadowPath === undefined)
  die("no shadow data given, so there is nothing to evaluate", {
    expected: "--shadow <file>, a JSON array of { workflow, old, new } shadow-run pairs",
    why: "evaluating an empty set reports every gate as insufficient-sample, which reads like a result",
  });

let pairs;
try {
  pairs = JSON.parse(await readFile(resolve(shadowPath), "utf8"));
} catch (error) {
  die("could not read the shadow data", { path: resolve(shadowPath), error: error.message });
}
if (!Array.isArray(pairs) || pairs.length === 0)
  die("the shadow data is empty or not an array", { path: resolve(shadowPath), got: typeof pairs });

/**
 * Pairs become diffs, grouped by workflow.
 *
 * The diffing is `diffShadowRuns`, the same function the shadow harness uses — not a second comparison written
 * for the report. Two implementations of "are these write sets the same" is two answers to the question the whole
 * gate rests on.
 */
const reportsByWorkflow = {};
let malformed = 0;
for (const pair of pairs) {
  if (pair?.workflow === undefined || pair?.old === undefined || pair?.new === undefined) {
    malformed += 1;
    continue;
  }
  (reportsByWorkflow[pair.workflow] ??= []).push(diffShadowRuns(pair.old, pair.new));
}
// Counted and refused, not skipped quietly: a malformed pair is a run that produced no comparison, and letting
// it vanish would shrink the sample towards the threshold without anyone seeing.
if (malformed > 0)
  die(`${malformed} of ${pairs.length} shadow pairs are malformed`, {
    expected: "each entry needs workflow, old and new",
    why: "silently dropping them shrinks the sample the gate is measured against",
  });

const evaluation = evaluateParity(reportsByWorkflow);

console.log(`parity report — ${pairs.length} shadow pairs across ${Object.keys(reportsByWorkflow).length} workflow(s)\n`);
/**
 * Built from `VERDICTS`, so a verdict added to the union cannot quietly render as "?".
 *
 * The first version wrote the keys by hand and spelled one of them `gate-unagreed`, which does not exist — every
 * unagreed gate printed as `?`, the same glyph as "I do not know what this is".
 */
const SYMBOL = { passed: "✓", failed: "✗", "gate-not-agreed": "✎", "insufficient-sample": "…", "not-measurable": "—" };
for (const verdict of VERDICTS)
  if (SYMBOL[verdict] === undefined) throw new Error(`no symbol for verdict "${verdict}" — add one to SYMBOL`);
for (const v of evaluation.verdicts) {
  const gate = PARITY_GATES.find((g) => g.workflow === v.workflow);
  const n = (reportsByWorkflow[v.workflow] ?? []).length;
  console.log(`${SYMBOL[v.verdict]} ${v.workflow.padEnd(20)} ${v.verdict.padEnd(20)} ${String(n).padStart(5)} run(s)  ${gate?.status ?? "no gate"}`);
  console.log(`  ${v.detail}`);
}

console.log("");
if (evaluation.unmeasurable.length > 0)
  console.log(`shadow data cannot decide: ${evaluation.unmeasurable.join(", ")} — these need an explicit decision.`);
console.log(
  evaluation.allMeasurablePassed
    ? "every measurable gate passed."
    : `blocking: ${evaluation.blocking.join(", ")}`,
);

if (!has("removal")) process.exit(evaluation.allMeasurablePassed ? 0 : 1);

/**
 * The removal gate, run only when asked for.
 *
 * Separate because the report is something to look at during a rollout and the removal check is a decision at the
 * end of one. Running the second implicitly would make a passing report read as permission to delete.
 */
const references = flag("references");
const check = canRemoveOldRuntime({
  evaluation,
  ...(flag("signed-off-by") === undefined ? {} : { signedOffBy: flag("signed-off-by") }),
  dataDispositionDecided: DATA_DISPOSITION.decision !== null,
  // Passed through only when given. Defaulting it to 0 would be the "did not look equals clean" mistake that
  // `scan-old-runtime.mjs` exists to prevent — that script produces this number.
  ...(references === undefined ? {} : { remainingReferences: Number(references) }),
});

console.log(`\nremoval: ${check.allowed ? "ALLOWED" : "BLOCKED"}`);
for (const blocker of check.blockers) console.log(`  - ${blocker}`);
process.exit(check.allowed ? 0 : 1);
