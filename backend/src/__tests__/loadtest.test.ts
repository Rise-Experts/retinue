import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOAD_BUDGET,
  DEFAULT_TRAFFIC,
  FAILURE_MATRIX,
  FAILURE_MODES,
  LEAK_BYTES_PER_HOUR,
  MIN_GROWTH_DURATION_MS,
  MIN_GROWTH_SAMPLES,
  RUNBOOKS,
  SELF_CONTAINED_MODES,
  createBoundedQueue,
  createEffectLedger,
  createSyntheticEngine,
  detectGrowth,
  judgeInjection,
  modesWithoutRunbook,
  percentile,
  readEnvelope,
  runFate,
  seededRandom,
  summarizeLatency,
  summarizeThroughput,
  type InjectionResult,
  type LoadStep,
  type ResourceSample,
} from "../loadtest/index.js";
import { asId } from "../core/ids.js";
import type { RunId, TenantId } from "../core/ids.js";

/**
 * The load harness's *conclusions* — #144.
 *
 * Everything here is against the pure layer, which is the whole reason there is one. A leak detector that has
 * only ever been exercised by the run it is judging is a detector nobody can trust: it says "no leak" and there
 * is no way to know it would ever say anything else. Same for the envelope reader and the injection verdicts.
 */

const step = (over: Partial<LoadStep> & { offeredPerSecond: number }): LoadStep => ({
  latency: summarizeLatency([100, 110, 120]),
  throughput: summarizeThroughput({ completed: over.offeredPerSecond, failed: 0, refused: 0, durationMs: 1_000 }),
  peakRssBytes: 100 * 1024 * 1024,
  peakQueueDepth: 0,
  ...over,
});

describe("latency summary", () => {
  it("uses nearest-rank, so a reported p99 is a latency someone actually saw", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    // Interpolation would report a number nobody experienced. For a capacity envelope the honest question is
    // "what did the slowest one percent actually see", and that has to be a real observation.
    expect(percentile(samples, 0.99)).toBe(99);
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 1)).toBe(100);
  });

  it("reports the sample count alongside the percentiles", () => {
    // A p99 over 40 samples is four data points. Quoting it as a property of the system is how a load test
    // becomes folklore, so the count travels with it.
    expect(summarizeLatency([1, 2, 3]).count).toBe(3);
  });

  it("survives an empty sample set without inventing a number", () => {
    const summary = summarizeLatency([]);
    expect(Number.isNaN(summary.p99)).toBe(true);
    expect(summary.count).toBe(0);
  });
});

describe("throughput summary", () => {
  it("keeps refusals out of the error rate", () => {
    const summary = summarizeThroughput({ completed: 90, failed: 0, refused: 10, durationMs: 1_000 });
    // A refusal is the system working — the honest "no" AC-4 asks for. Counting refusals as errors makes a
    // correctly back-pressuring system look broken exactly when it is behaving best, and the natural response to
    // that graph is to remove the backpressure.
    expect(summary.errorRate).toBe(0);
    expect(summary.refusalRate).toBe(0.1);
  });

  it("counts failures against attempts, not against completions", () => {
    const summary = summarizeThroughput({ completed: 50, failed: 50, refused: 0, durationMs: 1_000 });
    expect(summary.errorRate).toBe(0.5);
  });
});

