/**
 * BullMQ `ExportDispatcher` (#134).
 *
 * A third queue, and for the same reason extraction got its own: a hundred-page PDF render must not sit in
 * front of a user's next message, and rendering is CPU-bound where a run waits on a provider. The id, escaping
 * and timeout behaviour are `dispatcher.ts`'s, reused rather than re-derived — the length-prefix fix exists
 * because `${tenant}-${id}` is *ambiguous*, and a second implementation is a second chance to forget that.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { ExportDispatcher, ExportJob } from "../../export/index.js";
import { QUEUE_ATTEMPTS, runJobId, type JobDispatcherOptions } from "./dispatcher.js";

/** Hyphen, not a colon: BullMQ rejects a queue name containing `:` outright. See `RUN_QUEUE_NAME`. */
export const EXPORT_QUEUE_NAME = "agentkit-exports";
export const EXPORT_JOB_NAME = "export";

export type ExportJobData = { readonly tenantId: string; readonly exportId: string };

export interface ExportQueue {
  add(
    name: string,
    data: ExportJobData,
    opts?: { readonly jobId?: string; readonly attempts?: number },
  ): Promise<unknown>;
  close?(): Promise<void>;
}

/** Tenant-qualified and unambiguous, built by the same function a run's id is. */
export const exportJobId = (input: { readonly tenantId: string; readonly exportId: string }): string =>
  runJobId({ tenantId: input.tenantId, runId: input.exportId });

const unavailable = (cause: unknown) =>
  new AgentPlatformError(
    {
      code: "provider_unavailable",
      message: "Could not enqueue the export: the job queue is unreachable",
      retryable: true,
    },
    { cause },
  );

export const createBullMqExportDispatcher = (
  queue: ExportQueue,
  options: JobDispatcherOptions = {},
): ExportDispatcher => {
  const timeoutMs = options.enqueueTimeoutMs ?? 5_000;
  return {
    async enqueueExport({ tenantId, exportId }: ExportJob): Promise<void> {
      const add = queue.add(
        EXPORT_JOB_NAME,
        { tenantId, exportId },
        // The dedup that matters: an export claimed once must be rendered once, and the store's unique
        // constraint already guarantees one row per (artifact, version, format) — this stops a duplicated
        // *message* becoming a second render of that row.
        { jobId: exportJobId({ tenantId, exportId }), attempts: QUEUE_ATTEMPTS },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          add,
          new Promise<never>((_resolve, reject) => {
            // A connection that is open-but-dead fails neither fast nor at all, so the timeout is part of the
            // guarantee rather than a nicety.
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
