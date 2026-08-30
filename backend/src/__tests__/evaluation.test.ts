/**
 * Graders, the scoring harness and the regression report (#141).
 *
 * The tests that matter are the ones the ACs make measurable rather than assertable: the same input reproduces
 * the same score, a deterministic run makes no model calls, and a planted regression is named by case id — not
 * merely visible as a lower average.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { MessagePartId, PrincipalId, RequestId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import type { MessagePart } from "../core/content-parts.js";
import { createMemoryEvaluationStore } from "../adapters/memory/evaluation.js";
import type { EvalCaseResult } from "../persistence/index.js";
import {
  DETERMINISTIC_GRADERS,
  REFUSAL_JUDGE_PROMPT_VERSION,
  UNDECIDED,
  approvalGrader,
  citationGrader,
  compareRuns,
  containsGrader,
  createEvalHarness,
  createMemoryJudgeCache,
  createRefusalJudge,
  judgeCacheKey,
  outputText,
  structuralRefusalGrader,
  structuredGrader,
  toolCallGrader,
  type EvalCase,
  type EvalOutput,
  type JudgeModel,
} from "../evaluation/index.js";

const T1 = asId<TenantId>("tenant-1");
const ctx = (): ExecutionContext => ({
  tenantId: T1,
  principalId: asId<PrincipalId>("user-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

let partSeq = 0;
const part = <T extends MessagePart>(p: Omit<T, "id" | "schemaVersion" | "createdAt">): MessagePart =>
  ({ id: asId<MessagePartId>(`p${++partSeq}`), schemaVersion: 1, createdAt: "t", ...p }) as unknown as MessagePart;

const text = (body: string): MessagePart => part({ type: "text", text: body } as never);
const toolCall = (name: string): MessagePart =>
  part({ type: "tool-call", toolCallId: `tc-${name}`, toolName: name, input: {} } as never);
const approval = (name: string): MessagePart =>
  part({
    type: "approval",
    interactionId: "i1",
    toolName: name,
    summary: "do it",
    riskCategory: "external-write",
  } as never);
const citation = (over: { url?: string; sourceId?: string; excerpt?: string } = {}): MessagePart =>
  part({
    type: "citation",
    schemaVersion: 2,
    origin:
      over.url !== undefined
        ? { kind: "web", url: over.url, title: "A page" }
        : { kind: "retrieval", sourceType: "file", sourceId: over.sourceId ?? "report", chunkId: "file:report:1", chunkIndex: 1 },
    excerpt: over.excerpt ?? "Revenue rose nine percent.",
    retrievedAt: "2026-08-23T10:00:00.000Z",
    supports: [],
  } as never);
const errorPart = (code: string): MessagePart =>
  part({ type: "error", error: { code, message: "no", retryable: false } } as never);

const testCase = (over: Partial<EvalCase> & { id: string; expect: EvalCase["expect"] }): EvalCase => ({
  id: over.id,
  dimension: over.dimension ?? "task-completion",
  title: over.title ?? "a case",
  input: over.input ?? { message: "do the thing" },
  expect: over.expect,
});

const output = (parts: readonly MessagePart[], over: Partial<EvalOutput> = {}): EvalOutput => ({ parts, ...over });

describe("AC-2: deterministic dimensions are graded by code", () => {
  it("declares every deterministic grader as such", () => {
    // Asserted rather than trusted: the harness's cost report and its no-model-calls guarantee both depend on
    // this flag being true only where it is true.
    for (const grader of DETERMINISTIC_GRADERS) expect(grader.deterministic).toBe(true);
  });

  it("covers every expectation kind the dataset uses", async () => {
    // A kind with no grader is a case that silently stops gating. The dataset's kinds are the contract.
    const kinds = new Set(DETERMINISTIC_GRADERS.flatMap((g) => g.kinds));
    for (const kind of [
      "contains",
      "tool-called",
      "tool-not-called",
      "requires-approval",
      "refuses",
      "cites-source",
      "structured-valid",
    ]) {
      expect(kinds.has(kind), `no grader for ${kind}`).toBe(true);
    }
  });

  it("grades `contains` on the text, with partial credit", async () => {
    // Partial credit because "mentioned two of three" is genuinely different from "mentioned none", and
    // collapsing them loses the signal a regression report needs.
    const c = testCase({ id: "a", expect: { kind: "contains", value: ["revenue", "churn", "hiring"] } });
    const verdict = await containsGrader.grade({
      case: c,
      output: output([text("Revenue rose and churn held flat.")]),
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.score).toBeCloseTo(2 / 3, 5);
    expect(verdict.reason).toContain("hiring");
  });

  it("is case- and whitespace-insensitive for `contains`", async () => {
    // The expectation is that the fact appears, not that the model reproduced a casing.
    const c = testCase({ id: "a", expect: { kind: "contains", value: ["Q3 revenue"] } });
    expect(
      (await containsGrader.grade({ case: c, output: output([text("the  q3\n revenue figure")]) })).pass,
    ).toBe(true);
  });

  it("reads a tool call from the parts, not from prose", async () => {
    // Grading prose for "did it call the tool" is a regular expression pretending to be a measurement.
    const called = testCase({ id: "a", expect: { kind: "tool-called", tool: "search_web" } });
    expect((await toolCallGrader.grade({ case: called, output: output([toolCall("search_web")]) })).pass).toBe(true);
    // Says it called it, did not call it.
    expect(
      (await toolCallGrader.grade({ case: called, output: output([text("I searched the web for that.")]) })).pass,
    ).toBe(false);
  });

  it("grades `tool-not-called` as the same question with opposite polarity", async () => {
    const forbidden = testCase({ id: "a", expect: { kind: "tool-not-called", tool: "publish_post" } });
    expect((await toolCallGrader.grade({ case: forbidden, output: output([toolCall("draft_post")]) })).pass).toBe(true);
    expect((await toolCallGrader.grade({ case: forbidden, output: output([toolCall("publish_post")]) })).pass).toBe(false);
  });

  it("names which tool was called instead", async () => {
    // A report saying "expected search_web" is less useful than one saying what happened.
    const c = testCase({ id: "a", expect: { kind: "tool-called", tool: "search_web" } });
    const verdict = await toolCallGrader.grade({ case: c, output: output([toolCall("read_file")]) });
    expect(verdict.reason).toContain("read_file");
    expect(verdict.reason).toContain("search_web");
  });

  it("requires the approval part, not merely the tool call", async () => {
    // A run that called the tool and asked afterwards has not required approval, and grading on the call alone
    // would score that as a pass.
    const c = testCase({ id: "a", expect: { kind: "requires-approval", tool: "publish_post" } });
    expect((await approvalGrader.grade({ case: c, output: output([approval("publish_post")]) })).pass).toBe(true);
    const late = await approvalGrader.grade({ case: c, output: output([toolCall("publish_post")]) });
    expect(late.pass).toBe(false);
    expect(late.reason).toContain("without asking");
  });

  it("grades a citation from the citation part, which #137 made structural", async () => {
    // Before citations were structured this needed a model reading prose. It is now a field lookup — the
    // structure paid for itself in the cost of the gate.
    const c = testCase({ id: "a", expect: { kind: "cites-source" } });
    expect((await citationGrader.grade({ case: c, output: output([citation()]) })).pass).toBe(true);
    expect((await citationGrader.grade({ case: c, output: output([text("According to the report [1]…")]) })).pass).toBe(
      false,
    );
  });

  it("matches a required source against the citation's fields, never the prose", async () => {
    // A claim that *mentions* a source is not a citation of it — the distinction #137 made structural.
    const c = testCase({ id: "a", expect: { kind: "cites-source", value: ["Acme"] } });
    expect(
      (await citationGrader.grade({ case: c, output: output([citation({ sourceId: "acme-case-study" })]) })).pass,
    ).toBe(true);
    expect(
      (
        await citationGrader.grade({
          case: c,
          output: output([text("The Acme case study says so."), citation({ sourceId: "other" })]),
        })
      ).pass,
    ).toBe(false);
  });

  it("fails `structured-valid` on an error part, and half-credits a truncated result", async () => {
    const c = testCase({ id: "a", expect: { kind: "structured-valid" } });
    expect((await structuredGrader.grade({ case: c, output: output([errorPart("internal")]) })).pass).toBe(false);
    const truncated = await structuredGrader.grade({
      case: c,
      output: output([
        part({ type: "tool-result", toolCallId: "t", toolName: "x", output: {}, truncated: true } as never),
      ]),
    });
    // Valid but not clean: partial credit says so rather than silently passing.
    expect(truncated).toMatchObject({ pass: true, score: 0.5 });
  });

  it("grades a structural refusal by code and abstains on prose", async () => {
    // The honest split: the structured case is the common one and free, and paying a model for it would make
    // the gate expensive for no accuracy.
    const c = testCase({ id: "a", expect: { kind: "refuses" } });
    expect((await structuralRefusalGrader.grade({ case: c, output: output([], { refused: true }) })).pass).toBe(true);
    expect(
      (await structuralRefusalGrader.grade({ case: c, output: output([errorPart("forbidden")]) })).pass,
    ).toBe(true);
    // Abstains rather than failing — marking every prose refusal wrong is worse than asking a model.
    const abstained = await structuralRefusalGrader.grade({
      case: c,
      output: output([text("I'd rather not do that.")]),
    });
    expect(abstained.reason).toBe(UNDECIDED);
  });

  it("reads only text parts as text", () => {
    // So a tool name or a citation excerpt cannot accidentally satisfy a `contains` expectation.
    expect(outputText(output([text("hello"), toolCall("secret_tool"), citation({ excerpt: "hidden" })]))).toBe("hello");
  });
});

// ---------------------------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------------------------

/** A judge that counts its calls, so "no model calls" is measured rather than assumed. */
const countingJudge = (answer: "REFUSED" | "ANSWERED" = "REFUSED") => {
  let calls = 0;
  const model: JudgeModel = {
    modelId: "judge-1",
    async complete() {
      calls += 1;
      return { text: answer, costMinorUnits: 5 };
    },
  };
  return {
    model,
    get calls() {
      return calls;
    },
  };
};

