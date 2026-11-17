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

import { composeShareFlowApp, shareFlowManifest } from "./compose.js";
import { buildWorkerContext as buildContext } from "./worker-context.js";
import { createWorkspaceModelResolver } from "../adapters/model/workspace-model.js";
import { withTurnLogging } from "./turn-logging.js";
import { withTurnCharging } from "./turn-billing.js";
import { withFriendlyRunErrors, withFriendlyRunStoreErrors } from "./run-errors.js";
import { internalWebAppFrom } from "./internal.js";
/**
 * Re-exported, not re-implemented. These moved to `deployment.ts` when the worker needed them too —
 * see its header — and are re-exported here because this is the module a reader looks at first, and
 * because the tests and the host both name them from this path.
 */
export {
  PLACEHOLDER_AUTHORIZATION,
  connectionSetupFrom,
  createAuthenticator,
  mediaBytesFrom,
  promptOrMessages,
  runnerFor,
  structuredGenerateFrom,
  webToolkitFrom,
} from "./deployment.js";
import {
  PLACEHOLDER_AUTHORIZATION,
  connectionSetupFrom,
  createAuthenticator,
  runnerFor,
  structuredGenerateFrom,
  webToolkitFrom,
} from "./deployment.js";
import type { ConnectorDeps } from "../adapters/postgres/connectors.js";
import type { ConnectionSetup } from "../services/index.js";
import type { StructuredGenerate } from "../adapters/model/generator.js";
import { optionalEnv } from "./env.js";
import { shareFlowServicesFrom } from "./services.js";
import { mediaBytesFrom } from "./deployment.js";
import { createShareFlowServices } from "../adapters/index.js";
import { SHAREFLOW_TOOL_FACTORIES } from "../tools/index.js";
import { SHAREFLOW_BUILT_IN_SKILLS } from "../skills/index.js";
import { withNewestFirstConversations } from "./newest-first-conversations.js";
import { createPersonalMemoryService } from "../adapters/personal-memory.js";


/**
 * The four dependencies `createShareFlowServices` cannot invent, wired from the environment.
 *
 * **This replaced a version that passed `undefined as never` for all four.** It typechecked, and it would have
 * built a container that booted, reported healthy, and failed on the first turn touching a connector, the web
 * or the model. Each of these now either works or refuses by name — and two of them *legitimately* degrade
 * rather than refuse, which is the distinction worth keeping.
 */





