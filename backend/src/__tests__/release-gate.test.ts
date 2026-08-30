import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  formatGateReport,
  trendEntryFor,
  type GateThresholds,
} from "../evaluation/index.js";
import type { EvalCaseResult, EvalRun } from "../persistence/index.js";

/**
 * The release gate (#142).
 *
 * Everything here is against the pure `evaluateGate`, which is the whole reason it is pure: a gate whose logic
 * needed a CI run to exercise would be tested by shipping.
 */

const result = (
  caseId: string,
  dimension: string,
  score: number,
  extra: Partial<EvalCaseResult> = {},
): EvalCaseResult => ({
  caseId,
  dimension,
  expectKind: "contains",
  graderId: "contains",
  graderVersion: "1",
  // Zero for a deterministic grader, which the type asks to be stated rather than assumed.
  costMinorUnits: 0,
  verdict: { score, pass: score >= 1, reason: `${caseId} scored ${score}` },
  ...extra,
});

const runOf = (input: {
  release: string;
  results: readonly EvalCaseResult[];
  graderVersions?: Record<string, string>;
  costMinorUnits?: number;
}): EvalRun => {
  const byDimension = [...new Set(input.results.map((r) => r.dimension))].map((dimension) => {
    const rows = input.results.filter((r) => r.dimension === dimension);
    return {
      dimension,
      total: rows.length,
      passed: rows.filter((r) => r.verdict.pass).length,
      meanScore: rows.reduce((a, r) => a + r.verdict.score, 0) / rows.length,
    };
  });
  return {
    id: `run-${input.release}`,
    release: input.release,
    startedAt: "2026-08-23T10:00:00.000Z",
    finishedAt: "2026-08-23T10:05:00.000Z",
    total: input.results.length,
    passed: input.results.filter((r) => r.verdict.pass).length,
    meanScore: input.results.reduce((a, r) => a + r.verdict.score, 0) / input.results.length,
    byDimension,
    costMinorUnits: input.costMinorUnits ?? 0,
    graderVersions: input.graderVersions ?? { contains: "1" },
  };
};

const thresholds: GateThresholds = {
  dimensions: { authorization: 1, "task-completion": 0.8 },
  overallMeanScore: 0.85,
  maxRegressedCases: 0,
};

const passing = [result("a1", "authorization", 1), result("t1", "task-completion", 1)];

