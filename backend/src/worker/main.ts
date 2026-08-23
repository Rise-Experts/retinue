/**
 * The worker process entrypoint (#107).
 *
 * `runtime/worker.ts` has had the claim, heartbeat, checkpoint and recovery logic all along and
 * nothing ran it. This is that missing process, and it is **composition only** — every recovery and
 * heartbeat behaviour it relies on already exists and is already tested. Adding execution logic here
 * would mean two places to look when a run misbehaves.
 *
 * Written against a `JobConsumer` seam rather than BullMQ directly, so the entrypoint's ordering
 * decisions — which are the part that can actually be wrong — are testable without Redis.
 */
import type { JobDispatcher, Run } from "../runtime/index.js";
import type { DurableWorker, ProcessResult } from "../runtime/worker.js";
import type { RunId, TenantId } from "../core/ids.js";

/**
 * A unit of work off the queue. Mirrors the dispatcher's `enqueueRun` input.
 *
 * The trace fields (#143) are optional and unused by the runtime itself — `instrumentConsumer` reads them. They
 * live on this type rather than on a parallel one so the consumer seam stays a single shape; a second type would
 * mean an adapter deciding which to produce.
 */
export type RunJob = {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly traceparent?: string;
  readonly enqueuedAt?: string;
};

/**
 * The queue's consumer side.
 *
 * `stop` must **stop accepting new jobs immediately** and only then wait for in-flight handlers. An
 * implementation that drains first would accept a job it has no intention of finishing.
 */
export interface JobConsumer {
  start(handler: (job: RunJob) => Promise<void>): Promise<void> | void;
  stop(graceMs: number): Promise<void>;
}

export type WorkerConfig = {
  /** Jobs handled at once. Above the store's connection pool this queues on the pool instead. */
  readonly concurrency: number;
  /**
   * How long a claim survives without a keepalive. The worker heartbeats at a third of this, so a
   * single slow round trip does not drop a live claim.
   */
  readonly leaseMs: number;
  /** How often to sweep for runs whose lease expired. */
  readonly reapEveryMs: number;
  /** Candidates per sweep. Bounded so a large backlog cannot turn one sweep into a long transaction. */
  readonly reapLimit: number;
  /**
   * How long shutdown waits for in-flight runs.
   *
   * Deliberately shorter than a run's `maxWallClockMs` can be: a long run will be **checkpointed**
   * rather than finished, which is correct — the alternative is a deploy that never completes. See the
   * open question on #107.
   */
  readonly shutdownGraceMs: number;
};

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  concurrency: 4,
  leaseMs: 30_000,
  reapEveryMs: 10_000,
  reapLimit: 20,
  shutdownGraceMs: 20_000,
};

export type WorkerRuntimeDeps = {
  readonly worker: DurableWorker;
  readonly consumer: JobConsumer;
  /** Reaped runs are re-enqueued rather than executed inline, so recovery goes through the same path. */
  readonly dispatcher: JobDispatcher;
  readonly config?: Partial<WorkerConfig>;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  /** Observability hook; also what the tests assert on. */
  readonly onOutcome?: (job: RunJob, result: ProcessResult) => void;
  readonly onError?: (job: RunJob, error: unknown) => void;
  /** Injectable so a test can drive the reaper without waiting on wall clock. */
  readonly setInterval?: (fn: () => void, ms: number) => { readonly clear: () => void };
};

export type WorkerStatus = {
  readonly running: boolean;
  readonly inFlight: number;
  readonly processed: number;
  readonly reaped: number;
};

export type WorkerRuntime = {
  start(): Promise<void>;
  /** Resolves once consumption has stopped and in-flight work has finished or the grace elapsed. */
  shutdown(reason: string): Promise<{ readonly graceful: boolean; readonly exitCode: number }>;
  status(): WorkerStatus;
  /** Runs one reap sweep now. Exposed so a host can trigger recovery on demand. */
  reapOnce(): Promise<readonly Run[]>;
};

