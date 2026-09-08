/**
 * The deployable ShareFlow backend — the `RETINUE_APP_MODULE` the platform host loads.
 *
 * `createShareFlowApp` composes tools, skills and a manifest; `createShareFlowServer` serves `/api/message`
 * and `/api/events`. Neither is a *deployment*. The platform's host — `runApiHost()` — boots from
 * `RETINUE_DATABASE_URL` and one module that default-exports `{ authenticate, deps }`, and this is that
 * module. Without it there is nothing to containerise: the pieces existed and nothing wired them to a port.
 *
 * ## One pool, two schemas, and why that works
 *
 * The platform's own tables — conversations, runs, run events, usage — are **not** ShareFlow's. They live in a
 * dedicated `retinue` schema in the same Supabase database (decided 2026-09-08), which works because of a
 * property this package already had: **every ShareFlow adapter query is `public.`-qualified.** All 70 of them.
 * So one pool with `search_path=retinue,public` resolves the platform's unqualified names to `retinue` and
 * ShareFlow's explicit `public.posts` to the product tables, with no second connection and no ambiguity.
 *
 * That is checked rather than assumed: a test scans the adapters for an unqualified table reference, because
 * the day one appears it would silently read the wrong schema — and reading `retinue.posts`, which does not
 * exist, is the *lucky* failure. Reading a table that happens to exist in both is the other one.
 *
 * ## What this deliberately does not do
 *
 * No MCP client, no docs server, no dev-auth bypass. The reference application has all three because it is a
 * demonstration; a deployment serving a customer's workspace should have none of them, and the absence is the
 * point rather than an omission.
 */

import type { AuthorizationPolicy, ExecutionContext } from "@retinue/agentkit";
import { createApprovalGate, createApprovalService, createQuestionService } from "@retinue/agentkit/hitl";
import { createToolRegistry, createToolSearch } from "@retinue/agentkit/tools";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { createShareFlowApp } from "./index.js";
import type { ConnectorDeps } from "../adapters/postgres/connectors.js";
import type { ConnectionSetup } from "../services/index.js";
import type { StructuredGenerate } from "../adapters/model/generator.js";
import { createShareFlowServices } from "../adapters/index.js";
import { SHAREFLOW_TOOL_FACTORIES } from "../tools/index.js";
import { SHAREFLOW_BUILT_IN_SKILLS } from "../skills/index.js";

/**
 * The tenant and principal a request acts as.
 *
 * Read from headers the web app sets behind its own session check, which is the same trust boundary
 * `/api/internal/*` already uses: the Next app authenticates a person against Supabase and then speaks to the
 * backend over the private network with a shared secret. So this verifies the **secret**, and takes identity
 * from headers — it does not re-authenticate the user, because it cannot: it has no session.
 *
 * The secret is required with no fallback, for the reason `requireInternalSecret` gives on the other side of
 * the same boundary: an unset secret must mean *deny*, never "use the well-known default". A backend that
 * served an open API to anyone who forgot to configure it is the failure this cannot be allowed to have.
 */
export const createAuthenticator = (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const secret = env["SHARED_API_SECRET"];
  return (request: Request): ExecutionContext | null => {
    if (secret === undefined || secret === "") return null;
    const provided = request.headers.get("x-internal-secret") ?? request.headers.get("x-api-secret");
    if (provided !== secret) return null;

    const tenantId = request.headers.get("x-chorus-workspace-id");
    const principalId = request.headers.get("x-chorus-user-id");
    // Both, not either. A tenant with no principal cannot be authorised against and a principal with no tenant
    // cannot be scoped — and defaulting either one is how a request ends up acting as somebody else.
    if (tenantId === null || tenantId === "" || principalId === null || principalId === "") return null;

    return {
      tenantId,
      principalId,
      roleIds: (request.headers.get("x-chorus-roles") ?? "editor").split(",").map((role) => role.trim()),
      locale: request.headers.get("x-chorus-locale") ?? "en",
      timezone: request.headers.get("x-chorus-timezone") ?? "UTC",
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    } as unknown as ExecutionContext;
  };
};

/**
 * The four dependencies `createShareFlowServices` cannot invent, wired from the environment.
 *
 * **This replaced a version that passed `undefined as never` for all four.** It typechecked, and it would have
 * built a container that booted, reported healthy, and failed on the first turn touching a connector, the web
 * or the model. Each of these now either works or refuses by name — and two of them *legitimately* degrade
 * rather than refuse, which is the distinction worth keeping.
 */

