/**
 * Supabase Realtime publisher for the `RealtimePublisher` port. The Supabase client is wired to
 * a minimal `RealtimeBroadcaster` by the host app, so this module carries no client dependency.
 */
import type { RealtimePublisher, RunEvent } from "../../core/events.js";

/** The app adapts a Supabase channel's `send` to this (`channel.send({ type, event, payload })`). */
export interface RealtimeBroadcaster {
  send(channel: string, event: string, payload: unknown): Promise<void> | void;
}

export const createSupabaseRealtimePublisher = (broadcaster: RealtimeBroadcaster): RealtimePublisher => ({
  async publish(channel: string, event: RunEvent): Promise<void> {
    await broadcaster.send(channel, event.type, event);
  },
});
