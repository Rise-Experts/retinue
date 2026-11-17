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
 * ## Shadow turns are gone (#712)
 *
 * `shadow: true` used to run a turn in process with external writes suppressed, so its write set could be
 * compared against the old runtime's. The old runtime is gone and nothing sends the flag any more, so the
 * route refuses it rather than ignoring it: a caller that still sent it and got a normal turn would have
 * published for real while believing it had not.
 */

import { parseTurnSettings, type TurnSettings } from "./turn-settings.js";
import type { ExecutionContext, Run, RunId, TenantId, ToolRegistry } from "@retinue/agentkit";
/**
 * The decision list **from the platform**, not a copy of its four values.
 *
 * A hand-written `["allow-once", ...]` here would keep compiling after the platform added a fifth
 * decision, and this route would then refuse a decision the service understands — the stale-copy
 * failure this project keeps finding. `APPROVAL_DECISIONS` is exported at runtime precisely so a
 * validator can be the same list the service switches on.
 */
import { APPROVAL_DECISIONS } from "@retinue/agentkit/hitl";
import type { ApprovalDecision, QuestionAnswer } from "@retinue/agentkit/hitl";
import { executeToolCall, toolNameFrom } from "./tool-route.js";
import type { PersonalMemoryService } from "../services/index.js";
import { AgentPlatformError } from "@retinue/agentkit";

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
  /** Run events for a live turn, resumable after a cursor. */
  /**
   * The tool registry, for `POST /api/tools/:name` — the entry point the product's non-chat features
   * need, and the reason three capabilities were `partial`. Optional: a deployment that wants only the
   * conversational surface omits it and the route answers 404 like any other unknown path, rather than
   * existing and refusing.
   */
  readonly toolRegistry?: ToolRegistry;
  /**
   * A page of the caller's conversations, most recently **used** first. **Absent means the route refuses.**
   *
   * "Newest first" is what this line said while the implementation returned the thirty oldest — see
   * `conversation-list.ts` (#397). It is true now because the supplier orders by real last activity,
   * not because the store does; the store's `list` is ascending and not configurable.
   *
   * Added for the React chat: `@retinue/react`'s client contract needs `listConversations` and
   * `listMessages`, and this deployment had no HTTP surface for either — the old chat read its history
   * from Agno. Optional in the same shape as `toolRegistry`, so a deployment serving only live turns
   * says so rather than 404ing anonymously.
   */
  readonly listConversations?: (input: {
    readonly context: ExecutionContext;
    readonly limit: number;
    readonly cursor?: string;
  }) => Promise<{ readonly items: readonly { readonly id: string; readonly title: string; readonly updatedAt: string }[]; readonly nextCursor?: string }>;
  /** A page of one conversation's messages, oldest first — the order a transcript reads in. */
  readonly listMessages?: (input: {
    readonly context: ExecutionContext;
    readonly conversationId: string;
    readonly limit: number;
    readonly cursor?: string;
  }) => Promise<{ readonly items: readonly unknown[]; readonly nextCursor?: string }>;
  /**
   * Record answers to a parked question and resume the run. **Absent means the route refuses.**
   *
   * The three interaction routes were 501s until now, and why they were is worth keeping: answering is
   * not a row to write, it is *waking a parked run*. The platform's `QuestionService` and
   * `ApprovalService` only resume claimably when they hold a `RunStore` — without it an answer enqueues
   * a continuation the worker cannot claim, so the run waits forever and the chat shows an answer that
   * was accepted and did nothing.
   *
   * `resumed` travels back rather than being flattened into a bare 200: a second answer to the same
   * interaction is a deliberate no-op in the platform, and "already answered" is a different fact from
   * "resumed" to anything rendering the turn.
   */
  readonly answerQuestion?: (input: {
    readonly context: ExecutionContext;
    readonly interactionId: string;
    readonly runId: string;
    readonly answers: Readonly<Record<string, QuestionAnswer>>;
  }) => Promise<{ readonly resumed: boolean }>;
  /** Record an approval decision and resume. The same shape and the same reasoning as `answerQuestion`. */
  readonly decideApproval?: (input: {
    readonly context: ExecutionContext;
    readonly interactionId: string;
    readonly runId: string;
    readonly conversationId?: string;
    readonly decision: ApprovalDecision;
  }) => Promise<{ readonly resumed: boolean; readonly granted: boolean }>;
  /**
   * Request cancellation of a run. `null` when this caller's tenant has no such run.
   *
   * Cooperative by design — the platform persists the request and the owning worker observes it — so
   * this reports "the request is recorded", never "the run has stopped". The route says as much,
   * because a client told a run was cancelled and then watching it emit three more tool calls has been
   * lied to.
   */
  readonly cancelRun?: (input: {
    readonly context: ExecutionContext;
    readonly runId: string;
  }) => Promise<{ readonly status: string } | null>;
  /**
   * What a paused run is waiting for — **the piece that made the pause invisible.**
   *
   * A run that hits a gated tool parks at `waiting-for-approval`, and the engine announces it as an
   * *event* (`approval.requested` with an interaction id) rather than as a message part. So a client
   * deriving its permission card from `parts` — which is what `@retinue/react`'s own
   * `usePendingInteraction` does too — finds nothing, and the app shows a greyed tool chip, a disabled
   * composer, and no way to say yes. From the user's side the assistant simply stops: reported as
   * *"reply to comment gets stuck"*, and it was every gated tool, including publishing.
   *
   * The details are not in the event either — the tool, its normalized input, the risk category and the
   * summary the card renders are all in the interaction record. This is the read that fetches them.
   */
  /**
   * What this workspace has spent on the assistant, over a window.
   *
   * The product's credit meter reads `workspaces.ai_credits_used`, which only the web app's own AI
   * routes increment — the assistant's turns go through this runtime and never touch it, so every
   * conversation since the cutover has been invisible to it. The platform *does* record usage, per
   * realized step, in its own ledger; nothing exposed it. This is the read that does.
   *
   * Reported in the platform's units (tokens and minor currency units) plus a turn count, and
   * deliberately **not** converted into "credits" here: what a credit is worth is a billing decision
   * this file has no business making.
   */
  readonly usage?: (input: {
    readonly context: ExecutionContext;
    readonly from: string;
    readonly to: string;
  }) => Promise<{
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMinorUnits: number;
    readonly currency: string;
    readonly turns: number;
  }>;
  /**
   * One run's token usage, and the context window it is measured against.
   *
   * The *session context* meter: how full the model's window was on the last turn. Distinct from
   * `usage`, which is a spend total over days — this is a single prompt's size, which is the number a
   * person needs when a conversation starts to feel long and they are deciding whether to start a new
   * one. Nothing exposed it; the platform records it per realized step.
   *
   * `contextLimit` comes from the manifest rather than the client, so the bar cannot be drawn against a
   * number this deployment does not actually enforce.
   */
  readonly runUsage?: (input: {
    readonly context: ExecutionContext;
    /** One of the two. A run for a turn just finished; a conversation for one just opened. */
    readonly runId?: string;
    readonly conversationId?: string;
  }) => Promise<{
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly steps: number;
    /** #630: the answering model's working window — `min(window, 200k)`. */
    readonly contextLimit: number;
    /** #630: the answering model's full window, and its id. */
    readonly contextWindow?: number;
    readonly modelId?: string;
    /** #630: roughly where older turns get condensed. */
    readonly compactAt?: number;
    /** #630: whether the turn's history began with a condensed summary of older turns. */
    readonly historyCondensed?: boolean;
    /**
     * #518: true when `inputTokens` is the last model call's input — the real context. False for a
     * turn recorded before per-call measurement, where `inputTokens` is the turn's total and must not
     * be shown as context.
     */
    readonly contextMeasured?: boolean;
    /** #518: every call's input added up — what the turn cost in input, not how big the context is. */
    readonly turnInputTokens?: number;
    readonly cachedInputTokens?: number;
    /** #552: the turn's prompt by source — `{ instructionsTokens, sections: [{ providerId, tokens }] }`. */
    readonly contextSections?: unknown;
    /** #649 follow-up: hashes of the latest call's tools, system prompt and messages. */
    readonly promptFingerprint?: unknown;
    /**
     * #658: characters per token the provider showed on this turn (prompt characters ÷ measured input). The
     * `contextSections` above are already restated at it; absent when the turn predates the measurement.
     */
    readonly charsPerToken?: number;
  }>;
  /**
   * #551: the models this workspace's chats may pick — the deployment's, then the workspace's own key.
   * The web's model picker renders exactly this list, so it cannot offer what the turn would refuse.
   */
  readonly models?: (input: { readonly context: ExecutionContext }) => Promise<{
    readonly models: readonly { readonly id: string; readonly label: string; readonly source: "chorus" | "workspace"; readonly provider: string; readonly modelId: string }[];
    readonly defaultId: string;
  }>;
  readonly pendingInteraction?: (input: {
    readonly context: ExecutionContext;
    readonly runId: string;
  }) => Promise<{
    readonly approval?: {
      readonly interactionId: string;
      readonly toolName: string;
      readonly toolArgs: unknown;
      readonly riskCategory: string;
      readonly summary: string;
      readonly expiresAt: string;
      readonly estimatedCostMinorUnits?: number;
    };
    readonly question?: {
      readonly interactionId: string;
      readonly questions: readonly unknown[];
    };
  }>;
  /**
   * Readiness: whether this process can actually serve a turn.
   *
   * Optional, and its absence means `/readyz` answers 200 — a deployment that supplies no probe is
   * saying it has nothing to check, not that it is broken. Liveness needs no probe at all: the process
   * answering is the whole signal.
   */
  readonly ready?: () => Promise<{ readonly ok: boolean; readonly detail?: string }>;
  /**
   * The caller's personal memory, for Settings → Memory — #621. **Absent means the routes refuse.**
   *
   * Scoped by `turnContext` from the caller, like every route here, and the service reads the principal from that
   * context and nowhere else — so no id in a path or a body can reach another person's memory. A memory id this
   * caller does not own answers 404, the same as one that never existed.
   */
  readonly personalMemory?: Pick<PersonalMemoryService, "list" | "setEnabled" | "remove">;
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
  /** #543: the person's agent mode, model and effort for this turn — written onto the run (`turn-settings.ts`). */
  readonly settings?: TurnSettings;
};