/**
 * `ConnectionSetup` — what a person needs in order to connect an account.
 *
 * Deployment-specific by definition: the redirect URL is this deployment's, the credential entries are the
 * *names* of its environment variables, and the console URLs are each platform's. The port refuses a default
 * for that reason, so this is built from `PUBLIC_APP_URL` and refuses without it — a setup naming the wrong
 * redirect URL sends a person to a console to paste a value that will never match, which is worse than
 * saying the deployment is unconfigured.
 *
 * **Never a credential value, only a name.** `credentialVariables` is what `check_account_health` and
 * `get_connection_setup` surface, and `assertNoSecrets` in the accounts tools exists because a setup carrying
 * a real secret would put it in a tool result, which is persisted in the run event log.
 */
export const connectionSetupFrom = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectorDeps["setup"] => {
  const appUrl = env["PUBLIC_APP_URL"];
  if (appUrl === undefined || appUrl === "") {
    throw new Error(
      "PUBLIC_APP_URL is required: the connection setup tells a person which redirect URL to paste into a " +
        "platform's developer console, and a wrong one fails at consent with no explanation.",
    );
  }
  const origin = appUrl.replace(/\/$/, "");
  const redirectUrl = `${origin}/api/connect/callback`;

  /**
   * A real condition the type asks about: every platform refuses a plain-http redirect outside localhost, so
   * connecting cannot work until the deployment's URL is fixed. Saying so here is the difference between a
   * person understanding why consent failed and them re-pasting a correct-looking URL forever.
   */
  const insecure = origin.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(origin);
  const setup: ConnectionSetup = {
    redirectUrl,
    credentialsPageUrl: `${origin}/settings`,
    ...(insecure
      ? {
          warning:
            `PUBLIC_APP_URL is plain http (${origin}). Every platform below refuses a non-https redirect ` +
            `outside localhost, so connecting will fail at consent until the deployment is served over https.`,
        }
      : {}),
    /**
     * The platforms this deployment's web app actually has connect routes for. Names only — the values live
     * in the web app's environment and must never reach a tool result.
     */
    platforms: [
      {
        platformId: "linkedin",
        label: "LinkedIn",
        consoleUrl: "https://www.linkedin.com/developers/apps",
        credentialVariables: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
        consoleFields: [{ label: "Authorized redirect URL", url: redirectUrl }],
        scopes: ["w_member_social", "r_basicprofile"],
      },
      {
        platformId: "instagram",
        label: "Instagram",
        consoleUrl: "https://developers.facebook.com/apps",
        credentialVariables: ["META_APP_ID", "META_APP_SECRET"],
        consoleFields: [{ label: "Valid OAuth Redirect URI", url: redirectUrl }],
        scopes: ["instagram_content_publish", "pages_show_list"],
      },
      {
        platformId: "tiktok",
        label: "TikTok",
        consoleUrl: "https://developers.tiktok.com/apps",
        credentialVariables: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
        consoleFields: [{ label: "Redirect URI", url: redirectUrl }],
        scopes: ["video.publish"],
      },
    ],
  };

  /**
   * A **function**, because that is what `ConnectorDeps.setup` is — `createPostgresConnectorService` calls
   * `deps.setup(context)`. The first version of this returned the object above cast through
   * `as unknown as ConnectorDeps["setup"]`: it typechecked, and the first person to ask how to connect
   * LinkedIn would have got `deps.setup is not a function`. The cast was the whole defect, so there is none
   * now — the annotation on `setup` is checked, and the return type is inferred against the real one.
   */
  return () => setup;
};

/**
 * The web toolkit, from the platform — never a second fetcher.
 *
 * `createFetchPage` is where the egress policy, the redirect refusal and the body ceiling live. Writing one
 * here would be a second egress policy, and the one that mattered would be whichever the caller happened to
 * use.
 *
 * **Search degrades rather than refuses.** With no provider configured `createWebSearch` returns
 * `{ searched: false, reason: "not-configured" }`, which `ResearchService` passes straight through — and that
 * is the whole point of the port: the old runtime's `websearch.py` was *"deliberately fail-soft: network
 * errors, timeouts, or a missing package yield an empty result list"*, and an empty list is
 * indistinguishable from "nothing out there", which invites a model to answer from what it believes. A
 * refusal with a reason is usable; an empty list is a lie.
 */
export const webToolkitFrom = async (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const { createWebSearch, createFetchPage } = await import("@retinue/agentkit/tools");
  const apiKey = env["RETINUE_SEARCH_API_KEY"];
  const endpoint = env["RETINUE_SEARCH_ENDPOINT"];

  const provider =
    apiKey === undefined || endpoint === undefined
      ? undefined
      : {
          endpoint: (query: string, limit: number) =>
            `${endpoint}?q=${encodeURIComponent(query)}&count=${String(limit)}`,
          headers: { Authorization: `Bearer ${apiKey}` },
        };

  return {
    search: createWebSearch(provider === undefined ? {} : { provider: provider as never }),
    fetchPage: createFetchPage(),
  };
};

