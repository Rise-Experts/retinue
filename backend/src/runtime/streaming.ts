/**
 * Transport-neutral streaming — `docs/04-durable-runtime-and-hitl.md` → Transport events.
 *
 * The reconnect layer that sits under every transport (GraphQL subscription, SSE, …): a client
 * reconnects, reads everything after its cursor from the durable `RunEventLog`, then follows the
 * live feed — with catch-up and live de-duplicated by `sequence` so no part is missed or repeated.
 * Nothing here knows about a wire format, which is what keeps the layer transport-agnostic.
 */

import {
  reduceRunEvents,
  type RealtimePublisher,
  type RunEvent,
  type RunEventLog,
  type RunEventType,
  type RunStreamState,
} from "../core/events.js";
import type { RunId, TenantId } from "../core/ids.js";

const TERMINAL_EVENT_TYPES: ReadonlySet<RunEventType> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export const isTerminalEventType = (type: RunEventType): boolean => TERMINAL_EVENT_TYPES.has(type);

/** Live fan-in half of reconnect. `subscribe` must begin buffering at call time so the catch-up
 * read cannot race ahead of live events. Adapters: the in-memory bus below, Supabase Realtime, Redis. */
export interface LiveEventSource {
  subscribe(channel: string): AsyncIterable<RunEvent>;
}

/**
 * The persisted snapshot a transport sends on connect: the projected state plus the cursor to
 * resume streaming from. Built purely from the durable log, so it never disagrees with live deltas.
 */
export const reconnectSnapshot = async (input: {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly log: RunEventLog;
}): Promise<{ readonly state: RunStreamState; readonly after: number }> => {
  const events = await input.log.listAfter({ tenantId: input.tenantId, runId: input.runId, after: 0 });
  const state = reduceRunEvents(events);
  return { state, after: state.sequence };
};

/**
 * Ordered, gap-free, duplicate-free event stream from `after`. Subscribes first (so no live event
 * is lost during catch-up), replays the durable log, then follows live — skipping anything whose
 * sequence was already delivered. Ends on the run's terminal event or when `signal` aborts.
 */
export async function* openRunEventStream(input: {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly channel: string;
  readonly after: number;
  readonly log: RunEventLog;
  readonly live: LiveEventSource;
  readonly signal?: { readonly aborted: boolean };
}): AsyncIterable<RunEvent> {
  const iterator = input.live.subscribe(input.channel)[Symbol.asyncIterator]();
  try {
    let cursor = input.after;
    let terminalSeen = false;
    const catchup = await input.log.listAfter({ tenantId: input.tenantId, runId: input.runId, after: input.after });
    for (const event of catchup) {
      if (event.sequence <= cursor) continue;
      cursor = event.sequence;
      yield event;
      if (isTerminalEventType(event.type)) terminalSeen = true;
    }
    if (terminalSeen) return; // the run finished before we reconnected; no live events will come.

    for (;;) {
      if (input.signal?.aborted) return;
      const next = await iterator.next();
      if (next.done) return;
      const event = next.value;
      if (event.sequence <= cursor) continue; // duplicate already delivered via catch-up
      cursor = event.sequence;
      yield event;
      if (isTerminalEventType(event.type)) return;
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

/**
 * In-memory event bus: a `RealtimePublisher` paired with a `LiveEventSource`. Each subscriber gets
 * its own queue that starts filling the moment it subscribes, so `openRunEventStream` never races.
 * Serves tests, single-process deployments and the SSE embedded profile (#37).
 */
export const createMemoryEventBus = (): { publisher: RealtimePublisher; live: LiveEventSource } => {
  type Sub = { readonly queue: RunEvent[]; wake?: () => void; closed: boolean };
  const channels = new Map<string, Set<Sub>>();

  const publisher: RealtimePublisher = {
    async publish(channel, event) {
      const subs = channels.get(channel);
      if (!subs) return;
      for (const sub of subs) {
        sub.queue.push(event);
        sub.wake?.();
      }
    },
  };

  const live: LiveEventSource = {
    subscribe(channel) {
      const sub: Sub = { queue: [], closed: false };
      let subs = channels.get(channel);
      if (!subs) channels.set(channel, (subs = new Set()));
      subs.add(sub);
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!sub.closed) {
              const event = sub.queue.shift();
              if (event === undefined) {
                await new Promise<void>((resolve) => {
                  sub.wake = resolve;
                });
                sub.wake = undefined;
                continue;
              }
              yield event;
            }
          } finally {
            sub.closed = true;
            channels.get(channel)?.delete(sub);
          }
        },
      };
    },
  };

  return { publisher, live };
};
