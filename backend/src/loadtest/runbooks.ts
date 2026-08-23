/**
 * The runbooks — AC-5: "runbooks exist for every failure mode observed in testing".
 *
 * Kept as data next to the failure matrix, so a test can assert the two agree. A runbook in a wiki is a runbook
 * that drifts from the code silently, and the drift is discovered during the incident it was written for.
 *
 * Each one is written for someone woken at 3am: what they will see, what to check first, what to do, and — the
 * part usually missing — **what not to do**. Most of the damage in an incident comes from a well-intentioned
 * action that fights the recovery mechanism, and "do not restart the workers, the reaper is already handling it"
 * is the sentence that saves the night.
 */

import { FAILURE_MODES, type FailureMode } from "./injection.js";

export type Runbook = {
  readonly mode: FailureMode;
  /** What an operator sees on a dashboard, in the order they will see it. */
  readonly symptoms: readonly string[];
  /** Which metric or log confirms it is this and not something that looks like it. */
  readonly confirm: readonly string[];
  readonly action: readonly string[];
  /** The tempting action that makes it worse. */
  readonly doNot: readonly string[];
  /** How long unattended recovery takes, so an operator knows whether to wait. */
  readonly expectedRecovery: string;
};

export const RUNBOOKS: Readonly<Record<FailureMode, Runbook>> = {
  "provider-timeout": {
    mode: "provider-timeout",
    symptoms: [
      "agentkit_model_latency_ms p99 pinned at the provider timeout",
      "agentkit_retries_total climbing",
      "agentkit_run_duration_ms following, with throughput falling",
    ],
    confirm: [
      "model.failed log lines with errorCode=timeout, not rate-limited — the two need different responses",
      "agentkit_model_calls_total{outcome=error} rising while tool metrics stay flat, which locates it at the provider",
    ],
    action: [
      "Nothing, first: retries are bounded and runs will fail cleanly rather than hang.",
      "If it persists beyond the provider's own status page, fail over the model configuration to a second provider.",
      "Runs that failed are safe to re-drive — the checkpoint means a resumed run does not repeat a completed tool call.",
    ],
    doNot: [
      "Do not raise the retry count to ride it out. Retries hold a worker slot, so more retries against a dead provider converts a provider outage into a queue backlog.",
      "Do not raise the provider timeout. A longer timeout holds the same slot for longer and reaches the same place more slowly.",
    ],
    expectedRecovery: "Immediate once the provider answers; in-flight runs fail after their retry budget and can be re-driven.",
  },
  "provider-rate-limit": {
    mode: "provider-rate-limit",
    symptoms: [
      "agentkit_retries_total with reason=rate-limited",
      "throughput drops while error rate stays near zero — the shape of working backoff",
    ],
    confirm: ["run.retry-scheduled log lines", "the provider's own quota dashboard"],
    action: [
      "Reduce worker concurrency. Fewer parallel calls means fewer rejections and, counter-intuitively, more completed work.",
      "If sustained, raise the provider quota or spread across provider accounts.",
    ],
    doNot: [
      "Do not add workers. More workers means more concurrent calls against the same quota, so throughput falls as the rejection rate rises.",
      "Do not disable the retry. A rate limit is the one failure that genuinely does resolve by waiting.",
    ],
    expectedRecovery: "Throughput returns as the provider's window rolls; no run is lost.",
  },
  "redis-unavailable": {
    mode: "redis-unavailable",
    symptoms: [
      "enqueue errors with code=unavailable, immediately rather than after a hang",
      "queue depth unreadable; no new claims",
      "runs already claimed continue to completion",
    ],
    confirm: [
      "run.enqueue-failed log lines with errorCode=unavailable",
      "in-flight runs still reaching terminal states, which distinguishes this from a database problem",
    ],
    action: [
      "Restore Redis. The reaper re-enqueues anything whose lease expired while it was down.",
      "Callers that received the typed error may retry; the job id is derived from tenant and run, so a repeat enqueue collapses into one job.",
    ],
    doNot: [
      "Do not re-drive runs by hand while Redis is down; there is nowhere for the job to go and the attempt fails.",
      "Do not clear the queue to 'start clean'. Those jobs are the record of admitted work.",
    ],
    expectedRecovery: "Claims resume immediately; expired leases are re-enqueued within one reap interval.",
  },
  "database-unavailable": {
    mode: "database-unavailable",
    symptoms: [
      "claims stop entirely; runs fail with code=unavailable",
      "queue depth rises because nothing can be claimed",
      "connection errors in the worker logs",
    ],
    confirm: ["run.failed with errorCode=unavailable across every worker at once, which is what separates this from one bad worker"],
    action: [
      "Restore the database. Runs resume from their last checkpoint, so a multi-step run does not restart from the beginning.",
      "Expect a burst of reaper activity as leases that expired during the outage are collected.",
    ],
    doNot: [
      "Do not truncate or reset anything to clear the errors. The run rows and checkpoints are what makes resumption possible.",
      "Do not restart workers repeatedly; a worker with no database cannot claim, and restarting only loses its in-memory state.",
    ],
    expectedRecovery: "Claims resume immediately; checkpointed runs continue from their last committed step.",
  },
  "database-failover": {
    mode: "database-failover",
    symptoms: ["a burst of connection errors, then recovery", "a spike in reaped runs shortly after"],
    confirm: ["the failover event in the database provider's own log, correlated with the error burst"],
    action: [
      "Wait. The compare-and-set claim and the per-step checkpoint mean a half-applied step is never observable, so recovery is automatic.",
      "Check that the connection pool reconnected — a pool holding dead connections looks exactly like a database still being down.",
    ],
    doNot: [
      "Do not re-drive runs during the failover window. They are still claimed until their leases expire, and a manual re-drive races the reaper.",
    ],
    expectedRecovery: "Seconds to the provider's failover time, plus one lease interval for runs that were mid-step.",
  },
  "worker-kill": {
    mode: "worker-kill",
    symptoms: [
      "one worker disappears; its runs sit in 'running' with no progress",
      "claim latency p99 rises by roughly one lease interval",
    ],
    confirm: ["run.reaped log lines naming the runs, one lease interval after the worker went", "the killed worker's workerId absent from recent run.claimed lines"],
    action: [
      "Nothing. The lease expires, the reaper re-enqueues, another worker resumes from the checkpoint.",
      "If the worker was killed by the OOM killer, reduce concurrency before bringing it back or it will be killed again.",
    ],
    doNot: [
      "Do not re-drive the runs by hand before the lease expires. The claim is still held, so the manual attempt is rejected — and if it were not, it would be the duplicate-external-action bug this platform is built to prevent.",
      "Do not shorten the lease to speed recovery. A lease shorter than a slow step causes a *live* worker to lose its claim mid-run, which is a much worse failure.",
    ],
    expectedRecovery: "One lease interval plus one reap interval.",
  },
  "slow-consumer": {
    mode: "slow-consumer",
    symptoms: ["a subscriber falling behind its run's event sequence", "no producer-side memory growth"],
    confirm: ["the subscriber's last acknowledged sequence lagging the run's current sequence"],
    action: [
      "Nothing on the platform side: the durable event log means a slow reader holds no producer buffer and resumes from its own sequence.",
      "Investigate the client. A consistently slow subscriber is usually rendering every event rather than batching.",
    ],
    doNot: [
      "Do not raise a buffer size to 'give it room'. A producer-side buffer is precisely what turns one slow client into the platform's memory problem.",
    ],
    expectedRecovery: "The subscriber catches up at its own pace; nothing is lost while it is behind.",
  },
  overload: {
    mode: "overload",
    symptoms: [
      "queue depth at its bound",
      "admissions refused with code=resource-exhausted",
      "RSS flat — which is the point",
    ],
    confirm: [
      "run.refused-quota or a resource-exhausted rate rising while error rate stays low",
      "flat memory alongside the refusals; memory growth instead means the bound is not being enforced",
    ],
    action: [
      "Add workers if the database can take the extra connections; otherwise raise capacity upstream.",
      "Refusals are the correct behaviour. Communicate them as capacity, not as errors.",
    ],
    doNot: [
      "Do not raise maxQueueDepth to stop the refusals. That converts an honest 'no' into an unbounded backlog, and the queue then fails by exhausting memory instead of by saying no.",
      "Do not disable admission checks to 'let the work through'. A refused run holds no slot and no job; an admitted one it cannot serve holds both.",
    ],
    expectedRecovery: "Immediate once offered load falls below capacity; the backlog drains at the sustainable rate.",
  },
};

/** Every mode has a runbook. Asserted, so a new injector cannot ship undocumented. */
export const modesWithoutRunbook = (): readonly FailureMode[] =>
  FAILURE_MODES.filter((mode) => RUNBOOKS[mode] === undefined);
