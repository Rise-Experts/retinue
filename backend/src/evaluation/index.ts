/**
 * The scoring harness and the regression report — REQ-032 (#141).
 *
 * Three properties the ACs are actually about:
 *
 * - **Every case is scored with no manual step.** A grader is selected by expectation kind from a table built
 *   once; a case whose kind has no grader is a *failure of the harness*, reported as such rather than skipped.
 *   A skipped case is a case that silently stops gating.
 * - **Deterministic first, judge only on abstention.** The structural refusal grader returns `UNDECIDED` when it
 *   cannot decide, and only then does a model get called. Most runs make no model calls at all, which is what
 *   makes the gate cheap enough to run on every release.
 * - **The comparison names cases, not just numbers.** An aggregate hides a regression offset by an unrelated
 *   gain; that is the specific failure the report exists to prevent, so it lists the case ids that moved.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { EvalCaseResult, EvalRun, EvaluationStore } from "../persistence/index.js";
import { DETERMINISTIC_GRADERS, UNDECIDED, type EvalCase, type EvalOutput, type Grader } from "./graders.js";

export type EvalRunner = (input: {
  readonly case: EvalCase;
}) => Promise<EvalOutput>;

export type HarnessDeps = {
  readonly store: EvaluationStore;
  /** Produces the output for a case. The platform under test, injected so the harness is not the runtime. */
  readonly run: EvalRunner;
  /** Deterministic graders. Defaults to all of them; overridable so a test can narrow the set. */
  readonly graders?: readonly Grader[];
  /**
   * The judge, for a refusal with no structural signal.
   *
   * Optional. Without it, a prose-only refusal is reported as **unscoreable** rather than as a failure — a case
   * the harness could not decide is not the same as a case the platform got wrong, and scoring it as a failure
   * would make the gate fail for want of a model rather than for want of quality.
   */
  readonly judge?: Grader;
  /**
   * The judge's model id, recorded on every judged result.
   *
   * Passed rather than read from the grader: a `Grader` is deliberately ignorant of what backs it, and a judged
   * result without a model id cannot answer "did the score move because the model changed".
   */
  readonly judgeModelId?: string;
  readonly clock?: () => string;
  readonly runId?: () => string;
};

export type ScoredCase = {
  readonly result: EvalCaseResult;
  /** True when no grader could decide. Counted separately, never as a pass and never as a quality failure. */
  readonly unscoreable: boolean;
};

export type HarnessRunResult = {
  readonly run: EvalRun;
  readonly results: readonly EvalCaseResult[];
  /** Cases no grader could decide, by id. Non-empty means the *harness* needs attention, not the platform. */
  readonly unscoreable: readonly string[];
  /** Model calls made. Zero on a fully deterministic run, which is asserted rather than assumed. */
  readonly modelCalls: number;
};

export const createEvalHarness = (deps: HarnessDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const newRunId = deps.runId ?? (() => `eval_${crypto.randomUUID()}`);
  const graders = deps.graders ?? DETERMINISTIC_GRADERS;
  const judgeModelId = deps.judgeModelId;

  /** Built once: which grader decides which kind. A lookup, so selection cannot depend on case order. */
  const byKind = new Map<string, Grader>();
  for (const grader of graders) for (const kind of grader.kinds) byKind.set(kind, grader);

  return {
    /**
     * Score every case and store the run.
     *
     * The whole dataset in one run, because a partial run cannot gate a release and a run that skipped what it
     * could not grade would gate on a shrinking subset without saying so.
     */
    async score(
      context: ExecutionContext,
      input: { readonly release: string; readonly cases: readonly EvalCase[] },
    ): Promise<HarnessRunResult> {
      const runId = newRunId();
      await deps.store.startRun({
        tenantId: context.tenantId,
        id: runId,
        release: input.release,
        startedAt: clock(),
      });

      const results: EvalCaseResult[] = [];
      const unscoreable: string[] = [];
      let modelCalls = 0;
      const graderVersions: Record<string, string> = {};

      for (const testCase of input.cases) {
        const grader = byKind.get(testCase.expect.kind);
        if (grader === undefined)
          // A kind with no grader is a gap in the *harness*. Thrown rather than skipped, because a skipped case
          // is a case that has silently stopped gating and nobody finds out.
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `no grader for expectation kind "${testCase.expect.kind}" (case ${testCase.id})`,
            retryable: false,
          });

        const output = await deps.run({ case: testCase });
        let verdict = await grader.grade({ case: testCase, output });
        let used = grader;

        // The judge runs only on abstention. Most runs never reach this, which is what makes the gate cheap.
        if (verdict.reason === UNDECIDED) {
          if (deps.judge === undefined) {
            // Recorded as a non-pass with an explicit reason rather than omitted: the run's totals must account
            // for every case, and an omitted case makes the denominator lie.
            unscoreable.push(testCase.id);
            verdict = { pass: false, score: 0, reason: "unscoreable: no judge configured" };
          } else {
            verdict = await deps.judge.grade({ case: testCase, output });
            // Counted from the judge being *invoked*. A cache hit is not a provider call, but it is a case that
            // needed judgement — which is the number a reader of the report cares about.
            modelCalls += 1;
            used = deps.judge;
          }
        }

        const result: EvalCaseResult = {
          caseId: testCase.id,
          dimension: testCase.dimension,
          expectKind: testCase.expect.kind,
          verdict,
          graderId: used.id,
          graderVersion: used.version,
          ...(used.deterministic ? {} : { modelId: judgeModelId ?? "unknown", promptVersion: used.version }),
          // From the verdict, because only the grader knows whether it paid — a cached judgement is free and a
          // fresh one is not, and they are indistinguishable from here.
          costMinorUnits: verdict.costMinorUnits ?? 0,
        };
        results.push(result);
        graderVersions[used.id] = used.version;
        // Recorded inside the loop, for every case including an unscoreable one — a second pass for the
        // unscoreable rows was how the stored run's totals came to disagree with the returned ones.
        await deps.store.recordCase({ tenantId: context.tenantId, runId, result });
      }

      const run = await deps.store.completeRun({
        tenantId: context.tenantId,
        runId,
        finishedAt: clock(),
        graderVersions,
      });
      return { run, results, unscoreable, modelCalls };
    },
  };
};

