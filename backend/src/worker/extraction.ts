/**
 * The extraction worker (#131, AC-2 and AC-3).
 *
 * Composition only, like `worker/main.ts` — every bound and every failure decision lives in
 * `documents/extraction.ts`, and duplicating any of them here would mean two places to look when a document
 * misbehaves. What this file owns is the loop: claim, extract, report, and stop cleanly.
 *
 * Written against the same `JobConsumer`-shaped seam as the run worker so the ordering decisions — the part
 * that can actually be wrong — are testable without Redis.
 *
 * **A failed extraction is not a failed job.** The pipeline records a typed failure and returns; the job
 * completes. That is deliberate: a job that failed would be retried by the queue, and retrying a scan with no
 * text layer produces the same answer at the same cost forever. Only an *infrastructure* failure — the store
 * unreachable — throws, and only that is worth retrying.
 */

import type { FileExtraction } from "../persistence/index.js";
import type { ExtractionJob } from "../documents/index.js";
import type { ExtractionService } from "../documents/extraction.js";

/** The consumer side. Mirrors `JobConsumer` for runs; `stop` must stop accepting before it waits. */
export interface ExtractionConsumer {
  start(handler: (job: ExtractionJob) => Promise<void>): Promise<void> | void;
  stop(graceMs: number): Promise<void>;
}

export type ExtractionWorkerConfig = {
  /**
   * Jobs at once. Low by default, and lower than the run worker's on purpose: extraction is CPU-bound, and
   * four concurrent PDF parses on one event loop is four slow parses rather than four fast ones.
   */
  readonly concurrency: number;
  readonly shutdownGraceMs: number;
};

export const DEFAULT_EXTRACTION_WORKER_CONFIG: ExtractionWorkerConfig = {
  concurrency: 2,
  shutdownGraceMs: 20_000,
};

export type ExtractionWorkerDeps = {
  readonly extraction: ExtractionService;
  readonly consumer: ExtractionConsumer;
  readonly config?: Partial<ExtractionWorkerConfig>;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  /** Observability hook, and what the tests assert on. */
  readonly onOutcome?: (job: ExtractionJob, extraction: FileExtraction) => void;
  readonly onError?: (job: ExtractionJob, error: unknown) => void;
};

export type ExtractionWorkerStatus = {
  readonly running: boolean;
  readonly inFlight: number;
  readonly processed: number;
  readonly failed: number;
};

export const createExtractionWorker = (deps: ExtractionWorkerDeps) => {
  const config: ExtractionWorkerConfig = { ...DEFAULT_EXTRACTION_WORKER_CONFIG, ...deps.config };
  const log = deps.log ?? (() => {});
  let running = false;
  let inFlight = 0;
  let processed = 0;
  let failed = 0;
  const settled = new Set<Promise<void>>();

  const handle = async (job: ExtractionJob): Promise<void> => {
    inFlight += 1;
    try {
      const extraction = await deps.extraction.extract(job);
      processed += 1;
      // Counted, not thrown. A document that cannot be read is an outcome; the queue must not retry it.
      if (extraction.state === "failed") failed += 1;
      deps.onOutcome?.(job, extraction);
    } catch (error) {
      // Only infrastructure reaches here — the pipeline turns every document problem into a record. Rethrown
      // so the queue *does* retry, which is right for a store that was briefly unreachable.
      log("extraction job failed", { job, error });
      deps.onError?.(job, error);
      throw error;
    } finally {
      inFlight -= 1;
    }
  };

  return {
    async start(): Promise<void> {
      running = true;
      await deps.consumer.start(async (job) => {
        const promise = handle(job);
        settled.add(promise);
        try {
          await promise;
        } finally {
          settled.delete(promise);
        }
      });
    },

    async shutdown(reason: string): Promise<{ readonly graceful: boolean }> {
      log("extraction worker shutting down", { reason, inFlight });
      running = false;
      // Stop accepting first, then wait. Draining first would accept a job with no intention of finishing it.
      await deps.consumer.stop(config.shutdownGraceMs);
      const graceful = await Promise.race([
        Promise.allSettled([...settled]).then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), config.shutdownGraceMs);
          // Unref so a clean shutdown is not held open by its own deadline.
          timer.unref?.();
        }),
      ]);
      return { graceful };
    },

    status(): ExtractionWorkerStatus {
      return { running, inFlight, processed, failed };
    },

    concurrency: config.concurrency,
  };
};

export type ExtractionWorker = ReturnType<typeof createExtractionWorker>;
