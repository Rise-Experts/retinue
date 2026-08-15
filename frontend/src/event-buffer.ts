/**
 * Run-event ordering and de-duplication.
 *
 * Backs this acceptance criterion from `docs/06-graphql-and-frontend.md`:
 * "Subscription reconnect produces no missing or duplicated rendered parts."
 *
 * A reconnect replays from a cursor, so the same event can arrive twice, and a
 * transport may deliver out of order. The buffer releases events in strict sequence
 * order, drops anything already seen, and holds a gap until it fills.
 */

import type { RunEvent } from "@agentkit/backend";

export type EventBuffer = {
  /**
   * Accepts one event and returns the events that are now safe to render, in order.
   * Returns an empty array for a duplicate, or when the event sits beyond a gap.
   */
  push(event: RunEvent): RunEvent[];
  /** Sequence of the last released event. Use it as the resume cursor. */
  lastSequence(): number;
  /** Events held back waiting on a gap. */
  pendingCount(): number;
};

export const createEventBuffer = (fromSequence = 0): EventBuffer => {
  let lastReleased = fromSequence;
  const held = new Map<number, RunEvent>();

  return {
    push(event) {
      if (event.sequence <= lastReleased) {
        return [];
      }
      if (held.has(event.sequence)) {
        return [];
      }

      held.set(event.sequence, event);

      const released: RunEvent[] = [];
      for (;;) {
        const next = held.get(lastReleased + 1);
        if (next === undefined) {
          break;
        }
        held.delete(next.sequence);
        lastReleased = next.sequence;
        released.push(next);
      }
      return released;
    },

    lastSequence() {
      return lastReleased;
    },

    pendingCount() {
      return held.size;
    },
  };
};