export type EvalHarness = ReturnType<typeof createEvalHarness>;

/** How a case moved between two runs. */
export const CASE_CHANGES = ["improved", "regressed", "unchanged", "added", "removed"] as const;
export type CaseChange = (typeof CASE_CHANGES)[number];

export type CaseComparison = {
  readonly caseId: string;
  readonly dimension: string;
  readonly change: CaseChange;
  readonly before: number | null;
  readonly after: number | null;
  /** The current reason, so a regression report says *why* and not only *which*. */
  readonly reason: string;
};

export type ReleaseComparison = {
  readonly baseline: string;
  readonly candidate: string;
  readonly improved: readonly CaseComparison[];
  readonly regressed: readonly CaseComparison[];
  readonly added: readonly CaseComparison[];
  readonly removed: readonly CaseComparison[];
  readonly meanScoreDelta: number;
  /**
   * True when the graders differ between the two runs.
   *
   * A comparison across grader versions is a comparison of two instruments, and the delta cannot be attributed
   * to the platform. Flagged rather than refused, because sometimes it is the only comparison available — but
   * never silently, because "quality dropped" and "we recalibrated" look identical in the numbers.
   */
  readonly graderVersionsDiffer: boolean;
};

/**
 * Compare two runs, naming the cases that moved — AC-5.
 *
 * A pure function over two runs' results, because "which cases regressed" is arithmetic and belongs nowhere
 * near a store. An aggregate delta is reported too, but *after* the lists: the whole reason this exists is that
 * an aggregate hides a regression offset by an unrelated gain.
 */
export const compareRuns = (input: {
  readonly baseline: { readonly run: EvalRun; readonly results: readonly EvalCaseResult[] };
  readonly candidate: { readonly run: EvalRun; readonly results: readonly EvalCaseResult[] };
}): ReleaseComparison => {
  const before = new Map(input.baseline.results.map((r) => [r.caseId, r]));
  const after = new Map(input.candidate.results.map((r) => [r.caseId, r]));

  const improved: CaseComparison[] = [];
  const regressed: CaseComparison[] = [];
  const added: CaseComparison[] = [];
  const removed: CaseComparison[] = [];

  for (const [caseId, candidate] of after) {
    const baseline = before.get(caseId);
    if (baseline === undefined) {
      // A new case is not an improvement. Counting it as one would let adding easy cases look like progress.
      added.push({
        caseId,
        dimension: candidate.dimension,
        change: "added",
        before: null,
        after: candidate.verdict.score,
        reason: candidate.verdict.reason,
      });
      continue;
    }
    if (candidate.verdict.score === baseline.verdict.score) continue;
    const entry: CaseComparison = {
      caseId,
      dimension: candidate.dimension,
      change: candidate.verdict.score > baseline.verdict.score ? "improved" : "regressed",
      before: baseline.verdict.score,
      after: candidate.verdict.score,
      reason: candidate.verdict.reason,
    };
    (entry.change === "improved" ? improved : regressed).push(entry);
  }

  for (const [caseId, baseline] of before) {
    if (after.has(caseId)) continue;
    // A removed case is not an improvement either, and a dataset that shrinks quietly is a gate that weakens
    // quietly.
    removed.push({
      caseId,
      dimension: baseline.dimension,
      change: "removed",
      before: baseline.verdict.score,
      after: null,
      reason: "no longer in the dataset",
    });
  }

  const sorted = (entries: readonly CaseComparison[]): readonly CaseComparison[] =>
    // Largest movement first, then by id: a report that reshuffles between runs is one nobody diffs.
    [...entries].sort((a, b) => {
      const da = Math.abs((a.after ?? 0) - (a.before ?? 0));
      const db = Math.abs((b.after ?? 0) - (b.before ?? 0));
      return db !== da ? db - da : a.caseId.localeCompare(b.caseId);
    });

  return {
    baseline: input.baseline.run.release,
    candidate: input.candidate.run.release,
    improved: sorted(improved),
    regressed: sorted(regressed),
    added: sorted(added),
    removed: sorted(removed),
    meanScoreDelta: input.candidate.run.meanScore - input.baseline.run.meanScore,
    graderVersionsDiffer:
      JSON.stringify(sortedEntries(input.baseline.run.graderVersions)) !==
      JSON.stringify(sortedEntries(input.candidate.run.graderVersions)),
  };
};

/** Key order must not decide whether two version maps compare equal. */
const sortedEntries = (map: Readonly<Record<string, string>>): readonly [string, string][] =>
  Object.entries(map).sort(([a], [b]) => a.localeCompare(b));

export * from "./graders.js";
export * from "./judge.js";
export * from "./gate.js";
