/**
 * `openEvents` — the run's events, as an async iterable the SSE route drains.
 *
 * ## Polled from the event log, not subscribed over Redis
 *
 * The platform has `createRedisLiveEventSource`, and this deliberately does not use it. Two reasons,
 * and the second is the one that decided it:
 *
 * 1. **The log is the authority; the channel is a notification.** A subscriber that joins after a run
 *    started has missed everything before it, so a resumable stream needs the log anyway — `after` is a
 *    cursor into it. Building on the log means resume and first-connect are one code path rather than
 *    two, and the one that gets exercised less is the one that breaks.
 * 2. **A missed publish is invisible; a missed poll is a delay.** If the worker's publish fails or the
 *    subscriber reconnects at the wrong moment, a subscription silently stops delivering and the client
 *    sees a run that never finishes. Polling is duller and cannot lose an event that was written.
 *
 * The cost is latency, bounded by the interval. At 250ms a token-by-token stream arrives in visible
 * bursts rather than smoothly, which is worth saying plainly: this is correct and slightly less
 * pretty than a subscription, and the subscription can be layered on top of the same cursor later.
 */

import type { ExecutionContext, RunId, TenantId } from "@retinue/agentkit";

/** How often the log is re-read while a run is live. */
export const POLL_INTERVAL_MS = 250;

/**
 * How long to keep polling a run that never reaches a terminal state.
 *
 * A bound rather than forever: a worker killed mid-run leaves a run `running` with no further events,
 * and a stream that waits on it holds a connection until the client gives up. Generous, because the
 * ceiling that matters is the agent's own `wallClockTimeoutMs` (180s) plus room for a queued run to be
 * promoted ahead of it.
 */
export const MAX_STREAM_MS = 600_000;

const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled"]);

/**
 * The log, as `createPostgresRunEventLog` actually exposes it.
 *
 * `listAfter`, not `list`, and it returns **parsed events** rather than rows — each carries its own
 * `sequence` and `type`, because `parseRunEvent` validates the whole object on read. Written as
 * `list(...)` returning `{sequence, type, event}` first, which typechecked against a hand-written type
 * and would have thrown `log.list is not a function` on the first stream. Read from
 * `adapters/postgres/run-event-log.js`; three names in this build were wrong when guessed and right
 * when read.
 */
export type EventLogReader = {
  listAfter(input: {
    tenantId: TenantId;
    runId: RunId;
    after: number;
    limit?: number;
  }): Promise<readonly { readonly sequence: number; readonly type: string }[]>;
};

export const createOpenEvents =
  (log: EventLogReader, options: { readonly pollMs?: number; readonly maxMs?: number } = {}) =>
  (input: { context: ExecutionContext; runId: RunId; conversationId: string; after?: number }): AsyncIterable<unknown> => {
    const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
    const maxMs = options.maxMs ?? MAX_STREAM_MS;

    return {
      async *[Symbol.asyncIterator]() {
        let cursor = input.after ?? 0;
        const deadline = Date.now() + maxMs;

        for (;;) {
          const batch = await log.listAfter({
            tenantId: input.context.tenantId as TenantId,
            runId: input.runId,
            after: cursor,
            limit: 200,
          });

          for (const event of batch) {
            cursor = event.sequence;
            /**
             * The event itself, not a re-wrapped one.
             *
             * The client parses the platform's own event shape, and a wrapper here would be a second
             * schema for the same thing — the sort of difference that is invisible until a consumer
             * reads a field that moved.
             */
            yield event;
            if (TERMINAL.has(event.type)) return;
          }

          // Only sleep when the log had nothing new; a busy run should not be paced by the interval.
          if (batch.length === 0) {
            if (Date.now() > deadline) return;
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
        }
      },
    };
  };
