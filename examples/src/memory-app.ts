/**
 * The whole example in one process, with no database, queue or network — #155 AC-7.
 *
 * Not a second application: the same manifest, the same tools, the same engine, the same page. Only the adapters
 * differ, which is the claim ports-and-adapters makes and this is where it gets tested rather than asserted.
 *
 * ## What it is for
 *
 * Trying the agent with nothing installed. `node scripts/run-memory.mjs` and a model key, and that is all — no
 * `docker compose`, no migration, no second terminal.
 *
 * ## What it cannot demonstrate, stated plainly
 *
 * This list is the more useful half of the feature, because a demo that quietly drops guarantees teaches the
 * wrong lesson about the platform:
 *
 * - **Durability.** Every store is a `Map`. Restarting loses every conversation, every memory and every note. A
 *   crash mid-run loses the run. The checkpointing still *happens* — you can watch it — but nothing survives the
 *   process, so it proves the mechanism and not the guarantee.
 * - **The API/worker split.** One process means the boundary is a function call. #144 recorded that this boundary
 *   had never actually been exercised, and running here does not exercise it either: a run that works in this
 *   mode can still fail across two processes, which is exactly how #161 (a no-op publisher) and #157 (an
 *   unwired message store) survived.
 * - **Lease-based recovery.** Nothing else can claim a run, so an expired lease has no competitor and the atomic
 *   claim is never contended. The reaper runs against a set of one.
 * - **Concurrency on the conversation slot.** The queue drains inline, so two runs never race for the slot. The
 *   FIFO serialisation is real code doing nothing under test.
 * - **RLS and storage-level tenant isolation.** There is no database to enforce it. Isolation here rests on the
 *   adapters partitioning their maps by tenant — which the conformance suite does check, but it is defence in
 *   depth minus one layer.
 * - **Real SQL.** No migration runs, so a query that is wrong against Postgres is not wrong here.
 *
 * The Postgres path is the one to trust for anything but a first look.
 */

import {
  createDefaultEngine,
  createMemoryApprovalGrantStore,
  createMemoryCheckpointStore,
  createMemoryConversationRunCoordinator,
  createMemoryConversationStore,
  createMemoryIdempotencyStore,
  createMemoryInteractionStore,
  createMemoryJobDispatcher,
  createMemoryMessageStore,
  createMemoryPrincipalMemoryStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
  createMemorySessionStateStore,
  createMemoryThreadSummaryStore,
  createMemorySkillStore,
  createMemoryUsageBackend,
  createMemoryUsageLimitStore,
  createDurableWorker,
} from "@agentkit/backend";
import type { RunId, TenantId } from "@agentkit/backend";

/**
 * A realtime bus over the in-memory event log.
 *
 * The Redis publisher (#161) exists because two processes need a channel between them. One process needs a
 * function call, and pretending otherwise would add a dependency to prove a point. The **shape** is the same
 * `RealtimePublisher` / `LiveEventSource` pair, so the server code above it does not know the difference — which
 * is the interesting part.
 */
export const createInProcessBus = () => {
  const subscribers = new Map<string, Set<(event: unknown) => void>>();
  const listeners = (channel: string) => {
    let s = subscribers.get(channel);
    if (!s) subscribers.set(channel, (s = new Set()));
    return s;
  };

  return {
    publisher: {
      async publish(channel: string, event: unknown) {
        // A copy of the set, because a subscriber unsubscribing while being notified would otherwise mutate the
        // collection being iterated.
        for (const listener of [...listeners(channel)]) listener(event);
      },
    },
    live: {
      subscribe(channel: string) {
        /**
         * The queue exists because a subscriber is an async iterator and events arrive synchronously.
         *
         * Without it, an event published between two `next()` calls is delivered to nobody — and the durable log
         * replay would paper over it well enough that the loss would only show under load. The Redis source has
         * the same buffer for the same reason.
         */
        const queue: unknown[] = [];
        let wake: (() => void) | null = null;
        const listener = (event: unknown) => {
          queue.push(event);
          wake?.();
        };
        listeners(channel).add(listener);

        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<unknown>> {
                for (;;) {
                  const event = queue.shift();
                  if (event !== undefined) return { value: event, done: false };
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                }
              },
              async return(): Promise<IteratorResult<unknown>> {
                listeners(channel).delete(listener);
                return { value: undefined, done: true };
              },
            };
          },
        };
      },
    },
    close() {
      subscribers.clear();
    },
  };
};

/**
 * Every store, once.
 *
 * Shared instances rather than factories, and that is the whole difference from the Postgres path: there, a
 * factory per call is right because the state is in the database and the executor is what varies. Here the
 * factory *is* the state, so calling it twice gives two empty worlds — and the symptom is a message that
 * vanishes between being written and being read.
 */
export const createMemoryBackend = () => {
  const usage = createMemoryUsageBackend();
  return {
    conversations: createMemoryConversationStore(),
    messages: createMemoryMessageStore(),
    runs: createMemoryRunStore(),
    checkpoints: createMemoryCheckpointStore(),
    eventLog: createMemoryRunEventLog(),
    interactions: createMemoryInteractionStore(),
    grants: createMemoryApprovalGrantStore(),
    sessions: createMemorySessionStateStore(),
    summaries: createMemoryThreadSummaryStore(),
    idempotency: createMemoryIdempotencyStore(),
    principalMemory: createMemoryPrincipalMemoryStore(),
    skills: createMemorySkillStore(),
    usage: usage.usage,
    rollups: usage.rollups,
    limits: createMemoryUsageLimitStore(),
    coordinator: createMemoryConversationRunCoordinator(),
    bus: createInProcessBus(),
  };
};

export type MemoryBackend = ReturnType<typeof createMemoryBackend>;

/**
 * The worker, driven by the in-process dispatcher.
 *
 * `createMemoryJobDispatcher` takes the processor and runs jobs on `drain()`, so enqueue-then-drain is the whole
 * queue. Drained **after** the response rather than inside it: draining inline would make `/api/message` block
 * until the model finished, and the page would get one complete answer instead of a stream — which would hide
 * the streaming this example exists to show.
 */
export const createInProcessWorker = (input: {
  readonly backend: MemoryBackend;
  readonly engine: Parameters<typeof createDurableWorker>[0]["engine"];
  readonly buildContext: Parameters<typeof createDurableWorker>[0]["buildContext"];
}) => {
  const worker = createDurableWorker({
    runs: input.backend.runs,
    checkpoints: input.backend.checkpoints,
    publisher: input.backend.bus.publisher as never,
    engine: input.engine,
    eventLog: input.backend.eventLog,
    messages: input.backend.messages,
    buildContext: input.buildContext,
    workerId: `memory-${process.pid}`,
  });

  const dispatcher = createMemoryJobDispatcher(async ({ tenantId, runId }) => {
    // Errors are logged, not rethrown: `drain` would otherwise abandon the rest of the queue because one run
    // failed, and in a single process that queue is every other conversation.
    await worker.process({ tenantId, runId }).catch((error: unknown) => {
      console.error(`[memory-worker] run ${runId} failed:`, (error as Error).message);
    });
  });

  return {
    dispatcher,
    /** Kick the queue without waiting for it, so the caller can answer and the run can stream. */
    kick: () => {
      void dispatcher.drain().catch(() => undefined);
    },
    pending: () => dispatcher.pending(),
  };
};

/** Re-exported so the runner does not need a second import of the platform. */
export type { RunId, TenantId };
