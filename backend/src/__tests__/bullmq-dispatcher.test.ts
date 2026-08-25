/**
 * BullMQ `JobDispatcher` (#105).
 *
 * Split deliberately. The cases over the `JobQueue` seam need no Redis and assert the decisions —
 * tenant-qualified job id, `attempts: 1`, typed failure — which are the parts most likely to be
 * changed later by someone who does not know why they are that way. The integration block needs a
 * real Redis and asserts the behaviours a fake queue cannot: that a job survives having no worker,
 * and that BullMQ itself dedupes the id.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentPlatformError } from "../core/errors.js";
import { asId } from "../core/ids.js";
import type { RunId, TenantId } from "../core/ids.js";
import type { JobDispatcher } from "../runtime/index.js";
import {
  createBullMqJobDispatcher,
  QUEUE_ATTEMPTS,
  queueMetrics,
  RUN_JOB_NAME,
  RUN_QUEUE_NAME,
  runJobId,
  type JobQueue,
  type RunJobData,
} from "../adapters/bullmq/index.js";

const T1 = asId<TenantId>("bmq-t1");
const T2 = asId<TenantId>("bmq-t2");
const RUN = asId<RunId>("bmq-run1");
const REDIS_URL = process.env["RETINUE_TEST_REDIS_URL"];

type Recorded = { name: string; data: RunJobData; opts?: { jobId?: string; attempts?: number } };

/** A queue that records what it was asked to do, and can be told to fail. */
const recordingQueue = (behaviour: { readonly rejectWith?: unknown; readonly hang?: boolean } = {}) => {
  const calls: Recorded[] = [];
  const queue: JobQueue = {
    async add(name, data, opts) {
      calls.push({ name, data, ...(opts === undefined ? {} : { opts }) });
      if (behaviour.hang === true) return new Promise(() => {});
      if (behaviour.rejectWith !== undefined) throw behaviour.rejectWith;
      // BullMQ returns the *existing* job when the id is already present, which is the dedup this
      // adapter relies on; the fake mirrors the shape, not the dedup.
      return { id: opts?.jobId };
    },
    async getJobCounts(...types) {
      return Object.fromEntries(types.map((t, i) => [t, i]));
    },
  };
  return { queue, calls };
};

describe("job identity", () => {
  it("qualifies the job id with the tenant, not just the run", async () => {
    const { queue, calls } = recordingQueue();
    const dispatcher = createBullMqJobDispatcher(queue);
    await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });
    await dispatcher.enqueueRun({ tenantId: T2, runId: RUN });

    // The SPEC said "derived from runId". Derived from the run id alone, two tenants presenting the
    // same run id collide — BullMQ returns the existing job for a duplicate id, so the second tenant's
    // enqueue is silently dropped and its run simply never executes.
    expect(new Set(calls.map((c) => c.opts?.jobId)).size).toBe(2);
    // And colon-free: BullMQ rejects a custom id containing `:` ("Custom Id cannot contain :"),
    // which only a real Redis reveals — a fake queue accepts any string.
    for (const call of calls) expect(call.opts?.jobId).not.toContain(":");
  });

  it("derives the id purely from tenant and run, so a retry computes the same one", () => {
    // Dedup only works if the id is a pure function of the run's identity. Anything time- or
    // attempt-dependent would produce a fresh id per attempt and defeat AC-2 entirely.
    expect(runJobId({ tenantId: T1, runId: RUN })).toBe(runJobId({ tenantId: T1, runId: RUN }));
    expect(runJobId({ tenantId: T1, runId: RUN })).not.toBe(runJobId({ tenantId: T2, runId: RUN }));
  });

  it("cannot be made ambiguous by a separator inside either id", () => {
    // The collision a naive `${tenant}-${run}` would allow: tenant "a-b" + run "c" and tenant "a" +
    // run "b-c" would produce the same id, and an ambiguous id means one of the two runs silently
    // disappears. Length-prefixing the tenant makes the split unique.
    expect(runJobId({ tenantId: "a-b", runId: "c" })).not.toBe(runJobId({ tenantId: "a", runId: "b-c" }));
    // Colons in the ids themselves are escaped rather than passed through to BullMQ.
    const withColon = runJobId({ tenantId: "org:1", runId: "run:2" });
    expect(withColon).not.toContain(":");
    // Escaping stays injective, so two ids that differ only in an escaped character stay distinct.
    expect(runJobId({ tenantId: "org:1", runId: "r" })).not.toBe(runJobId({ tenantId: "org%3A1", runId: "r" }));
  });

  it("carries the tenant in the job data, so a worker can scope its stores", async () => {
    const { queue, calls } = recordingQueue();
    await createBullMqJobDispatcher(queue).enqueueRun({ tenantId: T1, runId: RUN });
    expect(calls[0]).toMatchObject({ name: RUN_JOB_NAME, data: { tenantId: T1, runId: RUN } });
    // A colon here would be rejected by BullMQ at construction — it builds keys as `bull:<name>:…`.
    expect(RUN_QUEUE_NAME).toBe("agentkit-runs");
    expect(RUN_QUEUE_NAME).not.toContain(":");
  });
});

