/**
 * The example's own HTTP surface — #155, AC-1 and AC-5.
 *
 * Two example routes in front of the platform host, which is mounted unchanged and handles everything else.
 * That is not a workaround; it is what an application looks like. The platform deliberately does **not** own
 * message ingestion: `sendMessage(conversationId, runId)` takes ids and no text, because what a "message" is —
 * who may send one, what it may contain, what else happens when one arrives — is the application's decision.
 * So the app writes the user's turn and then asks the platform to run it.
 *
 * It also demonstrates the composition the host's doc comment claims: the returned adapter is a fetch handler,
 * so putting routes in front of it is genuinely two lines rather than a framework choice.
 *
 * - `POST /api/message` — persist the user's turn, then start a run.
 * - `GET /` — the browser test surface.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  asId,
  createPostgresApprovalGrantStore,
  createPostgresConversationStore,
  createPostgresMessageStore,
  createPostgresSessionStateStore,
  startOrEnqueueRun,
} from "@agentkit/backend";
import type { ConversationMode } from "./modes.js";
import type {
  ConversationId,
  MessageId,
  MessagePartId,
  ResolverDeps,
  RunId,
  SqlExecutor,
  TenantId,
} from "@agentkit/backend";
import { createAgentkitHost, type Authenticate } from "@agentkit/server";
import { conversationTurns } from "./history.js";
import {
  CONVERSATION_MODES,
  DEFAULT_MODE,
  MODE_DESCRIPTIONS,
  PLAN_EXECUTION_MODE,
  PLAN_EXECUTION_PROMPT,
  isConversationMode,
} from "./modes.js";
import { createModeStore } from "./mode-store.js";

export type ExampleServerOptions = {
  readonly deps: ResolverDeps;
  readonly authenticate: Authenticate;
  readonly sql: SqlExecutor;
  readonly port: number;
  readonly pagePath?: string;
};

/** A run id derived from the message, so a double-submit starts one run rather than two. */
const runIdFor = (messageId: string): RunId => asId<RunId>(`run-${messageId}`);

