/**
 * The load and soak driver — AC-1, AC-2, AC-3, AC-4.
 *
 * Drives the **real durable path**: a real Postgres schema, a real BullMQ queue on a real Redis, several real
 * `WorkerRuntime` instances competing for work, real atomic claims, real leases, real checkpoints and a real
 * event log. The only synthetic part is the agent engine, and that is not a shortcut — see `scenario.ts`.
 *
 * What this is *not* is a request against a deployed HTTP endpoint. #144 asks for that, and there is no deployed
 * instance yet; the layers this cannot reach are the GraphQL server and the process boundary between host and
 * worker. Everything below them is exercised for real. That boundary is stated in the report the harness writes,
 * not left for someone to infer from a green tick.
 *
 * Structured so the driver returns **data** and the judging happens in `metrics.ts` and `injection.ts`. A
 * harness that both ran the load and decided whether it passed would be a harness whose verdict nobody could
 * test, and the verdict is the part most likely to be quietly wrong.
 */

import { createPostgresCheckpointStore } from "../adapters/postgres/checkpoint-store.js";
import { createPostgresRunEventLog } from "../adapters/postgres/run-event-log.js";
import { createPostgresRunStore } from "../adapters/postgres/run-store.js";
import { createMemoryEventBus } from "../runtime/streaming.js";
import { createDurableWorker } from "../runtime/worker.js";
import { createWorkerRuntime, type JobConsumer, type RunJob } from "../worker/main.js";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, RequestId, RunId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import type { JobDispatcher, Run } from "../runtime/index.js";
import { QUEUE_ATTEMPTS } from "../adapters/bullmq/dispatcher.js";
import type { SqlExecutor } from "../adapters/postgres/sql.js";
import {
  DEFAULT_TRAFFIC,
  createEffectLedger,
  createSyntheticEngine,
  runFate,
  seededRandom,
  type EffectLedger,
  type TrafficShape,
} from "./scenario.js";
import { detectGrowth, summarizeLatency, summarizeThroughput, type LoadStep, type ResourceSample } from "./metrics.js";

export type HarnessConfig = {
  readonly tenantId: TenantId;
  /** Worker runtimes competing for the same queue. Several, or a claim race is never exercised. */
  readonly workers: number;
  readonly concurrency: number;
  /** Short, so a killed worker's lease expires inside a test rather than inside a coffee break. */
  readonly leaseMs: number;
  readonly reapEveryMs: number;
  readonly traffic: TrafficShape;
  readonly seed: number;
  /**
   * The queue's bound. Past it, admission is refused.
   *
   * The mechanism AC-4 asks for. Without a bound, "overload" means an unbounded in-memory backlog, which is the
   * failure mode rather than the test.
   */
  readonly maxQueueDepth: number;
  readonly sampleEveryMs: number;
};

export const DEFAULT_HARNESS: Omit<HarnessConfig, "tenantId"> = {
  workers: 3,
  concurrency: 4,
  leaseMs: 2_000,
  reapEveryMs: 250,
  traffic: DEFAULT_TRAFFIC,
  seed: 20260823,
  maxQueueDepth: 200,
  sampleEveryMs: 250,
};

/**
 * An in-process queue with a **bounded** depth and an explicit refusal.
 *
 * Used where the point is backpressure rather than Redis. Deliberately not BullMQ for the overload case: BullMQ's
 * depth is Redis memory, so "bounded queueing" there is a Redis configuration question and the assertion would
 * be about Redis. Here the bound is ours and the refusal is the platform's.
 */
export class QueueFull extends Error {
  readonly code = "resource-exhausted";
  readonly retryable = true;
  constructor(readonly depth: number) {
    super(`queue full at depth ${depth}`);
    this.name = "QueueFull";
  }
}

