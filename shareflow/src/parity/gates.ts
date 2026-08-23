/**
 * The parity gates — #128 AC-1.
 *
 * ## Why every gate is `proposed`
 *
 * AC-1's real content is the clause *"not decided after seeing the results"*. A threshold chosen once the
 * numbers are in is not a gate, it is a rationalisation.
 *
 * I am in a legitimate position to **propose** these — I have seen no shadow data — and in no position to
 * **agree** them, because an acceptable quality bar is a product decision. So each carries
 * `status: "proposed"`, and `evaluateParity` **refuses to pass a gate that is not agreed**.
 *
 * That is what makes AC-1 machine-checkable rather than aspirational: the cutover checklist cannot go green
 * on numbers nobody signed. It is also why writing the proposals down is safe — they cannot be silently
 * adopted by being here.
 */

/** What a gate measures, and how. */
export const PARITY_METRICS = [
  /** Proportion of runs where the new runtime's write set is identical to the old runtime's. */
  "identical-write-rate",
  /** Proportion of runs where the new runtime would perform no more approval-bearing writes than the old. */
  "no-additional-approved-writes",
  /**
   * Cannot be measured from shadow data.
   *
   * Shadow mode compares *writes*, and a read-only workflow makes none — so a write-based gate would pass
   * vacuously on every run, which is worse than no gate: a green tick nobody earned.
   */
  "unmeasurable-by-shadow",
] as const;

export type ParityMetric = (typeof PARITY_METRICS)[number];

export type ParityGate = {
  /** The docs/07 workflow. Matches the `workflow` on a `ShadowRun`. */
  readonly workflow: string;
  readonly metric: ParityMetric;
  /**
   * The bar, as a proportion of runs from 0 to 1. Absent when the metric is unmeasurable.
   */
  readonly threshold?: number;
  /**
   * How many runs before a verdict means anything. Absent when unmeasurable.
   *
   * A threshold without a sample size is not a gate: 100% of three runs is noise, and a report that said
   * "passed" on it would be the most dangerous kind of green.
   */
  readonly minimumSample?: number;
  /** Why this number. The part a reviewer reads before agreeing to it. */
  readonly rationale: string;
  /**
   * `proposed` until a person agrees it. `evaluateParity` will not pass a proposed gate.
   */
  readonly status: "proposed" | "agreed";
  /** Who agreed, and when. Absent while proposed. */
  readonly agreedBy?: string;
  readonly agreedAt?: string;
  /** For an unmeasurable metric: what would measure it instead. */
  readonly needsInstead?: string;
};

/**
 * One gate per docs/07 workflow.
 *
 * The publish gate is the only threshold that is not my judgement: REQ-021 already states it as *"zero
 * unauthorized or duplicate actions"*, so 1.0 is transcribed rather than chosen. Every other number is a
 * proposal and says so.
 */
export const PARITY_GATES: readonly ParityGate[] = [
  {
    workflow: "create-post",
    metric: "identical-write-rate",
    threshold: 0.9,
    minimumSample: 200,
    rationale:
      "Not 1.0, deliberately: a drafted post is reviewed by a human before it goes anywhere, and the new runtime writing a different — possibly better — caption is not a regression. What 0.9 asserts is that it is not writing something *structurally* different most of the time. The sample is 200 because a create-post run is cheap and common, so a large sample costs little. This number is a proposal.",
    status: "proposed",
  },
  {
    workflow: "publish",
    metric: "no-additional-approved-writes",
    threshold: 1.0,
    minimumSample: 500,
    rationale:
      "1.0 is transcribed, not chosen: REQ-021 states the criterion as 'zero unauthorized or duplicate actions'. A single run where the new runtime would publish more than the old one did is a failure of the whole migration, so there is no proportion to trade. The sample is larger than create-post's because the failure is irreversible and rare failures are the ones that matter here.",
    status: "proposed",
  },
  {
    workflow: "campaign-planning",
    metric: "identical-write-rate",
    threshold: 0.8,
    minimumSample: 100,
    rationale:
      "Lower than create-post because a campaign plan is a longer chain of judgements, so more of the difference is legitimate variation rather than divergence. The sample is smaller because campaign planning is rarer — and a threshold whose sample cannot be reached in a reasonable window is a gate that blocks forever. This number is a proposal.",
    status: "proposed",
  },
  {
    workflow: "repurpose",
    metric: "identical-write-rate",
    threshold: 0.8,
    minimumSample: 100,
    rationale:
      "Same reasoning as campaign planning: the output is derived from a source the runtimes may read differently, so exact write equality is a strong demand. What matters more for this workflow is provenance, which is a grader's question rather than a diff's. This number is a proposal.",
    status: "proposed",
  },
  {
    workflow: "engagement-reply",
    metric: "no-additional-approved-writes",
    threshold: 1.0,
    minimumSample: 200,
    rationale:
      "A reply is public and irreversible, so it inherits publish's zero-tolerance rather than a rate. Split from the engagement read path because they fail differently: reading the wrong comments is a quality problem, sending an extra reply is not.",
    status: "proposed",
  },
  {
    workflow: "analytics",
    metric: "unmeasurable-by-shadow",
    rationale:
      "Every analytics capability is a read (#125), so the workflow performs no external write and shadow mode has nothing to compare. A write-based gate would pass vacuously on every run — a green tick nobody earned, which is worse than no gate. Declared unmeasurable rather than given a threshold it would always meet.",
    status: "proposed",
    needsInstead:
      "A comparison of the two runtimes' replies against the same stored metrics: same numbers, and no causal claim presented as measured. That is a grader (#141), not a write diff.",
  },
  {
    workflow: "engagement-read",
    metric: "unmeasurable-by-shadow",
    rationale:
      "Same as analytics: reading the inbox writes nothing. Listed separately from engagement-reply so the reply path's zero-tolerance gate is not weakened by being averaged with a read path that cannot be measured at all.",
    status: "proposed",
    needsInstead: "A grader comparing which comments each runtime surfaced and what it said about coverage.",
  },
];

/** Look a gate up by workflow. */
export const gateFor = (workflow: string): ParityGate | undefined =>
  PARITY_GATES.find((g) => g.workflow === workflow);

/** Workflows whose parity shadow mode can actually decide. */
export const measurableWorkflows = (): readonly string[] =>
  PARITY_GATES.filter((g) => g.metric !== "unmeasurable-by-shadow").map((g) => g.workflow);