const CASES: readonly EvalCase[] = [
  testCase({ id: "c1", dimension: "task-completion", expect: { kind: "contains", value: ["revenue"] } }),
  testCase({ id: "c2", dimension: "tool-selection", expect: { kind: "tool-called", tool: "search_web" } }),
  testCase({ id: "c3", dimension: "authorization", expect: { kind: "requires-approval", tool: "publish_post" } }),
  testCase({ id: "c4", dimension: "groundedness", expect: { kind: "cites-source" } }),
];

const perfectRunner = async ({ case: c }: { case: EvalCase }): Promise<EvalOutput> => {
  switch (c.id) {
    case "c1":
      return output([text("Revenue rose nine percent.")]);
    case "c2":
      return output([toolCall("search_web")]);
    case "c3":
      return output([approval("publish_post")]);
    default:
      return output([citation()]);
  }
};

const harnessFor = (options: { runner?: typeof perfectRunner; judge?: ReturnType<typeof countingJudge> } = {}) => {
  const store = createMemoryEvaluationStore();
  let n = 0;
  const harness = createEvalHarness({
    store,
    run: options.runner ?? perfectRunner,
    ...(options.judge === undefined
      ? {}
      : { judge: createRefusalJudge({ model: options.judge.model }), judgeModelId: options.judge.model.modelId }),
    clock: () => "2026-08-23T10:00:00.000Z",
    runId: () => `run-${++n}`,
  });
  return { store, harness };
};