describe("the envelope — AC-1", () => {
  it("reports the first failing step, not the worst", () => {
    const steps = [
      step({ offeredPerSecond: 10 }),
      step({ offeredPerSecond: 20, latency: summarizeLatency([9_000]) }),
      step({ offeredPerSecond: 40, throughput: summarizeThroughput({ completed: 0, failed: 40, refused: 0, durationMs: 1_000 }) }),
    ];
    const envelope = readEnvelope(steps);
    // An operator needs the point at which behaviour *starts* to go wrong; later steps are already past it.
    expect(envelope.sustainablePerSecond).toBe(10);
    expect(envelope.degradesAt).toBe(20);
    expect(envelope.mode).toBe("graceful-queueing");
  });

  /**
   * The hole my first version had, and the reason this test exists.
   *
   * A step can post an excellent p99 while completing a fraction of what was offered, because the work that
   * never got picked up contributes no latency sample at all — the fast runs are measured and the queued ones
   * are invisible. My staircase reported "sustainable 20/s, p99 5ms" for a step whose queue reached 101 jobs and
   * whose real throughput was 6.9/s.
   */
  it("refuses to call a step sustainable when completions fall behind the offer", () => {
    const envelope = readEnvelope([
      step({
        offeredPerSecond: 20,
        latency: summarizeLatency([100, 110]),
        throughput: summarizeThroughput({ completed: 7, failed: 0, refused: 0, durationMs: 1_000 }),
      }),
    ]);
    expect(envelope.sustainablePerSecond).toBe(0);
    expect(envelope.mode).toBe("backlog");
  });

  it("calls refusal what it is, and does not call it sustainable", () => {
    const envelope = readEnvelope([
      step({ offeredPerSecond: 10 }),
      step({
        offeredPerSecond: 20,
        throughput: summarizeThroughput({ completed: 20, failed: 0, refused: 5, durationMs: 1_000 }),
      }),
    ]);
    // Capacity was reached. Calling it sustainable would tell an operator to size for a load at which some users
    // are being turned away.
    expect(envelope.mode).toBe("honest-refusal");
    expect(envelope.sustainablePerSecond).toBe(10);
  });

  it("reports errors ahead of a backlog when a step is doing both", () => {
    const envelope = readEnvelope([
      step({
        offeredPerSecond: 20,
        throughput: summarizeThroughput({ completed: 2, failed: 10, refused: 0, durationMs: 1_000 }),
      }),
    ]);
    // Ordered by severity: a step that both errors and backlogs is an erroring step, and reporting the backlog
    // would point an operator at capacity when the problem is failure.
    expect(envelope.mode).toBe("errors");
  });

  it("says so when the range driven never found a limit", () => {
    const envelope = readEnvelope([step({ offeredPerSecond: 10 }), step({ offeredPerSecond: 20 })]);
    // "not-reached" rather than reporting the top step as the capacity. The upper bound was not found, and
    // claiming one would be claiming a measurement that was not made.
    expect(envelope.mode).toBe("not-reached");
    expect(envelope.degradesAt).toBeNull();
    expect(envelope.sustainablePerSecond).toBe(20);
  });

  it("carries the budget it judged against", () => {
    // Same reason the release gate stores its thresholds: without it, "capacity improved" and "we relaxed the
    // budget" produce identical reports.
    expect(readEnvelope([step({ offeredPerSecond: 5 })]).budget).toEqual(DEFAULT_LOAD_BUDGET);
  });
});

