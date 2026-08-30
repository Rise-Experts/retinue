/**
 * The extraction worker and its queue (#131).
 *
 * Two properties that only exist at this layer, and both are about *which failures the queue should retry*:
 *
 * - A document that cannot be read must **complete** the job. Retrying a scan with no text layer produces the
 *   same answer at the same cost forever, and a queue full of them starves real work.
 * - An unreachable store must **fail** the job, so the queue does retry it. Getting these two the same way
 *   round is the whole point of the distinction the pipeline draws between a record and a throw.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { FileId, TenantId } from "../core/ids.js";
import { AgentPlatformError } from "../core/errors.js";
import { createExtractionWorker } from "../worker/extraction.js";
import type { ExtractionConsumer } from "../worker/extraction.js";
import type { ExtractionJob } from "../documents/index.js";
import type { ExtractionService } from "../documents/extraction.js";
import type { FileExtraction } from "../persistence/index.js";
import {
  EXTRACTION_JOB_NAME,
  createBullMqExtractionDispatcher,
  extractionJobId,
} from "../adapters/bullmq/extraction.js";
import { runJobId } from "../adapters/bullmq/dispatcher.js";
import { EXPORT_JOB_NAME, createBullMqExportDispatcher, exportJobId } from "../adapters/bullmq/export.js";
import { createExportWorker } from "../worker/export.js";


/**
 * The value a `.catch((e) => e)` produced, asserted to actually be an error.
 *
 * Without it, `expect(error.message).toContain(...)` reads `undefined` when the call *succeeded* — and
 * `expect(undefined).toContain(...)` fails, so this particular shape is not vacuous. It is still worth
 * narrowing: the failure then names what came back instead of reporting a missing property.
 */
const thrown = (value: unknown): Error => {
  if (!(value instanceof Error)) throw new Error(`expected the call to reject, and it returned ${JSON.stringify(value)}`);
  return value;
};

const T1 = asId<TenantId>("tenant-1");
const F1 = asId<FileId>("file-1");

/** A consumer whose handler the test drives directly, so ordering is asserted rather than awaited. */
const manualConsumer = () => {
  let handler: ((job: ExtractionJob) => Promise<void>) | null = null;
  let stopped = false;
  const consumer: ExtractionConsumer = {
    start(h) {
      handler = h;
    },
    async stop() {
      stopped = true;
    },
  };
  return {
    consumer,
    deliver: (job: ExtractionJob) => handler?.(job) ?? Promise.resolve(),
    get stopped() {
      return stopped;
    },
  };
};

