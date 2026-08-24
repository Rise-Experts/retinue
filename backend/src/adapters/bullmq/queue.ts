/**
 * The real BullMQ queue and its connection policy (#105).
 *
 * Separate from `dispatcher.ts` so the dispatcher stays testable without Redis, and so the connection
 * decisions — which are the interesting part — sit in one place with their reasons.
 */
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_ATTEMPTS, RUN_QUEUE_NAME, type JobQueue } from "./dispatcher.js";

export type RunQueueOptions = {
  readonly url: string;
  /** Ceiling on establishing a connection. */
  readonly connectTimeoutMs?: number;
  /** Completed/failed jobs to retain. Retained, not zero — see below. */
  readonly keepCompleted?: number;
  readonly keepFailed?: number;
};

/**
 * `ioredis` options chosen for a *producer*, which wants to fail fast.
 *
 * `enableOfflineQueue: false` is the one AC-4 turns on. By default ioredis buffers commands while
 * disconnected, so `queue.add()` would sit there until the connection came back — the hang the AC
 * names. With it off, the command rejects immediately and the dispatcher can wrap that into a typed
 * error the API layer can turn into a real response.
 *
 * `maxRetriesPerRequest: 1` for the same reason: a producer would rather tell the caller now than
 * retry silently behind a request that is already waiting. Note this is deliberately **not** the right
 * setting for a BullMQ *worker* connection, which needs `maxRetriesPerRequest: null` for its blocking
 * reads — a worker built here would need its own connection, not this one.
 *
 * `retryStrategy` backs off with jitter and gives up climbing at 2s, so a flapping Redis produces a
 * steady trickle of reconnects rather than a thundering herd from every process at once.
 */
export const createRunQueueConnection = (options: RunQueueOptions): Redis =>
  new Redis(options.url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: options.connectTimeoutMs ?? 3_000,
    lazyConnect: true,
    retryStrategy: (attempt) => {
      const base = Math.min(2_000, 100 * 2 ** Math.min(attempt, 5));
      // Deterministic-ish jitter without Math.random, so a retry schedule is reproducible from the
      // attempt number when reading logs.
      return base - (base * (attempt % 4)) / 16;
    },
  });

/**
 * The run queue.
 *
 * `removeOnComplete` keeps a bounded history rather than zero. Two reasons: AC-5's counts are more
 * useful with a completed window, and a zero-retention queue makes it tempting to read `jobId` dedup
 * as durable idempotency — it is not, since a removed job's id is immediately reusable. What stops a
 * finished run being re-executed is `RunStore`, not this.
 *
 * `attempts` comes from the shared constant so the queue and the dispatcher cannot disagree about
 * whose retry policy is in force (AC-3).
 */
export const createBullMqRunQueue = (
  options: RunQueueOptions,
): JobQueue & { readonly queue: Queue; close(): Promise<void> } => {
  const connection = createRunQueueConnection(options);
  const queue = new Queue(RUN_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: QUEUE_ATTEMPTS,
      removeOnComplete: { count: options.keepCompleted ?? 1_000 },
      removeOnFail: { count: options.keepFailed ?? 5_000 },
    },
  });

  return {
    queue,
    add: (name, data, opts) => queue.add(name, data, opts),
    getJobCounts: (...types) => queue.getJobCounts(...(types as never[])),
    /**
     * Exposed so the dispatcher can clear a **finished** job holding a reusable id (#156).
     *
     * This object deliberately narrows the BullMQ `Queue` to the few methods the port needs, which is right — but
     * it meant adding `getJob` to `JobQueue` and to the dispatcher changed nothing at all, because the method was
     * never on the object the dispatcher received. The fix type-checked, the test against a raw `Queue` passed,
     * and the real deployment silently kept the old behaviour: every approval resume still sat in `queued`.
     *
     * A narrowing wrapper is a second place every capability has to be added, and forgetting is invisible.
     */
    getJob: (jobId) => queue.getJob(jobId) as never,
    async close() {
      await queue.close();
      // The queue closes its own connection only when it created it; this one was injected.
      await connection.quit().catch(() => undefined);
    },
  };
};