export type StartedTurn = {
  readonly conversationId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly started: string;
};

/** The longest message this will accept. A bound, so a runaway client cannot post a book. */
export const MAX_MESSAGE_CHARS = 32_000;

/**
 * How many rows a history page returns.
 *
 * Bounded here rather than trusted, for the reason every list in this package is bounded: a page is
 * rendered, and the ceiling has to belong to the server rather than to whoever asks. A missing or
 * unparseable value is the default rather than an error — a client asking for nothing in particular
 * wants a sensible page, not a 400.
 */
export const MAX_HISTORY_LIMIT = 100;
export const DEFAULT_HISTORY_LIMIT = 30;

export const boundedLimit = (raw: string | null): number => {
  if (raw === null || raw.trim() === "") return DEFAULT_HISTORY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_HISTORY_LIMIT));
};

/** `/api/memory/:id` → the id, or `null` when the path is something else — #621. */
export const memoryIdFrom = (pathname: string): string | null => {
  const match = /^\/api\/memory\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
};

/**
 * `/api/conversations/:id/messages` → the id, or `null` when the path is something else.
 *
 * Matched rather than split, so `/api/conversations/x/messages/y` is not read as a message list for
 * `x`: a path that means something else must not be answered as if it meant this. The same rule
 * `toolNameFrom` follows.
 */