/**
 * Structured generation over the configured model.
 *
 * `generateObject` rather than prose parsing, for `ContentGenerator`'s own reason: asking for prose and
 * parsing it fails the day a model writes "Here are three angles:" before the list, and that failure looks
 * like the model being bad at the task rather than the adapter being bad at reading.
 *
 * Pricing is zeroed deliberately — a cost derived from invented prices is worse than an obvious zero, and the
 * usage ledger showing 0 is readable as "not priced" where a plausible wrong number is not.
 */
export const structuredGenerateFrom = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StructuredGenerate> => {
  const apiKey = env["RETINUE_MODEL_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "RETINUE_MODEL_API_KEY is required: content generation is a model call, and a deployment without one " +
        "would admit a drafting turn and fail inside it.",
    );
  }
  const modelId = env["RETINUE_MODEL_ID"] ?? "gpt-4o";
  const { createProviderFactory } = await import("@retinue/agentkit/providers");
  const { generateObject } = await import("ai");
  const factory = createProviderFactory({
    credentials: { openai: { apiKey, name: "shareflow" } },
  } as never);
  const definition = {
    id: modelId,
    provider: "openai",
    modelId,
    displayName: modelId,
    capabilities: { tools: true, streaming: true, structuredOutput: true },
    limits: { contextWindow: 0, maxOutputTokens: 0 },
    pricing: { currency: "USD", inputPerMillion: 0, outputPerMillion: 0 },
  };
  return (async ({ system, prompt, schema }) => {
    /**
     * The options object is cast, and the reason is the overload rather than the behaviour.
     *
     * This exact call — `generateObject({ model, system, prompt, schema })` — is what
     * `scripts/shadow-turn.mjs` runs against a real model, and it produced the one valid parity datum this
     * project has. The script is `.mjs` and therefore untyped; typed, this `ai` version's `generateObject`
     * resolves to an overload whose options do not admit `schema` in that position.
     *
     * So the cast records "the types disagree with a call that demonstrably works", not "I do not know what
     * this returns". The narrow alternative — restating the whole option union — would be a second copy of
     * a vendor's types to keep in step, and it would be the copy that went stale.
     */
    const result = await generateObject({
      model: (factory as { languageModel: (d: unknown) => never }).languageModel(definition),
      system,
      prompt,
      schema,
    } as never);
    return (result as { object: unknown }).object;
  }) as StructuredGenerate;
};

const requireRunner = (runner: TransactionRunner | undefined): TransactionRunner => {
  if (runner === undefined) {
    /**
     * Fail-closed, as `PublishingDeps.transaction` does and for the same reason: publish-once rests on
     * `SELECT … FOR UPDATE` in a real transaction, and a deployment that cannot provide one should not be
     * publishing. The worker gets no runner from `boot`, which is why this is checked rather than assumed.
     */
    throw new Error(
      "A TransactionRunner is required: publish-once and the conversation slot both rest on a real " +
        "transaction, and a pooled executor cannot express one.",
    );
  }
  return runner;
};

export type ShareFlowModuleInput = {
  readonly config: { readonly redisUrl?: string };
  readonly sql: SqlExecutor;
  readonly runner?: TransactionRunner;
};

/**
 * Everything the platform's resolvers need, built over the `retinue` schema.
 *
 * Mirrors the reference application's wiring, minus the demonstration parts. The stores are mechanical; what
 * is *decided* here is the tool registry — it draws on `createShareFlowApp`'s providers, so the catalogue the
 * API filters and the catalogue the worker re-authorises are the same one. They have to be: a tool present in
 * one and absent in the other is a run that is admitted and then cannot finish.
 */
