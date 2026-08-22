/**
 * Supabase Realtime — the publisher and, as of #104, the `LiveEventSource` half.
 *
 * Both sides are defined against tiny interfaces the host app adapts its Supabase client to, so this
 * package carries no `@supabase/supabase-js` dependency and stays deployable without one.
 *
 * Two things the in-memory bus never had to worry about, and this does:
 *
 * **A Realtime payload is network input.** `openRunEventStream` feeds whatever the live source yields
 * straight into `reduceRunEvents`, so an unvalidated payload would put attacker-shaped or merely
 * corrupt data into a run's projected state. Every payload is parsed with `parseRunEvent` and dropped
 * if it fails, rather than trusted because it arrived on the right channel.
 *
 * **Entitlement is checked at subscribe time, not on delivery.** Filtering events after subscribing
 * would still reveal that a conversation exists and roughly how active it is. Refusing the
 * subscription is the only version that leaks nothing.
 */
import { parseRunEvent } from "../../core/validation.js";
import type { RealtimePublisher, RunEvent } from "../../core/events.js";
import type { LiveEventSource } from "../../runtime/streaming.js";

/** The app adapts a Supabase channel's `send` to this (`channel.send({ type, event, payload })`). */
export interface RealtimeBroadcaster {
  send(channel: string, event: string, payload: unknown): Promise<void> | void;
}

export const createSupabaseRealtimePublisher = (broadcaster: RealtimeBroadcaster): RealtimePublisher => ({
  async publish(channel: string, event: RunEvent): Promise<void> {
    await broadcaster.send(channel, event.type, event);
  },
});

/**
 * The receive side the host adapts a subscribed channel to.
 *
 * The contract that matters is inherited from `LiveEventSource`: **buffering must begin at call
 * time**, before the caller's first `next()`. `openRunEventStream` subscribes and *then* reads the
 * durable log, and that ordering is the only thing stopping an event published during catch-up from
 * being lost. An adapter that connects lazily on first `next()` silently breaks it.
 */
export interface RealtimeSubscriber {
  subscribe(channel: string): AsyncIterable<unknown>;
}

export type LiveEventSourceOptions = {
  /**
   * Whether this subscriber may read the channel. Rejected subscriptions yield nothing and end.
   * Absent means every channel is allowed, which is only appropriate when the caller has already
   * authorized — the GraphQL resolver path, for instance.
   */
  readonly authorize?: (channel: string) => Promise<boolean> | boolean;
  /** Called for each payload that fails validation. Defaults to silence. */
  readonly onInvalid?: (channel: string, payload: unknown) => void;
};

export const createSupabaseLiveEventSource = (
  subscriber: RealtimeSubscriber,
  options: LiveEventSourceOptions = {},
): LiveEventSource => ({
  subscribe(channel: string): AsyncIterable<RunEvent> {
    // Subscribe eagerly, before the authorization check resolves, so the buffering contract above
    // holds. An unauthorized channel yields nothing regardless — see below.
    const upstream = subscriber.subscribe(channel);

    return {
      async *[Symbol.asyncIterator]() {
        const allowed = options.authorize === undefined ? true : await options.authorize(channel);
        // Ending the stream rather than throwing: a subscriber that is not entitled should observe
        // an ordinary empty stream, not an error that distinguishes "forbidden" from "no such run".
        if (!allowed) return;

        for await (const payload of upstream) {
          let event: RunEvent;
          try {
            event = parseRunEvent(payload);
          } catch {
            // Dropped, not thrown: one malformed broadcast must not tear down a live stream that is
            // otherwise healthy, and the durable log remains the source of truth for the run.
            options.onInvalid?.(channel, payload);
            continue;
          }
          yield event;
        }
      },
    };
  },
});