describe("release gate — thresholds (AC-1)", () => {
  it("passes a run that meets every threshold", () => {
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results: passing }), results: passing },
      baseline: { run: runOf({ release: "1.0", results: passing }), results: passing },
      thresholds,
      requireBaseline: true,
    });
    expect(decision.outcome).toBe("pass");
  });

  it("fails a dimension below its threshold, naming the dimension and both numbers", () => {
    const results = [result("a1", "authorization", 0.5), result("t1", "task-completion", 1)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results }), results },
      baseline: { run: runOf({ release: "1.0", results: passing }), results: passing },
      thresholds,
      requireBaseline: true,
    });
    expect(decision.outcome).toBe("fail");
    if (decision.outcome === "pass") throw new Error("unreachable");
    const failure = decision.failures.find((f) => f.kind === "dimension-below-threshold");
    // The dimension, what it scored, and what was required. A gate that says "quality dropped" makes a reviewer
    // go and find all three, which is the difference between a gate people act on and one they rerun.
    expect(failure?.dimension).toBe("authorization");
    expect(failure?.actual).toBe(0.5);
    expect(failure?.required).toBe(1);
  });

  /**
   * The aggregate is a backstop, not the gate.
   *
   * Every dimension here sits above its own line while the overall mean is below the overall line — the shape
   * of many small slips, each individually defensible. Without this a team can degrade indefinitely by keeping
   * each dimension a hair above its threshold.
   */
  it("fails on the overall mean even when every dimension is individually above its line", () => {
    const results = [
      result("a1", "authorization", 1),
      result("t1", "task-completion", 0.8),
      result("t2", "task-completion", 0.8),
      result("t3", "task-completion", 0.8),
      // A fourth, because with three the overall mean is exactly 0.85 and "below" is strict — my first version
      // of this fixture sat *on* the line and the test failed for the right reason.
      result("t4", "task-completion", 0.8),
    ];
    const run = runOf({ release: "1.1", results });
    for (const d of run.byDimension) {
      const required = thresholds.dimensions[d.dimension];
      expect(d.meanScore, `${d.dimension} must be above its own threshold for this test to mean anything`)
        .toBeGreaterThanOrEqual(required ?? 0);
    }
    const decision = evaluateGate({
      candidate: { run, results },
      baseline: { run: runOf({ release: "1.0", results: passing }), results: passing },
      thresholds,
      requireBaseline: true,
    });
    expect(decision.outcome).toBe("fail");
    if (decision.outcome === "pass") throw new Error("unreachable");
    expect(decision.failures.map((f) => f.kind)).toContain("overall-below-threshold");
  });

  it("reports every failure at once rather than stopping at the first", () => {
    const results = [result("a1", "authorization", 0), result("t1", "task-completion", 0)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results }), results },
      baseline: { run: runOf({ release: "1.0", results: passing }), results: passing },
      thresholds,
      requireBaseline: true,
    });
    if (decision.outcome === "pass") throw new Error("unreachable");
    // Two dimensions, the overall mean, and the regressions: four findings from one run. Each re-run of this
    // gate costs what the gate costs, so one-failure-per-run is a real bill.
    expect(decision.failures.length).toBeGreaterThanOrEqual(4);
  });

  it("warns about a dimension with no threshold instead of silently ignoring it", () => {
    const results = [...passing, result("g1", "groundedness", 0.1)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results }), results },
      baseline: { run: runOf({ release: "1.0", results }), results },
      thresholds,
      requireBaseline: true,
    });
    // Not a failure — a new dimension should not block a release before its threshold is agreed — but an
    // ungated dimension is a dimension nobody is measuring, and that must be visible.
    expect(decision.warnings.join(" ")).toMatch(/groundedness.*no threshold/);
  });

  it("warns when a threshold is set for a dimension the run did not score", () => {
    const results = [result("t1", "task-completion", 1)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results }), results },
      baseline: { run: runOf({ release: "1.0", results }), results },
      // authorization is gated, and the run scored none of it. Either the dataset lost the dimension or the run
      // did not score it, and both mean the gate is measuring less than it claims.
      thresholds,
      requireBaseline: true,
    });
    expect(decision.warnings.join(" ")).toMatch(/authorization.*scored no cases/);
  });
});

