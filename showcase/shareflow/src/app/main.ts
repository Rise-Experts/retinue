/**
 * The deployable HTTP surface — `node dist/app/main.js`.
 *
 * ## What this is for
 *
 * The container ran `retinue serve`, the platform's **GraphQL** host, and `POST /api/message` answered
 * 404. Verified against the running backend, not assumed. That is exactly the misconfiguration
 * `agentkitClient.ts` was written to detect — *"A bare `retinue serve` has no `/api/message`"* — and the
 * deployed backend was the bare host, so every turn the web app sent would have been refused by its own
 * client. The repointing pointed at nothing.
 *
 * GraphQL is not used by this product at all: the web app speaks `/api/message`, `/api/events` and now
 * `/api/tools/:name`. So this is the deployment's API, and the platform host remains available by
 * overriding the command for anyone who wants it.
 *
 * ## What it refuses to start without
 *
 * Everything the module already refuses for, plus the schema check the reference application does:
 * `SHOW search_path` must actually name the configured schema. A pooler that dropped the connection
 * options would otherwise leave every read and write in `public` — no error, just the wrong tables.
 */

import { optionalEnv, optionalNumberEnv } from "./env.js";
import { TOOL_STEP_PREFIX } from "./tool-usage.js";
import { readTurnSteps } from "./turn-steps.js";
import { createShareFlowServer } from "./server.js";
import { createStartTurn } from "./turns.js";
import { conversationsByActivity } from "./conversation-list.js";
import { createOpenEvents } from "./events.js";
import { SOCIAL_ASSISTANT_LIMITS, SOCIAL_ASSISTANT_VERSION } from "./compose.js";
import { SOCIAL_ASSISTANT_ID } from "./index.js";
import app from "./module.js";
import { PLACEHOLDER_AUTHORIZATION } from "./deployment.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required to serve the ShareFlow backend`);
  }
  return value;
};

