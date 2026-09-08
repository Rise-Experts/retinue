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
 * The four dependencies `createShareFlowServices` cannot invent, refused loudly when absent.
 *
 * **This is the honest form of an unfinished deployment.** The first version of this module passed
 * `undefined as never` for all four: it typechecked, it would have built a container that booted and reported
 * healthy, and it would have failed on the first turn that used a connector, the web, or the model. A backend
 * that starts and then cannot work is worse than one that refuses to start, because the refusal names the
 * cause and the crash does not.
 *
 * So construction fails, listing exactly what is unwired. What each needs:
 *
 * - **`setup`** — `ConnectionSetup`: redirect URLs, console field labels and the *names* of each platform's
 *   credential variables. Deployment-specific by definition, which is why the port refuses a default: a
 *   default here would be this package asserting another deployment's configuration.
 * - **`search` / `fetchPage`** — the platform's `createWebSearch` / `createFetchPage`, where the egress
 *   policy, the redirect refusal and the body ceiling live. Wiring a second fetcher would be a second egress
 *   policy, and the one that mattered would be whichever the caller happened to use.
 * - **`generate`** — the model call.
 *
 * None is hard; all three are a deployment's decisions rather than this file's, and none should be guessed.
 */
const requireIntegrations = (): never => {
  throw new Error(
    "This ShareFlow module is not yet deployable: `setup`, `search`, `fetchPage` and `generate` are " +
      "unwired.\n" +
      "  setup     — ConnectionSetup (redirect URL, per-platform console fields and credential variable " +
      "names). Deployment-specific; the port refuses a default on purpose.\n" +
      "  search    — @retinue/agentkit's createWebSearch\n" +
      "  fetchPage — @retinue/agentkit's createFetchPage (egress policy, redirect refusal, body ceiling)\n" +
      "  generate  — the model call\n" +
      "Refusing at construction rather than at the first turn: a backend that boots and then cannot work " +
      "hides its own cause.",
  );
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
      ...(requireIntegrations() as unknown as { setup: never; search: never; fetchPage: never; generate: never }),
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