export type BoundedQueue = {
  readonly dispatcher: JobDispatcher;
  /**
   * A **fresh consumer per worker**, not one shared object.
   *
   * `JobConsumer.stop()` has no handle to say *which* worker is stopping, so a shared consumer's `stop` had to
   * clear every registration — which meant killing one worker silently stopped all three. The worker-kill
   * injection then hung forever waiting for a drain that could never happen, produced no output at all, and it
   * took a process listing to find. Each worker gets its own view, closing over its own slot.
   */
  consumerFor(): JobConsumer;
  depth(): number;
  peakDepth(): number;
  refused(): number;
  /** Jobs handed to a worker more than once. A pass that needed retries is not a clean first-attempt pass. */
  retried(): number;
  drained(): Promise<void>;
};

export const createBoundedQueue = (maxDepth: number, perWorkerConcurrency = 4): BoundedQueue => {
  /** A job and how many times it has been handed to a worker. */
  const waiting: (RunJob & { attempts?: number })[] = [];
  let peak = 0;
  let refused = 0;
  let retried = 0;
  /**
   * One handler **per worker**, not one for the queue.
   *
   * The first version kept a single `handler` and every `start()` overwrote it — so three "competing" worker
   * runtimes were one worker, and the claim race the load test exists to exercise was unreachable. The staircase
   * reported ~6/s and looked plausible, which is why it survived: a wrong capacity number is indistinguishable
   * from a real one without something to compare it against.
   */
  const workers: { readonly handle: (job: RunJob) => Promise<void>; inFlight: number }[] = [];
  /**
   * Every waiter, not one.
   *
   * A single `idle` slot meant a second concurrent `drained()` overwrote the first, and the first caller waited
   * forever. `settle` and `runLoadStep` both call it, so this was a live hang waiting for a schedule that
   * happened to overlap.
   */
  const idleWaiters: (() => void)[] = [];

  const busy = () => workers.reduce((n, w) => n + w.inFlight, 0);

  const releaseIdle = (): void => {
    // Drained and cleared in one go, so a waiter added while these are resolving is not resolved twice.
    const waiters = idleWaiters.splice(0, idleWaiters.length);
    for (const resolve of waiters) resolve();
  };

  /**
   * Hand jobs to whichever worker has a free slot.
   *
   * Concurrent, not sequential. The first version awaited each handler inside a `while` loop, so the queue
   * processed exactly one job at a time whatever the workers' configured concurrency was — the *queue* was the
   * bottleneck the staircase was measuring, and it would have been published as the platform's capacity.
   */
  const pump = (): void => {
    for (;;) {
      if (waiting.length === 0) break;
      const free = workers.find((w) => w.inFlight < perWorkerConcurrency);
      if (free === undefined) break;
      const job = waiting.shift() as RunJob & { attempts?: number };
      const attempts = (job.attempts ?? 0) + 1;
      free.inFlight += 1;
      void free
        .handle(job)
        .catch(() => {
          /**
           * Retry exactly as far as the real queue does — `QUEUE_ATTEMPTS`, which is currently **1**.
           *
           * Written against the constant rather than hard-coded, and that turned out to matter. I added this
           * expecting BullMQ to retry and the harness to be the weaker one; `QUEUE_ATTEMPTS = 1` says otherwise.
           * So the production queue does not retry a failed job either, and recovery rests entirely on the lease
           * reaper — which only finds runs in `running` with an expired lease.
           *
           * That makes the database-unavailable result a **platform** finding, not a harness artifact: a run
           * whose *claim* failed while the database was down stays `queued` with no job anywhere, and no
           * mechanism will ever pick it up. See docs/16 — it is recorded rather than fixed here, because the
           * queue's retry policy is a #105/#107 decision with consequences beyond this harness.
           *
           * The count is exposed, so a run that only passed *because* of retries is visible rather than looking
           * like a clean first-attempt success.
           */
          if (attempts < QUEUE_ATTEMPTS && workers.length > 0) {
            retried += 1;
            waiting.push({ ...job, attempts });
          }
        })
        .finally(() => {
          free.inFlight -= 1;
          if (waiting.length > 0) pump();
          else if (busy() === 0) releaseIdle();
        });
    }
  };

  return {
    dispatcher: {
      async enqueueRun(input) {
        if (waiting.length >= maxDepth) {
          refused += 1;
          // Thrown, not dropped. AC-4's "honest refusal" is a typed error reaching the caller; a silent drop is
          // data loss dressed as backpressure.
          throw new QueueFull(waiting.length);
        }
        waiting.push({ tenantId: input.tenantId, runId: input.runId });
        peak = Math.max(peak, waiting.length);
        pump();
      },
    },
    consumerFor() {
      let slot: { readonly handle: (job: RunJob) => Promise<void>; inFlight: number } | null = null;
      return {
        start(h) {
          slot = { handle: h, inFlight: 0 };
          workers.push(slot);
          pump();
        },
        async stop() {
          // Only *this* worker's slot. Its in-flight jobs are already running and will finish or fail on their
          // own; removing the slot is "stop accepting new work", which is exactly what stop means.
          const index = slot === null ? -1 : workers.indexOf(slot);
          if (index >= 0) workers.splice(index, 1);
          slot = null;
          // The remaining workers may now have room, and a queue that did not re-pump here would stall until the
          // next enqueue — which during a drain is never.
          pump();
          if (waiting.length === 0 && busy() === 0) releaseIdle();
        },
      };
    },
    depth: () => waiting.length,
    peakDepth: () => peak,
    refused: () => refused,
    retried: () => retried,
    /**
     * Resolves when nothing more will be handed out and nothing is in flight.
     *
     * The `workers.length === 0` arm is not a shortcut — without it this **deadlocks**. A queue with jobs waiting
     * and no worker to serve them can never drain, so a caller that stopped the workers and then awaited a drain
     * waits forever. Returning lets the caller discover the runs are stuck, which is the fact it was trying to
     * establish; blocking hides it behind a hang.
     */
    drained: () =>
      (waiting.length === 0 && busy() === 0) || (workers.length === 0 && busy() === 0)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
  };
};

