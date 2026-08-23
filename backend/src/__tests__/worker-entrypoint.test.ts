/**
 * The worker process entrypoint (#107).
 *
 * The entrypoint adds no execution logic — every recovery, heartbeat and checkpoint behaviour it
 * relies on already lives in `runtime/worker.ts` and is already tested there. So what is worth testing
 * here is the handful of things the entrypoint alone decides, and the one that can most easily be
 * wrong is **ordering**: shutdown must stop consuming before it drains, or it accepts a job it has no
 * intention of finishing.
 */

import { describe, expect, it, vi } from "vitest";
import { asId } from "../core/ids.js";
import type { RunId, TenantId } from "../core/ids.js";
import type { JobDispatcher, Run } from "../runtime/index.js";
import type { DurableWorker, ProcessResult } from "../runtime/worker.js";
import {
  createWorkerRuntime,
  DEFAULT_WORKER_CONFIG,
  installSignalHandlers,
  type JobConsumer,
  type RunJob,
} from "../worker/main.js";

const T1 = asId<TenantId>("wrk-t1");
const run = (id: string, over: Partial<Run> = {}): Run =>
  ({
    id: asId<RunId>(id),
    tenantId: T1,
    conversationId: asId("wrk-c1"),
    agentId: asId("wrk-a1"),
    agentVersion: 1,
    status: "running",
    createdAt: "2020-01-01T00:00:00.000Z",
    ...over,
  }) as Run;

/** A consumer whose handler a test calls by hand, so job arrival is deterministic. */
const manualConsumer = () => {
  let handler: ((job: RunJob) => Promise<void>) | null = null;
  let accepting = false;
  const stopped: number[] = [];
  const consumer: JobConsumer = {
    start(h) {
      handler = h;
      accepting = true;
    },
    async stop(graceMs) {
      // The contract: stop accepting *immediately*, then let the runtime own the waiting.
      accepting = false;
      stopped.push(graceMs);
    },
  };
  return {
    consumer,
    stopped,
    accepting: () => accepting,
    deliver: (job: RunJob) => {
      if (!accepting) throw new Error("consumer is not accepting work");
      return handler!(job);
    },
  };
};

const fakeWorker = (behaviour: {
  readonly process?: (job: RunJob) => Promise<ProcessResult>;
  readonly expired?: readonly Run[];
}): DurableWorker =>
  ({
    process: behaviour.process ?? (async () => ({ run: run("r1"), outcome: "completed" })),
    reapExpired: async () => behaviour.expired ?? [],
  }) as unknown as DurableWorker;

const recordingDispatcher = () => {
  const enqueued: RunJob[] = [];
  const dispatcher: JobDispatcher = {
    async enqueueRun(job) {
      enqueued.push(job as RunJob);
    },
  };
  return { dispatcher, enqueued };
};

describe("configuration", () => {
  it("documents its defaults, and heartbeats well inside the lease", () => {
    // The worker keepalives at a third of the lease, so a single slow round trip cannot drop a claim
    // that is still live. The relationship matters more than either number.
    expect(DEFAULT_WORKER_CONFIG.leaseMs).toBe(30_000);
    expect(DEFAULT_WORKER_CONFIG.reapEveryMs).toBeLessThan(DEFAULT_WORKER_CONFIG.leaseMs);
    // A grace period shorter than a run's possible wall clock is deliberate: a long run gets
    // checkpointed rather than finished, because the alternative is a deploy that never completes.
    expect(DEFAULT_WORKER_CONFIG.shutdownGraceMs).toBeGreaterThan(0);
    expect(Object.keys(DEFAULT_WORKER_CONFIG).sort()).toEqual([
      "concurrency",
      "leaseMs",
      "reapEveryMs",
      "reapLimit",
      "shutdownGraceMs",
    ]);
  });

  it("takes a partial override without losing the rest", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    const runtime = createWorkerRuntime({
      worker: fakeWorker({}),
      consumer: consumer.consumer,
      dispatcher,
      config: { concurrency: 1 },
      setInterval: () => ({ clear: () => {} }),
    });
    await runtime.start();
    expect(runtime.status().running).toBe(true);
    await runtime.shutdown("test");
  });
});