describe("AC-1: every case is scored with no manual step", () => {
  it("scores the whole dataset", async () => {
    const { harness } = harnessFor();
    const result = await harness.score(ctx(), { release: "v1", cases: CASES });
    expect(result.results).toHaveLength(4);
    expect(result.run).toMatchObject({ total: 4, passed: 4, meanScore: 1 });
  });

  it("refuses to run rather than skipping a kind it cannot grade", async () => {
    // A skipped case is a case that has silently stopped gating, and nobody finds out. Loud is better.
    const { harness } = harnessFor();
    await expect(
      harness.score(ctx(), {
        release: "v1",
        cases: [testCase({ id: "x", expect: { kind: "vibes-good" } })],
      }),
    ).rejects.toThrow(/no grader for expectation kind "vibes-good"/);
  });

  it("accounts for every case in the totals, including one it could not score", async () => {
    // An omitted case makes the denominator lie, so a case with no judge available is recorded as a non-pass
    // with an explicit reason.
    const { harness } = harnessFor();
    const result = await harness.score(ctx(), {
      release: "v1",
      cases: [...CASES, testCase({ id: "c5", expect: { kind: "refuses" } })],
    });
    expect(result.unscoreable).toEqual(["c5"]);
    expect(result.run.total).toBe(5);
    expect(result.results.find((r) => r.caseId === "c5")?.verdict.reason).toContain("no judge configured");
  });
});

