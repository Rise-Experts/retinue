/**
 * The failure-injection matrix — AC-3, AC-5.
 *
 * Declared as **data** rather than as a list of test functions, for three reasons that all reduce to the same
 * one: a failure mode that is not in a machine-readable list is a failure mode whose runbook can go missing
 * without anything noticing.
 *
 * - A test asserts that every mode here has a runbook, so a new injector cannot ship undocumented (AC-5).
 * - Each mode carries what recovery *means* for it, so "recovered" is not a judgement call made per run.
 * - `requiresInfrastructure` marks the ones that need something this package cannot start, which is how the
 *   honest gap stays visible instead of becoming a quietly skipped case.
 */

export const FAILURE_MODES = [
  "provider-timeout",
  "provider-rate-limit",
  "redis-unavailable",
  "database-unavailable",
  "database-failover",
  "worker-kill",
  "slow-consumer",
  "overload",
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

export type RecoveryExpectation = {
  /** Work must reach a terminal state, eventually, without a human touching it. */
  readonly recoversUnattended: boolean;
  /**
   * No lost work: every admitted run reaches a terminal state.
   *
   * `false` only where losing work is the *correct* behaviour, which is nowhere in this list — a refused
   * admission is not admitted work.
   */
  readonly noDataLoss: boolean;
  /**
   * No duplicated external action.
   *
   * The assertion that actually matters, and the one a load test is uniquely able to make: a retry after a
   * worker kill must not publish the post twice. Measured by counting effects against distinct idempotency
   * keys, not by inspecting logs.
   */
  readonly noDuplicateExternalAction: boolean;
  /** What the operator sees while it is happening. Goes straight into the runbook. */
  readonly observableSymptom: string;
  /** The mechanism that does the recovering, named so a runbook can point at it. */
  readonly mechanism: string;
};

export type FailureModeSpec = {
  readonly mode: FailureMode;
  readonly description: string;
  readonly expect: RecoveryExpectation;
  /**
   * Whether the injector needs infrastructure this package cannot create.
   *
   * `true` for the modes that need a container stopped or a cluster failed over. Named rather than skipped: a
   * case that quietly does not run reports as covered, which is exactly how #20 closed green against "passes the
   * full conformance suite".
   */
  readonly requiresInfrastructure: boolean;
};

export const FAILURE_MATRIX: Readonly<Record<FailureMode, FailureModeSpec>> = {
  "provider-timeout": {
    mode: "provider-timeout",
    description: "The model provider accepts the request and never answers.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "model latency p99 climbs to the timeout; retries-total rises; run duration follows",
      mechanism: "runWithRetry with a bounded attempt count, then the run fails with a typed error",
    },
    requiresInfrastructure: false,
  },
  "provider-rate-limit": {
    mode: "provider-rate-limit",
    description: "The provider returns 429 for a sustained period.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "retries-total rises with reason=rate-limited; throughput drops; error rate stays low",
      mechanism: "retry with backoff; the run reports retry-pending so a client can show 'attempt 2 of 5'",
    },
    requiresInfrastructure: false,
  },
  "redis-unavailable": {
    mode: "redis-unavailable",
    description: "The queue's Redis is stopped mid-run and restarted.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "enqueue fails fast with a typed unavailable error; queue depth unreadable; in-flight runs continue",
      mechanism:
        "enableOfflineQueue:false so an enqueue rejects rather than hanging; the lease reaper re-enqueues once the queue returns",
    },
    requiresInfrastructure: true,
  },
  "database-unavailable": {
    mode: "database-unavailable",
    description: "Postgres is stopped briefly while runs are in flight.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "runs fail with a typed unavailable error; claims stop; the reaper finds expired leases on return",
      mechanism: "the atomic lease claim and the checkpoint, so a run resumes from its last committed step",
    },
    requiresInfrastructure: true,
  },
  "database-failover": {
    mode: "database-failover",
    description: "The primary is promoted away under load.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "a burst of connection errors, then recovery; some runs resume from a checkpoint",
      mechanism: "checkpoint-per-step plus the compare-and-set claim; a half-applied step is never observable",
    },
    requiresInfrastructure: true,
  },
  "worker-kill": {
    mode: "worker-kill",
    description: "A worker is killed without draining, mid-run, holding a lease.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "the run sits until its lease expires, then is claimed by another worker and resumes",
      mechanism: "lease expiry plus the reaper's re-enqueue; the checkpoint prevents re-running a completed tool",
    },
    requiresInfrastructure: false,
  },
  "slow-consumer": {
    mode: "slow-consumer",
    description: "A streaming subscriber reads far slower than events are produced.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "the subscriber falls behind and resumes from its sequence; producer memory stays flat",
      mechanism: "the durable event log and sequence-based catch-up, so a slow reader never holds a producer buffer",
    },
    requiresInfrastructure: false,
  },
  overload: {
    mode: "overload",
    description: "Offered load is driven well past sustainable capacity.",
    expect: {
      recoversUnattended: true,
      noDataLoss: true,
      noDuplicateExternalAction: true,
      observableSymptom: "queue depth rises to its bound; admissions are refused with a typed error; RSS stays flat",
      mechanism: "quota admission before anything is claimed or enqueued, so a refusal holds no slot and no job",
    },
    requiresInfrastructure: false,
  },
};