export const conversationIdFrom = (pathname: string): string | null => {
  const match = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
  const id = match?.[1];
  return id === undefined || id === "" ? null : decodeURIComponent(id);
};

/**
 * `/api/interactions/:id/answer` and `.../decide` → the id and which one, or `null`.
 *
 * One matcher for both, anchored and single-segment, for the reason `conversationIdFrom` is: a path
 * that means something else must not be answered as if it meant this. `answer` and `decide` are kept
 * distinct rather than folded into one "respond" route because they take different bodies and touch
 * different services — a single endpoint would have to guess which from the payload, and guessing
 * wrong resumes a run with the wrong kind of outcome recorded.
 */
export const interactionActionFrom = (
  pathname: string,
): { readonly interactionId: string; readonly action: "answer" | "decide" } | null => {
  const match = /^\/api\/interactions\/([^/]+)\/(answer|decide)$/.exec(pathname);
  const id = match?.[1];
  const action = match?.[2];
  if (id === undefined || id === "" || action === undefined) return null;
  return { interactionId: decodeURIComponent(id), action: action as "answer" | "decide" };
};

/** `/api/runs/:id/cancel` → the run id, or `null`. */
export const runCancelIdFrom = (pathname: string): string | null => {
  const match = /^\/api\/runs\/([^/]+)\/cancel$/.exec(pathname);
  const id = match?.[1];
  return id === undefined || id === "" ? null : decodeURIComponent(id);
};