export type WorkerHandle = {
  readonly id: string;
  /** Stop without draining — the worker-kill injector. */
  kill(): Promise<void>;
  shutdown(): Promise<void>;
};

export type Harness = {
  readonly effects: EffectLedger;
  readonly queue: BoundedQueue;
  readonly workers: readonly WorkerHandle[];
  /** Admit and enqueue one run. Throws `QueueFull` when the queue is at its bound. */
  admit(input: { conversationId: ConversationId; runId: RunId }): Promise<void>;
  /** Runs in a terminal state, from the store — not from the harness's own bookkeeping. */
  terminalCount(): Promise<number>;
  /** Every run status and its count, so a paused run is never miscounted as a failure. */
  statusCounts(): Promise<Readonly<Record<string, number>>>;
  /**
   * Approve everything waiting, and re-enqueue it.
   *
   * A load test that left approvals pending would report them as lost work, which is the opposite of the truth:
   * a run waiting for a human is the platform holding state correctly, and it is the longest-lived state it has.
   * Deciding them here is also the only way the resume path is exercised under load.
   *
   * Returns how long each run waited, so approval wait time is measured rather than assumed.
   */
  approvePending(): Promise<readonly number[]>;
  /**
   * Wait until nothing with this id prefix is still in flight, then report what happened.
   *
   * Necessary because "the queue is empty" is not "the work is done": the queue empties when the last job reaches
   * a worker. Without settling, a step's slowest runs are still executing when it is measured, and they count as
   * failures — my first staircase reported `mode: errors` at 20/s for exactly that reason, which would have sent
   * an operator hunting a failure that was really my clock.
   *
   * A run still non-terminal when the timeout expires *does* count as stuck. That is the honest line: waiting
   * forever would hide a genuine hang, and not waiting at all reports one that is not there.
   */
  settle(input: { readonly idPrefix: string; readonly timeoutMs: number }): Promise<{
    readonly completed: number;
    readonly failed: number;
    readonly stuck: number;
    readonly stuckByStatus?: Readonly<Record<string, number>>;
    readonly approvalWaitsMs: readonly number[];
  }>;
  /**
   * End-to-end latency per finished run, in ms, from the store's own timestamps.
   *
   * The number that matters. Admission latency is a property of the enqueue and stays flat under any backlog;
   * what a user experiences is admission to terminal, and only the store knows both ends.
   */
  terminalLatencies(idPrefix: string): Promise<readonly number[]>;
  admittedCount(): number;
  sample(): ResourceSample;
  stop(): Promise<void>;
};

