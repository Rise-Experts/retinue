#!/usr/bin/env node
/**
 * The release gate — REQ-032 (#142).
 *
 * Usage:
 *   node scripts/release-gate.mjs --report <scored-run.json> [--record] [--release <name>]
 *
 * A thin wrapper. All the deciding happens in `evaluateGate` in `@retinue/agentkit`, which is a pure function
 * with its own tests; this file reads files, prints, appends to the trend and sets an exit code. Deliberately
 * thin, because logic here would be logic the test suite does not cover — and the gate is the one script whose
 * being wrong is invisible (it fails open by passing).
 *
 * THE REPORT. `--report` is a scored run: `{ run, results }` as `EvalHarness.run` produces. Producing it needs
 * a live runtime to score against, which lands with the ShareFlow cutover; until then the gate runs against a
 * recorded report. That boundary is stated in docs/09 rather than hidden behind a green tick.
 *
 * THE OVERRIDE. Environment, not a flag: `RETINUE_GATE_OVERRIDE_ACTOR` and `RETINUE_GATE_OVERRIDE_REASON`,
 * both required. In GitHub Actions these come from a `workflow_dispatch` input, so the actor is the person who
 * clicked and the reason is text they typed — neither can be defaulted. An override with a blank reason is
 * refused, because "overridden: " in the trend is the same as no record at all.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { evaluateGate, formatGateReport, trendEntryFor } from "@retinue/agentkit/observability";

const THRESHOLDS = "evals/thresholds.json";
const TREND = "evals/trend.json";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Named, because "unexpected token" with no path is the least useful CI failure there is.
    console.error(`✗ cannot read ${path}: ${error.message}`);
    process.exit(2);
  }
};

const reportPath = arg("report");
if (reportPath === undefined) {
  console.error("✗ --report <scored-run.json> is required");
  process.exit(2);
}

const report = readJson(reportPath);
const thresholdFile = readJson(THRESHOLDS);
const trend = readJson(TREND);

// The gate reads only the three fields it enforces. The rest of the file is rationale for humans, and a typo in
// a rationale key must not change a limit.
const thresholds = {
  dimensions: thresholdFile.dimensions ?? {},
  ...(thresholdFile.overallMeanScore !== undefined ? { overallMeanScore: thresholdFile.overallMeanScore } : {}),
  ...(thresholdFile.maxRegressedCases !== undefined ? { maxRegressedCases: thresholdFile.maxRegressedCases } : {}),
};

/**
 * The baseline is the newest *recorded* release, not the newest passing one.
 *
 * Comparing against the last release that passed would let a regression land once (failing, or overridden) and
 * then be compared against forever after as if it were the standard. The comparison must be against what
 * actually shipped.
 */
const baselineEntry = trend.entries.at(-1);
const baselinePath = arg("baseline");
const baseline = baselinePath === undefined ? null : readJson(baselinePath);

/**
 * Whether an absent baseline is fatal — and the CLI is the only thing that can tell.
 *
 * A first release genuinely has nothing to compare against, so requiring one would mean the gate could never
 * pass its own adoption. A later release with no baseline has *lost* its comparison, which is an ungated
 * release and must fail. The trend distinguishes them: entries exist, so a baseline should too.
 */
const requireBaseline = trend.entries.length > 0;

const actor = process.env.RETINUE_GATE_OVERRIDE_ACTOR?.trim();
const reason = process.env.RETINUE_GATE_OVERRIDE_REASON?.trim();
if ((actor === undefined || actor === "") !== (reason === undefined || reason === "")) {
  // Half an override is not an override. Refused rather than ignored: silently dropping it would fail the build
  // for someone who believed they had overridden it, and they would then reach for a worse workaround.
  console.error("✗ an override needs both RETINUE_GATE_OVERRIDE_ACTOR and RETINUE_GATE_OVERRIDE_REASON");
  process.exit(2);
}
const override = actor !== undefined && actor !== "" && reason !== undefined && reason !== "" ? { actor, reason } : undefined;

const run = arg("release") === undefined ? report.run : { ...report.run, release: arg("release") };
const decision = evaluateGate({
  candidate: { run, results: report.results },
  baseline,
  requireBaseline,
  thresholds,
  ...(override !== undefined ? { override } : {}),
});

console.log(formatGateReport(decision, run));

if (baselineEntry !== undefined && baseline === null)
  // Which release the comparison was expected against. `evaluateGate` reports the absence; only the CLI can say
  // what was missed, and a reviewer needs the release name to go and find that report.
  console.log(
    `\n! the trend's newest entry is ${baselineEntry.release}, but no --baseline report was supplied`,
  );

if (flag("record")) {
  // The timestamp is taken here rather than inside the pure function, so the decision stays testable without a
  // clock and the recorded entry still says when the gate ran.
  const entry = trendEntryFor({ decision, run, thresholds, at: new Date().toISOString() });
  writeFileSync(TREND, `${JSON.stringify({ ...trend, entries: [...trend.entries, entry] }, null, 2)}\n`);
  console.log(`\nrecorded ${entry.release} in ${TREND} (${entry.outcome})`);
}

// Overridden exits zero — that is what an override is for — but the trend entry says "overridden", so the record
// disagrees with the exit code on purpose. A green build that shipped past the gate is discoverable.
process.exit(decision.outcome === "fail" ? 1 : 0);