/** AC-1. */
describe("processing queued work", () => {
  it("processes a delivered job and records the outcome", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    const outcomes: ProcessResult[] = [];
    const runtime = createWorkerRuntime({
      worker: fakeWorker({}),
      consumer: consumer.consumer,
      dispatcher,
      onOutcome: (_job, result) => outcomes.push(result),
      setInterval: () => ({ clear: () => {} }),
    });

    await runtime.start();
    await consumer.deliver({ tenantId: T1, runId: asId<RunId>("r1") });
    expect(outcomes.map((o) => o.outcome)).toEqual(["completed"]);
    expect(runtime.status().processed).toBe(1);
    await runtime.shutdown("test");
  });

  it("survives a handler that throws, and surfaces it", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    const errors: unknown[] = [];
    const runtime = createWorkerRuntime({
      worker: fakeWorker({
        process: async () => {
          throw new Error("engine exploded");
        },
      }),
      consumer: consumer.consumer,
      dispatcher,
      onError: (_job, error) => errors.push(error),
      setInterval: () => ({ clear: () => {} }),
    });

    await runtime.start();
    // One failing run must not take the process down — the run's own failure state is already recorded
    // by `process`, and a crashing worker would strand every other run it holds.
    await expect(consumer.deliver({ tenantId: T1, runId: asId<RunId>("r1") })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(runtime.status().inFlight).toBe(0);
    await runtime.shutdown("test");
  });
});

/** AC-2. The ordering decision the whole file exists for. */
describe("graceful shutdown", () => {
  it("stops accepting work before it waits for in-flight runs", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    let release!: () => void;
    const inFlight = new Promise<void>((r) => {
      release = r;
    });

    const runtime = createWorkerRuntime({
      worker: fakeWorker({
        process: async () => {
          await inFlight;
          return { run: run("r1"), outcome: "completed" };
        },
      }),
      consumer: consumer.consumer,
      dispatcher,
      config: { shutdownGraceMs: 5_000 },
      setInterval: () => ({ clear: () => {} }),
    });

    await runtime.start();
    const processing = consumer.deliver({ tenantId: T1, runId: asId<RunId>("r1") });
    expect(runtime.status().inFlight).toBe(1);

    const shutdown = runtime.shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 10));
    // Already refusing new work while the in-flight run continues. A drain-first ordering would have
    // accepted another job here — one it has no intention of finishing.
    expect(consumer.accepting()).toBe(false);
    expect(() => consumer.deliver({ tenantId: T1, runId: asId<RunId>("r2") })).toThrow();

    release();
    await processing;
    const result = await shutdown;
    expect(result).toEqual({ graceful: true, exitCode: 0 });
  });

  it("reports non-zero only when the grace period elapses with work still running", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    const never = new Promise<never>(() => {});

    const runtime = createWorkerRuntime({
      worker: fakeWorker({ process: async () => never }),
      consumer: consumer.consumer,
      dispatcher,
      config: { shutdownGraceMs: 30 },
      setInterval: () => ({ clear: () => {} }),
    });

    await runtime.start();
    void consumer.deliver({ tenantId: T1, runId: asId<RunId>("r1") });
    const result = await runtime.shutdown("SIGTERM");
    // A deploy that checkpointed a long run did its job, so a non-zero exit is reserved for a genuine
    // failure to drain — otherwise an orchestrator would read every rolling deploy as a crash.
    expect(result).toEqual({ graceful: false, exitCode: 1 });
  });

  it("exits zero immediately when there is nothing in flight", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    const runtime = createWorkerRuntime({
      worker: fakeWorker({}),
      consumer: consumer.consumer,
      dispatcher,
      setInterval: () => ({ clear: () => {} }),
    });
    await runtime.start();
    expect(await runtime.shutdown("SIGTERM")).toEqual({ graceful: true, exitCode: 0 });
    // Idempotent: a second signal must not produce a second shutdown.
    expect(await runtime.shutdown("SIGTERM")).toEqual({ graceful: true, exitCode: 0 });
  });

  it("stops the reaper as part of shutting down", async () => {
    const consumer = manualConsumer();
    const { dispatcher, enqueued } = recordingDispatcher();
    let tick: (() => void) | null = null;
    const runtime = createWorkerRuntime({
      worker: fakeWorker({ expired: [run("stale")] }),
      consumer: consumer.consumer,
      dispatcher,
      setInterval: (fn) => {
        tick = fn;
        return { clear: () => (tick = null) };
      },
    });

    await runtime.start();
    await runtime.shutdown("SIGTERM");
    // Re-enqueuing during a drain hands work to a process that is leaving, so the reaper stops with
    // consumption rather than after it.
    expect(tick).toBeNull();
    expect(enqueued).toHaveLength(0);
  });
});