export type ShareFlowModuleInput = {
  /**
   * `databaseUrl` and `databaseSchema` as well as `redisUrl`, because the transaction runner is derived
   * from them when the caller supplies none — which is how the worker calls this. See `runnerFor`.
   */
  readonly config: {
    readonly redisUrl?: string;
    readonly databaseUrl?: string;
    readonly databaseSchema?: string;
  };
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
    createPostgresPrincipalMemoryStore,
  } = await import("@retinue/agentkit/adapters/postgres");

  /**
   * #628: a provider's refusal (credits, quota, rate limit, a bad key) is stored on the run in safe words —
   * the customer saw "Your prepayment credits are depleted…" about our own Google account. See `run-errors.ts`.
   */
  const runs = withFriendlyRunStoreErrors(createPostgresRunStore(sql));
  const interactions = createPostgresInteractionStore(sql);
  const grants = createPostgresApprovalGrantStore(sql);
  const idempotency = createPostgresIdempotencyStore(sql);
  /**
   * The run event log, narrating each turn to stdout on its way to `run_events` — #467.
   *
   * Wrapped here rather than in the engine because `AgentEngineDeps` has no lifecycle hooks, while
   * every run event already passes through this sink. See `turn-logging.ts` for what it prints and,
   * more importantly, what it refuses to print.
   */
  const logged = withTurnLogging(
    // #628: innermost, so the log line above still prints the provider's own words and only the stored event is safe.
    withFriendlyRunErrors(createPostgresRunEventLog(sql)),
  );
  /**
   * #597: and each completed turn reports itself to the app's credit meter — the app prices it, waives
   * it for a turn on the workspace's own model, and charges it once per run. Absent the app (a local
   * checkout with no `WEB_INTERNAL_URL`), nothing is metered, as with the tools' credits.
   */
  const internal = internalWebAppFrom(process.env);
  const eventLog = internal === undefined ? logged : withTurnCharging(logged, (turn) => internal.chargeTurn(turn));


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
  /** The workspace's own provider, wired the same way the engine wires it — #462. */
  const generate = await structuredGenerateFrom(process.env, {
    workspaceModel: createWorkspaceModelResolver({ sql }),
  });
  /**
   * Through the shared composition, not a second manifest.
   *
   * This used to build its own, with a three-sentence prompt and limits that disagreed with the
   * engine's on five of nine fields — so the catalogue this surface renders described one assistant
   * while the worker executed another. `compose.ts` has the reasoning and the transcribed numbers.
   */
  /**
   * Derived when the caller has none: the worker calls this with `{config, sql}` and no runner.
   */
  const runner = await runnerFor({ runner: input.runner, config: input.config });

  // One gate, shared by the tool deps and the registry — two would be two ideas of what is approved.
  const gate = createApprovalGate({ grants, interactions });

  const { app, registry } = composeShareFlowApp({
    sql,
    runner,
    authorization: PLACEHOLDER_AUTHORIZATION,
    // The shared factory — see `services.ts` for why this is not an argument list per composition.
    services: shareFlowServicesFrom({ sql, transaction: runner, search: web.search, fetchPage: web.fetchPage, generate }),
    deps: { authorization: PLACEHOLDER_AUTHORIZATION, idempotency, approvals: gate },
    /**
     * The same gate on the **registry**, which is a different wire from `deps.approvals`.
     *
     * `POST /api/tools/:name` executes through this registry, so without it that route refused every
     * `approvalPolicy: "always"` tool with "this is a wiring error, not a refusal" — the same defect
     * the worker had. Passing it can only ever allow more than before (a call with a standing grant),
     * never less, because the unwired state was a blanket refusal.
     */
    approval: gate,
    factories: SHAREFLOW_TOOL_FACTORIES,
  });

  return {
    /**
     * **With a real clock**, which is not the default.
     *
     * `createPostgresConversationStore(sql)` falls back to a *test* clock — the adapter's own comment
     * calls it a "monotonic ISO clock, injectable for deterministic ordering in tests" and then makes
     * the deterministic one the default:
     *
     *     () => new Date(Date.UTC(2020, 0, 1, 0, 0, 0, ++n)).toISOString()
     *
     * So every conversation this deployment ever created is dated 2020-01-01, with a counter in the
     * milliseconds. Two consequences, and the second is the serious one. The thread rail cannot group
     * or date anything, which is how this was found — every conversation, including one from a minute
     * ago, filed under "Earlier". And `n` restarts at zero with the process, so conversations created
     * after a restart collide with ones created before it — `list` pages with a cursor built from the
     * ordering columns, so duplicate timestamps make the order arbitrary and the pagination unstable.
     *
     * **And wrapped, because `list` is ascending.** The adapter's query is
     * `ORDER BY created_at, id` with a forward cursor, so the sidebar was handed the thirty *oldest*
     * conversations, oldest first — no "Today" section, and this morning's thread several pages down
     * behind `fetchMore`. This comment previously said `list` "orders by `(updated_at, id)`", which is
     * two mistakes in one clause: the direction and the column. See
     * `newest-first-conversations.ts` for the query and why the fix belongs here rather than in the
     * web app.
     */
    conversations: withNewestFirstConversations(
      createPostgresConversationStore(sql, () => new Date().toISOString()),
      sql,
    ),
    messages: createPostgresMessageStore(sql),
    sessions: createPostgresSessionStateStore(sql),
    skills: createPostgresSkillStore(sql),
    runs,
    eventLog,
    usage: createPostgresUsageStore(sql),
    // #621: Settings → Memory's routes — the same service and table the memory tools write through.
    personalMemory: createPersonalMemoryService({ store: createPostgresPrincipalMemoryStore(sql) }),
    toolRegistry: registry,
    /**
     * The tool providers and the manifest, for the shadow runner — **from this composition**, not a
     * second one.
     *
     * `createShadowTurnRunner` needs both, and composing a second app to get them would give the shadow
     * path a different tool surface from the live path. A shadow run that could do things a real one
     * cannot, or vice versa, is not a measurement of anything — which is the same argument the runner's
     * own comment makes about its authorization policy.
     */
    providers: app.providers,
    manifest: shareFlowManifest(),
    // `runs` goes to both services deliberately: without it an approved run is enqueued but stays in
    // `waiting-for-approval`, which `claim` will not accept.
    questions: createQuestionService({ interactions, dispatcher: queue.dispatcher, runs }),
    approvals: createApprovalService({ interactions, grants, dispatcher: queue.dispatcher, runs }),
    coordinator: createPostgresConversationRunCoordinator(sql, runner),
    dispatcher: queue.dispatcher,
    assignedSkills: SHAREFLOW_BUILT_IN_SKILLS.filter((skill) => skill.status === "active").map((s) => s.name),
  };
};