const serviceReturning = (outcome: FileExtraction | Error): ExtractionService =>
  ({
    async extract() {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  }) as unknown as ExtractionService;

describe("the extraction worker", () => {
  it("completes the job when a document cannot be read", async () => {
    // The important one. A failed *document* is a successful *job*: the outcome is recorded, and a retry
    // would burn a worker on the same answer forever.
    const consumer = manualConsumer();
    const worker = createExtractionWorker({
      extraction: serviceReturning({ state: "failed", failureReason: "no-text-layer", failureMessage: "scan" }),
      consumer: consumer.consumer,
    });
    await worker.start();
    await expect(consumer.deliver({ tenantId: T1, fileId: F1 })).resolves.toBeUndefined();
    expect(worker.status()).toMatchObject({ processed: 1, failed: 1 });
  });

  it("fails the job when the store is unreachable, so the queue retries it", async () => {
    // The other direction. A brief outage is exactly what a retry is for, and swallowing it would drop the
    // extraction silently.
    const consumer = manualConsumer();
    const worker = createExtractionWorker({
      extraction: serviceReturning(
        new AgentPlatformError({ code: "provider_unavailable", message: "down", retryable: true }),
      ),
      consumer: consumer.consumer,
    });
    await worker.start();
    await expect(consumer.deliver({ tenantId: T1, fileId: F1 })).rejects.toThrow(/down/);
    expect(worker.status()).toMatchObject({ processed: 0 });
  });

  it("reports each outcome to the observability hook", async () => {
    const seen: FileExtraction[] = [];
    const consumer = manualConsumer();
    const worker = createExtractionWorker({
      extraction: serviceReturning({ state: "extracted", blockCount: 3 }),
      consumer: consumer.consumer,
      onOutcome: (_job, extraction) => seen.push(extraction),
    });
    await worker.start();
    await consumer.deliver({ tenantId: T1, fileId: F1 });
    expect(seen).toEqual([{ state: "extracted", blockCount: 3 }]);
    expect(worker.status()).toMatchObject({ processed: 1, failed: 0 });
  });

  it("stops accepting before it waits for in-flight work", async () => {
    // Draining first would accept a job it has no intention of finishing — the same rule the run worker's
    // `JobConsumer` states.
    const consumer = manualConsumer();
    const worker = createExtractionWorker({
      extraction: serviceReturning({ state: "extracted" }),
      consumer: consumer.consumer,
    });
    await worker.start();
    const result = await worker.shutdown("test");
    expect(consumer.stopped).toBe(true);
    expect(result.graceful).toBe(true);
    expect(worker.status().running).toBe(false);
  });

  it("defaults to lower concurrency than the run worker", async () => {
    // Extraction is CPU-bound: four concurrent PDF parses on one event loop is four slow parses, not four
    // fast ones.
    const consumer = manualConsumer();
    const worker = createExtractionWorker({
      extraction: serviceReturning({ state: "extracted" }),
      consumer: consumer.consumer,
    });
    expect(worker.concurrency).toBeLessThan(4);
  });
});

describe("the BullMQ extraction dispatcher", () => {
  const fakeQueue = () => {
    const added: { name: string; data: unknown; opts?: { jobId?: string; attempts?: number } }[] = [];
    return {
      added,
      async add(name: string, data: unknown, opts?: { jobId?: string; attempts?: number }) {
        added.push({ name, data, opts });
        return {};
      },
    };
  };

  it("enqueues with a tenant-qualified, deduplicating job id", async () => {
    const queue = fakeQueue();
    await createBullMqExtractionDispatcher(queue).enqueueExtraction({ tenantId: T1, fileId: F1 });
    expect(queue.added).toHaveLength(1);
    expect(queue.added[0]).toMatchObject({
      name: EXTRACTION_JOB_NAME,
      data: { tenantId: T1, fileId: F1 },
      // `attempts: 1` because the caller owns retries; two retry policies multiply into backoff neither
      // layer intended.
      opts: { jobId: extractionJobId({ tenantId: T1, fileId: F1 }), attempts: 1 },
    });
  });

  it("builds an id that cannot collide across tenants", async () => {
    // `${tenant}-${file}` is ambiguous: tenant `a-b`/file `c` and tenant `a`/file `b-c` produce the same
    // string, and an ambiguous id is a *collision* — BullMQ treats an existing id as a no-op, so one
    // tenant's extraction is silently dropped. Shared with `runJobId` so there is one implementation of the
    // length-prefix fix rather than two.
    expect(extractionJobId({ tenantId: "a-b", fileId: "c" })).not.toBe(
      extractionJobId({ tenantId: "a", fileId: "b-c" }),
    );
    expect(extractionJobId({ tenantId: T1, fileId: F1 })).toBe(runJobId({ tenantId: T1, runId: F1 }));
  });

  it("contains no colon, which BullMQ rejects outright", async () => {
    // Found on real Redis for the run queue: a fake queue accepts any string, so this would have thrown on
    // the first production enqueue.
    expect(extractionJobId({ tenantId: "a:b", fileId: "c:d" })).not.toContain(":");
  });

  it("reports an unreachable queue as retryable rather than hanging", async () => {
    const dispatcher = createBullMqExtractionDispatcher(
      {
        async add() {
          // Never resolves: a connection that is open-but-dead fails neither fast nor at all, which is why
          // the timeout is part of the guarantee.
          return new Promise(() => {});
        },
      },
      { enqueueTimeoutMs: 20 },
    );
    const error = await dispatcher
      .enqueueExtraction({ tenantId: T1, fileId: F1 })
      .catch((e: AgentPlatformError) => e);
    expect(error).toMatchObject({ code: "provider_unavailable", retryable: true });
  });

  it("wraps a driver error rather than letting it reach the caller raw", async () => {
    const dispatcher = createBullMqExtractionDispatcher({
      async add() {
        throw new Error("ECONNREFUSED");
      },
    });
    const error = await dispatcher
      .enqueueExtraction({ tenantId: T1, fileId: F1 })
      .catch((e: AgentPlatformError) => e);
    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect(thrown(error).message).toMatch(/job queue is unreachable/);
  });
});

// ---------------------------------------------------------------------------------------------
// The export worker and queue (#134). Same shape, and the same two properties that only exist at
// this layer: which failures the queue should retry.
// ---------------------------------------------------------------------------------------------

describe("the export worker", () => {
  const manualExportConsumer = () => {
    let handler: ((job: { tenantId: string; exportId: string }) => Promise<void>) | null = null;
    let stopped = false;
    return {
      consumer: {
        start(h: (job: { tenantId: string; exportId: string }) => Promise<void>) {
          handler = h;
        },
        async stop() {
          stopped = true;
        },
      },
      deliver: (job: { tenantId: string; exportId: string }) => handler?.(job) ?? Promise.resolve(),
      get stopped() {
        return stopped;
      },
    };
  };

  const context = {
    tenantId: T1,
    principalId: asId("user-1"),
    roleIds: [],
    locale: "en",
    timezone: "UTC",
    requestId: asId("req-1"),
  } as never;

  it("completes the job when a render fails", async () => {
    // Retrying an artifact that cannot be rendered produces the same answer at the same cost forever.
    const consumer = manualExportConsumer();
    const worker = createExportWorker({
      exports: {
        async render() {
          return { state: "failed", failureReason: "render-failed" };
        },
      } as never,
      consumer: consumer.consumer,
      contextFor: () => context,
    });
    await worker.start();
    await expect(consumer.deliver({ tenantId: T1, exportId: "e1" })).resolves.toBeUndefined();
    expect(worker.status()).toMatchObject({ processed: 1, failed: 1 });
  });

  it("fails the job when the store is unreachable", async () => {
    const consumer = manualExportConsumer();
    const worker = createExportWorker({
      exports: {
        async render() {
          throw new AgentPlatformError({ code: "provider_unavailable", message: "down", retryable: true });
        },
      } as never,
      consumer: consumer.consumer,
      contextFor: () => context,
    });
    await worker.start();
    await expect(consumer.deliver({ tenantId: T1, exportId: "e1" })).rejects.toThrow(/down/);
    expect(worker.status()).toMatchObject({ processed: 0 });
  });

  it("renders as the context the host supplies, per job", async () => {
    // The point of `contextFor`: an export must be rendered with the entitlement of the person who asked for
    // it. A worker inventing an all-powerful context would make the download authorisation decorative.
    const seen: string[] = [];
    const consumer = manualExportConsumer();
    const worker = createExportWorker({
      exports: {
        async render(_job: unknown, ctx: { principalId: string }) {
          seen.push(ctx.principalId);
          return { state: "rendered" };
        },
      } as never,
      consumer: consumer.consumer,
      contextFor: (job) => ({ ...(context as object), principalId: `owner-of-${job.exportId}` }) as never,
    });
    await worker.start();
    await consumer.deliver({ tenantId: T1, exportId: "e7" });
    expect(seen).toEqual(["owner-of-e7"]);
  });

  it("stops accepting before it waits for in-flight work", async () => {
    const consumer = manualExportConsumer();
    const worker = createExportWorker({
      exports: { async render() { return { state: "rendered" }; } } as never,
      consumer: consumer.consumer,
      contextFor: () => context,
    });
    await worker.start();
    expect(await worker.shutdown("test")).toMatchObject({ graceful: true });
    expect(consumer.stopped).toBe(true);
  });
});

describe("the BullMQ export dispatcher", () => {
  it("enqueues with a deduplicating, colon-free job id", async () => {
    const added: { name: string; opts?: { jobId?: string; attempts?: number } }[] = [];
    await createBullMqExportDispatcher({
      async add(name: string, _data: unknown, opts?: { jobId?: string; attempts?: number }) {
        added.push({ name, ...(opts === undefined ? {} : { opts }) });
        return {};
      },
    }).enqueueExport({ tenantId: T1, exportId: "e1" });
    expect(added[0]).toMatchObject({
      name: EXPORT_JOB_NAME,
      opts: { jobId: exportJobId({ tenantId: T1, exportId: "e1" }), attempts: 1 },
    });
    // The ambiguity the length prefix prevents: two different pairs must not produce one id, or BullMQ's
    // "existing id is a no-op" behaviour silently drops one tenant's export.
    expect(exportJobId({ tenantId: "a-b", exportId: "c" })).not.toBe(
      exportJobId({ tenantId: "a", exportId: "b-c" }),
    );
    expect(exportJobId({ tenantId: "a:b", exportId: "c:d" })).not.toContain(":");
  });

  it("reports an unreachable queue as retryable rather than hanging", async () => {
    const dispatcher = createBullMqExportDispatcher(
      { async add() { return new Promise(() => {}); } },
      { enqueueTimeoutMs: 20 },
    );
    const error = await dispatcher.enqueueExport({ tenantId: T1, exportId: "e1" }).catch((e: AgentPlatformError) => e);
    expect(error).toMatchObject({ code: "provider_unavailable", retryable: true });
  });
});