describe("growth detection — AC-2", () => {
  const series = (input: { count: number; spanMs: number; startBytes: number; endBytes: number }): ResourceSample[] =>
    Array.from({ length: input.count }, (_, i) => ({
      atMs: (i * input.spanMs) / (input.count - 1),
      rssBytes: input.startBytes + ((input.endBytes - input.startBytes) * i) / (input.count - 1),
      heapUsedBytes: 0,
    }));

  it("detects a clear leak", () => {
    const hour = 3_600_000;
    const verdict = detectGrowth(series({ count: 60, spanMs: hour, startBytes: 100e6, endBytes: 400e6 }));
    expect(verdict.leaking).toBe(true);
    expect(verdict.reason).toBe("leaking");
    expect(verdict.bytesPerHour).toBeGreaterThan(LEAK_BYTES_PER_HOUR);
  });

  it("calls a flat series stable", () => {
    const verdict = detectGrowth(series({ count: 60, spanMs: 3_600_000, startBytes: 200e6, endBytes: 201e6 }));
    expect(verdict.leaking).toBe(false);
    expect(verdict.reason).toBe("stable");
  });

  /**
   * The arm that matters most.
   *
   * A short run producing "no leak" is the single most misleading output this harness could have, because it
   * looks exactly like a passing result. AC-2 asks for a multi-hour soak *because* a short burst hides slow
   * growth, so anything shorter must say so rather than report a clean bill of health.
   */
  it("refuses to conclude anything from too few samples", () => {
    const verdict = detectGrowth(series({ count: MIN_GROWTH_SAMPLES - 1, spanMs: 3_600_000, startBytes: 100e6, endBytes: 900e6 }));
    expect(verdict.reason).toBe("insufficient-samples");
    // Not `leaking: true` either — it does not know. The reason is the answer.
    expect(verdict.leaking).toBe(false);
  });

  it("refuses to conclude anything from too short a run", () => {
    const verdict = detectGrowth(series({ count: 60, spanMs: MIN_GROWTH_DURATION_MS - 1, startBytes: 100e6, endBytes: 900e6 }));
    expect(verdict.reason).toBe("insufficient-duration");
  });

  it("is not fooled by a warm-up ramp that then plateaus", () => {
    // Every real run does this: the JIT warms, pools fill, caches populate. This test *failed* on my first
    // version — a 20-second ramp followed by a flat hour fit at ~420 MiB/h and was reported as a leak. The
    // comment claimed the quartile check handled it and it did not, because the first quartile *was* the ramp.
    // Two checks that share a blind spot are one check.
    const hour = 3_600_000;
    const ramp = Array.from({ length: 20 }, (_, i) => ({ atMs: i * 1_000, rssBytes: 100e6 + i * 20e6, heapUsedBytes: 0 }));
    const plateau = Array.from({ length: 60 }, (_, i) => ({ atMs: 20_000 + i * (hour / 60), rssBytes: 500e6, heapUsedBytes: 0 }));
    const verdict = detectGrowth([...ramp, ...plateau]);
    expect(verdict.leaking, `fit was ${(verdict.bytesPerHour / 1024 / 1024).toFixed(1)} MiB/h`).toBe(false);
  });

  it("still catches a leak that begins after the warm-up window", () => {
    // The other side of excluding warm-up: discarding the first quarter must not discard the leak. A detector
    // that only looked at a steady window and *also* ignored growth inside it would be blind by construction.
    const hour = 3_600_000;
    const ramp = Array.from({ length: 20 }, (_, i) => ({ atMs: i * 1_000, rssBytes: 100e6 + i * 5e6, heapUsedBytes: 0 }));
    const leak = Array.from({ length: 60 }, (_, i) => ({ atMs: 20_000 + i * (hour / 60), rssBytes: 200e6 + i * 5e6, heapUsedBytes: 0 }));
    expect(detectGrowth([...ramp, ...leak]).leaking).toBe(true);
  });

  /**
   * A mid-run spike that drags the fit but leaves the quartiles equal.
   *
   * This is what the second check is *for*, and I could not find the case at first — sabotage removed the
   * quartile agreement and every test still passed, which meant it was defence nothing verified. Six samples of
   * 3 GiB at ~65% through the steady window fit at +211 MiB/h while the first and last quartiles are both flat
   * at 200 MiB. Fit alone calls that a leak; it is a spike that came back down.
   */
  it("needs the fit and the quartiles to agree, not just the fit", () => {
    const hour = 3_600_000;
    const samples = Array.from({ length: 80 }, (_, i) => ({
      atMs: i * (hour / 79),
      rssBytes: i >= 50 && i < 56 ? 3_000e6 : 200e6,
      heapUsedBytes: 0,
    }));
    const verdict = detectGrowth(samples);
    expect(verdict.bytesPerHour, "the fit must exceed the threshold or this proves nothing").toBeGreaterThan(
      LEAK_BYTES_PER_HOUR,
    );
    expect(verdict.firstQuartileMean).toBe(verdict.lastQuartileMean);
    expect(verdict.leaking).toBe(false);
  });

  it("is not fooled by a single spike", () => {
    const hour = 3_600_000;
    const flat = series({ count: 60, spanMs: hour, startBytes: 200e6, endBytes: 200e6 });
    const spiked = flat.map((s, i) => (i === 30 ? { ...s, rssBytes: 900e6 } : s));
    // The quartile comparison ignores it; a fit alone would be dragged. Both checks exist because each catches
    // what the other misses.
    expect(detectGrowth(spiked).leaking).toBe(false);
  });

  it("reports the quartile means even when it declines to judge", () => {
    // A short soak still produces useful evidence. Withholding it because the verdict is "insufficient" would
    // make the honest arm less useful than the dishonest one.
    const verdict = detectGrowth(series({ count: 4, spanMs: 1_000, startBytes: 100e6, endBytes: 200e6 }));
    expect(verdict.firstQuartileMean).toBeGreaterThan(0);
    expect(verdict.lastQuartileMean).toBeGreaterThan(verdict.firstQuartileMean);
  });
});