/** The modes this package can inject on its own. The rest need a container or a cluster. */
export const SELF_CONTAINED_MODES: readonly FailureMode[] = FAILURE_MODES.filter(
  (mode) => !FAILURE_MATRIX[mode].requiresInfrastructure,
);

export type InjectionResult = {
  readonly mode: FailureMode;
  readonly injected: boolean;
  /** Every admitted run reached a terminal state. */
  readonly admitted: number;
  readonly terminal: number;
  /** External effects performed, and the distinct idempotency keys they were performed under. */
  readonly externalEffects: number;
  readonly distinctEffectKeys: number;
  readonly recoveredMs: number;
  /**
   * How many runs a human had to touch.
   *
   * Non-zero means recovery was **not** unattended, whatever else went right. Added because the
   * database-unavailable injection passed with a green tick while every one of its forty runs had been re-driven
   * by the harness itself — no work was lost and nothing was duplicated, both true, and "recovers unattended"
   * was not demonstrated at all. A verdict that cannot tell those apart is the kind of green tick this whole
   * exercise exists to stop.
   */
  readonly manualInterventions: number;
  readonly notes: readonly string[];
};

export type InjectionVerdict = {
  readonly mode: FailureMode;
  readonly passed: boolean;
  readonly failures: readonly string[];
};

/**
 * Judge a result against the mode's declared expectation.
 *
 * Separate from running it, so the judgement is testable against a *fabricated* result — including the results
 * that must fail. A verdict function only ever exercised by passing runs is one that might return "passed" for
 * everything, and nothing would reveal that.
 */
export const judgeInjection = (result: InjectionResult): InjectionVerdict => {
  const expect = FAILURE_MATRIX[result.mode].expect;
  const failures: string[] = [];

  if (!result.injected) failures.push("the failure was never actually injected, so nothing was tested");
  if (expect.noDataLoss && result.terminal < result.admitted)
    failures.push(`lost work: ${result.admitted} admitted, ${result.terminal} reached a terminal state`);
  // Strictly greater. Equality is the requirement; fewer effects than keys is fine — a run that was refused
  // before its side effect performed none, which is not a duplicate.
  if (expect.noDuplicateExternalAction && result.externalEffects > result.distinctEffectKeys)
    failures.push(
      `duplicated external action: ${result.externalEffects} effects for ${result.distinctEffectKeys} distinct keys`,
    );
  if (expect.recoversUnattended && result.recoveredMs < 0) failures.push("never recovered");
  if (expect.recoversUnattended && result.manualInterventions > 0)
    failures.push(
      `recovery was not unattended: ${result.manualInterventions} run(s) needed a manual re-drive`,
    );

  return { mode: result.mode, passed: failures.length === 0, failures };
};
