/**
 * HTTP SSE endpoint for run events (#109).
 *
 * `@retinue/agentkit`'s `graphql/sse.ts` already produces ready-to-write frames and maps
 * `Last-Event-ID` to a resume cursor, deliberately without an HTTP dependency. This is the route that
 * serves it, in the workspace where the server dependency already lives.
 *
 * Two design decisions carry the weight, and they pull against each other:
 *
 * **Backpressure (AC-6) wants a pull-based stream** — produce only when the consumer asks.
 * **Keep-alives (AC-5) want the server to emit without being asked.** Resolved by racing inside
 * `pull`: each pull awaits the next event *or* a keep-alive timeout. Nothing is produced without
 * demand, so a slow client stops being pulled and backpressure reaches the source instead of a buffer;
 * and an idle stream still emits a comment per interval. A `setInterval` enqueuing comments regardless
 * of demand would satisfy AC-5 and quietly break AC-6 — a stalled client would accumulate one comment
 * per interval, forever.
 */
import { asId } from "../index.js";
import { cursorFromLastEventId, openRunEventSse } from "../graphql/sse.js";
import type { ConversationId, ExecutionContext, LiveEventSource, ResolverDeps, RunId } from "../index.js";
import type { Authenticate } from "./host.js";

export type SseRouteOptions = {
  readonly deps: Pick<ResolverDeps, "conversations" | "eventLog" | "live" | "channelFor">;
  readonly authenticate: Authenticate;
  /**
   * Finer-grained entitlement *within* a tenant, which the library cannot know. Optional: the
   * cross-tenant case is already closed by the unconditional ownership check below, so this is for
   * per-user policy rather than for the dangerous case.
   */
  readonly authorizeConversation?: (
    execution: ExecutionContext,
    conversationId: ConversationId,
  ) => Promise<boolean> | boolean;
  /** How often a quiet stream emits a comment frame. Default 15s. */
  readonly keepAliveMs?: number;
  readonly path?: string;
};

/** A comment frame. Intermediaries see bytes; clients ignore it. */
const KEEP_ALIVE = ": keep-alive\n\n";

const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Without this an nginx in front buffers the stream and the client sees nothing until it ends,
  // which for a live run is indistinguishable from the feature not working.
  "x-accel-buffering": "no",
};


/**
 * Read `runId` / `conversationId` / `after` out of a GraphQL operation body, tolerantly.
 *
 * Tolerant on purpose: a malformed or absent body is not an error here, because the query-parameter
 * form is equally valid. A body that cannot be parsed simply yields no identifiers, and the caller
 * then fails with the same 400 it would have for a missing parameter.
 */
const readOperationVariables = async (
  request: Request,
): Promise<{ runId: string | null; conversationId: string | null; after: string | null }> => {
  const empty = { runId: null, conversationId: null, after: null };
  if (request.method !== "POST") return empty;
  try {
    const body = (await request.clone().json()) as {
      variables?: Record<string, unknown>;
    };
    const variables = body.variables ?? {};
    const str = (key: string): string | null => {
      const value = variables[key];
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
    };
    return { runId: str("runId"), conversationId: str("conversationId"), after: str("after") };
  } catch {
    return empty;
  }
};

