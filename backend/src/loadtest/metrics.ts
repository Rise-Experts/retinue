/**
 * Measurement for the load and soak harness — REQ-033 (#144).
 *
 * Pure functions, so the *conclusions* the harness draws are testable without running a load test. A leak
 * detector that has only ever been exercised by the run it is judging is a detector nobody can trust: it will
 * say "no leak" and there is no way to know whether it would ever say anything else.
 *
 * Everything here is deliberately conservative in one direction — it would rather report a problem that is not
 * there than miss one. A load test that flatters the system is worse than no load test, because it converts an
 * unknown into a false belief.
 */

/**
 * A latency summary.
 *
 * Percentiles, and `max`, and **no mean**. A mean latency is the number that hides the problem: a p99 of eight
 * seconds behind a mean of 200ms is the normal shape of a system that is failing for one user in a hundred, and
 * the mean says everything is fine. `count` travels with them because a p99 over 40 samples is four data points
 * and should not be quoted as though it were a property of the system.
 */
export type LatencySummary = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

/**
 * Nearest-rank percentile on a sorted copy.
 *
 * Nearest-rank rather than interpolated, because an interpolated p99 reports a latency **nobody experienced**.
 * For a capacity envelope the honest question is "what did the slowest one percent actually see", and that has
 * to be a real observation.
 */
export const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
};

export const summarizeLatency = (samples: readonly number[]): LatencySummary => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? Number.NaN : (sorted[sorted.length - 1] as number),
  };
};

export type ThroughputSummary = {
  readonly completed: number;
  readonly failed: number;
  readonly refused: number;
  readonly durationMs: number;
  /** Completions per second. The number an operator sizes a deployment on. */
  readonly completedPerSecond: number;
  /**
   * Failures as a fraction of *attempts*, with refusals excluded from the numerator.
   *
   * A refusal is the system working: it is the honest "no" that AC-4 asks for. Counting refusals as errors would
   * make a correctly back-pressuring system look broken exactly when it is behaving best, and the natural
   * response to that graph is to remove the backpressure.
   */
  readonly errorRate: number;
  /** Refusals as a fraction of attempts. Separate, because it means something different. */
  readonly refusalRate: number;
};

export const summarizeThroughput = (input: {
  readonly completed: number;
  readonly failed: number;
  readonly refused: number;
  readonly durationMs: number;
}): ThroughputSummary => {
  const attempts = input.completed + input.failed + input.refused;
  const seconds = input.durationMs / 1_000;
  return {
    completed: input.completed,
    failed: input.failed,
    refused: input.refused,
    durationMs: input.durationMs,
    completedPerSecond: seconds > 0 ? input.completed / seconds : 0,
    errorRate: attempts > 0 ? input.failed / attempts : 0,
    refusalRate: attempts > 0 ? input.refused / attempts : 0,
  };
};

/** One resource observation. Sampled on a timer during a run. */
export type ResourceSample = {
  readonly atMs: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  /** Server-side connection count, when the harness can see it. Connection exhaustion is a real soak failure. */
  readonly dbConnections?: number;
  /** Jobs waiting. The other half of "bounded queueing". */
  readonly queueDepth?: number;
};

export type GrowthVerdict = {
  /** Bytes per hour, from a least-squares fit over the samples. */
  readonly bytesPerHour: number;
  readonly firstQuartileMean: number;
  readonly lastQuartileMean: number;
  readonly samples: number;
  readonly observedMs: number;
  readonly leaking: boolean;
  /**
   * Why the verdict is what it is — including "the run was too short to tell".
   *
   * The important arm. A short run producing "no leak" is the single most misleading output this harness could
   * have, because it looks exactly like a passing result. AC-2 asks for a multi-hour soak precisely because a
   * short burst hides slow growth, so anything shorter must say so rather than reporting a clean bill of health.
   */
  readonly reason: "leaking" | "stable" | "insufficient-samples" | "insufficient-duration";
};

/**
 * The threshold: 32 MiB per hour.
 *
 * Chosen to be well above JIT warm-up, heap fragmentation and a pool filling to its configured size, and well
 * below anything that survives a night. A process leaking at this rate grows by 768 MiB a day, which is an
 * incident; one growing at a tenth of it is noise a stricter threshold would report every run, and a detector
 * that cries wolf is one people stop reading.
 */
