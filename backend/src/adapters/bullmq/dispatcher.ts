/**
 * BullMQ/Redis `JobDispatcher` (#105) — the durable enqueue behind `POST /runs`.
 *
 * `JobDispatcher` has always been documented as *"Adapters: BullMQ, in-memory for tests"* and only the
 * in-memory half existed, so work enqueued by the API died with the process holding it. That is the
 * premise REQ-015 exists to fix.
 *
 * The `bullmq` import is confined to this directory (the boundary checker expects it here), and the
 * dispatcher is written against a small `JobQueue` seam that BullMQ's `Queue` satisfies structurally.
 * That keeps the port testable without Redis and keeps the real client one function away — the same
 * arrangement the Supabase Realtime adapter uses.
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { JobDispatcher } from "../../runtime/index.js";
import type { RunId, TenantId } from "../../core/ids.js";

/** The queue surface this adapter needs. BullMQ's `Queue` satisfies it structurally. */
export interface JobQueue {
  add(
    name: string,
    data: RunJobData,
    opts?: { readonly jobId?: string; readonly attempts?: number },
  ): Promise<unknown>;
  getJobCounts(
    ...types: readonly string[]
  ): Promise<Record<string, number>>;
  close?(): Promise<void>;
}

/** What a worker needs to execute the run. The tenant travels with the job, not with the queue. */
export type RunJobData = {
  readonly tenantId: string;
  readonly runId: string;
};

// Hyphen, not a colon. BullMQ rejects a queue name containing `:` outright ("Queue name cannot
// contain :"), because it builds its own Redis keys as `bull:<name>:<...>` and a colon in the name
// would make those keys ambiguous. Caught by running against real Redis — a fake queue accepts any
// string, so this would have thrown on the first enqueue in production.
export const RUN_QUEUE_NAME = "agentkit-runs";
export const RUN_JOB_NAME = "run";

/**
 * The job id: tenant-qualified, colon-free, and unambiguous.
 *
 * **Why the tenant is in it.** The SPEC says "job id derived from `runId`". Derived from the run id
 * **alone** it is a cross-tenant fault: `enqueueRun` takes `{ tenantId, runId }`, and BullMQ treats an
 * existing `jobId` as a no-op returning the existing job — so if two tenants ever present the same run
 * id, the second tenant's enqueue is **silently dropped**. The symptom is a run that never executes,
 * with no error anywhere.
 *
 * **Why the encoding looks like this.** BullMQ rejects a custom id containing `:` outright ("Custom Id
 * cannot contain :"), because ids become part of its Redis key structure. Found by running against a
 * real Redis; a fake queue accepts any string, so `tenant:run` passed every offline test and would
 * have failed on the first real enqueue.
 *
 * A naive `${tenantId}-${runId}` would be colon-free but **ambiguous**: tenant `a-b` with run `c` and
 * tenant `a` with run `b-c` produce the same id, and an ambiguous id is a *collision* — one of the two
 * runs disappears. So `:` and `%` are percent-escaped first (an injective mapping), and the escaped
 * tenant is length-prefixed, which makes the split unique regardless of what the ids contain.
 *
 * What this dedup does and does not buy is worth being precise about, because it is easy to mistake
 * for the idempotency story:
 *
 * - it stops an accidental *concurrent* double-enqueue, which is AC-2;
 * - it stops nothing once the job is removed from Redis, so re-enqueuing a *finished* run is the
 *   `RunStore`'s problem (#93), not the queue's;
 * - a *tool call* repeating a side effect is `IdempotencyStore`'s problem (#100).
 */
const escapeIdPart = (value: string): string => value.replace(/%/g, "%25").replace(/:/g, "%3A");

export const runJobId = (input: { readonly tenantId: string; readonly runId: string }): string => {
  const tenant = escapeIdPart(input.tenantId);
  const run = escapeIdPart(input.runId);
  return `${tenant.length}-${tenant}-${run}`;
};

/**
 * Queue-level attempts. Deliberately 1.
 *
 * The runtime owns retries (`DEFAULT_RETRY_POLICY`: 5 attempts, 0.5s base, ×2, −25% jitter,
 * `retry-after` honoured). A queue-level `attempts > 1` would multiply with it — five runtime attempts
 * inside three queue attempts is fifteen provider calls, with backoff neither layer intended. AC-3 is
 * exactly this constant.
 */
export const QUEUE_ATTEMPTS = 1;

const unavailable = (cause: unknown) =>
  new AgentPlatformError(
    {
      code: "provider_unavailable",
      message: "Could not enqueue the run: the job queue is unreachable",
      retryable: true,
    },
    { cause },
  );

export type JobDispatcherOptions = {
  /** Ceiling on a single enqueue. Without one, a half-open connection turns into a stalled request. */
  readonly enqueueTimeoutMs?: number;
};

export const createBullMqJobDispatcher = (
  queue: JobQueue,
  options: JobDispatcherOptions = {},
): JobDispatcher => {
  const timeoutMs = options.enqueueTimeoutMs ?? 5_000;

  return {
    async enqueueRun({ tenantId, runId }: { tenantId: TenantId; runId: RunId }): Promise<void> {
      const add = queue.add(
        RUN_JOB_NAME,
        { tenantId, runId },
        { jobId: runJobId({ tenantId, runId }), attempts: QUEUE_ATTEMPTS },
      );

      // Belt as well as braces. `enableOfflineQueue: false` makes ioredis reject rather than buffer,
      // but a connection that is open-but-dead fails neither way — it just never answers. AC-4 is
      // about the caller getting an error, so the timeout is part of the guarantee, not a nicety.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          add,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(unavailable(new Error(`enqueue timed out after ${timeoutMs}ms`))), timeoutMs);
          }),
        ]);
      } catch (error) {
        // Rethrown unchanged if it is already ours, so the timeout message survives; otherwise wrapped,
        // because a driver error should not reach the API layer as a driver error.
        throw error instanceof AgentPlatformError ? error : unavailable(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // The losing promise must not become an unhandled rejection when the timeout wins.
        void Promise.resolve(add).catch(() => undefined);
      }
    },
  };
};

export type QueueMetrics = {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly completed: number;
};

/**
 * Queue depth and failure counts (AC-5), for the observability work in REQ-033.
 *
 * Zero-filled rather than optional: a dashboard that has to distinguish "no failures" from "the count
 * was missing" will get it wrong, and the difference is not interesting.
 */
export const queueMetrics = async (queue: JobQueue): Promise<QueueMetrics> => {
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
  const at = (key: string): number => Number(counts[key] ?? 0);
  return {
    waiting: at("waiting"),
    active: at("active"),
    delayed: at("delayed"),
    failed: at("failed"),
    completed: at("completed"),
  };
};
