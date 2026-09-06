/**
 * The routes the agentkit client speaks to — Rise-Engineering/retinue#128.
 *
 * Two of them, and the contract is the client's: `social_share`'s `agentkitClient.ts` and the in-process
 * stand-in beside its tests are the executable specification. Anything here that drifts from those shapes
 * breaks a client that has no way to tell it is broken except by every turn going unanswered.
 *
 * | Route | Answers |
 * |---|---|
 * | `POST /api/message` | `{ conversationId, runId, messageId, started }` — a live turn, admitted and enqueued |
 * | `POST /api/message` with `shadow` and `await` | `{ runId, writes }` — run to completion with external writes suppressed |
 * | `GET /api/events` | Server-Sent Events for one run |
 *
 * Every response carries `x-retinue-application`. That header is not decoration: it is how a deployment that
 * pointed its client at a bare `retinue serve` finds out, instead of watching turns be accepted and never
 * answered.
 *
 * ## The run row is created before admission, and that order is load-bearing
 *
 * `startOrEnqueueRun` coordinates the conversation's *slot*; it does not create the run. Calling only that
 * returns `started` and executes nothing, because the worker claims a job whose row does not exist — the
 * reference app records making exactly this mistake, and it is the same shape as the abandoned-run gap #144
 * found. A job enqueued before its row exists is a job pointing at nothing.
 *
 * ## Why a shadow turn does not go through the queue
 *
 * It runs **in process, to completion**, and returns the writes. Three reasons, in order of how much they
 * matter:
 *
 * 1. The caller needs the result. A queued shadow would answer with a run id and the writes would arrive
 *    later, so the client would have to poll — and an empty answer is indistinguishable from "it would have
 *    written nothing", which is a real and different result.
 * 2. A shadow run must not compete with real ones for worker slots. It is measurement, and measurement that
 *    slows the thing it measures changes it.
 * 3. Nobody is waiting on the prose, so there is nothing to stream.
 */

import type { ExecutionContext, Run, RunId, TenantId } from "@retinue/agentkit";
import type { SuppressedWrite } from "@retinue/agentkit/tools";

import { APPLICATION_HEADER, APPLICATION_NAME, turnContext } from "./index.js";

/** What the host supplies. Ports, so this file knows nothing about Postgres or a queue. */
export type ShareFlowServerDeps = {
  /**
   * Authenticates a request and returns who is asking.
   *
   * `null` refuses. Required rather than optional, for the reason `RetinueApp.authenticate` is: a permissive
   * default in a server is how a permissive default reaches a deployment.
   */
  readonly authenticate: (request: Request) => Promise<AuthenticatedCaller | null> | AuthenticatedCaller | null;
  /** Writes the user's message and the run row, then admits. Returns what the client needs. */
  readonly startTurn: (input: StartTurnInput) => Promise<StartedTurn>;
  /**
   * Drives one run to completion **in this process**, with writes suppressed, and returns what it recorded.
   *
   * Separate from `startTurn` rather than a flag on it, because the two have genuinely different shapes: one
   * returns ids for a stream that has not happened yet, the other returns a result that has.
   */
  readonly runShadowTurn: (input: StartTurnInput) => Promise<{ runId: string; writes: readonly SuppressedWrite[] }>;
  /** Run events for a live turn, resumable after a cursor. */
  readonly openEvents: (input: {
    readonly context: ExecutionContext;
    readonly runId: RunId;
    readonly conversationId: string;
    readonly after?: number;
  }) => AsyncIterable<unknown>;
  readonly keepAliveMs?: number;
};

export type AuthenticatedCaller = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly roleIds: readonly string[];
};

export type StartTurnInput = {
  readonly context: ExecutionContext;
  readonly message: string;
  readonly conversationId?: string;
};

export type StartedTurn = {
  readonly conversationId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly started: string;
};

/** The longest message this will accept. A bound, so a runaway client cannot post a book. */
export const MAX_MESSAGE_CHARS = 32_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // On **every** response, including errors: a client diagnosing a 500 still needs to know it reached the
      // right service.
      [APPLICATION_HEADER]: APPLICATION_NAME,
    },
  });

const refuse = (status: number, message: string): Response => json({ error: message }, status);