/** AC-3. The number, asserted from what the adapter actually passes. */
describe("retries stay the runtime's", () => {
  it("enqueues with attempts: 1", async () => {
    const { queue, calls } = recordingQueue();
    await createBullMqJobDispatcher(queue).enqueueRun({ tenantId: T1, runId: RUN });
    // A queue-level attempts > 1 would multiply with DEFAULT_RETRY_POLICY's five: five runtime
    // attempts inside three queue attempts is fifteen provider calls, with backoff neither layer
    // intended and no single place that describes the resulting behaviour.
    expect(calls[0]?.opts?.attempts).toBe(1);
    expect(QUEUE_ATTEMPTS).toBe(1);
  });
});

/** AC-4. A typed error, and no waiting for one. */
describe("unreachable Redis", () => {
  it("wraps a driver rejection in a retryable platform error", async () => {
    const { queue } = recordingQueue({ rejectWith: new Error("ECONNREFUSED 127.0.0.1:6379") });
    const error = await createBullMqJobDispatcher(queue)
      .enqueueRun({ tenantId: T1, runId: RUN })
      .then(
        () => null,
        (e: unknown) => e,
      );

    // A driver error must not reach the API layer as a driver error: the layer above decides between
    // retry and 503 from the code, and it cannot read ioredis exceptions.
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect((error as AgentPlatformError).code).toBe("provider_unavailable");
    expect((error as AgentPlatformError).retryable).toBe(true);
    // The cause is preserved, because the operator needs to know *which* failure it was.
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("times out rather than hanging when the queue never answers", async () => {
    const { queue } = recordingQueue({ hang: true });
    const started = Date.now();
    const error = await createBullMqJobDispatcher(queue, { enqueueTimeoutMs: 50 })
      .enqueueRun({ tenantId: T1, runId: RUN })
      .then(
        () => null,
        (e: unknown) => e,
      );
    // The case `enableOfflineQueue: false` does not cover: a connection that is open but dead rejects
    // nothing, it just never answers. Without the timeout the caller's request stalls indefinitely,
    // which is exactly the hang AC-4 names.
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect((error as AgentPlatformError).code).toBe("provider_unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/** AC-5. */
describe("queue metrics", () => {
  it("reports every counter as a number, zero-filled", async () => {
    const { queue } = recordingQueue();
    const metrics = await queueMetrics(queue);
    // Zero-filled rather than optional: a dashboard forced to distinguish "no failures" from "the
    // count was missing" will get it wrong, and the difference is not interesting.
    expect(Object.keys(metrics).sort()).toEqual(["active", "completed", "delayed", "failed", "waiting"]);
    for (const value of Object.values(metrics)) expect(Number.isInteger(value)).toBe(true);
  });

  it("treats an absent counter as zero rather than NaN", async () => {
    const queue: JobQueue = {
      async add() {
        return {};
      },
      async getJobCounts() {
        return {}; // a Redis that answered with nothing useful
      },
    };
    expect(await queueMetrics(queue)).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    });
  });
});

/** AC-6. The port is unchanged, so nothing that depends on it needed to move. */
describe("the port is untouched", () => {
  it("satisfies JobDispatcher structurally, with enqueueRun as its only method", () => {
    const { queue } = recordingQueue();
    const dispatcher: JobDispatcher = createBullMqJobDispatcher(queue);
    // If this adapter had needed a wider port, every existing caller would have had to change. The
    // assertion is that it did not: one method, same shape as the in-memory dispatcher.
    expect(Object.keys(dispatcher)).toEqual(["enqueueRun"]);
    expect(typeof dispatcher.enqueueRun).toBe("function");
  });
});

// ---------------------------------------------------------------------------------------------
// Real Redis. Skipped by name when unset, never silently.
// ---------------------------------------------------------------------------------------------

describe("against a real Redis", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers) await close();
  });

  if (REDIS_URL === undefined) {
    it("[skipped: RETINUE_TEST_REDIS_URL unset — a fake queue cannot show that a job survives having no worker]", () => {
      expect(REDIS_URL).toBeUndefined();
    });
  } else {
    /** A queue on its own key prefix, so a run of this file cannot see another's jobs. */
    const freshQueue = async (suffix: string) => {
      const { Queue } = await import("bullmq");
      const { Redis } = await import("ioredis");
      const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      const queue = new Queue(`${RUN_QUEUE_NAME}-${suffix}`, { connection });
      await queue.obliterate({ force: true }).catch(() => undefined);
      closers.push(async () => {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close().catch(() => undefined);
        await connection.quit().catch(() => undefined);
      });
      return { queue, connection, name: `${RUN_QUEUE_NAME}-${suffix}` };
    };

    /**
     * #156. A run that suspended and was re-enqueued must actually be queued again.
     *
     * `runJobId` is deterministic, and BullMQ retains a completed job under `removeOnComplete` — so the
     * re-enqueue after an approval decision was silently a no-op, and every HITL resume sat in `queued` forever
     * with no job and no lease.
     *
     * Against real Redis, because that is the only place the collision exists: a fake queue does not retain a
     * completed job under a reusable id, so this test would pass on the broken code with any stand-in.
     */
    it("re-enqueues a run whose previous job already completed", async () => {
      const { queue, name } = await freshQueue("resume");
      const dispatcher = createBullMqJobDispatcher(queue as unknown as JobQueue);

      const { Worker } = await import("bullmq");
      const { Redis } = await import("ioredis");
      const workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      const executed: RunJobData[] = [];
      const worker = new Worker(name, async (job) => { executed.push(job.data as RunJobData); }, {
        connection: workerConnection,
      });
      closers.push(async () => {
        await worker.close().catch(() => undefined);
        await workerConnection.quit().catch(() => undefined);
      });

      // First pass: the run executes and its job completes — exactly what happens when a run suspends for an
      // approval, since the worker's unit of work is finished.
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });
      await vi.waitFor(() => expect(executed).toHaveLength(1), { timeout: 5_000 });
      await vi.waitFor(async () => {
        expect(await queue.getJobCountByTypes("completed")).toBe(1);
      }, { timeout: 5_000 });

      // The resume. Same tenant, same run, therefore the same job id.
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });

      // It runs a second time. Before the fix this assertion failed: `add` was a no-op and `executed` stayed at 1.
      await vi.waitFor(() => expect(executed).toHaveLength(2), { timeout: 5_000 });
      expect(executed[1]).toMatchObject({ tenantId: T1, runId: RUN });
    });

    /**
     * The other half, and the reason the fix clears only *finished* jobs.
     *
     * #105's guarantee is that two enqueues of a run that has not run yet collapse into one job. A fix that
     * cleared the id unconditionally would break that and this test would catch it — which is the point of
     * asserting both directions rather than only the one that was broken.
     */
    it("still collapses two enqueues of a run that has not run yet", async () => {
      const { queue } = await freshQueue("dedup");
      const dispatcher = createBullMqJobDispatcher(queue as unknown as JobQueue);

      // No worker: the job stays `waiting`, which is a live duplicate rather than history.
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });

      expect((await queueMetrics(queue as unknown as JobQueue)).waiting).toBe(1);
    });

    it("executes work enqueued before any worker existed, exactly once", async () => {
      const { queue, name } = await freshQueue("ac1");
      const dispatcher = createBullMqJobDispatcher(queue as unknown as JobQueue);

      // Enqueued with nothing consuming. This is the property the in-memory dispatcher cannot have:
      // the job is in Redis, not in this process.
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });
      expect((await queueMetrics(queue as unknown as JobQueue)).waiting).toBe(1);

      const { Worker } = await import("bullmq");
      const { Redis } = await import("ioredis");
      const workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      const executed: RunJobData[] = [];
      const worker = new Worker(
        name,
        async (job) => {
          executed.push(job.data as RunJobData);
        },
        { connection: workerConnection },
      );
      closers.push(async () => {
        await worker.close().catch(() => undefined);
        await workerConnection.quit().catch(() => undefined);
      });

      await new Promise<void>((resolve) => {
        worker.on("completed", () => resolve());
      });
      expect(executed).toEqual([{ tenantId: T1, runId: RUN }]);
    }, 30_000);

    it("collapses a double enqueue into exactly one job", async () => {
      const { queue } = await freshQueue("ac2");
      const dispatcher = createBullMqJobDispatcher(queue as unknown as JobQueue);
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });
      // BullMQ's own dedup, not the adapter's — which is why this case needs real Redis.
      expect((await queueMetrics(queue as unknown as JobQueue)).waiting).toBe(1);
    }, 30_000);

    it("keeps two tenants' identically-named runs as separate jobs", async () => {
      const { queue } = await freshQueue("tenant-split");
      const dispatcher = createBullMqJobDispatcher(queue as unknown as JobQueue);
      await dispatcher.enqueueRun({ tenantId: T1, runId: RUN });
      await dispatcher.enqueueRun({ tenantId: T2, runId: RUN });
      // The correction, proven against the real dedup: with a run-id-only job id this would be 1, and
      // one tenant's run would have vanished without an error.
      expect((await queueMetrics(queue as unknown as JobQueue)).waiting).toBe(2);
    }, 30_000);

    it("fails with a typed error when Redis is unreachable, within the timeout", async () => {
      const { Queue } = await import("bullmq");
      const { Redis } = await import("ioredis");
      // A port nothing listens on. `enableOfflineQueue: false` is what turns this into a rejection
      // instead of a command buffered until a connection that never arrives.
      const connection = new Redis("redis://127.0.0.1:6390", {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 300,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      const queue = new Queue(`${RUN_QUEUE_NAME}-dead`, { connection });
      closers.push(async () => {
        await queue.close().catch(() => undefined);
        connection.disconnect();
      });

      const started = Date.now();
      const error = await createBullMqJobDispatcher(queue as unknown as JobQueue, { enqueueTimeoutMs: 2_000 })
        .enqueueRun({ tenantId: T1, runId: RUN })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(AgentPlatformError);
      expect((error as AgentPlatformError).code).toBe("provider_unavailable");
      expect((error as AgentPlatformError).retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    }, 30_000);
  }
});