export const shareFlowDeps = async (input: ShareFlowModuleInput) => {
  const { sql } = input;
  const {
    createPostgresApprovalGrantStore,
    createPostgresConversationRunCoordinator,
    createPostgresConversationStore,
    createPostgresIdempotencyStore,
    createPostgresInteractionStore,
    createPostgresMessageStore,
    createPostgresRunEventLog,
    createPostgresRunStore,
    createPostgresSessionStateStore,
    createPostgresSkillStore,
    createPostgresUsageStore,
  } = await import("@retinue/agentkit/adapters/postgres");

  const runs = createPostgresRunStore(sql);
  const interactions = createPostgresInteractionStore(sql);
  const grants = createPostgresApprovalGrantStore(sql);
  const idempotency = createPostgresIdempotencyStore(sql);
  const eventLog = createPostgresRunEventLog(sql);

  /**
   * Allow-all, and it is a placeholder that says so.
   *
   * The real policy is docs/11's, and wiring it needs a role model this deployment has not defined —
   * ShareFlow's own authority is workspace membership, checked by the web app before it ever calls here.
   * Named `PLACEHOLDER` so a reader cannot mistake it for a decision, and it is the one thing in this file
   * that must change before a second tenant shares a deployment.
   */
  const PLACEHOLDER_AUTHORIZATION: AuthorizationPolicy = {
    async can() {
      return { allow: true };
    },
  } as unknown as AuthorizationPolicy;

  const queue = input.config.redisUrl === undefined ? undefined : await (async () => {
    const { createBullMqRunQueue, createBullMqJobDispatcher } = await import("@retinue/agentkit/adapters/bullmq");
    const q = createBullMqRunQueue({ url: input.config.redisUrl as string });
    return { queue: q, dispatcher: createBullMqJobDispatcher(q) };
  })();

  if (queue === undefined) {
    /**
     * Refused rather than run in-process.
     *
     * A run has to be dispatched to a worker; without a queue the API host would admit a turn and nothing
     * would execute it, which looks like a hung assistant rather than a misconfiguration. The platform's own
     * compose requires Redis for the same reason.
     */
    throw new Error(
      "RETINUE_REDIS_URL is required: a run is dispatched to a worker, and without a queue a turn is " +
        "admitted and never executed.",
    );
  }

  const web = await webToolkitFrom();
  const generate = await structuredGenerateFrom();

  const app = createShareFlowApp({
    /**
     * The manifest's four required fields are deployment decisions, so they are made here and visibly.
     *
     * `instructions` is the assistant's own prompt; the domain depth is in the seven skills, loaded on demand,
     * which is why this is short rather than a wall of rules. The limits are the platform's own defaults for a
     * conversational agent — a publish flow is search → read → generate → create → publish, and
     * `ai_backend`'s generalist ran at `tool_call_limit=18` for exactly that reason, so 18 is transcribed
     * rather than chosen.
     */
    manifest: {
      version: 1,
      instructions:
        "You are Chorus's social assistant. You draft, schedule and publish posts, read engagement and " +
        "report measured results. Load a skill before acting in its area rather than answering from memory. " +
        "Never claim something was published, deleted or sent unless a tool reported that it succeeded.",
      modelPolicy: {
        modelId: process.env["RETINUE_MODEL_ID"] ?? "gpt-4o",
      } as unknown as Parameters<typeof createShareFlowApp>[0]["manifest"]["modelPolicy"],
      authorizationPolicyId: "shareflow-workspace-member",
      limits: {
        // 18, from `ai_backend`'s generalist: "a grounded post is search -> read one or two pages ->
        // generate -> create -> publish, and fixing an incompatible file adds check -> convert ->
        // check_conversion (twice, since video is queued) -> replace."
        maxToolCalls: 18,
        maxSteps: 24,
        wallClockTimeoutMs: 180_000,
        maxInputTokens: 120_000,
        maxOutputTokens: 8_000,
        costCeilingMinorUnits: 200,
      } as unknown as Parameters<typeof createShareFlowApp>[0]["manifest"]["limits"],
    },
    services: createShareFlowServices({
      sql,
      transaction: requireRunner(input.runner),
      setup: connectionSetupFrom(),
      search: web.search,
      fetchPage: web.fetchPage,
      generate,
    }),
    deps: { authorization: PLACEHOLDER_AUTHORIZATION, idempotency, approvals: createApprovalGate({ grants, interactions }) },
    authorization: PLACEHOLDER_AUTHORIZATION,
    factories: SHAREFLOW_TOOL_FACTORIES,
  });

  return {
    conversations: createPostgresConversationStore(sql),
    messages: createPostgresMessageStore(sql),
    sessions: createPostgresSessionStateStore(sql),
    skills: createPostgresSkillStore(sql),
    runs,
    eventLog,
    usage: createPostgresUsageStore(sql),
    toolRegistry: createToolRegistry({
      providers: app.providers,
      authorization: PLACEHOLDER_AUTHORIZATION,
      search: createToolSearch(),
    }),
    // `runs` goes to both services deliberately: without it an approved run is enqueued but stays in
    // `waiting-for-approval`, which `claim` will not accept.
    questions: createQuestionService({ interactions, dispatcher: queue.dispatcher, runs }),
    approvals: createApprovalService({ interactions, grants, dispatcher: queue.dispatcher, runs }),
    coordinator: createPostgresConversationRunCoordinator(sql, input.runner as TransactionRunner),
    dispatcher: queue.dispatcher,
    assignedSkills: SHAREFLOW_BUILT_IN_SKILLS.filter((skill) => skill.status === "active").map((s) => s.name),
  };
};

/** The `{ authenticate, deps }` contract `runApiHost` loads. */
const app = {
  authenticate: createAuthenticator(),
  deps: shareFlowDeps,
};

export default app;
