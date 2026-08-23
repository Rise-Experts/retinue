/**
 * BullMQ `ExtractionDispatcher` (#131) — the durable enqueue behind document extraction.
 *
 * Its own queue, not the run queue, and that is the decision worth stating. A shared queue would let a
 * hundred-page PDF sit in front of a user's next message, which is precisely what AC-2 forbids; and the two
 * kinds of work want different concurrency, because extraction is CPU-bound and a run is mostly waiting on a
 * provider. Separate queues let a deployment give extraction one worker and runs ten.
 *
 * The id, escaping and timeout behaviour are `dispatcher.ts`'s, reused rather than re-derived: the ambiguity
 * bug that `runJobId`'s length prefix fixes is a property of tenant-qualified ids in general, not of runs.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { FileId, TenantId } from "../../core/ids.js";
import type { ExtractionDispatcher } from "../../documents/index.js";
import { QUEUE_ATTEMPTS, runJobId, type JobDispatcherOptions } from "./dispatcher.js";

/** Hyphen, not a colon: BullMQ rejects a queue name containing `:` outright. See `RUN_QUEUE_NAME`. */
export const EXTRACTION_QUEUE_NAME = "agentkit-extractions";
export const EXTRACTION_JOB_NAME = "extract";

export type ExtractionJobData = {
  readonly tenantId: string;
  readonly fileId: string;
};

/** The queue surface this adapter needs, structurally satisfied by BullMQ's `Queue`. */
export interface ExtractionQueue {
  add(
    name: string,
    data: ExtractionJobData,
    opts?: { readonly jobId?: string; readonly attempts?: number },
  ): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * The job id, tenant-qualified and unambiguous.
 *
 * Deliberately the same construction as a run's — `runJobId` takes the second part under the name `runId`,
 * and the file id goes there. Sharing it rather than writing a near-copy is the point: the length prefix
 * exists because `${tenant}-${id}` is *ambiguous* (tenant `a-b`/file `c` and tenant `a`/file `b-c` collide),
 * and a second implementation is a second chance to forget that.
 */
export const extractionJobId = (input: { readonly tenantId: string; readonly fileId: string }): string =>
  runJobId({ tenantId: input.tenantId, runId: input.fileId });

const unavailable = (cause: unknown) =>
  new AgentPlatformError(
    {
      code: "provider_unavailable",
      message: "Could not enqueue the extraction: the job queue is unreachable",
      retryable: true,
    },
    { cause },
  );

export const createBullMqExtractionDispatcher = (
  queue: ExtractionQueue,
  options: JobDispatcherOptions = {},
): ExtractionDispatcher => {
  const timeoutMs = options.enqueueTimeoutMs ?? 5_000;

  return {
    async enqueueExtraction({ tenantId, fileId }: { tenantId: TenantId; fileId: FileId }): Promise<void> {
      const add = queue.add(
        EXTRACTION_JOB_NAME,
        { tenantId, fileId },
        // The dedup that matters here: an upload retried by a client must not extract the same file twice.
        // `attempts: 1` for the same reason the run queue uses it — the caller owns retries, and multiplying
        // two retry policies gives backoff neither layer intended.
        { jobId: extractionJobId({ tenantId, fileId }), attempts: QUEUE_ATTEMPTS },
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          add,
          new Promise<never>((_resolve, reject) => {
            // A connection that is open-but-dead fails neither fast nor at all, so the timeout is part of
            // the guarantee rather than a nicety.
            timer = setTimeout(
              () => reject(unavailable(new Error(`enqueue timed out after ${timeoutMs}ms`))),
              timeoutMs,
            );
          }),
        ]);
      } catch (error) {
        throw error instanceof AgentPlatformError ? error : unavailable(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // The losing promise must not become an unhandled rejection when the timeout wins.
        void Promise.resolve(add).catch(() => undefined);
      }
    },
  };
};