/**
 * The answers map, validated — or a sentence saying what is wrong with it.
 *
 * Validated rather than cast, because these values are handed to the model as the person's reply. A
 * cast would let `{ tone: { nested: true } }` through to be rendered as `[object Object]` in the
 * prompt, which is the shape of a bug nobody traces back to an HTTP body: the run resumes, the answer
 * is nonsense, and nothing failed.
 *
 * `QuestionAnswer` is `string | readonly string[]` — a single-select answer stays a string on purpose,
 * so both arms are accepted here and neither is silently wrapped.
 */
export const validatedAnswers = (
  raw: unknown,
): { readonly ok: true; readonly answers: Readonly<Record<string, QuestionAnswer>> } | { readonly ok: false; readonly why: string } => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, why: "answers must be an object keyed by the question's key" };
  }
  const out: Record<string, QuestionAnswer> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      /**
       * An empty array is refused rather than accepted as "no answer".
       *
       * A multi-select that came back empty means the person chose nothing, and recording that as an
       * answer resumes the run believing it was told something. Leaving the key out is how a client
       * says nothing about it.
       */
      if (value.length === 0) return { ok: false, why: `the answer for ${key} is an empty list — omit the key instead` };
      out[key] = value as readonly string[];
      continue;
    }
    return { ok: false, why: `the answer for ${key} must be a string or a list of strings` };
  }
  if (Object.keys(out).length === 0) return { ok: false, why: "answers must contain at least one answer" };
  return { ok: true, answers: out };
};

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
      settings?: unknown;
    } | null;

    const text = typeof body?.message === "string" ? body.message.trim() : "";
    if (text === "") return refuse(400, "a message is required");
    if (text.length > MAX_MESSAGE_CHARS) {
      return refuse(400, `that message is ${text.length} characters and the limit is ${MAX_MESSAGE_CHARS}`);
    }
    const conversationId = typeof body?.conversationId === "string" ? body.conversationId : undefined;
    if (body?.shadow === true) {
      return refuse(
        400,
        "shadow turns are no longer supported — the runtime they compared against is gone (#712). " +
          "Send the turn without `shadow`; it will run for real.",
      );
    }

    const context = turnContext({
      tenantId: caller.tenantId,
      principalId: caller.principalId,
      roleIds: caller.roleIds,
      requestId: crypto.randomUUID(),
      ...(conversationId === undefined ? {} : { conversationId }),
    });

    // Parsed leniently: a malformed setting falls back to the default rather than refusing the turn.
    const settings = parseTurnSettings(body?.settings);
    const started = await deps.startTurn({ context, message: text, settings, ...(conversationId === undefined ? {} : { conversationId }) });
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

      /**
       * Health **before** authentication, because a healthcheck has no credentials.
       *
       * They were behind the authenticator at first, which answered `/healthz` with 401 — so the
       * container's own healthcheck marked it unhealthy, and `shareflow_worker` depends on it. A
       * liveness probe that needs a secret is not a liveness probe.
       */
      if (url.pathname === "/healthz" && request.method === "GET") {
        /**
         * 200 whenever the process is answering, and deliberately no database call.
         *
         * An orchestrator that restarts a process because a *dependency* is unavailable turns a brief
         * blip into a restart storm, and the replacement process is no more able to reach the database
         * than the one it killed.
         */
        return json({ status: "ok", application: APPLICATION_NAME }, 200);
      }

      if (url.pathname === "/readyz" && request.method === "GET") {
        const probe = deps.ready === undefined ? { ok: true } : await deps.ready().catch((error: unknown) => ({
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }));
        return json(
          { status: probe.ok ? "ready" : "not-ready", ...(probe.detail === undefined ? {} : { detail: probe.detail }) },
          probe.ok ? 200 : 503,
        );
      }

      const caller = await deps.authenticate(request);
      if (caller === null) return refuse(401, "not authenticated");

      if (url.pathname === "/api/message" && request.method === "POST") return message(request, caller);
      if (url.pathname === "/api/events" && request.method === "GET") return events(request, caller);

      /**
       * History, for a client that renders a transcript rather than only a live turn.
       *
       * Both are `GET` and both are scoped by the caller's own tenant through `turnContext` — the same
       * identity a turn runs under, so there is one answer to "who is this" rather than two.
       */
      if (url.pathname === "/api/conversations" && request.method === "GET") {
        if (deps.listConversations === undefined) {
          return refuse(404, "this deployment serves live turns only — it has no conversation history surface");
        }
        const limit = boundedLimit(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("cursor");
        const page = await deps.listConversations({
          context: turnContext({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            roleIds: caller.roleIds,
            requestId: crypto.randomUUID(),
          }),
          limit,
          ...(cursor === null || cursor === "" ? {} : { cursor }),
        });
        return json(page, 200);
      }

      const conversationId = conversationIdFrom(url.pathname);
      if (conversationId !== null && request.method === "GET") {
        if (deps.listMessages === undefined) {
          return refuse(404, "this deployment serves live turns only — it has no conversation history surface");
        }
        const limit = boundedLimit(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("cursor");
        const page = await deps.listMessages({
          context: turnContext({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            roleIds: caller.roleIds,
            requestId: crypto.randomUUID(),
          }),
          conversationId,
          limit,
          ...(cursor === null || cursor === "" ? {} : { cursor }),
        });
        return json(page, 200);
      }

      /**
       * Answering a question, deciding an approval, cancelling a run.
       *
       * All three are scoped by `turnContext` from the **caller's** identity, never by anything in the
       * body or the path. That is the check that matters here: an interaction id is opaque and arrives
       * from the client, so a route that trusted it would let one workspace answer another's approval —
       * and an approval is precisely the thing that must not be answerable by the wrong person. The
       * platform's services take a `tenantId` and scope every read and write by it, so passing the
       * caller's is what makes the id safe to accept.
       */
      /**
       * `GET /api/usage?days=30` — what this workspace has spent on the assistant.
       *
       * A window in days rather than a pair of instants, because every caller wants "recently" and a
       * client computing two ISO timestamps in its own timezone is a client that will disagree with the
       * next one. Capped at a year: this reads the ledger rather than the rollups, and an unbounded
       * window is an unbounded scan.
       */
      if (url.pathname === "/api/usage" && request.method === "GET") {
        /**
         * `?runId=` asks a different question from `?days=`: how full the window was on that turn,
         * rather than what the workspace has spent. One route because both are "usage", and the
         * parameter says which.
         */
        const forRun = url.searchParams.get("runId");
        /**
         * `conversationId` as well as `runId`, because a conversation the user just *opened* has no run
         * in this session — the messages come from the store and carry no run id. Without it the meter
         * appeared only after you sent something, which is the moment you least need to be told the
         * conversation is getting long.
         */
        const forConversation = url.searchParams.get("conversationId");
        if ((forRun !== null && forRun.trim() !== "") || (forConversation !== null && forConversation.trim() !== "")) {
          if (deps.runUsage === undefined) {
            return refuse(404, "this deployment does not report per-run usage");
          }
          const usage = await deps.runUsage({
            context: turnContext({
              tenantId: caller.tenantId,
              principalId: caller.principalId,
              roleIds: caller.roleIds,
              requestId: crypto.randomUUID(),
            }),
            ...(forRun === null || forRun.trim() === "" ? {} : { runId: forRun.trim() }),
            ...(forConversation === null || forConversation.trim() === ""
              ? {}
              : { conversationId: forConversation.trim() }),
          });
          return json(usage, 200);
        }

        if (deps.usage === undefined) {
          return refuse(404, "this deployment does not report usage");
        }
        const asked = Number(url.searchParams.get("days") ?? "30");
        const days = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 365) : 30;
        const to = new Date();
        const from = new Date(to.getTime() - days * 86_400_000);
        const totals = await deps.usage({
          context: turnContext({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            roleIds: caller.roleIds,
            requestId: crypto.randomUUID(),
          }),
          from: from.toISOString(),
          to: to.toISOString(),
        });
        return json({ ...totals, days, from: from.toISOString(), to: to.toISOString() }, 200);
      }

      /**
       * `GET /api/interactions/pending?runId=…` — what this run is waiting for, if anything.
       *
       * A GET with the run in the query rather than a path segment, because the caller has a run id and
       * not an interaction id: the whole point is that it does not know what it is waiting for yet.
       * The tenant comes from the caller as everywhere else, so one workspace cannot read another's
       * pending approval — which would leak the tool name and its arguments.
       */
      /** `GET /api/models` — #551, the chat box's model picker. Scoped by the caller, like everything here. */
      if (url.pathname === "/api/models" && request.method === "GET") {
        if (deps.models === undefined) return refuse(404, "this deployment does not list models");
        return json(
          await deps.models({
            context: turnContext({ tenantId: caller.tenantId, principalId: caller.principalId, roleIds: caller.roleIds, requestId: crypto.randomUUID() }),
          }),
          200,
        );
      }

      if (url.pathname === "/api/interactions/pending" && request.method === "GET") {
        if (deps.pendingInteraction === undefined) {
          return refuse(404, "this deployment cannot report pending interactions — it has no interaction surface");
        }
        const runId = url.searchParams.get("runId");
        if (runId === null || runId.trim() === "") return refuse(400, "runId is required");
        const pending = await deps.pendingInteraction({
          context: turnContext({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            roleIds: caller.roleIds,
            requestId: crypto.randomUUID(),
          }),
          runId: runId.trim(),
        });
        return json(pending, 200);
      }

      const interaction = interactionActionFrom(url.pathname);
      if (interaction !== null && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          runId?: unknown;
          answers?: unknown;
          decision?: unknown;
          conversationId?: unknown;
        } | null;

        const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
        /**
         * The run id is required, and it is not redundant with the interaction id.
         *
         * The platform's `answer`/`decide` take both, because the interaction says *what* was asked and
         * the run says *what to wake*. Deriving one from the other here would be this file inventing a
         * relationship the store already owns.
         */
        if (runId === "") return refuse(400, "runId is required — it says which run to resume");

        if (interaction.action === "answer") {
          if (deps.answerQuestion === undefined) {
            return refuse(404, "this deployment cannot answer questions — it has no interaction surface");
          }
          const parsed = validatedAnswers(body?.answers);
          if (!parsed.ok) return refuse(400, parsed.why);
          const outcome = await deps.answerQuestion({
            context: turnContext({
              tenantId: caller.tenantId,
              principalId: caller.principalId,
              roleIds: caller.roleIds,
              requestId: crypto.randomUUID(),
            }),
            interactionId: interaction.interactionId,
            runId,
            answers: parsed.answers,
          });
          return json({ ok: true, ...outcome }, 200);
        }

        if (deps.decideApproval === undefined) {
          return refuse(404, "this deployment cannot decide approvals — it has no interaction surface");
        }
        /**
         * The decision is checked against the platform's own list, and an unknown one is a 400.
         *
         * Not passed through: the service records whatever it is given and only *allow* decisions
         * authorize the stored call, so a typo would be recorded as a decision, read as "not an allow",
         * and resume the run as a denial. The person clicked approve and the tool did not run, with
         * nothing anywhere saying why — a wrong option name that typechecks and does the wrong thing
         * quietly, which is the failure this codebase has hit three times.
         */
        const decision = typeof body?.decision === "string" ? body.decision : "";
        if (!(APPROVAL_DECISIONS as readonly string[]).includes(decision)) {
          return refuse(400, `decision must be one of ${APPROVAL_DECISIONS.join(", ")}`);
        }
        const conversationId = typeof body?.conversationId === "string" && body.conversationId !== "" ? body.conversationId : undefined;
        /**
         * `allow-conversation` without a conversation id is refused rather than downgraded.
         *
         * The grant it issues is scoped *to a conversation*, so with none supplied the platform would
         * have to either mint a wider grant or none at all. Both are worse than saying so: one hands
         * over authority nobody granted, the other looks like approval and expires instantly.
         */
        if (decision === "allow-conversation" && conversationId === undefined) {
          return refuse(400, "allow-conversation needs conversationId — the grant it issues is scoped to that conversation");
        }
        const outcome = await deps.decideApproval({
          context: turnContext({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            roleIds: caller.roleIds,
            requestId: crypto.randomUUID(),
          }),
          interactionId: interaction.interactionId,
          runId,
          ...(conversationId === undefined ? {} : { conversationId }),
          decision: decision as ApprovalDecision,
        });
        return json({ ok: true, ...outcome }, 200);
      }

      const cancelRunId = runCancelIdFrom(url.pathname);
      if (cancelRunId !== null && request.method === "POST") {
        if (deps.cancelRun === undefined) {
          return refuse(404, "this deployment cannot cancel runs — it has no interaction surface");
        }
        const cancelled = await deps.cancelRun({
          context: turnContext({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            roleIds: caller.roleIds,
            requestId: crypto.randomUUID(),
          }),
          runId: cancelRunId,
        });
        /**
         * A 404 for a run this tenant does not have — the same answer as a run that never existed.
         *
         * Deliberately indistinguishable: a 403 would confirm that somebody else's run id is real,
         * which turns this route into an oracle for enumerating them. The tool route's own comment
         * makes the same argument about hiding a tool.
         */
        if (cancelled === null) return refuse(404, `no run ${cancelRunId}`);
        /**
         * `requested`, not `cancelled`. The worker observes the request and stops cooperatively, so the
         * run is still running when this answers, and the status is the run's own.
         */
        return json({ ok: true, requested: true, status: cancelled.status }, 200);
      }

      /**
       * `GET /api/memory`, `PATCH /api/memory/:id` (`{ enabled }`) and `DELETE /api/memory/:id` — #621.
       *
       * The caller's own memories only: the context is the caller's, and the service takes the principal from it.
       */
      if (url.pathname === "/api/memory" || memoryIdFrom(url.pathname) !== null) {
        if (deps.personalMemory === undefined) return refuse(404, "this deployment has no personal memory");
        const context = turnContext({
          tenantId: caller.tenantId,
          principalId: caller.principalId,
          roleIds: caller.roleIds,
          requestId: crypto.randomUUID(),
        });
        const memoryId = memoryIdFrom(url.pathname);
        try {
          if (memoryId === null && request.method === "GET") {
            return json({ items: await deps.personalMemory.list(context) }, 200);
          }
          if (memoryId !== null && request.method === "PATCH") {
            const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
            if (typeof body?.enabled !== "boolean") return refuse(400, "enabled must be true or false");
            return json({ memory: await deps.personalMemory.setEnabled(context, { id: memoryId, enabled: body.enabled }) }, 200);
          }
          if (memoryId !== null && request.method === "DELETE") {
            const { deleted } = await deps.personalMemory.remove(context, { id: memoryId });
            return deleted ? json({ ok: true, deleted: true }, 200) : refuse(404, "no such memory");
          }
        } catch (error) {
          if (error instanceof AgentPlatformError) {
            const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "invalid_input" ? 400 : error.code === "forbidden" ? 403 : 500;
            return refuse(status, status === 500 ? "the memory could not be changed" : error.message);
          }
          throw error;
        }
        return refuse(405, `${request.method} is not supported on ${url.pathname}`);
      }

      const toolName = toolNameFrom(url.pathname);
      if (toolName !== null && request.method === "POST") {
        if (deps.toolRegistry === undefined) {
          return refuse(404, "this deployment serves the conversational surface only");
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return refuse(400, "the body must be JSON — it is the tool's own input, unwrapped");
        }
        const outcome = await executeToolCall({
          registry: deps.toolRegistry,
          // The same `turnContext` the conversational routes use, so a tool called directly runs under
          // exactly the identity a tool called from a turn would. A second way of building a context is
          // a second answer to "who is this", and the registry re-authorises on execute.
          context: turnContext({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            roleIds: caller.roleIds,
            requestId: crypto.randomUUID(),
          }),
          name: toolName,
          body,
          /**
           * From the caller's own header, never generated here.
           *
           * An idempotency key this route invented would be unique per attempt, so a retry after a
           * timeout would execute twice — which is the failure the key exists to prevent.
           */
          ...(request.headers.get("idempotency-key") === null
            ? {}
            : { idempotencyKey: request.headers.get("idempotency-key") as string }),
        });
        return json(outcome.body, outcome.status);
      }
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
