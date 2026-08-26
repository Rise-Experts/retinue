/**
 * The release gate — REQ-032 (#142).
 *
 * Scoring without a gate is a dashboard nobody reads. This is the part that stops a regression shipping, and it
 * is deliberately a **pure function**: given a run, a baseline and a threshold set, it returns a decision. No
 * clock, no store, no process exit — so the decision is testable, and the CI wrapper around it is thin enough
 * to be obviously correct.
 *
 * Four decisions.
 *
 * **It fails on named cases as well as on aggregates.** A dimension can sit above its threshold while a
 * specific case that used to pass now fails, and an aggregate gate would ship that. Both are checked, and both
 * are *reported by name* — a gate that says "quality dropped" gives a reviewer nothing to act on.
 *
 * **A threshold lives in version control and the gate never adjusts it.** Nothing here writes a threshold, so
 * the only way to lower one is a reviewed change to a committed file. That is the mechanism: a gate that could
 * relax its own limits is not a gate.
 *
 * **An override is recorded or it does not exist.** `override` requires an actor *and* a reason, and the
 * decision carries both into the trend record. An unrecordable override is how gates quietly die — one person
 * ships past it, nobody sees, and the next person learns it is optional.
 *
 * **A missing baseline is reported, and whether it is fatal is the caller's to say.** Two situations look
 * identical from in here and are not: the first release of a dataset genuinely has nothing to compare against,
 * while a later release with no baseline has *lost* its comparison. Treating both as fatal means the gate can
 * never be adopted; treating both as fine means the regression check disappears the day someone regenerates the
 * trend and nobody notices. So `requireBaseline` is an input, set by whoever knows which case this is — the CLI
 * knows, because it can see whether the trend has entries.
 */

import type { EvalCaseResult, EvalRun } from "../persistence/index.js";
import { compareRuns } from "./index.js";
import { type CaseComparison, type ReleaseComparison } from "./index.js";

/**
 * The committed thresholds.
 *
 * Per dimension, because dimensions fail differently: an authorization regression is a security problem and a
 * task-completion regression is a quality one, and one number across both would be set by whichever mattered
 * less.
 */
export type GateThresholds = {
  /** Minimum mean score per dimension. A dimension absent from the map is ungated, which is reported. */
  readonly dimensions: Readonly<Record<string, number>>;
  /** Minimum overall mean, as a backstop against many small dimension slips that each stay above their line. */
  readonly overallMeanScore?: number;
  /**
   * How many named case regressions are tolerated.
   *
   * Zero by default. A non-zero budget exists because a large dataset has genuinely flaky cases, and a gate that
   * fails on one is a gate people learn to re-run until it passes — which is worse than a stated tolerance.
   */
  readonly maxRegressedCases?: number;
};

export const GATE_FAILURE_KINDS = [
  "dimension-below-threshold",
  "overall-below-threshold",
  "cases-regressed",
  "missing-baseline",
  "ungated-dimension",
] as const;
export type GateFailureKind = (typeof GATE_FAILURE_KINDS)[number];

export type GateFailure = {
  readonly kind: GateFailureKind;
  /** The dimension, when the failure is about one. */
  readonly dimension?: string;
  /** What was measured and what was required, so a reviewer needs no second lookup. */
  readonly actual?: number;
  readonly required?: number;
  /** The specific cases, when the failure is about cases. Named, never counted. */
  readonly cases?: readonly CaseComparison[];
  readonly message: string;
};

export type GateOverride = {
  /** Who. A gate overridden by "CI" is a gate nobody is accountable for. */
  readonly actor: string;
  /** Why. Free text, and required — an override with no reason is indistinguishable from a bug. */
  readonly reason: string;
};

/**
 * The decision.
 *
 * A union, so "failed" has no `passed` shape to hide in. An overridden failure is its own arm rather than a
 * pass with a flag: a reader counting passes must not count it, and a flag on a pass is a flag that gets
 * dropped.
 */
export type GateDecision =
  | { readonly outcome: "pass"; readonly comparison: ReleaseComparison | null; readonly warnings: readonly string[] }
  | {
      readonly outcome: "fail";
      readonly failures: readonly GateFailure[];
      readonly comparison: ReleaseComparison | null;
      readonly warnings: readonly string[];
    }
  | {
      readonly outcome: "overridden";
      readonly failures: readonly GateFailure[];
      readonly override: GateOverride;
      readonly comparison: ReleaseComparison | null;
      readonly warnings: readonly string[];
    };

