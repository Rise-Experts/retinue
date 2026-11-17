/**
 * The agent engine the worker runs — retinue REQ-041 (#190).
 *
 * `RETINUE_APP_MODULE` must default-export `{ authenticate, deps, engine }`. The first two are the API
 * host's contract and were enough to make it boot; the worker refuses to start without the third:
 *
 *     dist/app/module.js must default-export an `engine` for the worker command
 *
 * That refusal is the platform being right. The engine is *"an agent engine, which no generic
 * entrypoint can invent"* — the manifest, the model, the history projection and the tool surface are
 * all product decisions — so a worker that started without one would consume jobs it could not
 * execute. Before this existed the host answered `/healthz` and `/readyz`, accepted `sendMessage`, and
 * nothing ran: a healthy backend whose messages vanished.
 */

import { createDefaultEngine } from "@retinue/agentkit/runtime";
import { noteTurnModel } from "./turn-billing.js";
import { createApprovalGate, createApprovalService, createQuestionService, createRunApprovals } from "@retinue/agentkit/hitl";
import { createSkillCatalogueProvider } from "@retinue/agentkit/context";
import {
  createPostgresApprovalGrantStore,
  createPostgresIdempotencyStore,
  createPostgresInteractionStore,
  createPostgresMessageStore,
  createPostgresPrincipalMemoryStore,
  createPostgresThreadSummaryStore,
  createPostgresRunStore,
  createPostgresUsageStore,
} from "@retinue/agentkit/adapters/postgres";
import type { AgentEngine, ExecutionContext, Run } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { createWorkspaceModelResolver } from "../adapters/model/workspace-model.js";
import { createWorkspaceModelFactory, withWorkspaceModel } from "./workspace-turn-model.js";
import { shareFlowServicesFrom } from "./services.js";
import {
  PLACEHOLDER_AUTHORIZATION,
  connectionSetupFrom,
  runnerFor,
  structuredGenerateFrom,
  webToolkitFrom,
} from "./deployment.js";

import { SOCIAL_ASSISTANT_PRELOADED_TOOLS } from "../manifests/index.js";
import { SHAREFLOW_TOOL_FACTORIES } from "../tools/index.js";
import { SOCIAL_ASSISTANT_VERSION, composeShareFlowApp, shareFlowManifest } from "./compose.js";
import { conversationHistory, isSummaryTurn } from "./history.js";
import { createThreadSummarizer, summaryModelFor } from "./thread-summary.js";
import { IDLE_COMPACT_AT_TOKENS, IDLE_KEEP_TOKENS, createIdleCompactor } from "./idle-compaction.js";
import { PROMPT_VERSION, withheldClauses } from "./instructions.js";
import { createBuildTools, withLearnableSchemas } from "./tools-for-turn.js";
import { createContextForTurn } from "./context-for-turn.js";
import { optionalEnv } from "./env.js";
import { createRedisTokenBudgetStore, createTokenBudget, createTurnBudgetGate, tokenBudgetConfigFrom } from "./token-budget.js";
import { withAgentMode } from "./agent-mode.js";
import { createOutsideReads, outsideReadsInRunEvents } from "./outside-content.js";
import { withMediaDefaults } from "./media-defaults.js";
import { createTurnContextProvider } from "./turn-context.js";
import { createPersonalMemoryContextProvider } from "../context/personal-memory.js";
import { createDocumentsContextProvider } from "../context/documents.js";
import { createTurnInputReader } from "./turn-settings.js";
import { allContextProviders } from "../adapters/index.js";
import { PRICING, pricingFor } from "./model.js";
import { toolUsageRecorder } from "./tool-usage.js";
import { contextSectionsRecorder, promptFingerprintRecorder, readTurnSteps, turnHistoryBudgetRecorder, turnModelRecorder, turnStepsRecorder } from "./turn-steps.js";
import { charsPerTokenFor, measuredPromptOf } from "./token-ratio.js";
import { contextWindowFor } from "./context-window.js";
import { PLATFORM_HISTORY_CAP, historyBudgetForWindow } from "./prompt-budget.js";