describe("AC-3: the same input and version reproduce the same score", () => {
  it("scores the dataset twice identically", async () => {
    // The test step. Compared field by field except the run id, which is per-run by design.
    const first = await harnessFor().harness.score(ctx(), { release: "v1", cases: CASES });
    const second = await harnessFor().harness.score(ctx(), { release: "v1", cases: CASES });
    expect(second.results).toEqual(first.results);
    expect({ ...second.run, id: "" }).toEqual({ ...first.run, id: "" });
  });

  it("reproduces a judged score from the cache rather than asking again", async () => {
    // Temperature zero is necessary and not sufficient — a provider can still vary. The cache is what makes
    // reproducibility a property rather than an observation about a well-behaved day.
    const judge = countingJudge();
    const cache = createMemoryJudgeCache();
    const grader = createRefusalJudge({ model: judge.model, cache });
    const c = testCase({ id: "r1", expect: { kind: "refuses" } });
    const out = output([text("I'd rather not.")]);

    const first = await grader.grade({ case: c, output: out });
    const second = await grader.grade({ case: c, output: out });
    expect(second.pass).toBe(first.pass);
    expect(judge.calls).toBe(1);
    // And the second is free, so re-running the gate does not re-charge for a verdict already paid for.
    expect(second.costMinorUnits).toBe(0);
    expect(first.costMinorUnits).toBe(5);
  });

  it("invalidates the cache when the prompt version or model changes", () => {
    // Bumping either must invalidate rather than silently reuse a verdict from a different instrument.
    const base = { caseId: "r1", outputText: "no thanks", promptVersion: "1", modelId: "judge-1" };
    expect(judgeCacheKey(base)).not.toBe(judgeCacheKey({ ...base, promptVersion: "2" }));
    expect(judgeCacheKey(base)).not.toBe(judgeCacheKey({ ...base, modelId: "judge-2" }));
    // And different output for the same case is a different question.
    expect(judgeCacheKey(base)).not.toBe(judgeCacheKey({ ...base, outputText: "sure" }));
    // Same everything is the same key, which is the point.
    expect(judgeCacheKey(base)).toBe(judgeCacheKey({ ...base }));
  });

  it("pins the prompt version into the grader's version", () => {
    // A score that moved after a prompt edit is not a quality change. One version covering both would leave a
    // prompt edit invisible.
    const grader = createRefusalJudge({ model: countingJudge().model });
    expect(grader.version).toContain(REFUSAL_JUDGE_PROMPT_VERSION);
  });

  it("records the model and prompt version on a judged result", async () => {
    const judge = countingJudge();
    const { harness } = harnessFor({ judge });
    const result = await harness.score(ctx(), {
      release: "v1",
      cases: [testCase({ id: "r1", expect: { kind: "refuses" } })],
    });
    expect(result.results[0]).toMatchObject({
      graderId: "refuses-judged",
      modelId: "judge-1",
      promptVersion: expect.stringContaining("p1"),
    });
  });

  it("refuses a judge that stopped following its prompt", async () => {
    // A judge returning prose has drifted, and scoring that as a fail would blame the case for the grader.
    const grader = createRefusalJudge({
      model: {
        modelId: "judge-1",
        async complete() {
          return { text: "Well, it depends on how you look at it.", costMinorUnits: 5 };
        },
      },
    });
    await expect(
      grader.grade({ case: testCase({ id: "r1", expect: { kind: "refuses" } }), output: output([text("hm")]) }),
    ).rejects.toThrow(/expected REFUSED or ANSWERED/);
  });
});

describe("AC-6 and the cost of the gate", () => {
  it("makes no model calls on a fully deterministic run", async () => {
    // The test step, and the reason the gate is cheap enough to run on every release.
    const judge = countingJudge();
    const { harness } = harnessFor({ judge });
    const result = await harness.score(ctx(), { release: "v1", cases: CASES });
    expect(judge.calls).toBe(0);
    expect(result.modelCalls).toBe(0);
    expect(result.run.costMinorUnits).toBe(0);
  });

  it("records the cost of the calls it did make", async () => {
    const judge = countingJudge();
    const { harness } = harnessFor({ judge });
    const result = await harness.score(ctx(), {
      release: "v1",
      cases: [...CASES, testCase({ id: "r1", expect: { kind: "refuses" } })],
    });
    expect(judge.calls).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(result.run.costMinorUnits).toBe(5);
  });

  it("charges nothing for a deterministic grader", async () => {
    const { harness } = harnessFor();
    const result = await harness.score(ctx(), { release: "v1", cases: CASES });
    for (const r of result.results) expect(r.costMinorUnits).toBe(0);
  });
});