export const createShareFlowServer = (deps: ShareFlowServerDeps) => {
  const keepAliveMs = deps.keepAliveMs ?? 15_000;

  const message = async (request: Request, caller: AuthenticatedCaller): Promise<Response> => {
    const body = (await request.json().catch(() => null)) as {
      message?: unknown;
      conversationId?: unknown;
      shadow?: unknown;
      await?: unknown;
    } | null;

    const text = typeof body?.message === "string" ? body.message.trim() : "";
    if (text === "") return refuse(400, "a message is required");
    if (text.length > MAX_MESSAGE_CHARS) {
      return refuse(400, `that message is ${text.length} characters and the limit is ${MAX_MESSAGE_CHARS}`);
    }
    const conversationId = typeof body?.conversationId === "string" ? body.conversationId : undefined;
    const shadow = body?.shadow === true;

    /**
     * A shadow turn must be awaited, and the refusal is deliberate.
     *
     * `shadow` without `await` would run the turn and answer before it finished, so the client would record an
     * **empty** write list — indistinguishable from "it would have written nothing", which is a real result.
     * Refusing is the only honest answer: silently awaiting anyway would make the flag meaningless, and
     * answering empty would poison the parity data at exactly the point it is supposed to be evidence.
     */
    if (shadow && body?.await !== true) {
      return refuse(
        400,
        "a shadow turn must be requested with `await: true`. Without it this would answer before the run " +
          "finished and report no writes, which is indistinguishable from a run that would have written " +
          "nothing — and that is the one mistake parity data must not contain.",
      );
    }

    const context = turnContext({
      tenantId: caller.tenantId,
      principalId: caller.principalId,
      roleIds: caller.roleIds,
      requestId: crypto.randomUUID(),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(shadow ? { shadow: true } : {}),
    });

    if (shadow) {
      const result = await deps.runShadowTurn({ context, message: text, ...(conversationId === undefined ? {} : { conversationId }) });
      // `writes` is always present, even when empty — the client refuses a shadow answer without it, because
      // an application that ignored the flag ran the turn for real.
      return json({ runId: result.runId, writes: result.writes });
    }

    const started = await deps.startTurn({ context, message: text, ...(conversationId === undefined ? {} : { conversationId }) });
    return json(started);
  };

  const events = async (request: Request, caller: AuthenticatedCaller): Promise<Response> => {
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId");
    const conversationId = url.searchParams.get("conversationId");
    if (runId === null || conversationId === null) {
      return refuse(400, "runId and conversationId are required");
    }
    /**
     * `Last-Event-ID` before the query parameter.
     *
     * A reconnecting browser sends the header automatically and does not rewrite its URL, so trusting the
     * parameter alone would replay from the start on every reconnect — which for a long run means a user
     * watching their answer restart.
     */
    const header = request.headers.get("last-event-id");
    const after = header !== null ? Number(header) : Number(url.searchParams.get("after") ?? Number.NaN);

    const context = turnContext({
      tenantId: caller.tenantId,
      principalId: caller.principalId,
      roleIds: caller.roleIds,
      conversationId,
      runId,
      requestId: crypto.randomUUID(),
    });

    const source = deps.openEvents({
      context,
      runId: runId as unknown as RunId,
      conversationId,
      ...(Number.isFinite(after) ? { after } : {}),
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        /**
         * A keep-alive timer alongside the events.
         *
         * An idle stream with nothing on it is closed by intermediaries at around thirty seconds, and the
         * client sees that as the run ending. The comment frame is invisible to a consumer and keeps the
         * connection open.
         */
        const beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            // The stream closed between the tick and the write. Nothing to do.
          }
        }, keepAliveMs);

        try {
          for await (const event of source) {
            /**
             * One `data:` line, which is what a JSON payload must be.
             *
             * SSE joins multiple `data:` lines with a newline, so splitting a JSON token across them corrupts
             * it for any correct consumer — a mistake found while testing the client, from the other side.
             */
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        } catch (error) {
          // Reported as a frame rather than by tearing the connection down: a client that saw the socket close
          // cannot tell a finished run from a failed one.
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "stream.failed", message: String(error) })}\n\n`),
          );
        } finally {
          clearInterval(beat);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Without this an nginx in front buffers the stream and the client sees nothing until it ends, which
        // for a live run is indistinguishable from the feature not working.
        "x-accel-buffering": "no",
        [APPLICATION_HEADER]: APPLICATION_NAME,
      },
    });
  };

  return {
    /** One fetch handler, so a host mounts this on Node, Bun, Workers or a test without adapting it. */
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);

      const caller = await deps.authenticate(request);
      if (caller === null) return refuse(401, "not authenticated");

      if (url.pathname === "/api/message" && request.method === "POST") return message(request, caller);
      if (url.pathname === "/api/events" && request.method === "GET") return events(request, caller);
      /**
       * A 404 that still identifies the application.
       *
       * The client reads a 404 on `/api/message` as "wrong URL" — so an application answering 404 for an
       * unrelated path must still say who it is, or a typo in a path looks like a typo in the host.
       */
      return refuse(404, `no route for ${request.method} ${url.pathname}`);
    },
  };
};

export type ShareFlowServer = ReturnType<typeof createShareFlowServer>;
export { APPLICATION_HEADER, APPLICATION_NAME };
export type { Run, RunId, TenantId };