describe("the failure matrix — AC-3, AC-5", () => {
  it("gives every mode a runbook", () => {
    // A failure mode not in a machine-readable list is one whose runbook can go missing without anything
    // noticing, and the absence is discovered during the incident it was written for.
    expect(modesWithoutRunbook()).toEqual([]);
    expect(Object.keys(RUNBOOKS).sort()).toEqual([...FAILURE_MODES].sort());
  });

  it("gives every runbook symptoms, a confirmation, an action, a do-not and a recovery time", () => {
    for (const runbook of Object.values(RUNBOOKS)) {
      expect(runbook.symptoms.length, runbook.mode).toBeGreaterThan(0);
      expect(runbook.confirm.length, runbook.mode).toBeGreaterThan(0);
      expect(runbook.action.length, runbook.mode).toBeGreaterThan(0);
      // The part usually missing. Most of the damage in an incident comes from a well-intentioned action that
      // fights the recovery mechanism, so "do not restart the workers, the reaper is handling it" is required.
      expect(runbook.doNot.length, `${runbook.mode} has no "do not"`).toBeGreaterThan(0);
      expect(runbook.expectedRecovery.length, runbook.mode).toBeGreaterThan(10);
    }
  });

  it("names the mechanism that recovers each mode", () => {
    for (const spec of Object.values(FAILURE_MATRIX)) {
      expect(spec.expect.mechanism.length, spec.mode).toBeGreaterThan(10);
      expect(spec.expect.observableSymptom.length, spec.mode).toBeGreaterThan(10);
    }
  });

  it("requires no data loss and no duplicate external action of every mode", () => {
    // There is no mode in this list where losing admitted work or repeating an external action is acceptable. If
    // one is ever added, this test is where the argument has to be made.
    for (const spec of Object.values(FAILURE_MATRIX)) {
      expect(spec.expect.noDataLoss, spec.mode).toBe(true);
      expect(spec.expect.noDuplicateExternalAction, spec.mode).toBe(true);
    }
  });

  it("separates the modes needing infrastructure from the ones it can inject itself", () => {
    // Named rather than skipped. A case that quietly does not run reports as covered, which is exactly how #20
    // closed green against "passes the full conformance suite" with one table implemented.
    expect(SELF_CONTAINED_MODES).toContain("worker-kill");
    expect(SELF_CONTAINED_MODES).not.toContain("redis-unavailable");
    expect(FAILURE_MATRIX["database-failover"].requiresInfrastructure).toBe(true);
  });
});

