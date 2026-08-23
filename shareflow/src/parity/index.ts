/**
 * Parity evaluation and the cutover gate — #128.
 *
 * Everything here exists to make the removal **safe when it happens**, which is a different job from
 * performing it. Two reasons it cannot be performed by this package: the Agno call paths are in
 * `social_integgration`, a separate repository, and the gates have not passed because no deployment is
 * running both runtimes yet. docs/README lists removing Agno before parity as an explicit non-goal.
 *
 * So what ships is the machinery that refuses.
 */
import type { ParityReport } from "../shadow/index.js";
import { PARITY_GATES, gateFor, type ParityGate } from "./gates.js";

export * from "./gates.js";
export * from "./cutover.js";

/** A gate's outcome for one workflow. */
export const VERDICTS = [
  "passed",
  "failed",
  /** Enough runs, and the gate itself is not agreed. Not a pass. */
  "gate-not-agreed",
  /** Fewer runs than the gate requires. Not a failure either. */
  "insufficient-sample",
  /** Shadow data cannot decide this workflow at all. */
  "not-measurable",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export type WorkflowVerdict = {
  readonly workflow: string;
  readonly verdict: Verdict;
  readonly metric: ParityGate["metric"];
  readonly threshold?: number;
  /** The measured value, when one could be measured. */
  readonly measured?: number;
  readonly sampleSize: number;
  readonly minimumSample?: number;
  /** Why this verdict, in a sentence a reviewer can act on. */
  readonly detail: string;
};

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

/**
 * Evaluate one workflow's shadow reports against its gate.
 *
 * The order of checks is the point, and it is deliberately unhelpful in the safe direction:
 *
 * 1. **Unmeasurable** — decided by the gate, not by the data. No amount of data changes it.
 * 2. **Not agreed** — checked *before* the numbers, so a proposed gate cannot pass however good the data
 *    looks. That is what makes AC-1's "agreed in advance" a precondition rather than a hope.
 * 3. **Sample size** — a threshold without a sample is not a gate. 100% of three runs is noise, and
 *    "passed" on it would be the most dangerous kind of green.
 * 4. Only then, the measurement.
 */
export const evaluateAgainstGate = (
  gate: ParityGate,
  reports: readonly ParityReport[],
): WorkflowVerdict => evaluate(gate.workflow, gate, reports);

/**
 * Evaluate a workflow by looking its gate up.
 *
 * Split from `evaluateAgainstGate` because every shipped gate is `proposed` by design, which makes the
 * `passed` and `insufficient-sample` branches unreachable through this function — and the `passed` branch
 * is the one that eventually lets a removal through. An untested permissive branch is the worst one to
 * have, so the gate is injectable for the tests that need to reach it.
 */
export const evaluateWorkflow = (
  workflow: string,
  reports: readonly ParityReport[],
): WorkflowVerdict => evaluate(workflow, gateFor(workflow), reports);

const evaluate = (
  workflow: string,
  gate: ParityGate | undefined,
  reports: readonly ParityReport[],
): WorkflowVerdict => {
  const sampleSize = reports.length;
  if (gate === undefined) {
    return {
      workflow,
      verdict: "gate-not-agreed",
      metric: "identical-write-rate",
      sampleSize,
      detail: `no parity gate is defined for "${workflow}", so there is nothing to evaluate against`,
    };
  }

  const base = {
    workflow,
    metric: gate.metric,
    sampleSize,
    ...(gate.threshold === undefined ? {} : { threshold: gate.threshold }),
    ...(gate.minimumSample === undefined ? {} : { minimumSample: gate.minimumSample }),
  };

  if (gate.metric === "unmeasurable-by-shadow") {
    return {
      ...base,
      verdict: "not-measurable",
      detail:
        gate.needsInstead === undefined
          ? "shadow data cannot decide this workflow"
          : `shadow data cannot decide this workflow. Needs instead: ${gate.needsInstead}`,
    };
  }

  if (gate.status !== "agreed") {
    // Before the numbers, deliberately. A threshold agreed after seeing the results is exactly what AC-1
    // forbids, and the way to enforce that is to refuse to compute a pass against an unsigned one.
    return {
      ...base,
      verdict: "gate-not-agreed",
      detail: `the gate for "${workflow}" is still proposed — a threshold has to be agreed before results are visible, so this cannot pass until someone signs it`,
    };
  }

  if (gate.minimumSample !== undefined && sampleSize < gate.minimumSample) {
    return {
      ...base,
      verdict: "insufficient-sample",
      detail: `${sampleSize} runs, and the gate needs ${gate.minimumSample}. Not a failure — there is not yet enough to say`,
    };
  }

  const measured =
    gate.metric === "identical-write-rate"
      ? rate(reports.filter((r) => r.identical).length, sampleSize)
      : rate(
          reports.filter((r) => r.approvalBearingWrites.new <= r.approvalBearingWrites.old).length,
          sampleSize,
        );

  const threshold = gate.threshold ?? 1;
  return {
    ...base,
    measured,
    verdict: measured >= threshold ? "passed" : "failed",
    detail:
      measured >= threshold
        ? `${(measured * 100).toFixed(1)}% over ${sampleSize} runs, against a bar of ${(threshold * 100).toFixed(1)}%`
        : `${(measured * 100).toFixed(1)}% over ${sampleSize} runs, below the bar of ${(threshold * 100).toFixed(1)}%`,
  };
};

export type ParityEvaluation = {
  readonly verdicts: readonly WorkflowVerdict[];
  /**
   * True only when every gate that *can* be decided has passed.
   *
   * `not-measurable` does not block, and that is a judgement worth naming: a workflow shadow data cannot
   * decide would otherwise block the cutover forever, and blocking forever on an unmeasurable thing is how
   * a gate gets quietly removed. It is surfaced in `unmeasurable` instead, so the decision to proceed
   * without it is made by a person, visibly.
   */
  readonly allMeasurablePassed: boolean;
  readonly unmeasurable: readonly string[];
  readonly blocking: readonly string[];
};

/** Evaluate every gate against reports grouped by workflow. */
export const evaluateParity = (
  reportsByWorkflow: Readonly<Record<string, readonly ParityReport[]>>,
): ParityEvaluation => {
  const verdicts = PARITY_GATES.map((g) => evaluateWorkflow(g.workflow, reportsByWorkflow[g.workflow] ?? []));
  const blocking = verdicts.filter((v) => v.verdict !== "passed" && v.verdict !== "not-measurable");
  return {
    verdicts,
    allMeasurablePassed: blocking.length === 0,
    unmeasurable: verdicts.filter((v) => v.verdict === "not-measurable").map((v) => v.workflow),
    blocking: blocking.map((v) => v.workflow),
  };
};

// ---------------------------------------------------------------------------------------------------
// The cutover gate — AC-4's enforcement
// ---------------------------------------------------------------------------------------------------

export type RemovalCheck = {
  readonly allowed: boolean;
  /** Every reason it is not allowed. All of them, not the first — a reviewer wants the full list. */
  readonly blockers: readonly string[];
};

/**
 * May the Agno removal proceed?
 *
 * AC-4 says removal happens *"only after every workflow passes its gate"*. A checklist in a document is a
 * promise; this is the same statement as a function, so the answer cannot be "I thought they had passed".
 *
 * Every reason is returned rather than the first, because a reviewer fixing one blocker wants to know
 * whether there are three more.
 */
export const canRemoveOldRuntime = (input: {
  readonly evaluation: ParityEvaluation;
  /** Has the removal decision been signed, and by whom? */
  readonly signedOffBy?: string;
  /** Has the historical-data question been answered? See `DATA_DISPOSITION`. */
  readonly dataDispositionDecided?: boolean;
  /**
   * How many files still reference the old runtime, per `OLD_RUNTIME_REFERENCE_SCOPE`.
   *
   * Only meaningful *after* a removal attempt — it is what turns AC-5 into a check rather than a claim. A
   * caller that has not run the scan omits it, and omitting it is not treated as zero: "I did not look" and
   * "there are none" must not be the same value, which is the lesson #124's fail-soft search and #125's
   * unmeasured metric both landed on.
   */
  readonly remainingReferences?: number;
}): RemovalCheck => {
  const blockers: string[] = [];
  for (const workflow of input.evaluation.blocking) {
    const verdict = input.evaluation.verdicts.find((v) => v.workflow === workflow);
    blockers.push(`${workflow}: ${verdict?.verdict ?? "unknown"} — ${verdict?.detail ?? ""}`);
  }
  if (input.evaluation.unmeasurable.length > 0) {
    // Not a blocker on its own, and it *is* a blocker until someone says otherwise: proceeding past a
    // workflow nobody could measure has to be a decision, not a default.
    blockers.push(
      `these workflows cannot be decided by shadow data and need an explicit decision to proceed without them: ${input.evaluation.unmeasurable.join(", ")}`,
    );
  }
  if (input.signedOffBy === undefined || input.signedOffBy.trim() === "") {
    blockers.push("no one has signed off the removal — AC-3 requires a named decision-maker");
  }
  if (input.dataDispositionDecided !== true) {
    blockers.push(
      "the historical Agno conversation data question is unanswered — AC-6 requires it migrated or declared out of scope in writing",
    );
  }
  if (input.remainingReferences === undefined) {
    // "I did not look" is not evidence, and it must not be worth the same as "there are none". Sabotage
    // showed the earlier version treated an omitted count as clean — the presence of the field carried no
    // weight, so the comment claiming it did was overclaiming. Now it blocks, which is the same lesson
    // #124's fail-soft search and #125's unmeasured metric both landed on.
    blockers.push("the old-runtime reference scan has not been run — AC-5 cannot be assessed without it");
  } else if (input.remainingReferences > 0) {
    blockers.push(
      `${input.remainingReferences} file(s) still reference the old runtime — AC-5 is not met until the scan is clean`,
    );
  }
  return { allowed: blockers.length === 0, blockers };
};

// ---------------------------------------------------------------------------------------------------
// AC-5's executable definition of done
// ---------------------------------------------------------------------------------------------------

/**
 * Where the old runtime still lives.
 *
 * Recorded as data rather than as prose so AC-5 — *"no Agno reference remains"* — is a check someone can
 * run instead of a claim someone can make. **As of #128 it reports 71 files**, which is the honest state:
 * the removal has not happened and must not until the gates pass.
 *
 * The scan is not implemented here, and deliberately: `social_integgration` is a separate repository, and
 * a checker in this package that reached into a sibling directory on someone's disk is exactly the
 * coupling R9 exists to prevent. This is the *specification* of the check; the check runs where the code
 * is.
 */
export const OLD_RUNTIME_REFERENCE_SCOPE = {
  /** Repository, relative to the working tree root. Not this one. */
  repository: "social_integgration",
  /** Case-insensitive terms that mean the old runtime. */
  terms: ["agno", "agentos"] as const,
  /** Directories to scan. */
  roots: ["web/src", "ai_backend/app"] as const,
  /** What was there when the gate was written, so a later count is comparable. */
  baselineFileCount: 71,
  /** Where the bulk of it is, so a removal can be sequenced rather than attempted at once. */
  baselineHotspots: [
    { path: "web/src/lib/assistant", files: 15 },
    { path: "ai_backend/app/assistant", files: 9 },
    { path: "web/src/lib/assistant/__tests__", files: 8 },
    { path: "web/src/app/(dashboard)/assistant", files: 6 },
    { path: "ai_backend/app/agents", files: 6 },
  ] as const,
} as const;

/**
 * The written record AC-6 asks for.
 *
 * Deliberately **unanswered**. The question — what happens to historical Agno conversation data — is a
 * retention and customer-expectation decision, not an implementation one. An unfilled record is visibly
 * unfilled; a guess dressed as a decision would not be.
 */
export const DATA_DISPOSITION = {
  question: "What happens to historical Agno conversation data at cutover?",
  decision: null as null | "migrate" | "retain-read-only" | "out-of-scope",
  decidedBy: null as null | string,
  options: [
    {
      option: "migrate",
      consequence:
        "Conversations appear unbroken to the user. Requires a mapping from Agno's session and message shapes onto conversations, messages and parts — and the two disagree about what a step is, so some fidelity is lost silently unless the mapping is specified first.",
    },
    {
      option: "retain-read-only",
      consequence:
        "Old conversations stay readable in the old surface and new ones start clean. Cheapest, and the user sees a hard boundary in their history — which is honest but needs saying in the product rather than discovered.",
    },
    {
      option: "out-of-scope",
      consequence:
        "History is not carried over and is eventually deleted under the existing retention policy. Acceptable only if customers are told before cutover, not after — and REQ-034's retention work is where the deletion actually happens.",
    },
  ],
} as const;