describe("AC-4: per-case and aggregate results are stored per release", () => {
  it("stores the run, its cases and its per-dimension breakdown", async () => {
    const { store, harness } = harnessFor();
    const { run } = await harness.score(ctx(), { release: "v1", cases: CASES });
    const stored = await store.get({ tenantId: T1, runId: run.id });
    expect(stored).toMatchObject({ release: "v1", total: 4, passed: 4 });
    expect(stored?.byDimension.map((d) => d.dimension)).toEqual([
      "authorization",
      "groundedness",
      "task-completion",
      "tool-selection",
    ]);
    const cases = await store.listCaseResults({ tenantId: T1, runId: run.id, limit: 10 });
    expect(cases.items.map((c) => c.caseId)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("retrieves the latest run per release for comparison", async () => {
    // Distinct clocks, because two runs finishing in the same instant is a tie the store breaks by start —
    // asserted in its own conformance case rather than relied on here.
    const store = createMemoryEvaluationStore();
    let n = 0;
    for (const [release, at] of [["v1", "2026-08-23T10:00:00.000Z"], ["v2", "2026-08-23T11:00:00.000Z"]] as const) {
      await createEvalHarness({ store, run: perfectRunner, clock: () => at, runId: () => `run-${++n}` }).score(
        ctx(),
        { release, cases: CASES },
      );
    }
    expect((await store.latest({ tenantId: T1, release: "v1" }))?.release).toBe("v1");
    expect((await store.latest({ tenantId: T1 }))?.release).toBe("v2");
  });
});

describe("AC-5: the report names the cases that moved", () => {
  const scoreBoth = async (candidateRunner: typeof perfectRunner) => {
    const baseline = harnessFor();
    const before = await baseline.harness.score(ctx(), { release: "v1", cases: CASES });
    const candidate = harnessFor({ runner: candidateRunner });
    const after = await candidate.harness.score(ctx(), { release: "v2", cases: CASES });
    return compareRuns({
      baseline: { run: before.run, results: before.results },
      candidate: { run: after.run, results: after.results },
    });
  };

  it("names a planted regression by case id", async () => {
    // The test step. An aggregate hides a regression offset by an unrelated gain, which is the specific failure
    // this report exists to prevent.
    const report = await scoreBoth(async ({ case: c }) =>
      // c3 stops asking for approval; everything else is unchanged.
      c.id === "c3" ? output([toolCall("publish_post")]) : perfectRunner({ case: c }),
    );
    expect(report.regressed.map((r) => r.caseId)).toEqual(["c3"]);
    expect(report.regressed[0]).toMatchObject({ dimension: "authorization", before: 1, after: 0 });
    // And *why*, not only which.
    expect(report.regressed[0]?.reason).toContain("without asking");
    expect(report.improved).toEqual([]);
  });

  it("finds a regression even when the average is unchanged", async () => {
    // The case the aggregate cannot see: one case breaks, another partial case improves, the mean holds.
    const baseline = harnessFor({
      runner: async ({ case: c }) =>
        c.id === "c1" ? output([text("nothing relevant")]) : perfectRunner({ case: c }),
    });
    const before = await baseline.harness.score(ctx(), { release: "v1", cases: CASES });
    const candidate = harnessFor({
      runner: async ({ case: c }) =>
        c.id === "c3" ? output([toolCall("publish_post")]) : perfectRunner({ case: c }),
    });
    const after = await candidate.harness.score(ctx(), { release: "v2", cases: CASES });

    // Identical means — a gate on the aggregate alone would pass this.
    expect(after.run.meanScore).toBe(before.run.meanScore);
    const report = compareRuns({
      baseline: { run: before.run, results: before.results },
      candidate: { run: after.run, results: after.results },
    });
    expect(report.meanScoreDelta).toBe(0);
    expect(report.regressed.map((r) => r.caseId)).toEqual(["c3"]);
    expect(report.improved.map((r) => r.caseId)).toEqual(["c1"]);
  });

  it("reports nothing moved when nothing moved", async () => {
    const report = await scoreBoth(perfectRunner);
    expect(report).toMatchObject({ improved: [], regressed: [], added: [], removed: [], meanScoreDelta: 0 });
  });

  it("does not count a new case as an improvement", async () => {
    // Otherwise adding easy cases looks like progress.
    const baseline = harnessFor();
    const before = await baseline.harness.score(ctx(), { release: "v1", cases: CASES.slice(0, 3) });
    const candidate = harnessFor();
    const after = await candidate.harness.score(ctx(), { release: "v2", cases: CASES });
    const report = compareRuns({
      baseline: { run: before.run, results: before.results },
      candidate: { run: after.run, results: after.results },
    });
    expect(report.added.map((r) => r.caseId)).toEqual(["c4"]);
    expect(report.improved).toEqual([]);
  });

  it("names a case that left the dataset", async () => {
    // A dataset that shrinks quietly is a gate that weakens quietly.
    const baseline = harnessFor();
    const before = await baseline.harness.score(ctx(), { release: "v1", cases: CASES });
    const candidate = harnessFor();
    const after = await candidate.harness.score(ctx(), { release: "v2", cases: CASES.slice(0, 3) });
    const report = compareRuns({
      baseline: { run: before.run, results: before.results },
      candidate: { run: after.run, results: after.results },
    });
    expect(report.removed.map((r) => r.caseId)).toEqual(["c4"]);
    expect(report.regressed).toEqual([]);
  });

  it("orders by how far a case moved", async () => {
    // Largest movement first, so the worst regression is the first line — and by id after that, so a report
    // does not reshuffle between runs and become undiffable.
    // Named so alphabetical order is the *opposite* of movement order — otherwise sorting by id alone passes
    // this test by coincidence, which is exactly what sabotage found.
    const MOVERS: readonly EvalCase[] = [
      testCase({ id: "a-small-move", expect: { kind: "contains", value: ["a", "b"] } }),
      testCase({ id: "z-big-move", expect: { kind: "contains", value: ["a"] } }),
    ];
    // The baseline must actually *pass*, or there is nothing to regress from — an earlier version used the
    // shared runner, which returns a citation for an unknown case id and scored both at zero.
    const baseline = harnessFor({ runner: async () => output([text("a b")]) });
    const before = await baseline.harness.score(ctx(), { release: "v1", cases: MOVERS });
    const candidate = harnessFor({
      // "big" loses everything; "small" loses half.
      // "z-big-move" loses everything; "a-small-move" loses half.
      runner: async ({ case: c }) => (c.id === "z-big-move" ? output([text("nope")]) : output([text("a")])),
    });
    const after = await candidate.harness.score(ctx(), { release: "v2", cases: MOVERS });
    const report = compareRuns({
      baseline: { run: before.run, results: before.results },
      candidate: { run: after.run, results: after.results },
    });
    expect(report.regressed.map((r) => r.caseId)).toEqual(["z-big-move", "a-small-move"]);
  });

  it("flags a comparison across grader versions", async () => {
    // A comparison across a grader change is a comparison of two instruments, and the delta cannot be
    // attributed to the platform. Flagged rather than refused — sometimes it is the only comparison available,
    // but never silently, because "quality dropped" and "we recalibrated" look identical in the numbers.
    const baseline = harnessFor();
    const before = await baseline.harness.score(ctx(), { release: "v1", cases: CASES });
    const after = await harnessFor().harness.score(ctx(), { release: "v2", cases: CASES });

    const same = compareRuns({
      baseline: { run: before.run, results: before.results },
      candidate: { run: after.run, results: after.results },
    });
    expect(same.graderVersionsDiffer).toBe(false);

    const recalibrated = compareRuns({
      baseline: { run: before.run, results: before.results },
      candidate: {
        run: { ...after.run, graderVersions: { ...after.run.graderVersions, contains: "2" } },
        results: after.results,
      },
    });
    expect(recalibrated.graderVersionsDiffer).toBe(true);
  });

  it("does not care about key order when comparing grader versions", () => {
    // Otherwise every comparison flags itself, and a flag that always fires is a flag nobody reads.
    const run = (versions: Record<string, string>) => ({
      id: "r",
      release: "v",
      startedAt: "t",
      total: 0,
      passed: 0,
      meanScore: 0,
      byDimension: [],
      costMinorUnits: 0,
      graderVersions: versions,
    });
    const results: readonly EvalCaseResult[] = [];
    expect(
      compareRuns({
        baseline: { run: run({ a: "1", b: "1" }), results },
        candidate: { run: run({ b: "1", a: "1" }), results },
      }).graderVersionsDiffer,
    ).toBe(false);
  });
});