export const createWorkerRuntime = (deps: WorkerRuntimeDeps): WorkerRuntime => {
  const config: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...deps.config };
  const log = deps.log ?? (() => {});
  const timer =
    deps.setInterval ??
    ((fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref?.(); // a reaper timer must never be the reason a process cannot exit
      return { clear: () => clearInterval(handle) };
    });

  let running = false;
  let inFlight = 0;
  let processed = 0;
  let reaped = 0;
  let reaperTimer: { readonly clear: () => void } | null = null;
  /** Resolves when the last in-flight handler finishes. Rebuilt each time the count returns to zero. */
  let idle: { promise: Promise<void>; resolve: () => void } | null = null;

  const markBusy = () => {
    inFlight += 1;
    if (idle === null) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      idle = { promise, resolve };
    }
  };

  const markIdle = () => {
    inFlight -= 1;
    if (inFlight === 0 && idle !== null) {
      idle.resolve();
      idle = null;
    }
  };

  const handle = async (job: RunJob): Promise<void> => {
    markBusy();
    try {
      const result = await deps.worker.process(job);
      processed += 1;
      deps.onOutcome?.(job, result);
    } catch (error) {
      // Swallowed at this boundary on purpose: one failing run must not take the process down, and the
      // run's own failure state is already recorded by `process`. Surfaced through `onError` so a host
      // can alert on it.
      deps.onError?.(job, error);
      log("run handler threw", { runId: job.runId, error: String(error) });
    } finally {
      markIdle();
    }
  };

  /**
   * One recovery sweep.
   *
   * Re-enqueues rather than executing inline, so a reclaimed run goes through exactly the same path as
   * a fresh one — including the queue's dedup, which is half of why AC-4 needs no reaper-level lock.
   *
   * Note what is deliberately *absent*: no guard against two reapers finding the same run.
   * `reapExpired` is a pure read, so both will, and the exclusion already exists twice — #105's job id
   * collapses the two enqueues into one job, and #93's `claim` is an atomic lease compare-and-set that
   * admits one worker regardless. A third guard here would protect something already atomic, and a
   * stalled holder of it would block recovery entirely.
   */
  const reapOnce = async (): Promise<readonly Run[]> => {
    const candidates = await deps.worker.reapExpired(config.reapLimit);
    for (const run of candidates) {
      try {
        await deps.dispatcher.enqueueRun({ tenantId: run.tenantId, runId: run.id });
        reaped += 1;
      } catch (error) {
        // A queue that is down must not stop the sweep: the next sweep will find the same runs, since
        // nothing has claimed them.
        log("could not re-enqueue a reaped run", { runId: run.id, error: String(error) });
      }
    }
    if (candidates.length > 0) log(`reaped ${candidates.length} expired run(s)`);
    return candidates;
  };

  return {
    async start() {
      if (running) return;
      running = true;
      await deps.consumer.start(handle);
      reaperTimer = timer(() => {
        void reapOnce().catch((error: unknown) => log("reap sweep failed", { error: String(error) }));
      }, config.reapEveryMs);
      log("worker started", {
        concurrency: config.concurrency,
        leaseMs: config.leaseMs,
        reapEveryMs: config.reapEveryMs,
      });
    },

    async shutdown(reason: string) {
      if (!running) return { graceful: true, exitCode: 0 };
      running = false;
      log("shutting down", { reason });

      // Order matters, and this is the ordering decision worth the whole file. Consumption stops
      // first, so nothing new is accepted; the reaper stops with it, because re-enqueuing during a
      // drain hands work to a process that is leaving. Only then do we wait.
      reaperTimer?.clear();
      reaperTimer = null;
      await deps.consumer.stop(config.shutdownGraceMs);

      let graceful = true;
      if (inFlight > 0 && idle !== null) {
        const deadline = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), config.shutdownGraceMs).unref?.(),
        );
        const outcome = await Promise.race([idle.promise.then(() => "drained" as const), deadline]);
        graceful = outcome === "drained";
      }

      // Non-zero only on a genuine failure to drain. A rolling deploy that checkpointed a long run
      // did its job, and a non-zero exit there would make an orchestrator treat a success as a crash.
      log(graceful ? "drained cleanly" : "grace period elapsed with work in flight", { inFlight });
      return { graceful, exitCode: graceful ? 0 : 1 };
    },

    status() {
      return { running, inFlight, processed, reaped };
    },

    reapOnce,
  };
};

/**
 * Attach OS signal handlers. Separate from `createWorkerRuntime` on purpose: a library that binds to
 * `process` merely by being constructed is hostile to embed and to test, and every test here would
 * otherwise need real signals.
 */
export const installSignalHandlers = (
  runtime: WorkerRuntime,
  options: {
    readonly signals?: readonly NodeJS.Signals[];
    readonly onExit?: (code: number) => void;
    readonly process?: Pick<NodeJS.Process, "on">;
  } = {},
): (() => void) => {
  const target = options.process ?? process;
  const signals = options.signals ?? (["SIGTERM", "SIGINT"] as const);
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const listeners = signals.map((signal) => {
    const listener = () => {
      // A second signal during shutdown is ignored rather than escalating: an impatient orchestrator
      // sending SIGTERM twice should not abandon a run that is seconds from checkpointing.
      if (shuttingDown) return;
      shuttingDown = true;
      void runtime.shutdown(signal).then(({ exitCode }) => onExit(exitCode));
    };
    target.on(signal, listener);
    return { signal, listener } as const;
  });

  return () => {
    for (const { signal, listener } of listeners) {
      (target as NodeJS.Process).removeListener?.(signal, listener);
    }
  };
};