export const main = async (): Promise<void> => {
  const databaseUrl = required("RETINUE_DATABASE_URL");
  const redisUrl = required("RETINUE_REDIS_URL");
  const schema = optionalEnv("RETINUE_DATABASE_SCHEMA");
  // `Number("")` is 0, which binds a random port. See env.ts.
  const port = optionalNumberEnv("PORT", 4000);

  const { Pool } = await import("pg");
  const { createPgExecutor, createPoolOpener, createTransactionScope, createPostgresRunEventLog } = await import(
    "@retinue/agentkit/adapters/postgres"
  );

  const searchPath = schema === undefined || schema === "" ? undefined : `${schema},public`;
  const pool = new Pool({
    connectionString: databaseUrl,
    // The startup parameter, not a `SET`: applied before the connection is usable, and no space after
    // the comma — libpq reads a space as the end of one option, and Postgres refuses the connection.
    ...(searchPath === undefined ? {} : { options: `-c search_path=${searchPath}` }),
  });


  /**
   * An idle client's error must not take the process down.
   *
   * `pg` emits `'error'` on the **pool** when a client that is sitting idle in the pool fails — a
   * database restart, a pooler recycling connections, a network blip. `EventEmitter`'s contract is that
   * an `'error'` event with no listener is re-thrown as an uncaught exception, so a pool with no
   * listener turns a routine reconnect into a dead worker. `pg` removes the broken client from the pool
   * on its own; the only thing missing was somewhere for the event to go.
   *
   * Logged rather than swallowed silently: this is the signal that the database went away, and a worker
   * that recovered without saying so is a worker whose restarts have no explanation.
   */
  pool.on("error", (error) => {
    console.error(`[shareflow] idle postgres client failed; pg will discard it: ${String(error)}`);
  });

  const scope = createTransactionScope(createPoolOpener(pool, searchPath));
  const sql = scope.scoped(createPgExecutor(pool));

  if (searchPath !== undefined) {
    /**
     * The check the reference application does, and for the same reason.
     *
     * A pooler that dropped `options` leaves every connection on the default path, and every table this
     * process touches is the wrong one — with nothing to see. Refusing here costs one round trip and
     * turns a silent misconfiguration into a boot failure that names itself.
     */
    const [row] = await sql.query<{ readonly search_path: string }>("SHOW search_path");
    const actual = row?.search_path ?? "";
    if (!actual.includes(schema as string)) {
      throw new Error(
        `RETINUE_DATABASE_SCHEMA is "${schema}" but this connection reports search_path "${actual}". The ` +
          `connection options were not applied — a pooler in front of Postgres may be dropping them.`,
      );
    }
  }

  const deps = await app.deps({
    config: { redisUrl, databaseUrl, ...(schema === undefined ? {} : { databaseSchema: schema }) },
    sql,
    runner: scope.runner,
  });

  /**
   * The model, resolved once at boot.
   *
   * Both the shadow path and (through the engine, in the worker) the live path need one, and resolving
   * per request would open a provider client per turn. `resolveModelForTurn` also warns here rather
   * than on the first shadow run if the model has no pricing.
   */
  const { resolveModelForTurn } = await import("./model.js");
  const resolvedModel = await resolveModelForTurn(process.env);

  // #551: the catalogue the chat box's model picker shows — the same one the engine honours.
  const { deploymentModelFactory } = await import("./model.js");
  const { deploymentChoices, workspaceChoice } = await import("./model-catalogue.js");
  const { COMPACT_AT, contextWindowFor } = await import("./context-window.js");
  const { NON_HISTORY_TOKENS } = await import("./prompt-budget.js");
  const { measuredCharsPerToken, measuredPromptOf, rescaleContextSections } = await import("./token-ratio.js");
  const { createWorkspaceModelResolver } = await import("../adapters/model/workspace-model.js");
  const deploymentModel = await deploymentModelFactory(process.env);
  const workspaceModelFor = createWorkspaceModelResolver({ sql, env: process.env });

  const server = createShareFlowServer({
    authenticate: app.authenticate,
    models: async ({ context }) => {
      const chorus = deploymentChoices({ provider: deploymentModel.provider, modelId: deploymentModel.modelId }, process.env);
      const workspace = await workspaceModelFor(context).catch(() => undefined);
      return {
        models: [...chorus, ...(workspace === undefined ? [] : [workspaceChoice(workspace)])],
        // With a workspace key the default already runs on it (#462); the picker shows that truthfully.
        defaultId: workspace === undefined ? chorus[0]!.id : workspaceChoice(workspace).id,
      };
    },
    startTurn: createStartTurn({
      conversations: deps.conversations as never,
      messages: deps.messages as never,
      runs: deps.runs as never,
      coordinator: deps.coordinator as never,
      dispatcher: deps.dispatcher as never,
      limits: SOCIAL_ASSISTANT_LIMITS as unknown as Record<string, number>,
      agentId: SOCIAL_ASSISTANT_ID,
      agentVersion: SOCIAL_ASSISTANT_VERSION,
    }),
    openEvents: createOpenEvents(createPostgresRunEventLog(sql) as never),
    toolRegistry: deps.toolRegistry as never,
    /**
     * History, from the stores the module already built.
     *
     * `deps.conversations` and `deps.messages` are the same instances the turn path writes through, so
     * a transcript cannot disagree with what a run recorded — the alternative was a second pair of
     * stores over the same tables, which is a second answer to what a conversation is.
     *
     * Messages are **oldest-first**, because a transcript reads downwards. The store's own note is why
     * that is a parameter at all: asking for 100 of a 2,000-message conversation the other way gets
     * turns 1–100 and none of the recent ones.
     *
     * Conversations do **not** go through the store's `list` — see `conversation-list.ts` (#397). This
     * comment previously claimed "newest-first for conversations (a session list is read from the
     * top)", which is what it should do and was not what it did: the store's query is
     * `ORDER BY created_at, id` ascending with no way to change it, so the sidebar showed the thirty
     * *oldest* threads — 30 of 117 on production, with the 87 most recent unreachable. Ordering by
     * `updated_at` would not have fixed it either, because nothing bumps that column when a message
     * arrives. The list is now ordered by real last activity.
     */
    /**
     * Settings → Memory — #621. The same service the tools write through, over the same executor: what a
     * person switches off here is what the next turn's "About you" leaves out.
     */
    personalMemory: deps.personalMemory as never,
    listConversations: async ({ context, limit, cursor }) =>
      conversationsByActivity({
        sql,
        tenantId: String(context.tenantId),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    listMessages: async ({ context, conversationId, limit, cursor }) => {
      const page = await deps.messages.listByConversation({
        tenantId: context.tenantId,
        conversationId,
        limit,
        newestFirst: false,
        ...(cursor === undefined ? {} : { cursor }),
      } as never);
      return {
        items: page.items,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
    /**
     * The interaction surface, over the services the module already built.
     *
     * `deps.questions` and `deps.approvals` are the same instances the *worker* raises questions and
     * approvals through, which is the whole reason this can be a thin wiring rather than a second
     * implementation: the pause and the resume have to agree about what is pending, and two services
     * over the same tables are two answers to that.
     *
     * Both were constructed with `runs` — see the note at their construction. Without it the answer is
     * recorded, the continuation is enqueued, and the worker cannot claim a run still sitting in
     * `waiting-for-approval`; the run then waits forever and the chat shows an accepted answer that did
     * nothing.
     */
    answerQuestion: async ({ context, interactionId, runId, answers }) => {
      const outcome = await deps.questions.answer({
        /**
         * The **ids** are cast, not the object.
         *
         * `TenantId`/`InteractionId`/`RunId` are branded, so a plain string will not assign — but
         * `as never` on the whole literal is what this file did at first, and that turns off checking
         * of the *field names* too. A cast to an interface is a promise the compiler stops keeping, and
         * every wrong-field-name bug in this project got in exactly that way. Casting the values keeps
         * `interactionId` spelled wrong an error.
         */
        tenantId: context.tenantId,
        interactionId: interactionId as never,
        runId: runId as never,
        answers,
      });
      return { resumed: outcome.resumed };
    },
    decideApproval: async ({ context, interactionId, runId, conversationId, decision }) => {
      const outcome = await deps.approvals.decide({
        // The ids are cast, the shape is not — see `answerQuestion` above.
        tenantId: context.tenantId,
        interactionId: interactionId as never,
        runId: runId as never,
        ...(conversationId === undefined ? {} : { conversationId: conversationId as never }),
        decision,
      });
      /**
       * `granted` is whether a **standing** grant was issued, which is not the same as whether the
       * decision allowed the call. `allow-once` allows it and deliberately issues no grant — its single
       * execution is claimed off the interaction — so reporting `grant !== undefined` as "allowed"
       * would tell a client that an approved one-time call had been denied.
       */
      return { resumed: outcome.resumed, granted: outcome.grant !== undefined };
    },
    /**
     * What this workspace spent on the assistant. See `ShareFlowServerDeps.usage`.
     *
     * `totalsBetween` reads the ledger rather than the rollups, which is what the platform's own note
     * says to do for a window that is not a whole bucket. The turn count comes from `eventCount` —
     * usage is recorded per realized step, so it is steps rather than turns, and it is named for what it
     * is rather than dressed up as something rounder.
     */
    usage: async ({ context, from, to }) => {
      // `{ totals, earliestAt }` — the second field answers "when does headroom return" for a sliding
      // window, which this read does not need.
      const { totals } = await deps.usage.totalsBetween({ tenantId: context.tenantId, from, to });
      return {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costMinorUnits: totals.costMinorUnits,
        currency: "USD",
        turns: totals.eventCount,
      };
    },
    /**
     * One run's usage, for the session-context meter. See `ShareFlowServerDeps.runUsage`.
     *
     * The **last** step's `inputTokens` is the context size, not the sum: usage is recorded per step and
     * each step re-sends the whole conversation, so adding them up would report a 5k-token prompt asked
     * three times as 15k of context. `outputTokens` *is* summed, because that is what the turn produced.
     *
     * `contextLimit` is the answering model's working window (#630, `context-window.ts`): what history is
     * condensed against and in-run tool outputs are cleared against, so the bar and the behaviour agree.
     */
    runUsage: async ({ context, runId, conversationId }) => {
      /*
       * Measured per call (#518) when the turn ran after that existed: the last call's input is the
       * context, the calls are the steps, and their sum is what the turn spent on input.
       */
      const measured = await readTurnSteps(
        sql,
        String(context.tenantId),
        runId !== undefined ? { runId } : { conversationId: String(conversationId ?? "") },
      ).catch(() => null);
      if (measured !== null && measured.steps > 0) {
        /*
         * #630: drawn against the answering model's working window, recorded with the turn. A turn from before
         * that (or a database without the columns) is drawn against the deployment model's.
         */
        const model = measured.model ?? {
          modelId: deploymentModel.modelId,
          contextWindow: contextWindowFor(deploymentModel.modelId).window,
          workingWindow: contextWindowFor(deploymentModel.modelId).working,
          historyCondensed: false,
        };
        /*
         * #658: the ratio this turn's own prompt showed. The sections were sized at chars ÷ 4 before anything was
         * measured, and the bar's "chat" is the measured total minus them — on Gemini that shrank the chat by a third.
         */
        const charsPerToken = measuredCharsPerToken(measuredPromptOf(measured));
        return {
          inputTokens: measured.lastInputTokens,
          outputTokens: measured.totalOutputTokens,
          steps: measured.steps,
          contextLimit: model.workingWindow,
          contextWindow: model.contextWindow,
          modelId: model.modelId,
          // #657: where this turn's history actually condenses — 200k on the platform's key — when recorded.
          compactAt: model.historyBudget === undefined ? Math.floor(model.workingWindow * COMPACT_AT) : model.historyBudget + NON_HISTORY_TOKENS,
          historyCondensed: model.historyCondensed,
          contextMeasured: true,
          turnInputTokens: measured.totalInputTokens,
          cachedInputTokens: measured.cachedInputTokens,
          // #552: what the prompt was made of, for the meter's breakdown.
          ...(measured.contextSections === undefined ? {} : { contextSections: rescaleContextSections(measured.contextSections, charsPerToken) }),
          ...(charsPerToken === undefined ? {} : { charsPerToken }),
          // #649 follow-up: the latest call's prompt as hashes, to trace a broken prompt cache.
          ...(measured.promptFingerprint === undefined ? {} : { promptFingerprint: measured.promptFingerprint }),
        };
      }

      /*
       * An older turn: the ledger holds only the turn's total, so it is reported as that and never as
       * the context — the mislabel that made a 2k-token chat read 80k.
       */
      if (runId !== undefined) {
        const page = await deps.usage.listByRun({
          tenantId: context.tenantId,
          runId: runId as never,
          limit: 200,
        });
        const events = page.items;
        /*
         * The context is the last **chat** step's input. A tool's own model call (#499, `tool:` steps)
         * counts toward what the run produced and cost, but its prompt is not the conversation — a
         * caption writer's brief read as the chat's context would move the meter for no reason.
         */
        const chat = events.filter((event) => !(event.stepId ?? "").startsWith(TOOL_STEP_PREFIX));
        const last = chat[chat.length - 1];
        return {
          inputTokens: last?.inputTokens ?? 0,
          outputTokens: events.reduce((total, event) => total + event.outputTokens, 0),
          steps: chat.length,
          contextLimit: contextWindowFor(deploymentModel.modelId).working,
          contextMeasured: false,
          turnInputTokens: last?.inputTokens ?? 0,
        };
      }

      /**
       * By conversation, read straight from the ledger.
       *
       * `UsageStore` has `listByRun` and `breakdown`, and neither answers "the most recent step in this
       * conversation": a breakdown by conversation *sums* the steps, and summing a context size counts
       * the same prompt once per step — a 5k conversation asked three times would read as 15k. There is
       * no `listByConversation` on `RunStore` either, so this is one scoped read of the same table the
       * port writes, ordered the way the table is indexed. `readyz` above reads raw SQL for the same
       * kind of reason.
       */
      const [row] = await sql.query<{ readonly input_tokens: number; readonly output_tokens: number }>(
        `SELECT input_tokens, output_tokens
           FROM usage_records
          WHERE tenant_id = $1 AND conversation_id = $2
            AND (step_id IS NULL OR step_id NOT LIKE '${TOOL_STEP_PREFIX}%')
       ORDER BY occurred_at DESC, record_seq DESC
          LIMIT 1`,
        [String(context.tenantId), String(conversationId ?? "")],
      );
      return {
        inputTokens: row?.input_tokens ?? 0,
        outputTokens: row?.output_tokens ?? 0,
        steps: row === undefined ? 0 : 1,
        contextLimit: contextWindowFor(deploymentModel.modelId).working,
        contextMeasured: false,
        turnInputTokens: row?.input_tokens ?? 0,
      };
    },
    /**
     * What a paused run is waiting for. See `ShareFlowServerDeps.pendingInteraction`.
     *
     * Both stores are asked, because a run parks on exactly one of the two and the caller does not know
     * which. Fields are mapped rather than forwarded: `normalizedInput` is the platform's name for the
     * arguments and `toolArgs` is the card's, and a client should not have to know both.
     */
    pendingInteraction: async ({ context, runId }) => {
      const [approval, question] = await Promise.all([
        deps.approvals.pending({ tenantId: context.tenantId, runId: runId as never }),
        deps.questions.pending({ tenantId: context.tenantId, runId: runId as never }),
      ]);
      return {
        ...(approval === null
          ? {}
          : {
              approval: {
                interactionId: String(approval.id),
                toolName: approval.toolName,
                toolArgs: approval.normalizedInput,
                riskCategory: approval.riskCategory,
                summary: approval.summary,
                expiresAt: approval.expiresAt,
                ...(approval.estimatedCostMinorUnits === undefined
                  ? {}
                  : { estimatedCostMinorUnits: approval.estimatedCostMinorUnits }),
              },
            }),
        ...(question === null
          ? {}
          : { question: { interactionId: String(question.id), questions: question.questions } }),
      };
    },
    cancelRun: async ({ context, runId }) => {
      const run = await deps.runs.requestCancel({
        // `id`, not `runId` — the store names it for the row it addresses. Checked, per the note above.
        tenantId: context.tenantId,
        id: runId as never,
        now: new Date().toISOString(),
      });
      return run === null ? null : { status: String(run.status) };
    },
    /**
     * Readiness is the database **and** the schema, not just a connection.
     *
     * A pool that connects to a database with no `retinue` schema is reachable and useless: every query
     * would resolve to the wrong tables or none. One query answers both.
     */
    ready: async () => {
      try {
        const [row] = await sql.query<{ readonly applied: number }>(
          "SELECT count(*)::int AS applied FROM schema_migrations",
        );
        const applied = row?.applied ?? 0;
        return applied > 0
          ? { ok: true }
          : { ok: false, detail: "the schema has no applied migrations — run `retinue migrate`" };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  const { createServerAdapter } = await import("@whatwg-node/server");
  const { createServer } = await import("node:http");
  const adapter = createServerAdapter((request: Request) => server.handle(request));
  const http = createServer(adapter as never);

  await new Promise<void>((resolve) => http.listen(port, resolve));
  console.log(JSON.stringify({ event: "listening", port, schema: schema ?? "(connection default)" }));
};

/**
 * Run when invoked directly, so importing this file in a test does not start a server.
 *
 * The same guard the platform's own `bin.ts` uses: a module that listens on import cannot be
 * imported by anything that is not willing to bind a port.
 */
if (process.argv[1] !== undefined && /main\.js$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