export const startExampleServer = async (options: ExampleServerOptions) => {
  const host = createAgentkitHost({
    deps: options.deps,
    authenticate: options.authenticate,
    // On, deliberately: this *is* a playground, and the reference host turns it off because it is not one.
    graphiql: true,
    // The platform's SSE route, on the same handler. `deps` and `authenticate` come from above rather than
    // being repeated -- the host already has them, and a second copy is a second thing to get out of step.
    sse: { enabled: true },
  });

  const conversations = createPostgresConversationStore(options.sql);
  const messages = createPostgresMessageStore(options.sql);
  const pagePath = options.pagePath ?? resolve(import.meta.dirname, "../public/index.html");
  /**
   * Read **per request**, not once at boot.
   *
   * Cached at startup, editing the page did nothing until the server was restarted — and the failure mode is
   * nasty: the browser silently serves a stale page, so a fix you have just made appears not to work. I lost time
   * to exactly that, debugging a rendering bug I had already fixed.
   *
   * A file read per request is irrelevant here (one small file, a single developer) and this is a test surface, so
   * the trade is entirely in favour of edit-and-reload.
   */
  const page = (): string => readFileSync(pagePath, "utf8");

  /** One factory for the three routes that need the mode: the selector, the plan button, and history. */
  const modeStore = () =>
    createModeStore({
      sessions: createPostgresSessionStateStore(options.sql),
      grants: createPostgresApprovalGrantStore(options.sql),
    });

  /**
   * Starting a turn: persist the message, create the run, admit it.
   *
   * One function, because `POST /api/message` and `POST /api/plan/execute` both do exactly this and the two
   * getting out of step is not hypothetical — the create-then-admit ordering below is a bug I already wrote
   * once. A second copy of it would be a second chance to write it again.
   */
  const startTurn = async (
    context: { readonly tenantId: TenantId },
    input: { readonly conversationId?: string; readonly text: string; readonly mode?: ConversationMode },
  ): Promise<{ conversationId: string; runId: string; messageId: string; started: string; mode: ConversationMode }> => {
    const conversationId = asId<ConversationId>(input.conversationId ?? `conv-${Date.now().toString(36)}`);
    // Idempotent: re-sending the same first message to an existing conversation does not create a second.
    const existing = await conversations.findById({ tenantId: context.tenantId, id: conversationId });
    if (existing === null)
      await conversations.create({ tenantId: context.tenantId, id: conversationId, title: input.text.slice(0, 60) });

    /**
     * The mode is settled **before** the run is admitted, and the caller's selection wins.
     *
     * This is a bug I shipped and then watched happen. `POST /api/mode` cannot store a mode for a conversation
     * that does not exist yet, so it answered `{ pending: true }` and left the page to "remember" it — and the
     * page never sent it. Choosing Plan on a fresh chat therefore showed Plan in the selector, ran the turn in
     * `ask`, and the assistant called `share_note` and raised an approval. The selector was making a promise
     * the run did not keep, which is worse than having no modes at all.
     *
     * Sending the mode with the message removes the whole class: there is no window in which the page's idea of
     * the mode and the conversation's differ, because the same request carries both. And it has to be *before*
     * admission — a run enqueued first can be claimed by the worker while the old mode is still stored.
     */
    const mode = input.mode;
    if (mode !== undefined) {
      const current = await modeStore().get({ tenantId: String(context.tenantId), conversationId: String(conversationId) });
      // Written only on a change: `set` also issues and revokes the `auto` grant, and rewriting it on every
      // message would churn a row (and its audit trail) for no reason.
      if (current !== mode)
        await modeStore().set({ tenantId: String(context.tenantId), conversationId: String(conversationId), mode });
    }

    const messageId = asId<MessageId>(`msg-${Date.now().toString(36)}`);
    /**
     * Straight through the port — `MessageStore.append`, added by #157.
     *
     * This used to be a cast past the port with a long comment explaining why. The port was read-only, and both
     * adapters carried an `append` documented as a "test-only affordance", so no host could record what the user
     * said without reaching around the contract. Writing this example is what surfaced it.
     */
    const runId = runIdFor(String(messageId));
    await messages.append({
      tenantId: context.tenantId,
      message: {
        id: messageId,
        conversationId,
        runId,
        role: "user",
        parts: [
          {
            id: asId<MessagePartId>(`${messageId}-p0`),
            type: "text",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            text: input.text,
          },
        ],
        createdAt: new Date().toISOString(),
      },
    });

    /**
     * The run row first, then admission.
     *
     * `startOrEnqueueRun` coordinates the conversation's *slot*; it does not create the run. My first version
     * called only that, got `started` back, and nothing ever executed — the worker claimed a job whose run row
     * did not exist, so `claim` matched nothing and the job was silently skipped. Exactly the shape of the
     * abandoned-run gap #144 found, reproduced here by leaving out the create.
     *
     * This order matters for the same reason it did there: a job enqueued before its row exists is a job
     * pointing at nothing.
     */
    await options.deps.runs.create({
      tenantId: context.tenantId,
      id: runId,
      conversationId,
      agentId: asId("example-notes-agent"),
      agentVersion: 1,
    });
    // Through the platform's own admission path, so the conversation's single-run slot and the queue's dedup
    // both apply — an app that inserted a job directly would bypass exactly the coordination it needs.
    const started = await startOrEnqueueRun(options.deps.coordinator, {
      tenantId: context.tenantId,
      conversationId,
      runId,
    });
    if (started === "started") await options.deps.dispatcher.enqueueRun({ tenantId: context.tenantId, runId });

    return {
      conversationId: String(conversationId),
      runId: String(runId),
      messageId: String(messageId),
      started,
      mode: mode ?? (await modeStore().get({ tenantId: String(context.tenantId), conversationId: String(conversationId) })),
    };
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/message" && request.method === "POST") {
      const context = await options.authenticate(request);
      // The same rejection the GraphQL surface gives. An example route that authenticated more loosely than the
      // platform's would be the example teaching the wrong thing.
      if (context === null) return Response.json({ error: "Unauthenticated" }, { status: 401 });

      const body = (await request.json()) as { conversationId?: string; text?: string; mode?: string };
      const text = String(body.text ?? "").trim();
      if (text === "") return Response.json({ error: "text is required" }, { status: 400 });
      // An unrecognised mode is refused rather than ignored. Ignoring it would run the turn under a mode the
      // caller did not choose, which is precisely the failure this parameter exists to prevent.
      if (body.mode !== undefined && !isConversationMode(body.mode))
        return Response.json({ error: `mode must be one of ${CONVERSATION_MODES.join(", ")}` }, { status: 400 });

      return Response.json(
        await startTurn(context, { conversationId: body.conversationId, text, mode: body.mode }),
      );
    }

    /**
     * Executing a plan — the person read what the assistant proposed and said do it.
     *
     * Two steps, in this order: leave plan mode, then send the instruction. The other order would enqueue a run
     * that the worker picks up while the mode is still `plan`, so the tools would still be excluded from the
     * catalogue and the model would answer the instruction to act by describing the plan again.
     *
     * It lands in `ask`, not `auto` — see `PLAN_EXECUTION_MODE`.
     */
    if (url.pathname === "/api/plan/execute" && request.method === "POST") {
      const context = await options.authenticate(request);
      if (context === null) return Response.json({ error: "Unauthenticated" }, { status: 401 });

      const body = (await request.json()) as { conversationId?: string };
      if (body.conversationId === undefined || body.conversationId === "")
        return Response.json({ error: "conversationId is required" }, { status: 400 });

      const modes = modeStore();
      const mode = await modes.get({ tenantId: String(context.tenantId), conversationId: body.conversationId });
      // Refused rather than treated as a fresh instruction. Outside plan mode there is no plan waiting, so the
      // request is a stale button in an old tab, and acting on it would run something the person never chose.
      if (mode !== "plan")
        return Response.json({ error: `no plan is pending: the conversation is in ${mode} mode` }, { status: 409 });

      // Through the same parameter every other turn uses, so leaving plan mode and starting the run cannot get
      // out of order — `startTurn` settles the mode before it admits anything.
      const result = await startTurn(context, {
        conversationId: body.conversationId,
        text: PLAN_EXECUTION_PROMPT,
        mode: PLAN_EXECUTION_MODE,
      });
      return Response.json({ ...result, text: PLAN_EXECUTION_PROMPT });
    }

    if (url.pathname === "/api/mode") {
      const context = await options.authenticate(request);
      if (context === null) return Response.json({ error: "Unauthenticated" }, { status: 401 });
      const modes = modeStore();

      if (request.method === "GET") {
        const conversationId = url.searchParams.get("conversationId");
        // No conversation yet means the default rather than an error: the page asks for the mode before the first
        // message exists, and answering "400" there would make the selector unusable on a new chat.
        if (conversationId === null) return Response.json({ mode: DEFAULT_MODE, modes: MODE_DESCRIPTIONS });
        return Response.json({
          mode: await modes.get({ tenantId: String(context.tenantId), conversationId }),
          modes: MODE_DESCRIPTIONS,
        });
      }

      if (request.method === "POST") {
        const body = (await request.json()) as { conversationId?: string; mode?: string };
        if (!isConversationMode(body.mode))
          return Response.json({ error: `mode must be one of ${CONVERSATION_MODES.join(", ")}` }, { status: 400 });
        // A mode with no conversation is accepted and remembered by the *page* until the first message creates
        // one; there is nothing server-side to attach it to yet, and inventing a conversation to hold a setting
        // would leave an empty one behind every time somebody changed their mind.
        if (body.conversationId === undefined || body.conversationId === "")
          return Response.json({ mode: body.mode, pending: true });
        await modes.set({
          tenantId: String(context.tenantId),
          conversationId: body.conversationId,
          mode: body.mode,
        });
        return Response.json({ mode: body.mode });
      }
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      const context = await options.authenticate(request);
      if (context === null) return Response.json({ error: "Unauthenticated" }, { status: 401 });
      const conversationId = url.searchParams.get("conversationId");
      if (conversationId === null) return Response.json({ error: "conversationId is required" }, { status: 400 });

      /** The same projection the engine uses for history, so the page and the model see the same conversation. */
      const turns = await conversationTurns({
        sql: options.sql,
        tenantId: String(context.tenantId),
        conversationId,
      });

      /**
       * Whether a plan is waiting to be executed — **derived, not stored**.
       *
       * The conversation is in plan mode and the last thing said was the assistant's: that reply *is* the plan,
       * because plan mode is the only thing it could have been. Persisting a `planPending` flag instead would
       * add a second source of truth that can disagree with the transcript — and it would have to be cleared
       * correctly on every path out of plan mode, including the ones nobody thought of.
       */
      const mode = await modeStore().get({ tenantId: String(context.tenantId), conversationId });
      const planReady = mode === "plan" && turns.length > 0 && turns[turns.length - 1]?.role === "assistant";

      /**
       * The run this conversation is parked on, if any — so a reload does not lose the picker.
       *
       * Without it, closing the tab on a question meant the run stayed in `waiting-for-question` forever with
       * no way to answer it: the card is drawn from the live event stream, and that event has already been and
       * gone. The page needs a run id to query `pendingQuestion` with, and the newest run of the conversation
       * is the only one that can be waiting.
       */
      const recent = await messages.listByConversation({
        tenantId: context.tenantId,
        conversationId: asId<ConversationId>(conversationId),
        limit: 100,
      });
      // The last message's run. `RunStore` has no list-by-conversation and widening the port for one page's
      // reload would be the wrong trade: every user turn already records the run it started, so the newest
      // message names the newest run, which is the only one that can be waiting.
      const lastRunId = [...recent.items].reverse().find((m) => m.runId !== undefined)?.runId;
      const parked =
        lastRunId === undefined ? null : await options.deps.runs.findById({ tenantId: context.tenantId, id: lastRunId });
      const isParked =
        parked !== null && (parked.status === "waiting-for-question" || parked.status === "waiting-for-approval");

      return Response.json({
        turns,
        mode,
        planReady,
        parkedRunId: isParked ? parked.id : null,
        parkedStatus: isParked ? parked.status : null,
      });
    }

    // Everything else is the platform's: GraphQL, SSE, health probes.
    return (host as unknown as (r: Request) => Promise<Response>)(request);
  };

  const server = createServer(
    // The same adapter trick the host uses, and the reason it had to be fixed: Node hands a listener
    // `(IncomingMessage, ServerResponse)`, not a `Request`.
    (await import("@whatwg-node/server")).createServerAdapter(handler),
  );
  await new Promise<void>((r) => server.listen(options.port, r));
  return { port: options.port, close: () => new Promise<void>((r) => server.close(() => r())) };
};
