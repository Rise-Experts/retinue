/**
 * The export worker (#134).
 *
 * Composition only, like the extraction worker — every bound and every failure decision lives in
 * `export/index.ts`. What this owns is the loop.
 *
 * **A failed render completes the job.** The service records a typed failure and returns; retrying a
 * document that cannot be rendered produces the same answer at the same cost forever. Only an infrastructure
 * failure throws, and only that is worth retrying.
 *
 * The job carries a tenant but not a *principal*, so the host supplies the `ExecutionContext` the render runs
 * as. That is deliberate: an export must be rendered with the entitlement of the person who asked for it, and
 * a worker inventing an all-powerful context would make AC-5 decorative.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ArtifactExport } from "../persistence/index.js";
import type { ExportJob, ExportService } from "../export/index.js";

export interface ExportConsumer {
  start(handler: (job: ExportJob) => Promise<void>): Promise<void> | void;
  stop(graceMs: number): Promise<void>;
}

export type ExportWorkerConfig = {
  /** Low, like extraction's: rendering is CPU-bound and four concurrent renders on one loop is four slow ones. */
  readonly concurrency: number;
  readonly shutdownGraceMs: number;
};

export const DEFAULT_EXPORT_WORKER_CONFIG: ExportWorkerConfig = { concurrency: 2, shutdownGraceMs: 20_000 };

export type ExportWorkerDeps = {
  readonly exports: ExportService;
  readonly consumer: ExportConsumer;
  /**
   * The context a job renders as.
   *
   * Required, and required to be per-job: the render re-reads the artifact through `ArtifactService`, so this
   * is what makes an export carry the requester's entitlement rather than the worker's.
   */
  readonly contextFor: (job: ExportJob) => Promise<ExecutionContext> | ExecutionContext;
  readonly config?: Partial<ExportWorkerConfig>;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  readonly onOutcome?: (job: ExportJob, result: ArtifactExport) => void;
  readonly onError?: (job: ExportJob, error: unknown) => void;
};

export const createExportWorker = (deps: ExportWorkerDeps) => {
  const config: ExportWorkerConfig = { ...DEFAULT_EXPORT_WORKER_CONFIG, ...deps.config };
  const log = deps.log ?? (() => {});
  let running = false;
  let inFlight = 0;
  let processed = 0;
  let failed = 0;
  const settled = new Set<Promise<void>>();

  const handle = async (job: ExportJob): Promise<void> => {
    inFlight += 1;
    try {
      const context = await deps.contextFor(job);
      const result = await deps.exports.render(job, context);
      processed += 1;
      // Counted, not thrown: a document that cannot be rendered is an outcome, and the queue must not retry it.
      if (result.state === "failed") failed += 1;
      deps.onOutcome?.(job, result);
    } catch (error) {
      // Only infrastructure reaches here — the service turns every render problem into a record. Rethrown so
      // the queue does retry, which is right for a store that was briefly unreachable.
      log("export job failed", { job, error });
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
      log("export worker shutting down", { reason, inFlight });
      running = false;
      // Stop accepting first, then wait. Draining first would accept a job it has no intention of finishing.
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

    status() {
      return { running, inFlight, processed, failed };
    },

    concurrency: config.concurrency,
  };
};

export type ExportWorker = ReturnType<typeof createExportWorker>;