export type EngineInput = {
  /**
   * The loaded configuration, which is where the connection comes from.
   *
   * `databaseSchema` matters as much as the URL: the worker's own pool already honours it, and a
   * transaction runner opened here without it would hold `SELECT … FOR UPDATE` against `public` while
   * everything else read `retinue`. That is not an error — it is a lock on a table that does not
   * contain the row.
   */
  readonly config: {
    readonly databaseUrl?: string;
    readonly databaseSchema?: string;
    /**
     * The queue, which the worker already passes and this type did not mention.
     *
     * `cli-worker.ts` calls `app.engine({ config, sql })` with the whole `RetinueConfig`, `redisUrl`
     * included — so it has always been here at runtime and invisible to a reader of this file. It is
     * load-bearing now: an approval pauses a run, and the decision that resumes it is dispatched as a
     * job. Without a queue the pause would be permanent.
     */
    readonly redisUrl?: string;
  };
  readonly sql: SqlExecutor;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Build the engine.
 *
 * Every store it needs comes from `sql` here rather than from the caller, for the reason the platform's
 * own worker gives about its checkpoint and message stores: it is the same database and the same
 * migration set, and an app module that had to remember to supply them is an app module that ships an
 * amnesiac agent the first time someone forgets.
 */
export const createShareFlowEngine = async (input: EngineInput): Promise<AgentEngine> => {
  const env = input.env ?? process.env;
  const { resolveModelForTurn } = await import("./model.js");
  const resolved = await resolveModelForTurn(env);
  // #551: the chat's model choice — the deployment's other models on its own key, and what "the default" is.
  const { deploymentModelFactory } = await import("./model.js");
  const { deploymentChoices } = await import("./model-catalogue.js");
  const deploymentModels = await deploymentModelFactory(env);
  const deploymentTarget = { provider: deploymentModels.provider, modelId: deploymentModels.modelId };
  const allowedDeploymentModels = deploymentChoices(deploymentTarget, env).map((m) => m.modelId);
  const web = await webToolkitFrom(env);
  /**
   * The generator, with the workspace's own provider wired in — #462.
   *
   * `input.sql` is the same executor every other adapter here uses, so the BYO lookup adds a
   * connection to nothing. What it adds is the difference between a workspace's configured Claude (or
   * OpenAI, or self-hosted) key generating its content and that key being stored, displayed, billed
   * as in use, and never called.
   */
  /**
   * One resolver, shared by content generation and by conversational turns — #462.
   *
   * Two would be two ideas of what a workspace's provider is, and the symptom of their disagreeing is
   * a deployment that drafts with one vendor and converses with another, both working, with nothing
   * to see. That is the same reasoning `model.ts` gives for having a single model selection.
   */
  const workspaceModel = createWorkspaceModelResolver({ sql: input.sql, env });
  /** #499: a tool's model calls land on the same ledger as the turn's steps. */
  const recordUsage = toolUsageRecorder({ store: createPostgresUsageStore(input.sql), env });
  const recordTurnStep = turnStepsRecorder(input.sql);
  const recordPromptFingerprint = promptFingerprintRecorder(input.sql);
  const recordHistoryBudget = turnHistoryBudgetRecorder(input.sql);
  const recordTurnModel = turnModelRecorder(input.sql);
  /**
   * #630: each run's model, from `resolveModel` to `loadHistory` — the engine calls them in that order — so
   * the history budget is the answering model's, not a fixed 120,000. A run this process did not resolve
   * (a resumed one) has no entry and is sized against the deployment's model.
   */
  const turnTargets = new Map<string, () => Promise<{ readonly provider: string; readonly modelId: string } | undefined>>();
  // #657: whose key each turn runs on, and the quiet-chat condenser.
  const turnSources = new Map<string, () => Promise<"deployment" | "workspace">>();
  const idle = createIdleCompactor();
  const summaryModelOverride = optionalEnv("SHAREFLOW_SUMMARY_MODEL", env);
  let turnModelWarned = false;
  const generate = await structuredGenerateFrom(env, { workspaceModel, recordUsage });
  const workspaceLanguageModel = createWorkspaceModelFactory();

  const withheld = withheldClauses();
  if (withheld.length > 0) {
    // Reported, because a prompt quietly missing a rule is a very confusing assistant. Each id maps to
    // a capability in the inventory — see `instructions.ts`.
    console.warn(`[shareflow] ${withheld.length} prompt clause(s) withheld for missing tools: ${withheld.join(", ")}`);
  }

  const messages = createPostgresMessageStore(input.sql);
  /**
   * Durable thread summaries, so a long conversation is condensed once rather than on every turn.
   *
   * The adapter and its table both shipped with the platform and were reached by nothing. Versioned
   * and append-only: `latest()` is a single indexed read on the hot path, which is what lets
   * compaction stay off the model until a thread actually outgrows its budget.
   */
  const summaries = createPostgresThreadSummaryStore(input.sql);

  /**
   * The transaction scope, derived from `config` — the worker supplies no runner.
   *
   * Shared with `deps` through the memo in `runnerFor`, so one worker process opens one pool rather
   * than two. `publish-once` rests on a lock held across statements, which `sql.query` cannot express.
   */
  const runner = await runnerFor({ config: input.config });

  const services = shareFlowServicesFrom({
    sql: input.sql,
    transaction: runner,
    search: web.search,
    fetchPage: web.fetchPage,
    generate,
    env,
  });


  /**
   * The HITL stores and services, **wired into the engine** — they were not, and nothing worked.
   *
   * Two separate omissions with one symptom. The registry had no `approval`, so it refused every
   * `approvalPolicy: "always"` tool outright ("this is a wiring error, not a refusal"); and the engine
   * had no `approvals`, whose own documentation says absent "means no HITL: tool calls go straight to
   * `buildTools`' own `execute`". So nothing ever raised an approval and nothing could have run one:
   * *"Publish my Ethiopia draft to Instagram"* — the product's central action — could not succeed by any
   * path, and the pending-approval card the web app renders had nothing that could produce it.
   *
   * The stores are hoisted rather than built inline because four things now share them, and two
   * interaction stores over one table would be two ideas of what is pending.
   */
  const interactions = createPostgresInteractionStore(input.sql);
  const grants = createPostgresApprovalGrantStore(input.sql);
  const runs = createPostgresRunStore(input.sql);
  const gate = createApprovalGate({ grants, interactions });

  const redisUrl = input.config.redisUrl;
  if (redisUrl === undefined || redisUrl === "") {
    throw new Error(
      "RETINUE_REDIS_URL is required to build the engine: an approval pauses the run, and the decision " +
        "that resumes it is dispatched as a job. Without a queue the pause is permanent — a user would " +
        "approve a publish and watch nothing happen. The worker cannot claim a run without Redis either, " +
        "so an engine built without it could never have run one.",
    );
  }
  const { createBullMqRunQueue, createBullMqJobDispatcher, quietQueueErrors } = await import("@retinue/agentkit/adapters/bullmq");
  const runQueue = createBullMqRunQueue({ url: redisUrl });
  /*
   * #668: the platform key's per-minute token budget, counted in Redis so every worker sees one count. Its own
   * client, not the run queue's: that one is lazy with no offline queue, so its first command fails. A command
   * that cannot reach Redis fails fast and the budget lets the turn through (`token-budget.ts`).
   */
  const { Redis } = await import("ioredis");
  const budgetRedis = quietQueueErrors(new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3_000 }), "tpm-budget");
  const tokenBudget = createTokenBudget({ store: createRedisTokenBudgetStore(budgetRedis), config: tokenBudgetConfigFrom(env) });
  // #668: a rate-limited chat call is tried once on this model, on the deployment's key. Unset, there is no retry.
  const siblingModelId = optionalEnv("SHAREFLOW_SIBLING_MODEL", env);
  // #473: agentkit 0.3.5 gives the run queue and its connection their own quiet error listener (retinue#288).
  const dispatcher = createBullMqJobDispatcher(runQueue);
  const questions = createQuestionService({ interactions, dispatcher, runs });
  const approvals = createApprovalService({ interactions, grants, dispatcher, runs });

  const { app, registry, skills } = composeShareFlowApp({
    sql: input.sql,
    runner,
    authorization: PLACEHOLDER_AUTHORIZATION,
    /**
     * The **shared** service factory, not a second argument list.
     *
     * This block used to call `createShareFlowServices` directly with six fields while `module.ts`
     * passed nine, and the three it omitted — `readMediaBytes`, `storeMedia`, `mermaidBundlePath` —
     * are the ones every media capability needs. Since this is the composition the *worker* runs, that
     * made `capture_website`, `render_diagram` and `generate_pdf` refuse inside every conversation
     * while passing their direct tests, which go through the host's composition instead.
     */
    services,
    deps: {
      authorization: PLACEHOLDER_AUTHORIZATION,
      idempotency: createPostgresIdempotencyStore(input.sql),
      approvals: gate,
    },
    // The registry's own gate — the one that makes approval unbypassable. See `ComposeInput.approval`.
    approval: gate,
    factories: SHAREFLOW_TOOL_FACTORIES,
  });

  /**
   * The registry the *model* talks to, which is not quite the registry the app composed.
   *
   * `learn_tools` answers with the descriptors themselves, and every ShareFlow descriptor carries a Zod
   * schema — live objects with methods, which the AI SDK rejects when it validates the next prompt.
   * `withLearnableSchemas` converts them. Both the tool objects **and** the approval loop take this one,
   * because the loop reaches `execute` directly and would otherwise bypass the conversion.
   */
  /**
   * #550: the chat's agent mode, applied in front of `execute` — see `agent-mode.ts`. Outermost, so both
   * the model's tools and the approval loop pass through it.
   */
  const turnInput = createTurnInputReader(runs);
  // #575: inside the mode gate, so a refused call is refused before its input is filled.
  // #662: after a run reads outside content, its internal writes ask too — see `outside-content.ts`.
  const outsideReads = createOutsideReads(outsideReadsInRunEvents(input.sql));
  const modelFacing = withAgentMode(withMediaDefaults(withLearnableSchemas(registry), { turnInput }), { gate, turnInput, outsideReads });
  /**
   * The **built** manifest, not the seed `shareFlowManifest()` returns.
   *
   * `shareFlowManifest()` is the *input* to `socialAssistantManifest` — five fields: version,
   * instructions, modelPolicy, authorizationPolicyId, limits. Returning it from `loadManifest` handed
   * the engine a manifest with no `id`, no `name`, no `toolPolicy`, no `skillPolicy` and no
   * `contextProviderIds`, and the `as never` on the deps object is the only reason that compiled. The
   * instructions were there, so the prompt looked right and every policy field read as `undefined`.
   *
   * `app.manifest` is what `createShareFlowApp` built from that seed, validated, and it is the same
   * object the host serves — so the two paths now agree about the agent they are running.
   */
  const manifest = app.manifest;

  /**
   * The turn's system prompt: the manifest's instructions **plus the assembled context**.
   *
   * Absent this, `createDefaultEngine` sends `manifest.instructions` alone — which is what this
   * deployment did for its whole life, while those instructions told the model *"Your context includes
   * the workspace's brand profile and recent post behaviour"*. `context-for-turn.ts` has the recorded
   * request that proves it carried none, and the reason each of its three decisions is the way it is.
   *
   * The skill catalogue is a provider like any other, and the manifest declares it: without it the
   * model can load `mermaid-diagrams` because the prompt names it, and cannot discover the other six.
   */
  const recordContextSections = contextSectionsRecorder(input.sql);
  const nonceSecret = optionalEnv("ENCRYPTION_SECRET", env);
  const systemPrompt = createContextForTurn({
    // #649: the per-conversation delimiter nonce is derived from this, so the prompt is stable across turns.
    ...(nonceSecret === undefined ? {} : { nonceSecret }),
    // #552: what each turn's prompt was made of, for the chat box's meter.
    onAssembled: (context, summary) => {
      recordContextSections(context, summary).catch((error: unknown) => {
        console.warn(`[shareflow] the context make-up was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    providers: [
      ...allContextProviders(services),
      /*
       * #621: "About you" — the person's own memories, from agentkit's `principal_memory` (migration 0011,
       * part of the set `retinue migrate` already ran). The same executor as `services.personalMemory`, which
       * writes them, so what `remember_about_me` stores is what the next turn reads.
       */
      createPersonalMemoryContextProvider({ store: createPostgresPrincipalMemoryStore(input.sql) }),
      // #543: the chat's mode, and what this message pointed at or attached.
      createTurnContextProvider({ turnInput, services }),
      // #644: the current text of this chat's documents, so an edit changes the document that exists.
      createDocumentsContextProvider({ messages, artifacts: services.artifacts }),
      createSkillCatalogueProvider({
        resolver: skills,
        policy: {
          assigned: manifest.skillPolicy?.assigned ?? [],
          allowTenantSkills: manifest.skillPolicy?.allowTenantSkills ?? false,
        },
      }),
    ],
  });

  return createDefaultEngine({
    /**
     * The stored version is checked, not ignored.
     *
     * A run records the manifest version it executed so history is never rewritten. Serving a run
     * recorded at version 2 with today's version 1 would replay it under different instructions and a
     * different tool surface, and the transcript would no longer explain itself. There is one version
     * so far, so this can only fire after a bump — which is exactly when it matters.
     */
    async loadManifest({ version }: { readonly version: number }) {
      if (version !== SOCIAL_ASSISTANT_VERSION) {
        throw new Error(
          `this deployment serves Social Assistant v${SOCIAL_ASSISTANT_VERSION}, and the run records ` +
            `v${version}. Replaying it under the current manifest would execute it with instructions and ` +
            `tools it was not written against.`,
        );
      }
      return manifest;
    },

    /**
     * The turn's model, chosen per turn from the context — #462.
     *
     * This was `resolveModel: () => resolved`: both arguments thrown away, every workspace served the
     * deployment's model. The `context` it ignores is the one the platform passes precisely so a host
     * can make this decision per tenant.
     *
     * The lookup cannot happen here — the engine calls this synchronously — so what is returned is a
     * model that performs it on its first call. `workspace-turn-model.ts` has the mechanism and what
     * it does not cover.
     */
    resolveModel: (_manifest: unknown, context: ExecutionContext) => {
      const turn = withWorkspaceModel({
        model: resolved.model,
        context,
        resolve: workspaceModel,
        languageModelFor: workspaceLanguageModel,
        // #551: the chat's model and effort, read from the run.
        turnSettings: async () => (await turnInput(context)).settings,
        deployment: deploymentTarget,
        deploymentModelFor: deploymentModels.modelFor,
        allowedDeploymentModels,
        // #668: over the platform key's per-minute budget, the turn queues — visibly — instead of failing.
        gate: createTurnBudgetGate({ budget: tokenBudget, workspaceId: String(context.tenantId), runId: context.runId }),
        ...(siblingModelId === undefined ? {} : { sibling: { modelId: siblingModelId, model: () => deploymentModels.modelFor(siblingModelId) } }),
        // #518: each call's input, so the meter shows the real context and the turn's step count.
        onCall: (call) => {
          recordTurnStep(context, call).catch((error: unknown) => {
            console.warn(`[shareflow] a turn step was not recorded: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
        // #649 follow-up: the prompt as hashes, so a broken prompt cache can be traced to what changed.
        // #714: with the prompt version, so a run can be traced to the prompt text it was given.
        onPrompt: (fingerprint) => {
          recordPromptFingerprint(context, { ...fingerprint, promptVersion: PROMPT_VERSION }).catch((error: unknown) => {
            console.warn(`[shareflow] a prompt fingerprint was not recorded: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
      });
      // #597: the turn's credit is waived when the workspace's own model served it — asked on completion.
      noteTurnModel(context.runId, turn.ranOnWorkspaceModel, context.conversationId);
      if (context.runId !== undefined) {
        turnTargets.set(String(context.runId), turn.target);
        turnSources.set(String(context.runId), turn.source);
      }
      return {
        ...resolved,
        /**
         * Cast at the boundary, not inside.
         *
         * `withWorkspaceModel` deliberately speaks `unknown` rather than importing the AI SDK's
         * `LanguageModel`: this package keeps SDK types confined to the models layer, and the
         * wrapper's whole job is to be a model whose provider is not yet decided. This one line is
         * where that meets the engine's concrete `ResolvedModelInfo`.
         */
        model: turn.model as never,
        /**
         * A BYO turn costs this platform nothing, and saying otherwise is not a rounding error — it
         * is a customer's tokens on the platform's ledger. `price` is read after the turn, by which
         * point the wrapper knows which provider actually ran.
         */
        ...(resolved.price === undefined
          ? {}
          : {
              price: (usage: Parameters<NonNullable<typeof resolved.price>>[0]) => {
                const platformPrice = resolved.price;
                if (turn.ranOnWorkspaceModel() || platformPrice === undefined) return 0;
                return platformPrice(usage);
              },
            }),
      };
    },

    systemPrompt,

    loadHistory: async (context: ExecutionContext, run: Run) => {
      const runKey = String(context.runId ?? run.id);
      const pickTarget = turnTargets.get(runKey);
      turnTargets.delete(runKey);
      const target = (await pickTarget?.().catch(() => undefined)) ?? deploymentTarget;
      const pickSource = turnSources.get(runKey);
      turnSources.delete(runKey);
      const onOwnKey = (await pickSource?.().catch(() => "deployment" as const)) === "workspace";
      // #644: the answering model's whole window. #657: on the platform's key, at most PLATFORM_HISTORY_CAP of it.
      const window = contextWindowFor(target.modelId);
      const budget = onOwnKey ? historyBudgetForWindow(window.working) : Math.min(historyBudgetForWindow(window.working), PLATFORM_HISTORY_CAP);
      // #657: summaries on a small model on the platform's key; a workspace's own key keeps its own model.
      const summaryModel = onOwnKey ? undefined : summaryModelFor(deploymentTarget.provider, summaryModelOverride);
      const summarizerFor = () => createThreadSummarizer({ generate, context, ...(summaryModel === undefined ? {} : { modelId: summaryModel }) });
      /*
       * #658: history is estimated in the answering provider's tokens — the ratio its measured input showed on this
       * chat's previous turn, else the model's default (Gemini ~6, Claude/OpenAI ~4). At a flat chars ÷ 4 a Gemini
       * thread condensed at ~53% of its window instead of 85%. A failed read is the default, never a failed turn.
       */
      const previous = await readTurnSteps(input.sql, String(context.tenantId), { conversationId: String(run.conversationId) }).catch(() => null);
      const charsPerToken = charsPerTokenFor({ modelId: target.modelId, previous: measuredPromptOf(previous) });
      const turns = await conversationHistory({
        tokenBudget: budget,
        charsPerToken,
        messages,
        tenantId: String(context.tenantId),
        // From the run, not the context: the run is what identifies the conversation being executed,
        // and a context whose conversationId was absent would silently load an empty history — an
        // assistant that forgets the question it is answering.
        conversationId: String(run.conversationId),
        /**
         * Long threads are condensed rather than truncated — `compactThread`, wired.
         *
         * It had no caller, here or anywhere in `@retinue/agentkit`, while its store
         * (`createPostgresThreadSummaryStore`) and its table (`thread_summaries`, migrated by the
         * platform) both existed and waited. So a thread past the history budget lost its beginning
         * with nothing said; now the beginning is summarized and kept.
         *
         * The summarizer is built **per turn** because `StructuredGenerate` needs the run's context to
         * resolve the model, its credentials and its cost ceiling, while the platform's
         * `ThreadSummarizer` interface takes only messages — provider-neutral by design. Building it
         * here is what reconciles the two, and it costs an object, not a call: the model is reached
         * only when a thread is actually over budget.
         */
        compaction: {
          summaries,
          summarizer: summarizerFor(),
          onCompacted: ({ summarized, kept, tokensReclaimed }) => {
            console.info(
              `[shareflow] condensed ${summarized} older turn(s) of conversation ${String(run.conversationId)} ` +
                `into a stored summary, keeping ${kept} verbatim and reclaiming ~${tokensReclaimed} tokens.`,
            );
          },
        },
      });
      /*
       * #657: once this chat has been quiet for IDLE_COMPACT_AFTER_MS — its prompt cache cold anyway — condense it if it
       * is long, so the message the person comes back with sends a summary and the recent part, not everything.
       */
      const conversationKey = `${String(context.tenantId)}:${String(run.conversationId)}`;
      idle.touch(conversationKey, async () => {
        await conversationHistory({
          messages,
          tenantId: String(context.tenantId),
          conversationId: String(run.conversationId),
          tokenBudget: budget,
          charsPerToken,
          compactAt: IDLE_COMPACT_AT_TOKENS,
          keepTokens: IDLE_KEEP_TOKENS,
          onTrimmed: () => {},
          compaction: {
            summaries,
            summarizer: summarizerFor(),
            onCompacted: ({ summarized, kept, tokensReclaimed }) => {
              console.info(
                `[shareflow] condensed quiet conversation ${String(run.conversationId)}: ${summarized} older turn(s) into its summary, ` +
                  `${kept} kept verbatim, ~${tokensReclaimed} tokens fewer on the next message.`,
              );
            },
          },
        });
      });
      // #657: where this turn's history condenses, for the meter.
      recordHistoryBudget(context, budget).catch(() => {});
      // #630: for the meter — the model that answers, its windows, and whether older turns are condensed.
      recordTurnModel(context, {
        modelId: target.modelId,
        contextWindow: window.window,
        workingWindow: window.working,
        historyCondensed: isSummaryTurn(turns[0]),
      }).catch((error: unknown) => {
        if (turnModelWarned) return;
        turnModelWarned = true;
        console.warn(
          `[shareflow] the turn's model window was not recorded (is migration 20260929180000 applied?): ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return turns;
    },

    buildTools: createBuildTools(modelFacing),

    /**
     * The approval loop owns tool execution for the turn — deliberately.
     *
     * "A gated call has to be *routed* through the loop rather than merely observed after the fact,
     * because by the time a refusal has been thrown there is nothing left to pause on." So a call to a
     * gated tool now parks the run at `waiting-for-approval` with a pending interaction, which is what
     * `/api/interactions/:id` decides and what the web app's permission card renders.
     */
    approvals: createRunApprovals({ interactions, approvals, tools: modelFacing }),

    /**
     * The question side, symmetrical with approvals.
     *
     * Without it "a run that parked on a question resumes with no idea it was answered, and the model
     * asks the same question again — the person picks an option and gets the picker back."
     */
    questions,
    /**
     * **No `as never` here, and that is deliberate.**
     *
     * This object was cast, and the cast paid for itself in defects: it accepted a five-field manifest
     * seed where `AgentManifest` was required, and it would accept any future field name — the same
     * shape of mistake as `x-chorus-workspace-id`, which typechecked and authenticated nobody. If a
     * change here stops compiling, the deps really do not satisfy the engine's contract; the fix is the
     * wiring, not the cast.
     */
  });
};

/** The preloaded set, re-exported so the module and the manifest cannot disagree about it. */
export { SOCIAL_ASSISTANT_PRELOADED_TOOLS };

/**
 * Re-exported from `model.ts`, where the pricing table now lives.
 *
 * It was defined here first, which made `model.ts` import this file while this file imported
 * `model.ts` — a cycle broken only by the dynamic import, which is a fragile reason for a module graph
 * to be acyclic. Pricing is a property of the model, so it moved to the file about models.
 */
export { PRICING, pricingFor };
