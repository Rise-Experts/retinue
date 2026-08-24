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
  createResolvers,
  createRollupJob,
  createPostgresUsageRollupStore,
} from "@agentkit/backend";
import { citationViewModel, formatCost, formatTokens, shapeUsagePanel } from "@agentkit/frontend";
import { COMPACT_AT_FRACTION, compactConversation, createExampleSummarizer } from "./compaction.js";
import { HISTORY_READ_LIMIT } from "./history.js";
import { contextUsage } from "./context-usage.js";
import { exampleProviders } from "./providers.js";
import { resolveExampleModel } from "./model.js";
import type { ConversationMode } from "./modes.js";
import type {
  ConversationId,
  ExecutionContext,
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
   * Compact a conversation — #169.
   *
   * The summariser is a model call through the app's own resolved model, which is why this lives here rather
   * than in `compaction.ts`: that module is the deterministic part and takes the summariser as a dependency, so
   * it is testable without a model.
   */
  const compactNow = async (context: ExecutionContext, conversationId: string) => {
    const messages = await createPostgresMessageStore(options.sql).listByConversation({
      tenantId: context.tenantId,
      conversationId: asId<ConversationId>(conversationId),
      limit: 500,
    });
    return compactConversation({
      sql: options.sql,
      context,
      conversationId,
      messages: messages.items,
      summarizer: createExampleSummarizer({
        generate: async (prompt) => {
          const { generateText } = await import("ai");
          const resolved = resolveExampleModel();
          const result = await generateText({ model: resolved.model, prompt });
          return result.text;
        },
      }),
    });
  };

  /**
   * Starting a turn: persist the message, create the run, admit it.
   *
   * One function, because `POST /api/message` and `POST /api/plan/execute` both do exactly this and the two
   * getting out of step is not hypothetical — the create-then-admit ordering below is a bug I already wrote
   * once. A second copy of it would be a second chance to write it again.
   */
  const startTurn = async (
    // The whole execution context, not just the tenant: the run records the principal and roles it was
    // admitted for (#164), and narrowing this to `{ tenantId }` is what let the identity go missing.
    context: ExecutionContext,
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
     * Compact before admitting, if the window is nearly full — #169.
     *
     * **Before**, not after: the run about to start is the one that would fail, and compacting after it has been
     * admitted fixes the turn after the one that broke. This is also why the threshold is 0.7 rather than 0.9 —
     * compaction is itself a model call over the whole prefix, so at 0.9 the summarisation prompt may not fit.
     *
     * Failure here is logged and swallowed. A conversation that cannot be compacted should still get its turn:
     * it may well fit, and refusing to answer because an optimisation failed is worse than a long prompt.
     */
    const effectiveMode = await modeStore().get({
      tenantId: String(context.tenantId),
      conversationId: String(conversationId),
    });
    try {
      const usage = await contextUsage({
        sql: options.sql,
        context: { ...context, conversationId },
        mode: effectiveMode,
        providers: exampleProviders(options.sql),
      });
      if (usage.fraction >= COMPACT_AT_FRACTION || usage.totalMessages > HISTORY_READ_LIMIT) {
        const outcome = await compactNow(context, String(conversationId));
        if (outcome.compacted) {
          console.log(
            `[compact] ${conversationId}: ${outcome.droppedParts} parts condensed, ` +
              `~${outcome.tokensReclaimed} tokens reclaimed, ${outcome.keptTurns} turns kept verbatim`,
          );
        }
      }
    } catch (thrown) {
      console.error(`[compact] skipped for ${conversationId}: ${(thrown as Error).message}`);
    }

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
      /**
       * Who this run is for, recorded at admission — #164.
       *
       * From the authenticated caller, which is the only place it can honestly come from. Without it the worker
       * has nothing to rebuild an identity from, and this app used to invent `principalId: "example-worker"`
       * with `roleIds: ["editor"]`: every person's memories landed under one identity, and a `viewer`'s
       * admitted run executed with editor rights.
       */
      principalId: context.principalId,
      roleIds: context.roleIds,
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

    /**
     * The usage panel — #155 AC-5.
     *
     * The **shaping is done here, by the platform's own `shapeUsagePanel`**, and the page draws what it is
     * given. That is the point rather than a convenience: the panel's rules are real decisions — `state` comes
     * from `eventCount` and not from the bucket array, because a rollup over a quiet hour writes zeroed buckets
     * and drawing those is exactly what the empty state exists to avoid; bar fractions are against the peak so a
     * quiet period looks quiet; the quota fraction is capped at 1 because a bar wider than its track is a
     * rendering bug. A page that reimplemented any of that would be a second answer to the same question.
     *
     * `@agentkit/frontend` is a runtime dependency here for that reason. Its React components stay untouched —
     * `shapeUsagePanel`, `formatCost` and `formatTokens` are react-free by design, and `./ui` is opt-in.
     */
    if (url.pathname === "/api/usage" && request.method === "GET") {
      const context = await options.authenticate(request);
      if (context === null) return Response.json({ error: "Unauthenticated" }, { status: 401 });

      const to = new Date();
      const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      const period = "day" as const;

      /**
       * Rebuilt on request, not on a schedule.
       *
       * A rollup is a *recomputation*, so running it twice cannot double count — which is what makes doing it
       * here safe rather than merely convenient. A cron in an example is a process someone has to know to start,
       * and a chart empty until it runs looks like a bug in the panel.
       */
      const job = createRollupJob({ rollups: createPostgresUsageRollupStore(options.sql) });
      // Bounded. An unbounded loop over stale buckets would turn one page load into a backfill.
      for (let page = 0; page < 8; page += 1) {
        const { remaining } = await job.run(
          { tenantId: context.tenantId },
          { period, since: from.toISOString(), limit: 50 },
        );
        if (remaining === 0) break;
      }

      const resolvers = createResolvers(options.deps);
      const report = await resolvers.Query.usageReport(
        {},
        { period, from: from.toISOString(), to: to.toISOString(), breakdownLimit: 5 },
        { execution: context },
      );
      const panel = shapeUsagePanel(report as never);
      return Response.json({
        panel,
        // Formatted server-side with the platform's own formatters, so minor units become major ones in exactly
        // one place. Doing that division at a call site is how a figure ends up a hundred times wrong.
        formatted: {
          cost: formatCost(panel.totals.costMinorUnits, panel.currency),
          inputTokens: formatTokens(panel.totals.inputTokens),
          outputTokens: formatTokens(panel.totals.outputTokens),
          bars: panel.bars.map((b) => ({ ...b, cost: formatCost(b.costMinorUnits, panel.currency) })),
          byModel: panel.byModel.map((e) => ({ key: e.key, cost: formatCost(e.totals.costMinorUnits, panel.currency) })),
        },
      });
    }

    /**
     * How full the window is — #168.
     *
     * Both halves: the budgeted context sections and the conversation history. A utilization figure that counts
     * only one of them reassures you right up to the failure, and history is usually the larger half and the one
     * that grows without bound.
     */
    if (url.pathname === "/api/context" && request.method === "GET") {
      const context = await options.authenticate(request);
      if (context === null) return Response.json({ error: "Unauthenticated" }, { status: 401 });
      const conversationId = url.searchParams.get("conversationId");
      const scoped =
        conversationId === null ? context : { ...context, conversationId: asId<ConversationId>(conversationId) };
      const mode =
        conversationId === null
          ? DEFAULT_MODE
          : await modeStore().get({ tenantId: String(context.tenantId), conversationId });

      const usage = await contextUsage({
        sql: options.sql,
        context: scoped,
        mode,
        // The same list the app module assembles from — see `./providers.ts`.
        providers: exampleProviders(options.sql),
      });
      return Response.json({
        ...usage,
        // Advertised so the page does not hardcode the same number. A threshold the UI and the server disagree
        // about is a UI that says "fine" while the server compacts, or the reverse.
        compactAt: COMPACT_AT_FRACTION,
        /**
         * Two triggers, either of which is enough.
         *
         * The fraction catches a conversation whose turns are long. The message count catches one whose turns are
         * short but numerous — where a *capped* history read makes the window look roomy while turns fall off the
         * end unsummarised. Only checking the fraction is how a 2000-message conversation reports "3% full" and
         * never compacts.
         */
        totalMessages: usage.totalMessages,
        overflowing: usage.totalMessages > HISTORY_READ_LIMIT,
        shouldCompact: usage.fraction >= COMPACT_AT_FRACTION || usage.totalMessages > HISTORY_READ_LIMIT,
      });
    }

    /**
     * Compact this conversation now — #169.
     *
     * Explicit as well as automatic, because a threshold picks its moment from a number and a person picks
     * theirs when they have finished with a topic. That is the better moment and no threshold can see it.
     */
    if (url.pathname === "/api/compact" && request.method === "POST") {
      const context = await options.authenticate(request);
      if (context === null) return Response.json({ error: "Unauthenticated" }, { status: 401 });
      const body = (await request.json()) as { conversationId?: string };
      if (body.conversationId === undefined || body.conversationId === "")
        return Response.json({ error: "conversationId is required" }, { status: 400 });

      const outcome = await compactNow(context, body.conversationId);
      return Response.json(outcome);
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
        /**
         * Citations come back with the turn, derived by the platform's `citationViewModel` (#155 AC-5).
         *
         * The view model rather than the raw parts, because the *numbering* is the part that matters and it is
         * a decision: numbers are assigned in arrival order and never recomputed from position, since
         * renumbering as citations stream in would change text the reader is already looking at. A page that
         * numbered them itself would be a second answer to "which citation is number 3".
         *
         * Only for assistant turns; a user turn has no citations to ground anything with.
         */
        turns: turns.map((turn) => ({
          role: turn.role,
          text: turn.text,
          citations:
            turn.role === "assistant"
              ? citationViewModel({ id: "", role: "assistant", parts: turn.parts } as never).panels.map(
                  (panel, i) => ({
                    ...panel,
                    /**
                     * The origin too, so the page renders a reloaded citation exactly as it renders a streamed
                     * one. The panel's `label` is the platform's rendering; the page has its own, because a
                     * streaming citation arrives as a raw part and never passes through here. Sending the origin
                     * means one label derivation on the page rather than one for each path.
                     */
                    origin: turn.parts.filter((x) => x.type === "citation")[i]?.origin ?? {},
                  }),
                )
              : [],
        })),
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