export const createRunEventSseRoute = (options: SseRouteOptions) => {
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const path = options.path ?? "/runs/events";

  return {
    path,
    async handle(request: Request): Promise<Response> {
      /**
       * Identifiers from either shape, because two kinds of consumer reach this route.
       *
       * A `graphql-sse` client POSTs `{query, variables}` with `accept: text/event-stream` — that is
       * what its distinct-connections mode does, and it never looks at query parameters. #109 accepted
       * only query parameters, so #111's frame compliance was real while the *request* side still could
       * not be reached by a real client. An `EventSource`, by contrast, can only issue a GET with a URL.
       *
       * The query text is deliberately not executed: this is a streaming route, not a GraphQL executor.
       * See the open question on #112.
       */
      const url = new URL(request.url);
      const fromBody = await readOperationVariables(request);
      const runIdParam = url.searchParams.get("runId") ?? fromBody.runId;
      const conversationIdParam = url.searchParams.get("conversationId") ?? fromBody.conversationId;
      if (runIdParam === null || conversationIdParam === null) {
        return new Response("runId and conversationId are required", { status: 400 });
      }

      const execution = await options.authenticate(request);
      if (execution === null || execution === undefined) {
        return new Response("Unauthenticated", { status: 401 });
      }

      const conversationId = asId<ConversationId>(conversationIdParam);
      const runId = asId<RunId>(runIdParam);

      /**
       * Ownership from data, unconditionally.
       *
       * Every store read is tenant-scoped, so a conversation belonging to another tenant simply is not
       * found — the caller cannot forget this check because the route performs it before anything else.
       * A callback alone would have left the cross-tenant case, which is the dangerous one, to the
       * caller's policy.
       */
      const conversation = await options.deps.conversations.findById({
        tenantId: execution.tenantId,
        id: conversationId,
      });
      // 404, not 403. A 403 confirms the conversation exists, which across tenants is itself the leak.
      if (conversation === null) return new Response("Not found", { status: 404 });

      if (options.authorizeConversation) {
        const allowed = await options.authorizeConversation(execution, conversationId);
        // Also 404 rather than 403, for the same reason: an unentitled user learning a conversation
        // exists is information they should not have.
        if (!allowed) return new Response("Not found", { status: 404 });
      }

      /**
       * Resume cursor, from whichever source the consumer has.
       *
       * `Last-Event-ID` first, because a browser `EventSource` resends it automatically and that is the
       * only mechanism it has. Then `after` from the operation variables — the graphql-sse client
       * **never sends `Last-Event-ID`** (it is absent from its source entirely; it retries with backoff
       * and re-subscribes from the start), so a consumer that wants resume has to pass a cursor itself.
       * That is the one accommodation beyond the raw protocol, recorded for #112's AC-6.
       */
      const after =
        request.headers.get("last-event-id") !== null
          ? cursorFromLastEventId(request.headers.get("last-event-id"))
          : cursorFromLastEventId(fromBody.after);

      // Polled by `openRunEventStream`, so a Web AbortSignal needs adapting rather than passing.
      // Both directions matter: the request's signal (the client dropped) and the stream's `cancel`
      // (the consumer stopped reading without closing) — the second is the case that leaks a
      // generator.
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted || request.signal.aborted;
        },
      };

      /**
       * A promise that settles when this stream is abandoned, and the reason it has to exist.
       *
       * `openRunEventStream` polls `signal.aborted`, which only helps *between* events. When it is
       * parked awaiting the live source there is nothing to poll: an async generator suspended at an
       * `await` cannot run its `finally` until that await settles, so calling `.return()` on it does
       * not interrupt it — it queues. Awaiting that return in `cancel()` therefore hangs forever,
       * which is exactly what the first version of this route did.
       *
       * So the live source is wrapped to race each read against this promise. Cancelling resolves it,
       * the wrapper returns, and its `finally` releases the underlying subscription.
       */
      let abandon: () => void = () => {};
      const abandoned = new Promise<"abandoned">((resolve) => {
        abandon = () => resolve("abandoned");
      });

      const live: LiveEventSource = {
        subscribe(channel) {
          const inner = options.deps.live.subscribe(channel)[Symbol.asyncIterator]();
          return {
            async *[Symbol.asyncIterator]() {
              try {
                for (;;) {
                  const next = await Promise.race([inner.next(), abandoned]);
                  if (next === "abandoned" || next.done === true) return;
                  yield next.value;
                }
              } finally {
                // Not awaited: a parked in-memory subscriber cannot be interrupted mid-await, so
                // awaiting here would reintroduce the hang. The subscription is released when the
                // inner generator next wakes.
                void inner.return?.(undefined);
              }
            },
          };
        },
      };

      const frames = openRunEventSse({
        tenantId: execution.tenantId,
        runId,
        conversationId,
        after,
        log: options.deps.eventLog,
        live,
        ...(options.deps.channelFor ? { channelFor: options.deps.channelFor } : {}),
        signal,
      })[Symbol.asyncIterator]();

      const encoder = new TextEncoder();

      /**
       * One reader owns the generator; `pull` takes from a **one-slot** handoff.
       *
       * The obvious implementation — race `frames.next()` against a keep-alive timer inside `pull` —
       * has a subtle flaw that cost real debugging time. When the keep-alive wins, the outstanding
       * `next()` must be retained, or the event it eventually yields is delivered to an abandoned
       * promise and lost. Retaining it is not enough either: a generator that yields and then returns
       * (which is exactly what a terminal event does) can deliver its value to one queued `next()` and
       * `done` to another, so the frame disappears and the stream just closes. Observed: `yielding 1`
       * followed immediately by `terminal`, with no frame ever reaching the client.
       *
       * A single reader removes the class of problem. It reads one frame, parks until `pull` takes it,
       * then reads the next — so the generator has exactly one consumer and exactly one outstanding
       * `next()`, and the one-slot capacity is what keeps AC-6 true: a client that stops reading stops
       * the reader after one frame rather than draining the source into a buffer.
       */
      let slot: string | null = null;
      let finished = false;
      let failure: unknown = null;
      let notifyPull: (() => void) | null = null;
      let notifyReader: (() => void) | null = null;

      const wake = (fn: (() => void) | null) => fn?.();

      const readerLoop = (async () => {
        try {
          for (;;) {
            if (signal.aborted) return;
            const next = await frames.next();
            if (next.done === true) return;
            slot = next.value;
            wake(notifyPull);
            // Park until `pull` empties the slot. This is the backpressure: no further read happens
            // while the consumer has not taken what is already there.
            if (slot !== null) {
              await new Promise<void>((resolve) => {
                notifyReader = resolve;
              });
              notifyReader = null;
            }
          }
        } catch (error) {
          failure = error;
        } finally {
          finished = true;
          wake(notifyPull);
          abandon();
          void frames.return?.(undefined);
        }
      })();

      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (;;) {
            if (failure !== null) {
              controller.error(failure);
              return;
            }
            if (slot !== null) {
              const frame = slot;
              slot = null;
              wake(notifyReader);
              controller.enqueue(encoder.encode(frame));
              return;
            }
            if (finished || signal.aborted) {
              controller.close();
              return;
            }

            // Nothing waiting: emit a keep-alive if the interval elapses first. Only ever reached on
            // demand, so an idle stream produces one comment per pull rather than one per interval.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const armed = new Promise<"tick">((resolve) => {
              timer = setTimeout(() => resolve("tick"), keepAliveMs);
            });
            const arrival = new Promise<"frame">((resolve) => {
              notifyPull = () => resolve("frame");
            });
            const outcome = await Promise.race([arrival, armed]);
            if (timer !== undefined) clearTimeout(timer);
            notifyPull = null;
            if (outcome === "tick") {
              controller.enqueue(encoder.encode(KEEP_ALIVE));
              return;
            }
            // A frame (or the end) arrived; loop once to handle whichever it was.
          }
        },
        cancel() {
          // Flip the polled flag, settle the abandonment promise so the live wrapper unwinds, and let
          // the reader loop finish on its own. Not awaited: a parked source cannot be interrupted
          // mid-await, and awaiting here is what hangs.
          aborted = true;
          abandon();
          wake(notifyReader);
          void readerLoop;
        },
      });

      return new Response(body, { status: 200, headers: SSE_HEADERS });
    },
  };
};

export type RunEventSseRoute = ReturnType<typeof createRunEventSseRoute>;
