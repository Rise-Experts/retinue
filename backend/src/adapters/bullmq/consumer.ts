/**
 * BullMQ consumer side (#107) — the other half of the queue from `dispatcher.ts`.
 *
 * Lives here rather than in `src/worker/` so the `bullmq` coupling stays inside the adapter directory,
 * and so the entrypoint's ordering decisions remain testable without Redis.
 */
import type { JobConsumer, RunJob } from "../../worker/main.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { RUN_QUEUE_NAME, type RunJobData } from "./dispatcher.js";

/** What BullMQ's `Worker` gives us, narrowed to what this needs. */
export interface QueueWorkerFactory {
  (
    queueName: string,
    handler: (job: { readonly data: RunJobData }) => Promise<void>,
    options: { readonly concurrency: number },
  ): { close(): Promise<void>; pause?(doNotWaitActive?: boolean): Promise<void> };
}

export type BullMqConsumerOptions = {
  readonly queueName?: string;
  readonly concurrency?: number;
};

/**
 * A `JobConsumer` over BullMQ's `Worker`.
 *
 * `stop` pauses before closing. BullMQ's `close()` already waits for active jobs, but pausing first is
 * what makes "stop accepting new work" true *immediately* rather than eventually — without it, a
 * worker with free concurrency can pick up another job in the moment between deciding to shut down and
 * `close()` taking effect, which is precisely the job AC-2 says must not be accepted.
 */
export const createBullMqJobConsumer = (
  createWorker: QueueWorkerFactory,
  options: BullMqConsumerOptions = {},
): JobConsumer => {
  const queueName = options.queueName ?? RUN_QUEUE_NAME;
  const concurrency = options.concurrency ?? 4;
  let worker: ReturnType<QueueWorkerFactory> | null = null;

  return {
    start(handler: (job: RunJob) => Promise<void>) {
      worker = createWorker(
        queueName,
        async (job) => {
          await handler({
            tenantId: job.data.tenantId as TenantId,
            runId: job.data.runId as RunId,
          });
        },
        { concurrency },
      );
    },
    async stop() {
      const current = worker;
      worker = null;
      if (!current) return;
      // `true` = do not wait for active jobs to finish *pausing*; the runtime's own drain handles
      // waiting, and it owns the grace period.
      await current.pause?.(true).catch(() => undefined);
      await current.close().catch(() => undefined);
    },
  };
};
