/**
 * SSE transport adapter — `docs/06` (embedded-profile streaming). A thin mapping from the
 * transport-neutral `RunEvent` stream to Server-Sent Events frames. It takes no HTTP-framework
 * dependency: `sseFrames` yields ready-to-write text frames, and `openRunEventSse` composes the
 * reconnect stream (catch-up + live) with SSE encoding. The `Last-Event-ID` header a browser
 * resends on reconnect maps directly to the run event `sequence`, so resuming loses no events.
 */

import type { RunEvent, RunEventLog } from "../core/events.js";
import type { ConversationId, RunId, TenantId } from "../core/ids.js";
import { openRunEventStream, type LiveEventSource } from "../runtime/index.js";

/** Encode one event as an SSE frame: `id`/`event`/`data` lines terminated by a blank line. */
export const toSseFrame = (event: RunEvent): string =>
  `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** Parse a browser `Last-Event-ID` header into a resume cursor. Missing/invalid ⇒ 0 (from start). */
export const cursorFromLastEventId = (lastEventId: string | null | undefined): number => {
  const n = Number(lastEventId);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/** Map a `RunEvent` async stream to SSE text frames. Pair with any HTTP response writer. */
export async function* sseFrames(events: AsyncIterable<RunEvent>): AsyncIterable<string> {
  for await (const event of events) yield toSseFrame(event);
}

/**
 * Open a resumable SSE stream for a run: catch up from the durable log after `after`, then follow
 * live, encoded as SSE frames. Ends on the run's terminal event.
 */
export const openRunEventSse = (input: {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly conversationId: ConversationId;
  readonly after: number;
  readonly log: RunEventLog;
  readonly live: LiveEventSource;
  readonly channelFor?: (conversationId: ConversationId) => string;
  readonly signal?: { readonly aborted: boolean };
}): AsyncIterable<string> => {
  const channel = (input.channelFor ?? ((id: ConversationId) => `conversation:${id}`))(input.conversationId);
  return sseFrames(
    openRunEventStream({
      tenantId: input.tenantId,
      runId: input.runId,
      channel,
      after: input.after,
      log: input.log,
      live: input.live,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  );
};
