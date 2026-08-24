/**
 * The parity gates — #128 AC-1.
 *
 * ## Agreed, and when that matters
 *
 * AC-1's real content is the clause *"not decided after seeing the results"*. A threshold chosen once the
 * numbers are in is not a gate, it is a rationalisation.
 *
 * These were proposed by the implementation and **agreed on 2026-08-24 by Azeem Sarwar, before shadow mode had
 * ever run against production traffic**. There was no shadow data for them to be fitted to — which is the whole
 * value of the signature, and why agreeing them early was worth more than agreeing them carefully later. After
 * the first shadow run no threshold set here could carry the same claim.
 *
 * `evaluateParity` **refuses to pass a gate that is not agreed**, so the mechanism remains what makes AC-1
 * machine-checkable rather than aspirational: the cutover checklist cannot go green on numbers nobody signed. It
 * still refuses for anything added later, which is the case that now matters most.
 *
 * A revision after data exists must move `agreedAt` and say in the rationale what was seen. A silently edited
 * threshold is the exact failure this mechanism exists to prevent.
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
   * `proposed` until a person agrees it. `evaluateParity` will not pass a proposed gate — which is what keeps a
   * gate added after shadow data exists from passing on numbers fitted to it.
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
/**
 * Who agreed these, and when — #128 AC-1.
 *
 * The date is the part that carries the weight. AC-1's real content is *"not decided after seeing the results"*,
 * and these were agreed on 2026-08-24, **before shadow mode had ever run against production traffic** — there is
 * no shadow data in existence for these thresholds to have been fitted to. That is what makes the signature
 * meaningful rather than ceremonial, and it is why agreeing them was worth doing now rather than later: after
 * the first shadow run, no threshold set here could carry the same claim.
 *
 * A gate whose numbers are revised after data exists must say so — change the date, and say in the rationale
 * what was seen. A silently edited threshold is the failure this whole mechanism exists to prevent.
 */
const AGREED_BY = "Azeem Sarwar";
const AGREED_AT = "2026-08-24";

export const PARITY_GATES: readonly ParityGate[] = [
  {
    workflow: "create-post",
    metric: "identical-write-rate",
    threshold: 0.9,
    minimumSample: 200,
    rationale:
      "Not 1.0, deliberately: a drafted post is reviewed by a human before it goes anywhere, and the new runtime writing a different — possibly better — caption is not a regression. What 0.9 asserts is that it is not writing something *structurally* different most of the time. The sample is 200 because a create-post run is cheap and common, so a large sample costs little. This number is a proposal.",
    status: "agreed",
    agreedBy: AGREED_BY,
    agreedAt: AGREED_AT,
  },
  {
    workflow: "publish",
    metric: "no-additional-approved-writes",
    threshold: 1.0,
    minimumSample: 500,
    rationale:
      "1.0 is transcribed, not chosen: REQ-021 states the criterion as 'zero unauthorized or duplicate actions'. A single run where the new runtime would publish more than the old one did is a failure of the whole migration, so there is no proportion to trade. The sample is larger than create-post's because the failure is irreversible and rare failures are the ones that matter here.",
    status: "agreed",
    agreedBy: AGREED_BY,
    agreedAt: AGREED_AT,
  },
  {
    workflow: "campaign-planning",
    metric: "identical-write-rate",
    threshold: 0.8,
    minimumSample: 100,
    rationale:
      "Lower than create-post because a campaign plan is a longer chain of judgements, so more of the difference is legitimate variation rather than divergence. The sample is smaller because campaign planning is rarer — and a threshold whose sample cannot be reached in a reasonable window is a gate that blocks forever. This number is a proposal.",
    status: "agreed",
    agreedBy: AGREED_BY,
    agreedAt: AGREED_AT,
  },
  {
    workflow: "repurpose",
    metric: "identical-write-rate",
    threshold: 0.8,
    minimumSample: 100,
    rationale:
      "Same reasoning as campaign planning: the output is derived from a source the runtimes may read differently, so exact write equality is a strong demand. What matters more for this workflow is provenance, which is a grader's question rather than a diff's. This number is a proposal.",
    status: "agreed",
    agreedBy: AGREED_BY,
    agreedAt: AGREED_AT,
  },
  {
    workflow: "engagement-reply",
    metric: "no-additional-approved-writes",
    threshold: 1.0,
    minimumSample: 200,
    rationale:
      "A reply is public and irreversible, so it inherits publish's zero-tolerance rather than a rate. Split from the engagement read path because they fail differently: reading the wrong comments is a quality problem, sending an extra reply is not.",
    status: "agreed",
    agreedBy: AGREED_BY,
    agreedAt: AGREED_AT,
  },
  {
    workflow: "analytics",
    metric: "unmeasurable-by-shadow",
    rationale:
      "Every analytics capability is a read (#125), so the workflow performs no external write and shadow mode has nothing to compare. A write-based gate would pass vacuously on every run — a green tick nobody earned, which is worse than no gate. Declared unmeasurable rather than given a threshold it would always meet.",
    status: "agreed",
    agreedBy: AGREED_BY,
    agreedAt: AGREED_AT,
    needsInstead:
      "A comparison of the two runtimes' replies against the same stored metrics: same numbers, and no causal claim presented as measured. That is a grader (#141), not a write diff.",
  },
  {
    workflow: "engagement-read",
    metric: "unmeasurable-by-shadow",
    rationale:
      "Same as analytics: reading the inbox writes nothing. Listed separately from engagement-reply so the reply path's zero-tolerance gate is not weakened by being averaged with a read path that cannot be measured at all.",
    status: "agreed",
    agreedBy: AGREED_BY,
    agreedAt: AGREED_AT,
    needsInstead: "A grader comparing which comments each runtime surfaced and what it said about coverage.",
  },
];

/** Look a gate up by workflow. */
export const gateFor = (workflow: string): ParityGate | undefined =>
  PARITY_GATES.find((g) => g.workflow === workflow);

/** Workflows whose parity shadow mode can actually decide. */
export const measurableWorkflows = (): readonly string[] =>
  PARITY_GATES.filter((g) => g.metric !== "unmeasurable-by-shadow").map((g) => g.workflow);