const AGENT = asId<AgentId>("loadtest-agent");

/**
 * Build the harness over an already-migrated schema.
 *
 * Takes a `SqlExecutor` rather than a URL so the caller owns the connection: the database-unavailable injector
 * needs to stop the server underneath a live pool, and a harness that owned the pool would reconnect on its own
 * schedule and the injector could not control the window.
 */
export const createHarness = async (input: {
  readonly sql: SqlExecutor;
  readonly config: HarnessConfig;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<Harness> => {
  const { sql, config } = input;
  const now = input.now ?? Date.now;
  const runs = createPostgresRunStore(sql);
  const checkpoints = createPostgresCheckpointStore(sql);
  const eventLog = createPostgresRunEventLog(sql);
  const { publisher } = createMemoryEventBus();
  const effects = createEffectLedger();
  const queue = createBoundedQueue(config.maxQueueDepth, config.concurrency);

  const engine = createSyntheticEngine({
    traffic: config.traffic,
    effects,
    random: seededRandom(config.seed),
    now,
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
  });

  const buildContext = (run: Run): ExecutionContext => ({
    tenantId: run.tenantId,
    principalId: asId("loadtest-principal"),
    roleIds: [],
    locale: "en",
    timezone: "UTC",
    requestId: asId<RequestId>(`load-${run.id}`),
  });

  const handles: WorkerHandle[] = [];
  const admittedIds: RunId[] = [];

  for (let i = 0; i < config.workers; i += 1) {
    const id = `w${i}`;
    const worker = createDurableWorker({
      runs,
      checkpoints,
      publisher,
      engine,
      eventLog,
      buildContext,
      workerId: id,
      leaseMs: config.leaseMs,
      now,
    });
    const runtime = createWorkerRuntime({
      worker,
      // Every runtime shares the one queue, so they genuinely compete for jobs and the atomic claim is exercised
      // rather than assumed. A queue per worker would make the claim race unreachable, which is the single most
      // important thing a load test of this platform can hit.
      consumer: queue.consumerFor(),
      dispatcher: queue.dispatcher,
      config: {
        concurrency: config.concurrency,
        leaseMs: config.leaseMs,
        reapEveryMs: config.reapEveryMs,
        reapLimit: 50,
        shutdownGraceMs: 1_000,
      },
    });
    await runtime.start();
    handles.push({
      id,
      // A kill is `shutdown(0)` — stop consuming immediately and do not wait. The lease is left held, which is
      // the situation the reaper exists for and the one a graceful shutdown would hide.
      kill: async () => void (await runtime.shutdown("killed")),
      shutdown: async () => void (await runtime.shutdown("drain")),
    });
  }

  /** Hoisted so `settle` can call it: `this` inside the returned literal is typed as the enclosing promise. */
  const approvePending = async (): Promise<readonly number[]> => {
      // The paused runs, straight from the store. Re-enqueued rather than driven inline, so recovery goes through
      // the same claim path a real approval decision takes -- an inline drive would test a path production never
      // uses.
      /**
       * Bounded by the queue's free room, and that bound is not optional.
       *
       * The first version approved every waiting run at once. The queue is bounded, so most of those enqueues
       * were **refused** — and because the transition had already happened, each refused run was left in
       * `queued` with no job. `settle` then saw non-terminal runs, asked for `waiting-for-approval` runs, got
       * none, and spun until its timeout. 1,293 runs orphaned this way in one soak.
       *
       * Which is the *same failure shape* as the platform bug this harness found an hour earlier: a run in
       * `queued` that nothing will ever pick up. I introduced it in my own code by copying the fix's ordering
       * without noticing that a bounded queue can refuse. Transition-then-enqueue is only safe when the enqueue
       * cannot fail, so the batch is limited to the room actually available.
       */
      const room = Math.max(0, config.maxQueueDepth - queue.depth());
      if (room === 0) return [];

      const rows = await sql.query<{ id: string; waited: string }>(
        // `keepalive_at` when present, else `created_at`. There is no `updated_at` on `runs` -- and the wait a
        // human actually imposes is measured from when the run stopped, which is its last keepalive.
        `SELECT id, EXTRACT(EPOCH FROM (now() - COALESCE(keepalive_at, created_at))) * 1000 AS waited
           FROM runs WHERE tenant_id = $1 AND status = 'waiting-for-approval'
          ORDER BY created_at
          LIMIT $2`,
        [config.tenantId, room],
      );
      const waited: number[] = [];
      for (const row of rows) {
        const runId = asId<RunId>(row.id);
        try {
          // Status *then* job, which is what `createApprovalService.decide` now does too. Enqueueing first lets a
          // worker take the job while the run is still paused, fail the claim, and drop the only job that would
          // have resumed it -- the bug this harness surfaced.
          await runs.transition({ tenantId: config.tenantId, id: runId, workerId: "loadtest-approver", to: "queued", now: new Date(now()).toISOString() });
          await queue.dispatcher.enqueueRun({ tenantId: config.tenantId, runId });
          const ms = Number(row.waited);
          if (Number.isFinite(ms)) waited.push(ms);
        } catch {
          // A run that moved on between the read and the write. Not a failure of the approval; the next round
          // picks it up. Swallowed so one bad row does not abandon the rest of the batch.
        }
      }
      return waited;
    };

  return {
    effects,
    queue,
    workers: handles,
    approvePending,
    async admit({ conversationId, runId }) {
      await runs.create({ tenantId: config.tenantId, id: runId, conversationId, agentId: AGENT, agentVersion: 1 });
      // Create first, then enqueue. The other order loses a run whose enqueue succeeded and whose row never
      // existed — the queue would hand a worker an id it cannot find, and the work is gone with nothing to
      // recover from.
      try {
        await queue.dispatcher.enqueueRun({ tenantId: config.tenantId, runId });
      } catch (error) {
        // A refused enqueue must not leave a `queued` row behind. The first version did, and the overload step
        // then reported 236 refused *and* 236 stuck — the same runs counted twice, once correctly as refusals and
        // once as lost work. A refused admission is not admitted work, so the row is cancelled and the caller
        // still sees the refusal.
        await runs
          .transition({ tenantId: config.tenantId, id: runId, workerId: "loadtest-admit", to: "cancelled", now: new Date(now()).toISOString() })
          .catch(() => undefined);
        throw error;
      }
      admittedIds.push(runId);
    },
    async terminalLatencies(prefix) {
      // From the store's own timestamps, admission to terminal. The first version of this measured the latency of
      // `admit()` — create plus enqueue — which is a few milliseconds however deep the backlog is. That made the
      // envelope say "p99 5ms, sustainable" while the queue was 200 jobs deep and throughput had flatlined: the
      // measurement flattered the system exactly where it was failing, which is worse than not measuring.
      const rows = await sql.query<{ id: string; ms: string }>(
        `SELECT id, EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000 AS ms
           FROM runs
          WHERE tenant_id = $1 AND id LIKE $2 AND status = 'completed' AND finished_at IS NOT NULL`,
        [config.tenantId, `${prefix}%`],
      );
      // Runs that paused for a human are **excluded**.
      //
      // Their end-to-end time is dominated by how fast the approver answered, which here is this harness's poll
      // interval and in production is a person. Mixing them in put p99 at ~7 seconds at *every* step and made the
      // envelope read "sustainable 0/s" — the platform's latency was 130ms and the number reported was the
      // harness's own scheduling. Approval wait is measured separately, for the same reason #143 keeps it a
      // distinct metric: it must be visibly not the platform's latency.
      return rows
        .filter((r) => runFate(r.id).b >= config.traffic.approvalRate)
        .map((r) => Number(r.ms))
        .filter((n) => Number.isFinite(n));
    },
    async terminalCount() {
      // Counted from the store, not from the harness's own tally. The harness's tally is what it *believes*
      // happened, and the entire question is whether the platform agrees.
      const rows = await sql.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM runs
          WHERE tenant_id = $1 AND status IN ('completed', 'failed', 'cancelled')`,
        [config.tenantId],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async statusCounts() {
      const rows = await sql.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*) AS n FROM runs WHERE tenant_id = $1 GROUP BY status`,
        [config.tenantId],
      );
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    },

        async settle({ idPrefix, timeoutMs }) {
      const approvalWaitsMs: number[] = [];
      const deadline = now() + timeoutMs;
      const counts = async () => {
        const rows = await sql.query<{ status: string; n: string }>(
          `SELECT status, COUNT(*) AS n FROM runs
            WHERE tenant_id = $1 AND id LIKE $2 GROUP BY status`,
          [config.tenantId, `${idPrefix}%`],
        );
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
      };

      for (;;) {
        await queue.drained();
        const byStatus = await counts();
        const pending =
          (byStatus["queued"] ?? 0) + (byStatus["running"] ?? 0) + (byStatus["waiting-for-approval"] ?? 0) +
          (byStatus["waiting-for-answer"] ?? 0) + (byStatus["retry-pending"] ?? 0);
        if (pending === 0) {
          return {
            completed: byStatus["completed"] ?? 0,
            failed: byStatus["failed"] ?? 0,
            stuck: 0,
            approvalWaitsMs,
          };
        }
        // Re-drive anything sitting in `queued` with no job. Belt as well as braces: the batch bound above should
        // make this unnecessary, and it is here because an orphan in `queued` is invisible -- it looks exactly
        // like a run waiting its turn, which is why the platform's version of this bug survived so long.
        const orphans = await sql.query<{ id: string }>(
          `SELECT id FROM runs WHERE tenant_id = $1 AND id LIKE $2 AND status = 'queued' LIMIT $3`,
          [config.tenantId, `${idPrefix}%`, Math.max(0, config.maxQueueDepth - queue.depth())],
        );
        for (const row of orphans)
          await queue.dispatcher
            .enqueueRun({ tenantId: config.tenantId, runId: asId<RunId>(row.id) })
            .catch(() => undefined);

        if (now() >= deadline) {
          const byStatusFinal = await counts();
          return {
            completed: byStatusFinal["completed"] ?? 0,
            failed: byStatusFinal["failed"] ?? 0,
            // Reported apart from `failed`, because they are different diagnoses: a failed run has an error and a
            // stuck one has nothing, and an operator needs to know which they are looking at.
            stuck: pending,
            // *Which* statuses are stuck. A count alone sent me guessing between four different explanations;
            // the breakdown answered it in one run.
            stuckByStatus: Object.fromEntries(
              Object.entries(byStatusFinal).filter(([status]) => status !== "completed" && status !== "failed" && status !== "cancelled"),
            ),
            approvalWaitsMs,
          };
        }
        // Anything waiting on a human is decided, then we go round again -- a resumed run can pause a second
        // time on a later step, and a single pass would leave those pending forever.
        approvalWaitsMs.push(...(await approvePending()));
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    },

    admittedCount: () => admittedIds.length,
    sample() {
      const memory = process.memoryUsage();
      return {
        atMs: now(),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        queueDepth: queue.depth(),
      };
    },
    async stop() {
      await Promise.all(handles.map((h) => h.shutdown()));
    },
  };
};

/**
 * One step of the load staircase.
 *
 * Offers a fixed rate for a fixed duration, then waits for the queue to drain before measuring. Measuring
 * without draining would attribute a step's backlog to the *next* step and the staircase would show capacity
 * that is really borrowed from earlier.
 */
export const runLoadStep = async (input: {
  readonly harness: Harness;
  readonly offeredPerSecond: number;
  readonly durationMs: number;
  readonly tenantId: TenantId;
  readonly startIndex: number;
  /** How long to wait for a step's work to finish before calling the remainder stuck. */
  readonly settleTimeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<LoadStep> => {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = 1_000 / input.offeredPerSecond;
  const samples: ResourceSample[] = [];
  let admitted = 0;
  let failed = 0;
  let refused = 0;
  const admitFailures: string[] = [];

  // A prefix unique to this step, so the store query reads this step's runs and not the whole staircase's. Without
  // it, every step would report the cumulative latency distribution and each step would look better than the last.
  const prefix = `load-s${input.offeredPerSecond}-`;
  const startedAt = now();
  let index = input.startIndex;
  const inFlight: Promise<void>[] = [];

  while (now() - startedAt < input.durationMs) {
    const runId = asId<RunId>(`${prefix}${index}`);
    const conversationId = asId<ConversationId>(`load-c${index % 50}`);
    index += 1;
    inFlight.push(
      input.harness
        .admit({ conversationId, runId })
        .then(() => {
          admitted += 1;
        })
        .catch((error: unknown) => {
          // A refusal and a failure are counted apart, because they mean opposite things about the system: one is
          // it working, the other is it not. Folding them together is how a correctly back-pressuring system
          // gets "fixed" by removing the backpressure.
          if ((error as { code?: string } | null)?.code === "resource-exhausted") refused += 1;
          else {
            failed += 1;
            // The first *distinct* reason, capped. A step reporting "12 failed" with no reason sends whoever
            // reads it back to reproduce the run; one reason line usually ends the investigation.
            const reason = `${(error as { code?: string } | null)?.code ?? "unknown"}: ${String(error).slice(0, 120)}`;
            if (!admitFailures.includes(reason) && admitFailures.length < 5) admitFailures.push(reason);
          }
        }),
    );
    samples.push(input.harness.sample());
    await sleep(gapMs);
  }

  await Promise.allSettled(inFlight);
  // Settle *before* measuring, and count the settling in the duration. Measuring at the end of the offer window
  // instead would attribute this step's backlog to the next one, and the staircase would show capacity borrowed
  // from earlier steps.
  const settled = await input.harness.settle({ idPrefix: prefix, timeoutMs: input.settleTimeoutMs ?? 30_000 });
  const latencies = await input.harness.terminalLatencies(prefix);
  const terminalMs = now() - startedAt;
  // `admitted` is a cross-check on the store, not a source: a mismatch means the harness and the platform
  // disagree about what was accepted, which is worth knowing and is not the same as a failure.
  void admitted;

  return {
    offeredPerSecond: input.offeredPerSecond,
    latency: summarizeLatency(latencies),
    // Completions from the **store's own status column**, not from what `admit()` resolved. A step that accepted
    // 160 and finished 55 has not sustained 160/s, and only the store can say which number is which. A stuck run
    // counts as a failure here — it did not complete, and the report keeps the two apart.
    throughput: summarizeThroughput({
      completed: settled.completed,
      failed: failed + settled.failed + settled.stuck,
      refused,
      durationMs: terminalMs,
    }),
    peakRssBytes: Math.max(0, ...samples.map((s) => s.rssBytes)),
    peakQueueDepth: Math.max(0, ...samples.map((s) => s.queueDepth ?? 0)),
    ...(admitFailures.length > 0 ? { admitFailures } : {}),
    ...(settled.stuck > 0 ? { stuck: settled.stuck, stuckByStatus: settled.stuckByStatus } : {}),
  };
};

export { detectGrowth };
