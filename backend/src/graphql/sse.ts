/**
 * SSE transport adapter — `docs/06` (embedded-profile streaming). A thin mapping from the
 * transport-neutral `RunEvent` stream to Server-Sent Events frames. It takes no HTTP-framework
 * dependency: `sseFrames` yields ready-to-write text frames, and `openRunEventSse` composes the
 * reconnect stream (catch-up + live) with SSE encoding. The `Last-Event-ID` header a browser
 * resends on reconnect maps directly to the run event `sequence`, so resuming loses no events.
 */

import type { PlatformError } from "../core/errors.js";
import type { RunEvent, RunEventLog } from "../core/events.js";
import type { ConversationId, RunId, TenantId } from "../core/ids.js";
import { openRunEventStream, type LiveEventSource } from "../runtime/index.js";

/**
 * The GraphQL field the frames are shaped for.
 *
 * Hard-coded to match the SDL's `runEvents` subscription, because that is the selection a client made.
 * A client that *aliased* the field would look for its alias and not find it — see the open question
 * on #111; the adapter has no way to know the alias.
 */
export const SSE_RESULT_FIELD = "runEvents";

/**
 * Encode one event as a graphql-sse `next` frame.
 *
 * `docs/extraction/twenty-sdk-comparison.md` records the decision: *"Match the `graphql-sse` framing
 * rather than inventing a bespoke SSE protocol"* — twenty-sdk already streams GraphQL over graphql-sse,
 * so a client can consume this unmodified. This previously emitted `event: <RunEvent.type>` with a raw
 * `RunEvent` as `data`, which no graphql-sse client understands.
 *
 * The `id:` line keeps carrying `RunEvent.sequence`, which is what makes `Last-Event-ID` resume work.
 *
 * **A failed run is a `next` frame, not an error frame**, and that is deliberate. `run.failed` is a
 * durable event with a sequence, sitting in the log like any other. Delivering it as a protocol-level
 * error would leave it with no `id:` — so `Last-Event-ID` could not resume past it, and a reconnecting
 * client would never learn the run ended. An `ExecutionResult` may carry both `data` and `errors`, so
 * the event travels in `data` and the platform error in `errors`: clients surface it through their
 * normal error path (which is what AC-3 is for) and resume keeps working.
 */
export const toSseFrame = (event: RunEvent): string => {
  const result: { data: Record<string, RunEvent>; errors?: readonly unknown[] } = {
    data: { [SSE_RESULT_FIELD]: event },
  };
  if (event.type === "run.failed") {
    const { error } = event as RunEvent & { readonly error: PlatformError };
    result.errors = [
      {
        message: error.message,
        extensions: { code: error.code, retryable: error.retryable },
      },
    ];
  }
  return `id: ${event.sequence}\nevent: next\ndata: ${JSON.stringify(result)}\n\n`;
};

/**
 * The terminating frame.
 *
 * graphql-sse's distinct-connections mode uses `event: complete` to say the response is finished. A
 * stream that simply stops is indistinguishable from a truncated one, and a client cannot tell whether
 * to reconnect.
 */
export const SSE_COMPLETE_FRAME = `event: complete\ndata: \n\n`;

/**
 * A stream-level failure, in the protocol's error shape.
 *
 * Distinct from a failed *run*: there is no sequence to preserve and nothing to resume to, so this is
 * genuinely a protocol error rather than an event.
 */
export const sseErrorFrame = (message: string): string =>
  `event: next\ndata: ${JSON.stringify({ errors: [{ message }] })}\n\n`;

/** Parse a browser `Last-Event-ID` header into a resume cursor. Missing/invalid ⇒ 0 (from start). */
export const cursorFromLastEventId = (lastEventId: string | null | undefined): number => {
  const n = Number(lastEventId);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/**
 * Map a `RunEvent` async stream to graphql-sse text frames, terminated by `complete`.
 *
 * The `complete` frame is emitted in a `finally`, so it is sent whether the stream ended on a terminal
 * event or because the consumer stopped — a client should be told the response is over either way.
 */
export async function* sseFrames(events: AsyncIterable<RunEvent>): AsyncIterable<string> {
  try {
    for await (const event of events) yield toSseFrame(event);
  } finally {
    yield SSE_COMPLETE_FRAME;
  }
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
