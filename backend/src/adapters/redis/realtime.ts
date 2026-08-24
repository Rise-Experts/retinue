/**
 * Redis pub/sub realtime — the cross-process half that was missing (#161).
 *
 * Everything needed for streaming already existed: a durable event log, resumable SSE frames, the projection
 * fold, and both ports. What did not exist was a `RealtimePublisher`/`LiveEventSource` pair that works when the
 * publisher and the subscriber are **different processes** — which they always are, since the whole point of the
 * durable runtime is that the API host and the worker share only Postgres and the queue.
 *
 * The consequence was that no client ever saw a token while a run was in progress. The in-memory bus connects a
 * publisher and a subscriber inside one process, and the worker CLI published to a hard-coded no-op; so the SSE
 * endpoint replayed the durable log and then waited forever on a channel nothing wrote to. It looked like a
 * working system with no streaming rather than a broken one.
 *
 * **Why pub/sub is the right primitive here, despite being at-most-once.** The durable log is the source of
 * truth and the stream resumes from a sequence, so a dropped live message costs *latency*, not correctness — a
 * reconnect fills the gap. The live channel only has to be fast. Reaching for a Redis Stream instead would buy
 * replay this design already has, at the cost of trimming policy and consumer-group bookkeeping.
 *
 * Redis is already a required configuration value and already carries the queue, so this adds no dependency and
 * no new operational surface.
 */

import { parseRunEvent } from "../../core/validation.js";
import type { RealtimePublisher, RunEvent } from "../../core/events.js";
import type { LiveEventSource } from "../../runtime/streaming.js";

/**
 * The publish side, narrowed to one method.
 *
 * An interface rather than an `ioredis` import so this file stays testable without a server and the package does
 * not gain a hard dependency for a feature a deployment may not use — the same reasoning the Supabase adapter
 * gives for its broadcaster.
 */
export interface RedisPublishClient {
  publish(channel: string, message: string): Promise<number> | number;
}

/**
 * The subscribe side.
 *
 * **A subscriber connection cannot issue other commands**, which is why this is a separate interface from
 * `RedisPublishClient` rather than one client doing both: in Redis, a connection in subscriber mode rejects
 * everything except further subscribe/unsubscribe. A single shared client would work until the first publish
 * from the same process and then fail confusingly.
 */
export interface RedisSubscribeClient {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  off?(event: "message", listener: (channel: string, message: string) => void): unknown;
}

/** Namespaced, so run events cannot collide with BullMQ's own keys or another app's channels. */
export const realtimeChannel = (channel: string): string => `agentkit:events:${channel}`;

export const createRedisRealtimePublisher = (client: RedisPublishClient): RealtimePublisher => ({
  async publish(channel: string, event: RunEvent): Promise<void> {
    // Failure is deliberately *not* swallowed here. The worker decides what a failed publish means; silently
    // dropping it inside the adapter would make a misconfigured Redis indistinguishable from a quiet run, which
    // is precisely the bug this file exists to fix.
    await client.publish(realtimeChannel(channel), JSON.stringify(event));
  },
});

export type RedisLiveEventSourceOptions = {
  /**
   * How many events one subscriber may buffer before the oldest are dropped.
   *
   * A bound, because a subscriber that stops reading must not grow this process's memory — #144's `slow-consumer`
   * mode is exactly that scenario. Dropping is safe: the durable log is the source of truth, so a client that
   * fell behind reconnects and resumes from its sequence. An unbounded queue would trade a correctness-preserving
   * gap for an out-of-memory kill.
   */
  readonly maxBuffered?: number;
  /** Reported when a payload fails validation or the buffer overflows, so neither is silent. */
  readonly onDropped?: (reason: "invalid-payload" | "buffer-overflow", channel: string) => void;
};

export const DEFAULT_MAX_BUFFERED = 512;

/**
 * The receive side.
 *
 * The contract that matters is inherited from `LiveEventSource`: **buffering must begin at `subscribe()` time**,
 * before the caller's first `next()`. `openRunEventStream` subscribes and *then* reads the durable log, and that
 * ordering is the only thing stopping an event published during catch-up from being lost. So the Redis
 * subscription and the listener are established synchronously inside `subscribe`, not lazily in the generator.
 */
export const createRedisLiveEventSource = (
  client: RedisSubscribeClient,
  options: RedisLiveEventSourceOptions = {},
): LiveEventSource => {
  const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;

  return {
    subscribe(channel: string): AsyncIterable<RunEvent> {
      const topic = realtimeChannel(channel);
      const queue: RunEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;

      const listener = (incoming: string, message: string): void => {
        if (incoming !== topic || closed) return;
        let event: RunEvent;
        try {
          // A pub/sub payload is network input. `openRunEventStream` feeds whatever the live source yields
          // straight into the projection fold, so an unvalidated message would put corrupt — or attacker-shaped —
          // data into a run's state. Parsed and dropped on failure rather than trusted for arriving on the right
          // channel, exactly as the Supabase adapter does.
          event = parseRunEvent(JSON.parse(message));
        } catch {
          options.onDropped?.("invalid-payload", channel);
          return;
        }
        if (queue.length >= maxBuffered) {
          // Oldest first: the newest events are the ones a live view needs, and a client that fell behind is
          // going to reconnect and replay from its sequence anyway.
          queue.shift();
          options.onDropped?.("buffer-overflow", channel);
        }
        queue.push(event);
        wake?.();
      };

      // Established here, synchronously — see the note above. `subscribe` is awaited inside the generator's first
      // pull, but the *listener* is attached now, so a message arriving between this line and the first `next()`
      // is queued rather than missed.
      client.on("message", listener);
      const subscribed = Promise.resolve(client.subscribe(topic)).catch(() => undefined);

      return {
        async *[Symbol.asyncIterator]() {
          await subscribed;
          try {
            for (;;) {
              while (queue.length > 0) {
                const event = queue.shift();
                if (event !== undefined) yield event;
              }
              if (closed) return;
              await new Promise<void>((resolve) => {
                wake = () => {
                  wake = null;
                  resolve();
                };
              });
            }
          } finally {
            // Unsubscribing on *any* exit — return, throw, or the consumer breaking out of its loop — because a
            // leaked subscription is a listener that keeps buffering for a client that has gone. One per abandoned
            // SSE connection is how a host runs out of memory a day later.
            closed = true;
            client.off?.("message", listener);
            await Promise.resolve(client.unsubscribe(topic)).catch(() => undefined);
          }
        },
      };
    },
  };
};