export type GateInput = {
  readonly candidate: { readonly run: EvalRun; readonly results: readonly EvalCaseResult[] };
  /** The previous release. `null` for the first run of a dataset, which is reported rather than assumed fine. */
  readonly baseline: { readonly run: EvalRun; readonly results: readonly EvalCaseResult[] } | null;
  /**
   * Whether an absent baseline fails the gate.
   *
   * True for every release after the first. False only when there has genuinely never been one — and false is
   * not the default, because a defaulted-permissive flag is one that stays permissive in every deployment that
   * did not think about it.
   */
  readonly requireBaseline: boolean;
  readonly thresholds: GateThresholds;
  readonly override?: GateOverride;
};

/**
 * Evaluate the gate.
 *
 * Every failure is collected before returning, rather than short-circuiting on the first. A gate that reported
 * one problem per run makes a reviewer fix, re-run, and fix again — and each re-run costs what the gate costs.
 */
export const evaluateGate = (input: GateInput): GateDecision => {
  const failures: GateFailure[] = [];
  const warnings: string[] = [];
  const { candidate, baseline, thresholds } = input;

  for (const summary of candidate.run.byDimension) {
    const required = thresholds.dimensions[summary.dimension];
    if (required === undefined) {
      // Not a failure by default — a new dimension appearing before its threshold is agreed should not block a
      // release — but loud, because an ungated dimension is a dimension nobody is measuring.
      warnings.push(
        `dimension "${summary.dimension}" has no threshold; add one to the committed thresholds file`,
      );
      continue;
    }
    if (summary.meanScore < required) {
      failures.push({
        kind: "dimension-below-threshold",
        dimension: summary.dimension,
        actual: summary.meanScore,
        required,
        message: `${summary.dimension} scored ${summary.meanScore.toFixed(3)}, below its threshold of ${required}`,
      });
    }
  }

  // A threshold for a dimension the run did not produce. Reported, because it means either the dataset lost a
  // dimension or the run did not score it — and both are the gate measuring less than it claims to.
  for (const dimension of Object.keys(thresholds.dimensions)) {
    if (!candidate.run.byDimension.some((d) => d.dimension === dimension))
      warnings.push(`threshold set for "${dimension}" but the run scored no cases in it`);
  }

  if (thresholds.overallMeanScore !== undefined && candidate.run.meanScore < thresholds.overallMeanScore) {
    failures.push({
      kind: "overall-below-threshold",
      actual: candidate.run.meanScore,
      required: thresholds.overallMeanScore,
      message: `overall mean ${candidate.run.meanScore.toFixed(3)} is below the threshold of ${thresholds.overallMeanScore}`,
    });
  }

  const comparison = baseline === null ? null : compareRuns({ baseline, candidate });

  if (baseline === null) {
    const message =
      "no baseline run to compare against, so no regression check ran; thresholds were still applied";
    // Fatal when a baseline was expected — a release whose comparison has gone missing is ungated on
    // regressions, and that must stop the build rather than print a line nobody reads. Loud but survivable when
    // there has never been one, so the gate can be adopted on its first run.
    if (input.requireBaseline) failures.push({ kind: "missing-baseline", message });
    else warnings.push(message);
  } else {
    const budget = thresholds.maxRegressedCases ?? 0;
    if (comparison !== null && comparison.regressed.length > budget) {
      failures.push({
        kind: "cases-regressed",
        cases: comparison.regressed,
        actual: comparison.regressed.length,
        required: budget,
        // The case ids in the message, so a CI log line is actionable without opening an artifact.
        message: `${comparison.regressed.length} case(s) regressed (budget ${budget}): ${comparison.regressed
          .map((c) => `${c.caseId} (${c.dimension}, ${c.before} → ${c.after})`)
          .join("; ")}`,
      });
    }
    if (comparison?.graderVersionsDiffer === true)
      // A warning, not a failure: sometimes a grader change is the point of the release. But never silent —
      // a delta across two instruments cannot be attributed to the platform.
      warnings.push(
        "grader versions differ between the baseline and the candidate; the score delta cannot be attributed to the platform alone",
      );
  }

  if (failures.length === 0) return { outcome: "pass", comparison, warnings };
  if (input.override !== undefined) {
    // The override applies to *whatever failed*, and the failures travel with it. An override that discarded
    // them would leave a trend record saying "overridden" with no way to learn what for.
    return { outcome: "overridden", failures, override: input.override, comparison, warnings };
  }
  return { outcome: "fail", failures, comparison, warnings };
};