export const LEAK_BYTES_PER_HOUR = 32 * 1024 * 1024;

/** Below this, a fit is fitting noise. */
export const MIN_GROWTH_SAMPLES = 12;
/** Below this, growth is indistinguishable from warm-up whatever the fit says. */
export const MIN_GROWTH_DURATION_MS = 5 * 60 * 1_000;

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * The share of a run treated as warm-up and excluded from the fit.
 *
 * Every real process ramps at the start: the JIT compiles, connection pools fill to their configured size, caches
 * populate. That ramp is not a leak, and it is steep — steeper than any leak worth catching — so a fit including
 * it reports a leak on **every single run**.
 *
 * A quarter. Enough to clear the ramp on runs of any length, and it still leaves three quarters of the samples to
 * fit, which is where a leak would show anyway: a leak that only exists during warm-up is a warm-up.
 */
export const WARMUP_FRACTION = 0.25;

/**
 * Least-squares slope of RSS against time, after discarding warm-up, plus a quartile comparison.
 *
 * Both, because each catches what the other misses. A fit is robust to a single spike; a quartile comparison is
 * robust to a ramp but fooled by one outlier. A verdict of "leaking" needs *both*.
 *
 * The warm-up exclusion was not in the first version, and the test for it failed: a 20-second ramp to 500 MiB
 * followed by a flat hour fit at ~420 MiB/h and was reported as a leak. My own comment claimed the quartile check
 * handled it, and it did not — the first quartile *was* the ramp, so its mean was low and the comparison agreed
 * with the fit. Two checks that share a blind spot are one check.
 */
export const detectGrowth = (samples: readonly ResourceSample[]): GrowthVerdict => {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const observedMs = first !== undefined && last !== undefined ? last.atMs - first.atMs : 0;

  // Both the fit and the comparison run on the post-warm-up window, so they cannot share the ramp as a blind spot.
  const warmup = Math.floor(samples.length * WARMUP_FRACTION);
  const steady = samples.slice(warmup);
  const quartile = Math.max(1, Math.floor(steady.length / 4));
  const firstQuartileMean = mean(steady.slice(0, quartile).map((s) => s.rssBytes));
  const lastQuartileMean = mean(steady.slice(-quartile).map((s) => s.rssBytes));

  if (samples.length < MIN_GROWTH_SAMPLES)
    return { bytesPerHour: Number.NaN, firstQuartileMean, lastQuartileMean, samples: samples.length, observedMs, leaking: false, reason: "insufficient-samples" };
  if (observedMs < MIN_GROWTH_DURATION_MS)
    return { bytesPerHour: Number.NaN, firstQuartileMean, lastQuartileMean, samples: samples.length, observedMs, leaking: false, reason: "insufficient-duration" };

  const t0 = steady[0]?.atMs ?? 0;
  const xs = steady.map((s) => (s.atMs - t0) / 3_600_000);
  const ys = steady.map((s) => s.rssBytes);
  const xBar = mean(xs);
  const yBar = mean(ys);
  let num = 0;
  let den = 0;
  for (const [i, x] of xs.entries()) {
    num += (x - xBar) * ((ys[i] as number) - yBar);
    den += (x - xBar) ** 2;
  }
  const bytesPerHour = den === 0 ? 0 : num / den;
  const leaking = bytesPerHour > LEAK_BYTES_PER_HOUR && lastQuartileMean > firstQuartileMean;

  return {
    bytesPerHour,
    firstQuartileMean,
    lastQuartileMean,
    samples: samples.length,
    observedMs,
    leaking,
    reason: leaking ? "leaking" : "stable",
  };
};

/**
 * Where behaviour degrades, and how — AC-1.
 *
 * The criterion asks for the *manner* as well as the point, so this is a union rather than a number. "Throughput
 * peaked at 40/s" tells an operator nothing about whether the next request queues or fails, and those need
 * completely different responses.
 */
export type DegradationMode =
  /** Latency rose, everything still completed. The good failure: work is queueing. */
  | "graceful-queueing"
  /** The system said no, on purpose. Also good — capacity was reached and it was honest about it. */
  | "honest-refusal"
  /** Requests started failing. The bad one. */
  | "errors"
  /**
   * Work was accepted faster than it was finished.
   *
   * Distinct from `graceful-queueing`, which is a latency rise with completions keeping up. This is a *backlog*:
   * the system is accepting more than it can serve, and the queue is absorbing the difference. Graceful only for
   * as long as the queue has room.
   */
  | "backlog"
  /** Nothing degraded within the range driven; the envelope's upper bound was not found. */
  | "not-reached";