describe("injection verdicts", () => {
  const result = (over: Partial<InjectionResult>): InjectionResult => ({
    mode: "worker-kill",
    injected: true,
    admitted: 40,
    terminal: 40,
    externalEffects: 12,
    distinctEffectKeys: 12,
    recoveredMs: 3_000,
    manualInterventions: 0,
    notes: [],
    ...over,
  });

  it("passes a clean recovery", () => {
    expect(judgeInjection(result({})).passed).toBe(true);
  });

  it("fails when work was lost", () => {
    const verdict = judgeInjection(result({ terminal: 38 }));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/lost work: 40 admitted, 38/);
  });

  /** The assertion that actually matters: a retry after a kill must not publish the post twice. */
  it("fails when an external action was duplicated", () => {
    const verdict = judgeInjection(result({ externalEffects: 14, distinctEffectKeys: 12 }));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/duplicated external action: 14 effects for 12/);
  });

  it("does not treat fewer effects than keys as a duplicate", () => {
    // A run refused before its side effect performed none. That is not a duplicate, and a >= comparison here
    // would fail every overload test for the wrong reason.
    expect(judgeInjection(result({ externalEffects: 10, distinctEffectKeys: 12 })).passed).toBe(true);
  });

  /**
   * The verdict I was missing.
   *
   * The database-unavailable injection passed green while every one of its forty runs had been re-driven by the
   * harness. No work lost, nothing duplicated — both true — and "recovers unattended" simply untested. A verdict
   * that cannot tell "it recovered" from "I recovered it" is worse than no verdict.
   */
  it("fails when recovery needed a human, even though nothing was lost or duplicated", () => {
    const verdict = judgeInjection(result({ manualInterventions: 40 }));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/not unattended: 40 run\(s\) needed a manual re-drive/);
  });

  it("fails when the failure was never injected", () => {
    // The most important negative. A run where nothing broke tests nothing, and reporting it as a pass is how a
    // recovery guarantee gets an unearned tick.
    const verdict = judgeInjection(result({ injected: false }));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/never actually injected/);
  });
});