describe("release gate — named regressions (AC-1, AC-6)", () => {
  /**
   * The test the whole gate exists for.
   *
   * Every dimension is above threshold and the overall mean is above its line — one case moved down and another
   * moved up by the same amount. A gate on aggregates alone ships this.
   */
  it("fails on a named case regression while every aggregate still passes", () => {
    const before = [
      result("a1", "authorization", 1),
      result("t1", "task-completion", 1),
      result("t2", "task-completion", 0.6),
    ];
    const after = [
      result("a1", "authorization", 1),
      result("t1", "task-completion", 0.6),
      result("t2", "task-completion", 1),
    ];
    const candidate = runOf({ release: "1.1", results: after });
    const baselineRun = runOf({ release: "1.0", results: before });
    expect(candidate.meanScore, "the means must be identical or this test proves nothing").toBe(baselineRun.meanScore);

    const decision = evaluateGate({
      candidate: { run: candidate, results: after },
      baseline: { run: baselineRun, results: before },
      requireBaseline: true,
      thresholds: { dimensions: { authorization: 1, "task-completion": 0.7 }, overallMeanScore: 0.8 },
    });
    expect(decision.outcome).toBe("fail");
    if (decision.outcome === "pass") throw new Error("unreachable");
    const regression = decision.failures.find((f) => f.kind === "cases-regressed");
    expect(regression?.cases?.map((c) => c.caseId)).toEqual(["t1"]);
    // The id in the message too: a CI log line must be actionable without downloading an artifact.
    expect(regression?.message).toContain("t1");
  });

  it("does not treat an improvement as a regression", () => {
    const before = [result("a1", "authorization", 1), result("t1", "task-completion", 0.8)];
    const after = [result("a1", "authorization", 1), result("t1", "task-completion", 1)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results: after }), results: after },
      baseline: { run: runOf({ release: "1.0", results: before }), results: before },
      thresholds,
      requireBaseline: true,
    });
    expect(decision.outcome).toBe("pass");
    expect(decision.comparison?.improved.map((c) => c.caseId)).toEqual(["t1"]);
  });

  it("honours a stated regression budget, and only up to it", () => {
    const before = [result("t1", "task-completion", 1), result("t2", "task-completion", 1), result("a1", "authorization", 1)];
    const oneDown = [result("t1", "task-completion", 0.9), result("t2", "task-completion", 1), result("a1", "authorization", 1)];
    const twoDown = [result("t1", "task-completion", 0.9), result("t2", "task-completion", 0.9), result("a1", "authorization", 1)];
    const budget: GateThresholds = { dimensions: { authorization: 1, "task-completion": 0.8 }, maxRegressedCases: 1 };

    expect(
      evaluateGate({
        candidate: { run: runOf({ release: "1.1", results: oneDown }), results: oneDown },
        baseline: { run: runOf({ release: "1.0", results: before }), results: before },
        thresholds: budget,
        requireBaseline: true,
      }).outcome,
    ).toBe("pass");

    expect(
      evaluateGate({
        candidate: { run: runOf({ release: "1.1", results: twoDown }), results: twoDown },
        baseline: { run: runOf({ release: "1.0", results: before }), results: before },
        thresholds: budget,
        requireBaseline: true,
      }).outcome,
    ).toBe("fail");
  });

  it("defaults the regression budget to zero, so one regression fails", () => {
    const before = [result("t1", "task-completion", 1), result("a1", "authorization", 1)];
    const after = [result("t1", "task-completion", 0.9), result("a1", "authorization", 1)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results: after }), results: after },
      baseline: { run: runOf({ release: "1.0", results: before }), results: before },
      requireBaseline: true,
      // No maxRegressedCases at all: the *absence* must mean zero, not unbounded. A gate whose default was
      // permissive would pass for every deployment that had not configured it.
      thresholds: { dimensions: { authorization: 1, "task-completion": 0.8 } },
    });
    expect(decision.outcome).toBe("fail");
  });

  it("does not fail on a removed case, but reports it", () => {
    const before = [result("t1", "task-completion", 1), result("t2", "task-completion", 1), result("a1", "authorization", 1)];
    const after = [result("t1", "task-completion", 1), result("a1", "authorization", 1)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results: after }), results: after },
      baseline: { run: runOf({ release: "1.0", results: before }), results: before },
      thresholds,
      requireBaseline: true,
    });
    // A removed case is not a regression in score — but a dataset that shrinks quietly is a gate that weakens
    // quietly, so it must appear in the report a reviewer reads.
    expect(decision.outcome).toBe("pass");
    expect(decision.comparison?.removed.map((c) => c.caseId)).toEqual(["t2"]);
    expect(formatGateReport(decision, runOf({ release: "1.1", results: after }))).toMatch(/- t2/);
  });

  it("warns rather than fails when the grader versions differ", () => {
    const decision = evaluateGate({
      candidate: {
        run: runOf({ release: "1.1", results: passing, graderVersions: { contains: "2" } }),
        results: passing,
      },
      baseline: { run: runOf({ release: "1.0", results: passing, graderVersions: { contains: "1" } }), results: passing },
      thresholds,
      requireBaseline: true,
    });
    expect(decision.outcome).toBe("pass");
    expect(decision.warnings.join(" ")).toMatch(/grader versions differ/);
  });
});