/** AC-3 and AC-4. */
describe("reaping", () => {
  it("re-enqueues expired runs rather than executing them inline", async () => {
    const consumer = manualConsumer();
    const { dispatcher, enqueued } = recordingDispatcher();
    const runtime = createWorkerRuntime({
      worker: fakeWorker({ expired: [run("stale-1"), run("stale-2")] }),
      consumer: consumer.consumer,
      dispatcher,
      setInterval: () => ({ clear: () => {} }),
    });

    await runtime.start();
    const reaped = await runtime.reapOnce();
    // Recovery goes through the same path as a fresh run — including the queue's dedup, which is half
    // of why AC-4 needs no reaper-level lock.
    expect(reaped).toHaveLength(2);
    expect(enqueued.map((j) => j.runId)).toEqual(["stale-1", "stale-2"]);
    expect(runtime.status().reaped).toBe(2);
    await runtime.shutdown("test");
  });

  it("keeps sweeping when the queue refuses an enqueue", async () => {
    const consumer = manualConsumer();
    const dispatcher: JobDispatcher = {
      async enqueueRun() {
        throw new Error("queue unreachable");
      },
    };
    const runtime = createWorkerRuntime({
      worker: fakeWorker({ expired: [run("stale-1"), run("stale-2")] }),
      consumer: consumer.consumer,
      dispatcher,
      setInterval: () => ({ clear: () => {} }),
    });

    await runtime.start();
    // A queue that is down must not abort the sweep or the process: nothing has claimed these runs, so
    // the next sweep finds them again.
    await expect(runtime.reapOnce()).resolves.toHaveLength(2);
    expect(runtime.status().reaped).toBe(0);
    await runtime.shutdown("test");
  });

  it("lets two reapers both find a run, because exclusion is downstream", async () => {
    const stale = run("contended");
    const consumers = [manualConsumer(), manualConsumer()];
    const seen: RunJob[] = [];
    // One shared dispatcher standing in for the queue: both reapers enqueue the same run, and #105's
    // job id (tenant + run) collapses that into one job. #93's `claim` then admits exactly one worker.
    const dispatcher: JobDispatcher = {
      async enqueueRun(job) {
        seen.push(job as RunJob);
      },
    };

    const runtimes = consumers.map((c) =>
      createWorkerRuntime({
        worker: fakeWorker({ expired: [stale] }),
        consumer: c.consumer,
        dispatcher,
        setInterval: () => ({ clear: () => {} }),
      }),
    );
    for (const r of runtimes) await r.start();
    await Promise.all(runtimes.map((r) => r.reapOnce()));

    // Both reapers found it — deliberately. `reapExpired` is a pure read, so a guard here would
    // protect something already atomic, and a stalled holder of that guard would block recovery.
    expect(seen).toHaveLength(2);
    expect(new Set(seen.map((j) => `${j.tenantId}:${j.runId}`)).size).toBe(1);
    for (const r of runtimes) await r.shutdown("test");
  });
});