describe("the traffic scenario", () => {
  it("gives a run the same fate on every attempt", () => {
    // A real bug the first time: the engine drew from a shared generator, so a resumed run drew *different*
    // values — a run that had performed its external action could come back deciding it never does one. A load
    // test whose scenario is not stable across a resume can make no claim about resumption at all.
    for (const id of ["r1", "load-s20-7", "soak-r1234"]) expect(runFate(id)).toEqual(runFate(id));
    expect(runFate("r1")).not.toEqual(runFate("r2"));
  });

  it("distributes both fates close to their configured rate", () => {
    // The second bug: plain FNV-1a with two offset bases gave 0.03 for one id prefix and 0.50 for another against
    // a configured 0.30. A biased traffic mix is a load test measuring a different workload than it reports, and
    // nothing in the output would have said so.
    for (const prefix of ["load-s5-", "load-s20-", "soak-r", "kill-r"]) {
      const ids = Array.from({ length: 400 }, (_, i) => `${prefix}${i}`);
      const external = ids.filter((id) => runFate(id).a < 0.3).length / ids.length;
      const approval = ids.filter((id) => runFate(id).b < 0.1).length / ids.length;
      expect(external, `${prefix} external`).toBeGreaterThan(0.22);
      expect(external, `${prefix} external`).toBeLessThan(0.38);
      expect(approval, `${prefix} approval`).toBeGreaterThan(0.04);
      expect(approval, `${prefix} approval`).toBeLessThan(0.17);
    }
  });

  it("and the two fates are independent of each other", () => {
    // Salted strings rather than two offset bases. Changing the basis leaves the pair correlated; salting the
    // input decorrelates it.
    const ids = Array.from({ length: 2_000 }, (_, i) => `r${i}`);
    const both = ids.filter((id) => runFate(id).a < 0.5 && runFate(id).b < 0.5).length / ids.length;
    expect(both).toBeGreaterThan(0.2);
    expect(both).toBeLessThan(0.3);
  });

  it("replays identically from a seed", () => {
    const draw = (seed: number) => Array.from({ length: 20 }, seededRandom(seed));
    // A run that found a failure has to be replayable. `Math.random()` would make the interesting runs — the ones
    // that broke — unrepeatable, which is the opposite of what a load test is for.
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  it("does not deduplicate the effect ledger, because that is what is under test", () => {
    const ledger = createEffectLedger();
    ledger.perform("r1:2", 1);
    ledger.perform("r1:2", 2);
    // A ledger that refused a repeat would answer the question on the platform's behalf and every run would pass.
    expect(ledger.performed).toHaveLength(2);
    expect(ledger.distinctKeys()).toBe(1);
  });

  it("performs the external effect under a key that a retry reuses", async () => {
    const ledger = createEffectLedger();
    const engine = createSyntheticEngine({
      traffic: { ...DEFAULT_TRAFFIC, externalActionRate: 1, approvalRate: 0, steps: 2 },
      effects: ledger,
      random: seededRandom(1),
      now: () => 0,
      sleep: async () => {},
    });
    const run = { id: asId<RunId>("r1"), tenantId: asId<TenantId>("t1") } as never;
    const input = { run, context: {}, resume: null, signal: { isCancelled: () => false } } as never;
    for await (const _ of engine.run(input)) void _;
    // Twice, from scratch both times: the key is derived from run and step, so a repeat is *detectable*. A key
    // including an attempt number would make every retry unique and the duplicate check vacuous.
    for await (const _ of engine.run(input)) void _;
    expect(ledger.performed).toHaveLength(2);
    expect(ledger.distinctKeys()).toBe(1);
  });
});

describe("the bounded queue — AC-4", () => {
  const job = (n: number) => ({ tenantId: asId<TenantId>("t1"), runId: asId<RunId>(`r${n}`) });

  it("refuses past its bound with a typed error rather than dropping", async () => {
    const queue = createBoundedQueue(3, 1);
    // No consumer yet, so nothing drains and the bound is reachable.
    for (let i = 0; i < 3; i += 1) await queue.dispatcher.enqueueRun(job(i));
    // Thrown, not dropped. A silent drop is data loss dressed as backpressure.
    await expect(queue.dispatcher.enqueueRun(job(99))).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(queue.refused()).toBe(1);
    expect(queue.depth()).toBe(3);
  });

  it("hands work to several workers concurrently", async () => {
    // The bug that made the whole staircase wrong. The first version kept one `handler` and every `start()`
    // overwrote it, so three "competing" worker runtimes were one worker — and it awaited each job sequentially,
    // so the *queue* was the bottleneck being measured. It reported ~6/s and looked plausible.
    const queue = createBoundedQueue(100, 2);
    let peakConcurrent = 0;
    let current = 0;
    const release: (() => void)[] = [];
    const handler = () =>
      new Promise<void>((resolve) => {
        current += 1;
        peakConcurrent = Math.max(peakConcurrent, current);
        release.push(() => {
          current -= 1;
          resolve();
        });
      });
    queue.consumerFor().start(handler);
    queue.consumerFor().start(handler);
    for (let i = 0; i < 6; i += 1) await queue.dispatcher.enqueueRun(job(i));
    await new Promise((r) => setTimeout(r, 10));
    // Two workers × concurrency 2 = four in flight, not one.
    expect(peakConcurrent).toBe(4);
    for (const r of [...release]) r();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("keeps pumping after a handler throws", async () => {
    const queue = createBoundedQueue(10, 1);
    const seen: string[] = [];
    queue.consumerFor().start(async (j) => {
      seen.push(j.runId);
      if (j.runId === "r0") throw new Error("boom");
    });
    await queue.dispatcher.enqueueRun(job(0));
    await queue.dispatcher.enqueueRun(job(1));
    await queue.drained();
    // A queue that stopped on one bad job would turn a single failure into a stall, and the harness would measure
    // the stall rather than the platform.
    expect(seen).toEqual(["r0", "r1"]);
  });

  it("records the peak depth reached, which is the bounded-queueing evidence", async () => {
    const queue = createBoundedQueue(10, 1);
    for (let i = 0; i < 5; i += 1) await queue.dispatcher.enqueueRun(job(i));
    expect(queue.peakDepth()).toBe(5);
    queue.consumerFor().start(async () => {});
    await queue.drained();
    // Depth returns to zero; the peak does not. The peak is the number that shows the bound was respected.
    expect(queue.depth()).toBe(0);
    expect(queue.peakDepth()).toBe(5);
  });

  /**
   * Transition-then-enqueue is only safe when the enqueue cannot fail.
   *
   * The harness's approval draining copied the ordering of the platform fix — status first, then job — without
   * noticing that a *bounded* queue can refuse. Every refused enqueue left a run in `queued` with no job, 1,293
   * of them in one soak, and the settle loop then spun to its timeout looking for `waiting-for-approval` rows
   * that no longer existed.
   *
   * The same failure shape as the platform bug this harness had found an hour earlier, reintroduced by me. An
   * orphan in `queued` is invisible: it looks exactly like a run waiting its turn.
   */
  it("refuses only when full, so a caller can bound a batch to the room available", async () => {
    const queue = createBoundedQueue(3, 1);
    for (let i = 0; i < 3; i += 1) await queue.dispatcher.enqueueRun(job(i));
    // The number a caller must consult before transitioning anything.
    expect(queue.depth()).toBe(3);
    await expect(queue.dispatcher.enqueueRun(job(9))).rejects.toMatchObject({ code: "resource-exhausted" });

    // With room, the same enqueue succeeds — so a batch sized to `bound - depth()` never orphans a run.
    queue.consumerFor().start(async () => {});
    await queue.drained();
    await expect(queue.dispatcher.enqueueRun(job(9))).resolves.toBeUndefined();
  });

  it("resolves drained() immediately when there is nothing in flight", async () => {
    await expect(createBoundedQueue(10, 1).drained()).resolves.toBeUndefined();
  });

  it("does not deadlock on a drain when there are no workers to serve the queue", async () => {
    // Without this arm `drained()` waits forever: jobs are waiting, nothing will ever take them, and the waiter
    // is never released. A caller that stopped its workers and then awaited a drain hangs — which is how the
    // stuck-run test failed with a 30-second timeout instead of an assertion.
    const queue = createBoundedQueue(10, 1);
    for (let i = 0; i < 3; i += 1) await queue.dispatcher.enqueueRun(job(i));
    expect(queue.depth()).toBe(3);
    await expect(queue.drained()).resolves.toBeUndefined();
  });

  it("resolves every concurrent drained() waiter, not just the last", async () => {
    // A single `idle` slot meant a second concurrent waiter overwrote the first, and the first waited forever.
    // `settle` and `runLoadStep` both call `drained()`, so this was a live hang waiting for an overlapping
    // schedule.
    const queue = createBoundedQueue(10, 1);
    queue.consumerFor().start(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await queue.dispatcher.enqueueRun(job(1));
    const [a, b] = [queue.drained(), queue.drained()];
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it("stopping one worker does not stop the others", async () => {
    // The hang that produced no output at all. `JobConsumer.stop()` has no handle to say which worker is
    // stopping, so a shared consumer had to clear every registration — and killing one worker silently stopped
    // all three, leaving the drain waiting on nothing.
    const queue = createBoundedQueue(20, 1);
    const seen: string[] = [];
    const first = queue.consumerFor();
    const second = queue.consumerFor();
    first.start(async () => {
      seen.push("first");
    });
    second.start(async (j) => {
      seen.push(`second:${j.runId}`);
    });
    await first.stop(0);
    for (let i = 0; i < 3; i += 1) await queue.dispatcher.enqueueRun(job(i));
    await queue.drained();
    expect(seen.every((s) => s.startsWith("second"))).toBe(true);
    expect(seen).toHaveLength(3);
  });
});