describe("release gate — a missing baseline (AC-1)", () => {
  it("fails when a baseline was expected, because a lost comparison is an ungated release", () => {
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.0", results: passing }), results: passing },
      baseline: null,
      thresholds,
      requireBaseline: true,
    });
    if (decision.outcome === "pass") throw new Error("unreachable");
    // A gate that skipped its regression check on a missing baseline would skip it forever if a baseline were
    // ever lost — and losing one is exactly what happens when a trend file is regenerated.
    expect(decision.failures.map((f) => f.kind)).toEqual(["missing-baseline"]);
    expect(decision.comparison).toBeNull();
  });

  it("also reports the threshold failures of a first run, not only the missing baseline", () => {
    const results = [result("a1", "authorization", 0), result("t1", "task-completion", 0)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.0", results }), results },
      baseline: null,
      thresholds,
      requireBaseline: true,
    });
    if (decision.outcome === "pass") throw new Error("unreachable");
    expect(decision.failures.map((f) => f.kind)).toContain("dimension-below-threshold");
  });

  /**
   * The first release of a dataset.
   *
   * Genuinely nothing to compare against, and a gate that could never pass its own first run is a gate nobody
   * adopts. So it warns and passes on thresholds alone — but the *caller* says which situation this is, because
   * from inside the function a first release and a lost baseline look identical.
   */
  it("warns and passes on thresholds alone when there has never been a baseline", () => {
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.0", results: passing }), results: passing },
      baseline: null,
      requireBaseline: false,
      thresholds,
    });
    expect(decision.outcome).toBe("pass");
    expect(decision.warnings.join(" ")).toMatch(/no baseline run to compare against/);
  });

  it("still fails a first release that is below a threshold", () => {
    const results = [result("a1", "authorization", 0), result("t1", "task-completion", 1)];
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.0", results }), results },
      baseline: null,
      // The permissive baseline setting must not soften the thresholds. A first release is exempt from the
      // *comparison*, not from the bar.
      requireBaseline: false,
      thresholds,
    });
    expect(decision.outcome).toBe("fail");
  });
});

describe("release gate — the override (AC-4)", () => {
  const failing = [result("a1", "authorization", 0), result("t1", "task-completion", 1)];
  const failingInput = {
    candidate: { run: runOf({ release: "1.1", results: failing }), results: failing },
    baseline: { run: runOf({ release: "1.0", results: passing }), results: passing },
    requireBaseline: true,
    thresholds,
  };

  it("is its own outcome, not a pass with a flag", () => {
    const decision = evaluateGate({ ...failingInput, override: { actor: "azeem", reason: "hotfix for SEV-1" } });
    // A reader counting passes must not count this. A flag on a pass is a flag that gets dropped by the next
    // person who writes a summary.
    expect(decision.outcome).toBe("overridden");
    expect(decision.outcome === "overridden" && decision.override).toEqual({
      actor: "azeem",
      reason: "hotfix for SEV-1",
    });
  });

  it("carries the failures it overrode, so the record says what for", () => {
    const decision = evaluateGate({ ...failingInput, override: { actor: "azeem", reason: "hotfix for SEV-1" } });
    if (decision.outcome !== "overridden") throw new Error("unreachable");
    expect(decision.failures.map((f) => f.kind)).toContain("dimension-below-threshold");
  });

  it("does nothing to a run that was passing anyway", () => {
    const decision = evaluateGate({
      candidate: { run: runOf({ release: "1.1", results: passing }), results: passing },
      baseline: { run: runOf({ release: "1.0", results: passing }), results: passing },
      requireBaseline: true,
      thresholds,
      override: { actor: "azeem", reason: "belt and braces" },
    });
    // An override present on a green run must not mark the release as overridden — or the trend would fill with
    // overrides from a CI job that sets the variable unconditionally, and a real one would be invisible.
    expect(decision.outcome).toBe("pass");
  });

  it("names both the actor and the reason in the report", () => {
    const decision = evaluateGate({ ...failingInput, override: { actor: "azeem", reason: "hotfix for SEV-1" } });
    const report = formatGateReport(decision, failingInput.candidate.run);
    expect(report).toContain("OVERRIDDEN by azeem");
    expect(report).toContain("hotfix for SEV-1");
  });
});