export type LoadStep = {
  /** Offered load, in run admissions attempted per second. */
  readonly offeredPerSecond: number;
  readonly latency: LatencySummary;
  readonly throughput: ThroughputSummary;
  readonly peakRssBytes: number;
  readonly peakQueueDepth: number;
  /** Distinct reasons admissions were rejected, capped. A count with no reason costs a reproduction. */
  readonly admitFailures?: readonly string[];
  /** Runs that never reached a terminal state before the settle timeout. Apart from `failed` on purpose. */
  readonly stuck?: number;
  /** Which non-terminal statuses they were in. A count alone does not say what to investigate. */
  readonly stuckByStatus?: Readonly<Record<string, number>>;
};

export type Envelope = {
  readonly steps: readonly LoadStep[];
  /** The highest step that stayed inside the latency and error budget. */
  readonly sustainablePerSecond: number;
  readonly degradesAt: number | null;
  readonly mode: DegradationMode;
  readonly budget: LoadBudget;
};

export type LoadBudget = {
  /** The p99 an operator would accept. Above it, the step is outside the envelope however much completed. */
  readonly p99Ms: number;
  /** The error rate an operator would accept. Refusals are not errors. */
  readonly errorRate: number;
  /**
   * How far completions may fall short of offered load before the step is not sustained.
   *
   * The check latency alone does not make. A step can post an excellent p99 while completing a third of what was
   * offered, because the work that never got picked up contributes no latency sample at all — the fast runs are
   * measured and the queued ones are invisible. My first version of this had exactly that hole and reported
   * "sustainable 20/s, p99 5ms" for a step whose queue reached 101 jobs and whose real throughput was 6.9/s.
   *
   * 0.9: completions must be within ten percent of offered load. Not 1.0, because the drain window makes the
   * ratio slightly noisy at low rates and a knife-edge threshold would make the envelope flap.
   */
  readonly minCompletionRatio: number;
};

export const DEFAULT_LOAD_BUDGET: LoadBudget = { p99Ms: 5_000, errorRate: 0.01, minCompletionRatio: 0.9 };

/**
 * Read an envelope off a staircase of load steps.
 *
 * The first failing step is the one reported, not the worst: an operator needs the point at which behaviour
 * *starts* to go wrong, and later steps are already past it. And the mode is read from that step rather than
 * from the whole run, because a system that queues at 40/s and errors at 80/s degrades gracefully — the abrupt
 * behaviour further out is a different fact.
 */
export const readEnvelope = (steps: readonly LoadStep[], budget: LoadBudget = DEFAULT_LOAD_BUDGET): Envelope => {
  let sustainable = 0;
  for (const step of steps) {
    const withinLatency = step.latency.count > 0 && step.latency.p99 <= budget.p99Ms;
    const withinErrors = step.throughput.errorRate <= budget.errorRate;
    // A step with refusals is *not* sustainable: capacity was reached, and calling it sustainable would tell an
    // operator to size for a load at which some users are being turned away.
    const noRefusals = step.throughput.refused === 0;
    // And completions must keep up with the offer. Without this, a step that accepted 160/s and finished 55/s
    // reports a fine p99 — because the runs that never got picked up contribute no sample — and the envelope
    // recommends a capacity the system does not have.
    const keepingUp =
      step.offeredPerSecond === 0 ||
      step.throughput.completedPerSecond / step.offeredPerSecond >= budget.minCompletionRatio;

    if (withinLatency && withinErrors && noRefusals && keepingUp) sustainable = step.offeredPerSecond;
    else
      return {
        steps,
        sustainablePerSecond: sustainable,
        degradesAt: step.offeredPerSecond,
        // Ordered by severity, so the reported mode is the worst thing happening at the first failing step.
        // Errors first: a step that both errors and backlogs is an erroring step, and reporting the backlog would
        // point an operator at capacity when the problem is failure.
        mode: !withinErrors ? "errors" : !noRefusals ? "honest-refusal" : !keepingUp ? "backlog" : "graceful-queueing",
        budget,
      };
  }
  return { steps, sustainablePerSecond: sustainable, degradesAt: null, mode: "not-reached", budget };
};