/**
 * A record for the trend file.
 *
 * Deliberately flat and small: it is committed, so it is read in a diff. A record carrying the whole run would
 * make every release a thousand-line diff and the trend unreadable, which is the same as not having one.
 */
export type TrendEntry = {
  readonly release: string;
  readonly at: string;
  readonly outcome: GateDecision["outcome"];
  readonly meanScore: number;
  readonly total: number;
  readonly passed: number;
  readonly byDimension: readonly { readonly dimension: string; readonly meanScore: number }[];
  readonly regressedCaseIds: readonly string[];
  readonly improvedCaseIds: readonly string[];
  readonly costMinorUnits: number;
  readonly graderVersions: Readonly<Record<string, string>>;
  /** Present only when overridden, and carrying both fields — that is the whole point of recording it. */
  readonly override?: GateOverride;
  /** The thresholds this release was judged against, so a later threshold change is visible against results. */
  readonly thresholds: GateThresholds;
};

/**
 * Build the trend entry for a decision.
 *
 * The thresholds are copied in, which is what makes AC-2 and AC-3 meet: lowering a threshold shows up in the
 * *next* entry next to the results it was applied to, so a reviewer reading history sees the limit and the
 * number that prompted moving it side by side.
 */
export const trendEntryFor = (input: {
  readonly decision: GateDecision;
  readonly run: EvalRun;
  readonly thresholds: GateThresholds;
  readonly at: string;
}): TrendEntry => ({
  release: input.run.release,
  at: input.at,
  outcome: input.decision.outcome,
  meanScore: input.run.meanScore,
  total: input.run.total,
  passed: input.run.passed,
  byDimension: input.run.byDimension.map((d) => ({ dimension: d.dimension, meanScore: d.meanScore })),
  regressedCaseIds: input.decision.comparison?.regressed.map((c) => c.caseId) ?? [],
  improvedCaseIds: input.decision.comparison?.improved.map((c) => c.caseId) ?? [],
  costMinorUnits: input.run.costMinorUnits,
  graderVersions: input.run.graderVersions,
  ...(input.decision.outcome === "overridden" ? { override: input.decision.override } : {}),
  thresholds: input.thresholds,
});

/**
 * The gate's report, as a CI log reads it.
 *
 * Plain text rather than JSON, because the first thing a person does with a failing gate is read the log. The
 * artifact carries the structured version.
 */
export const formatGateReport = (decision: GateDecision, run: EvalRun): string => {
  const lines: string[] = [
    `release gate: ${decision.outcome.toUpperCase()}`,
    `release ${run.release} — ${run.passed}/${run.total} passed, mean ${run.meanScore.toFixed(3)}, cost ${run.costMinorUnits} minor units`,
  ];
  for (const d of run.byDimension) lines.push(`  ${d.dimension}: ${d.meanScore.toFixed(3)} (${d.passed}/${d.total})`);

  if (decision.outcome !== "pass") {
    lines.push("", "failures:");
    for (const failure of decision.failures) lines.push(`  ✗ ${failure.message}`);
  }
  if (decision.outcome === "overridden")
    lines.push("", `OVERRIDDEN by ${decision.override.actor}: ${decision.override.reason}`);

  const comparison = decision.comparison;
  if (comparison !== null) {
    lines.push("", `versus ${comparison.baseline}: mean ${comparison.meanScoreDelta >= 0 ? "+" : ""}${comparison.meanScoreDelta.toFixed(3)}`);
    // Regressed first: it is what a reviewer is looking for, and a report that led with improvements would bury
    // it.
    for (const c of comparison.regressed) lines.push(`  ↓ ${c.caseId} (${c.dimension}) ${c.before} → ${c.after}  ${c.reason}`);
    for (const c of comparison.improved) lines.push(`  ↑ ${c.caseId} (${c.dimension}) ${c.before} → ${c.after}`);
    for (const c of comparison.added) lines.push(`  + ${c.caseId} (${c.dimension}) new`);
    for (const c of comparison.removed) lines.push(`  - ${c.caseId} (${c.dimension}) removed`);
  }
  for (const warning of decision.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
};