describe("release gate — the trend record (AC-2, AC-3, AC-6)", () => {
  const before = [result("t1", "task-completion", 1), result("t2", "task-completion", 0.6), result("a1", "authorization", 1)];
  const after = [result("t1", "task-completion", 0.6), result("t2", "task-completion", 1), result("a1", "authorization", 1)];

  it("records the release, the score, and the cases that moved in each direction", () => {
    const run = runOf({ release: "1.1", results: after, costMinorUnits: 4200 });
    const decision = evaluateGate({
      candidate: { run, results: after },
      baseline: { run: runOf({ release: "1.0", results: before }), results: before },
      requireBaseline: true,
      thresholds: { dimensions: { authorization: 1, "task-completion": 0.7 }, maxRegressedCases: 1 },
    });
    const entry = trendEntryFor({ decision, run, thresholds, at: "2026-08-23T11:00:00.000Z" });
    expect(entry.release).toBe("1.1");
    expect(entry.regressedCaseIds).toEqual(["t1"]);
    expect(entry.improvedCaseIds).toEqual(["t2"]);
    // AC-5: what the gate itself cost, on the record, so its expense is known rather than assumed cheap.
    expect(entry.costMinorUnits).toBe(4200);
  });

  /**
   * AC-2 and AC-3 meeting.
   *
   * The thresholds in force are copied into the entry. That is what makes a lowered threshold visible *against
   * the results that prompted lowering it* — without this, "quality improved" and "we moved the bar" produce
   * the same history.
   */
  it("stores the thresholds the release was judged against", () => {
    const run = runOf({ release: "1.1", results: after });
    const decision = evaluateGate({
      candidate: { run, results: after },
      baseline: { run: runOf({ release: "1.0", results: before }), results: before },
      requireBaseline: true,
      thresholds: { dimensions: { authorization: 1, "task-completion": 0.7 }, maxRegressedCases: 1 },
    });
    const strict = trendEntryFor({ decision, run, thresholds: { dimensions: { "task-completion": 0.9 } }, at: "t" });
    const relaxed = trendEntryFor({ decision, run, thresholds: { dimensions: { "task-completion": 0.5 } }, at: "t" });
    expect(strict.thresholds.dimensions["task-completion"]).toBe(0.9);
    expect(relaxed.thresholds.dimensions["task-completion"]).toBe(0.5);
    // Same scores, different recorded bar — so a diff of two entries distinguishes the two stories.
    expect(strict.meanScore).toBe(relaxed.meanScore);
  });

  it("records an override with its actor and reason, and omits the field otherwise", () => {
    const failing = [result("a1", "authorization", 0)];
    const run = runOf({ release: "1.2", results: failing });
    const input = {
      candidate: { run, results: failing },
      baseline: { run: runOf({ release: "1.1", results: [result("a1", "authorization", 1)] }), results: [result("a1", "authorization", 1)] },
      requireBaseline: true,
      thresholds,
    };
    const overridden = trendEntryFor({
      decision: evaluateGate({ ...input, override: { actor: "azeem", reason: "SEV-1" } }),
      run,
      thresholds,
      at: "t",
    });
    expect(overridden.outcome).toBe("overridden");
    expect(overridden.override).toEqual({ actor: "azeem", reason: "SEV-1" });

    const plain = trendEntryFor({ decision: evaluateGate(input), run, thresholds, at: "t" });
    // Absent rather than an empty object: a reader scanning for overrides must not have to distinguish
    // `{actor: "", reason: ""}` from a real one.
    expect(plain.override).toBeUndefined();
    expect("override" in plain).toBe(false);
  });

  it("accumulates across consecutive releases, keeping each release's own numbers", () => {
    // The trend is a list the CLI appends to; what is asserted here is that an entry is self-contained, which is
    // what makes the accumulated list readable. An entry that referenced a shared threshold block would be
    // rewritten in meaning every time the block changed.
    const entries = ["1.0", "1.1", "1.2"].map((release, i) => {
      const results = [result("t1", "task-completion", 0.7 + i * 0.1), result("a1", "authorization", 1)];
      const run = runOf({ release, results });
      const decision = evaluateGate({
        candidate: { run, results },
        baseline: null,
        requireBaseline: true,
        thresholds: { dimensions: { "task-completion": 0.5, authorization: 1 } },
      });
      return trendEntryFor({ decision, run, thresholds: { dimensions: { "task-completion": 0.5 } }, at: `t${i}` });
    });
    expect(entries.map((e) => e.release)).toEqual(["1.0", "1.1", "1.2"]);
    // toBeCloseTo per entry: 0.7 + 0.1 is 0.7999999999999999, and a toEqual here asserts a property of binary
    // floating point rather than of the trend.
    const means = entries.map((e) => e.byDimension.find((d) => d.dimension === "task-completion")?.meanScore ?? 0);
    for (const [i, expected] of [0.7, 0.8, 0.9].entries()) expect(means[i]).toBeCloseTo(expected, 10);
  });

  it("keeps the trend entry small, because it is read in a diff", () => {
    const run = runOf({ release: "1.1", results: after });
    const decision = evaluateGate({
      candidate: { run, results: after },
      baseline: { run: runOf({ release: "1.0", results: before }), results: before },
      thresholds,
      requireBaseline: true,
    });
    const entry = trendEntryFor({ decision, run, thresholds, at: "t" });
    // An entry carrying every case result would make each release a thousand-line diff, and a trend nobody can
    // read in a diff is the same as not having one. Case *ids* only, no verdicts.
    expect(JSON.stringify(entry)).not.toContain("scored 0.6");
    expect(JSON.stringify(entry).length).toBeLessThan(1200);
  });
});