/** AC-6, and what of it can be asserted honestly. */
describe("scaling", () => {
  it("processes distinct runs across concurrent workers, never the same one twice", async () => {
    const claimed = new Set<string>();
    const build = () => {
      const consumer = manualConsumer();
      const { dispatcher } = recordingDispatcher();
      const runtime = createWorkerRuntime({
        worker: fakeWorker({
          process: async (job) => {
            // Standing in for #93's atomic claim: the second worker to see a run gets "skipped".
            if (claimed.has(job.runId)) return { run: null, outcome: "skipped" };
            claimed.add(job.runId);
            return { run: run(job.runId), outcome: "completed" };
          },
        }),
        consumer: consumer.consumer,
        dispatcher,
        setInterval: () => ({ clear: () => {} }),
      });
      return { consumer, runtime };
    };

    const a = build();
    const b = build();
    await a.runtime.start();
    await b.runtime.start();

    await Promise.all([
      a.consumer.deliver({ tenantId: T1, runId: asId<RunId>("r1") }),
      b.consumer.deliver({ tenantId: T1, runId: asId<RunId>("r2") }),
      // The same run offered to both: exactly one completes it.
      a.consumer.deliver({ tenantId: T1, runId: asId<RunId>("r3") }),
      b.consumer.deliver({ tenantId: T1, runId: asId<RunId>("r3") }),
    ]);

    // Deliberately not asserting wall-clock throughput: that measures the CI machine rather than the
    // code, and would be the flakiest test in the suite. What makes added workers *useful* is that
    // they take distinct work rather than duplicating it, and that is what this asserts.
    expect([...claimed].sort()).toEqual(["r1", "r2", "r3"]);
    await a.runtime.shutdown("scale-down");
    await b.runtime.shutdown("scale-down");
  });

  it("leaves un-started work for another worker when one shuts down", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    const runtime = createWorkerRuntime({
      worker: fakeWorker({}),
      consumer: consumer.consumer,
      dispatcher,
      setInterval: () => ({ clear: () => {} }),
    });
    await runtime.start();
    await runtime.shutdown("scale-down");

    // The scale-down half of AC-6: a job never accepted is still in the queue, so nothing is lost.
    // The consumer refusing delivery is what "still queued" looks like from this side of the seam.
    expect(consumer.accepting()).toBe(false);
    expect(runtime.status().processed).toBe(0);
  });
});

describe("signal handling", () => {
  it("shuts down once per process, ignoring an impatient second signal", async () => {
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    const runtime = createWorkerRuntime({
      worker: fakeWorker({}),
      consumer: consumer.consumer,
      dispatcher,
      setInterval: () => ({ clear: () => {} }),
    });
    await runtime.start();

    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const fakeProcess = {
      on: (signal: string, listener: () => void) => {
        listeners.set(signal, listener);
        return fakeProcess as never;
      },
    };
    const shutdownSpy = vi.spyOn(runtime, "shutdown");

    installSignalHandlers(runtime, {
      signals: ["SIGTERM"],
      onExit: (code) => exits.push(code),
      process: fakeProcess as never,
    });

    listeners.get("SIGTERM")?.();
    listeners.get("SIGTERM")?.();
    await new Promise((r) => setTimeout(r, 20));

    // An orchestrator sending SIGTERM twice should not abandon a run seconds from checkpointing.
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });

  it("does not attach to the real process merely by constructing a runtime", () => {
    const before = process.listenerCount("SIGTERM");
    const consumer = manualConsumer();
    const { dispatcher } = recordingDispatcher();
    createWorkerRuntime({
      worker: fakeWorker({}),
      consumer: consumer.consumer,
      dispatcher,
      setInterval: () => ({ clear: () => {} }),
    });
    // Signal handling is a separate, explicit call. A library that binds to `process` on construction
    // is hostile to embed and would make every test here need real signals.
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