/** The `{ authenticate, deps }` contract `runApiHost` loads. */
const app = {
  authenticate: createAuthenticator(),
  deps: shareFlowDeps,
  /**
   * The worker's half of the contract — retinue #190.
   *
   * `{ authenticate, deps }` was enough for the API host and not for the worker, which refuses to start
   * without this rather than consuming jobs it cannot execute. Before it existed the host answered
   * `/healthz` and `/readyz`, accepted `sendMessage`, and nothing ran.
   *
   * It builds its own registry from the same providers rather than receiving `deps`': the worker calls
   * `engine({ config, sql })` and never calls `deps`, so there is nothing to share — and a registry
   * built from the same providers with the same authorization is the same registry by construction.
   */
  /**
   * The fourth member of the contract, and the one that decides identity — see `worker-context.ts`.
   *
   * The worker calls `deps.buildContext(run)`, and a run whose context cannot be built is *failed*
   * rather than retried. Without this the run reached the worker, was claimed, and died with
   * `deps.buildContext is not a function` — which is what a missing contract member looks like from the
   * outside: a run that fails instantly for no stated reason.
   */
  buildContext,
  /**
   * **Synchronous**, returning an engine whose construction happens on first use.
   *
   * The worker calls `engine: app.engine({ config, sql })` and does not await it, so an `async` factory
   * hands it a Promise — and the run then dies with `engine.run is not a function`, which is what a
   * broken contract looks like from the outside: an instant failure naming a method the caller never
   * wrote. Found by running a real turn, not by reading the code.
   *
   * Construction is genuinely asynchronous — it resolves a model, opens a pool, imports adapters — so
   * it cannot simply be moved earlier. `AgentEngine` has exactly one method returning an async
   * iterable, which makes deferring it exact rather than approximate: build on the first `run`, and
   * `for await` the real engine's events straight through.
   *
   * Built **once**, not per run: the promise is cached, so a second turn reuses the same model handle
   * and the same pool rather than opening another of each.
   */
  engine: (input: {
    readonly config: { readonly databaseUrl?: string; readonly databaseSchema?: string };
    readonly sql: SqlExecutor;
  }) => {
    let built: Promise<{ run: (i: unknown) => AsyncIterable<unknown> }> | undefined;
    return {
      run(runInput: unknown) {
        built ??= import("./engine.js").then(async ({ createShareFlowEngine }) =>
          (await createShareFlowEngine(input)) as unknown as { run: (i: unknown) => AsyncIterable<unknown> },
        );
        return {
          async *[Symbol.asyncIterator]() {
            // Non-null: assigned by the `??=` immediately above, before this iterator can be pulled.
            const engine = await built!;
            yield* engine.run(runInput);
          },
        };
      },
    } as never;
  },
};

export default app;