describe("release gate — the report a reviewer reads (AC-6)", () => {
  const before = [result("t1", "task-completion", 1), result("t2", "task-completion", 0.6), result("a1", "authorization", 1)];
  const after = [result("t1", "task-completion", 0.6), result("t3", "task-completion", 1), result("a1", "authorization", 1)];

  const report = () => {
    const run = runOf({ release: "1.1", results: after });
    const decision = evaluateGate({
      candidate: { run, results: after },
      baseline: { run: runOf({ release: "1.0", results: before }), results: before },
      thresholds,
      requireBaseline: true,
    });
    return formatGateReport(decision, run);
  };

  it("shows the outcome, the per-dimension scores, and every movement", () => {
    const text = report();
    expect(text).toMatch(/^release gate: FAIL/);
    expect(text).toMatch(/task-completion: 0\.800/);
    expect(text).toMatch(/↓ t1/);
    expect(text).toMatch(/\+ t3/);
    expect(text).toMatch(/- t2/);
  });

  it("puts the regressions before the improvements", () => {
    const results = [result("t1", "task-completion", 0.6), result("t2", "task-completion", 1), result("a1", "authorization", 1)];
    const run = runOf({ release: "1.1", results });
    const text = formatGateReport(
      evaluateGate({
        candidate: { run, results },
        baseline: { run: runOf({ release: "1.0", results: before }), results: before },
        requireBaseline: true,
        thresholds,
      }),
      run,
    );
    // A reviewer opens this log to find what broke. A report that led with improvements buries it — and the ids
    // here are chosen so alphabetical order is the *opposite* of this expectation, or the assertion would pass
    // on a report that simply sorted.
    expect(text.indexOf("↓ t1")).toBeLessThan(text.indexOf("↑ t2"));
  });

  it("states the cost of the run, so the gate's expense is visible in its own output", () => {
    const run = runOf({ release: "1.1", results: after, costMinorUnits: 1234 });
    const text = formatGateReport(
      evaluateGate({ candidate: { run, results: after }, baseline: null, requireBaseline: false, thresholds }),
      run,
    );
    expect(text).toContain("cost 1234 minor units");
  });
});
