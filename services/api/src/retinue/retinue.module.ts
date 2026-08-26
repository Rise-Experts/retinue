/**
 * The runtime, provided through Nest's container — REQ-044 (#201).
 *
 * A dynamic module rather than a set of `@Injectable()` classes, because nothing the platform provides *is* a
 * class: `createPostgresRunStore(sql)` returns a structural `RunStore`, and there is no constructor for Nest to
 * inspect. Factory providers against symbol tokens are the honest mapping, and they keep the composition in one
 * readable block instead of scattered across a dozen wrapper classes that would each exist only to be injectable.
 *
 * ## What this proves, and what it found
 *
 * The service composes the runtime **itself**, from published subpaths only — no reach into `dist/` or `src/`.
 * That is REQ-044 AC-7, and it is the point: our own host composes top-down, so a second consumer wiring the same
 * pieces through a container is the first evidence that the package can be wired more than one way.
 *
 * Two things that composition surfaced, both recorded on #199 rather than worked around here:
 *
 * - There is no supported "standard Postgres wiring" helper, so every host writes the same thirty lines. The
 *   example has `postgresBackend`; this service now has its own copy of the same idea. Two copies is the shape
 *   that drifts.
 * - `ConversationRunCoordinator` needs a `TransactionRunner`, which needs a pool opener that sets the schema on
 *   *the transaction's own connection*. Getting that wrong puts `FOR UPDATE` in the wrong schema, and nothing
 *   about the types says so.
 */

import { Module } from "@nestjs/common";
import type { DynamicModule, OnApplicationShutdown } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import pg from "pg";
import { Redis } from "ioredis";
import { createApprovalGate, createApprovalService, createAuthorizationPolicy, createQuestionService } from "@retinue/agentkit/hitl";
import { createToolRegistry } from "@retinue/agentkit/tools";
import { createQuotaGuard, createStoredLimitResolver } from "@retinue/agentkit/usage";
import {
  createPostgresApprovalGrantStore,
  createPostgresConversationRunCoordinator,
  createPostgresConversationStore,
  createPostgresIdempotencyStore,
  createPostgresInteractionStore,
  createPostgresMessageStore,
  createPostgresRunEventLog,
  createPostgresRunStore,
  createPostgresUsageLimitStore,
  createPostgresUsageRollupStore,
  createPostgresUsageStore,
  createPoolOpener,
  createTransactionScope,
} from "@retinue/agentkit/adapters/postgres";
import { createRedisLiveEventSource } from "@retinue/agentkit/adapters/redis";
import { createBullMqJobDispatcher, createBullMqRunQueue } from "@retinue/agentkit/adapters/bullmq";
import { createStandardToolProvider } from "@retinue/agentkit/tools";
import { postgresProbe, redisProbe, schemaProbe } from "@retinue/agentkit/server";
import { createSchemaManager } from "@retinue/agentkit/adapters/postgres";
import { loadServiceConfig } from "./config.js";
import {
  RETINUE_AUTHENTICATE,
  RETINUE_AGENT,
  RETINUE_CONFIG,
  RETINUE_MESSAGES,
  RETINUE_POOL,
  RETINUE_PROBES,
  RETINUE_REDIS,
  RETINUE_REGISTRY,
  RETINUE_RESOLVER_DEPS,
  RETINUE_SQL,
} from "./tokens.js";
import type { ServiceConfig } from "./config.js";
import type { Authenticate } from "@retinue/agentkit/server";
import type { ExecutionContext, ResolverDeps } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

export type RetinueModuleOptions = {
  /**
   * How a request becomes an `ExecutionContext`. **Required.**
   *
   * No default and no fallback: a service that starts with a permissive one serves an open API to whoever forgot
   * to configure it. Required here means "forgot" is a compile error.
   */
  readonly authenticate: Authenticate;
  /** Roles, as the authorization policy wants them. Without any, every tool call is refused — which is the safe way round. */
  readonly roles?: readonly { readonly roleId: string; readonly permissions: readonly unknown[]; readonly tools: readonly string[] }[];
  readonly config?: ServiceConfig;
  /** Extra tool providers beyond the standard library. */
  readonly toolProviders?: readonly unknown[];
  /**
   * Which agent a run records itself against.
   *
   * Recorded at admission rather than resolved later: the worker rebuilds the run from this row, and a run that
   * does not say which agent it is for is one nothing can execute.
   */
  readonly agentId?: string;
};

/**
 * Owns the connections, so shutdown has somewhere to happen.
 *
 * A pool left open on SIGTERM is a service that fails its *next* deploy rather than this one: the old process
 * holds connections the new one needs, and the symptom arrives minutes later as a connection-limit error nobody
 * associates with a restart.
 */
@Injectable()
export class RetinueConnections implements OnApplicationShutdown {
  constructor(
    @Inject(RETINUE_POOL) private readonly pool: pg.Pool,
    @Inject(RETINUE_REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    // Both, and neither failure prevents the other: a Redis that is already gone must not leave the pool open.
    const results = await Promise.allSettled([this.pool.end(), this.redis.quit()]);
    for (const result of results) {
      if (result.status === "rejected") console.error(`[shutdown] ${signal ?? ""} ${String(result.reason)}`);
    }
  }
}

@Module({})
export class RetinueModule {
  static forRoot(options: RetinueModuleOptions): DynamicModule {
    const config = options.config ?? loadServiceConfig();

    return {
      module: RetinueModule,
      global: true,
      providers: [
        { provide: RETINUE_CONFIG, useValue: config },
        { provide: RETINUE_AGENT, useValue: options.agentId ?? "retinue-api-agent" },
        {
          provide: RETINUE_MESSAGES,
          inject: [RETINUE_SQL],
          useFactory: ({ sql }: { sql: SqlExecutor }) => createPostgresMessageStore(sql),
        },
        { provide: RETINUE_AUTHENTICATE, useValue: options.authenticate },
        {
          provide: RETINUE_POOL,
          useFactory: () => new pg.Pool({ connectionString: config.databaseUrl, max: 8 }),
        },
        {
          provide: RETINUE_REDIS,
          useFactory: () => new Redis(config.redisUrl, { maxRetriesPerRequest: null }),
        },
        {
          provide: RETINUE_SQL,
          inject: [RETINUE_POOL],
          useFactory: (pool: pg.Pool) => {
            const base: SqlExecutor = {
              async query(text, params) {
                return (await pool.query(text, params ? [...params] : undefined)).rows;
              },
            };
            /**
             * The scope, and the reason it takes a *pool opener* rather than the executor above.
             *
             * A transaction runs on its own connection, which is not the one that served the last query — so the
             * schema has to be set there too. Without the second argument the coordinator's `FOR UPDATE` runs
             * against the default schema, which in a shared database is somebody else's.
             */
            const scope = createTransactionScope(createPoolOpener(pool, config.schema));
            return { sql: scope.scoped(base), runner: scope.runner };
          },
        },
        {
          provide: RETINUE_REGISTRY,
          inject: [RETINUE_SQL],
          useFactory: ({ sql }: { sql: SqlExecutor }) => {
            const authorization = createAuthorizationPolicy({ roles: (options.roles ?? []) as never });
            const idempotency = createPostgresIdempotencyStore(sql);
            const approvals = createApprovalGate({
              grants: createPostgresApprovalGrantStore(sql),
              interactions: createPostgresInteractionStore(sql),
            });
            return createToolRegistry({
              providers: [
                createStandardToolProvider({ deps: { authorization, idempotency, approvals }, http: {} }),
                ...((options.toolProviders ?? []) as never[]),
              ],
              authorization,
              idempotency,
              approval: approvals,
              onMisconfiguration: (report) => console.error(`[tools] ${JSON.stringify(report)}`),
            });
          },
        },
        {
          provide: RETINUE_RESOLVER_DEPS,
          inject: [RETINUE_SQL, RETINUE_REDIS, RETINUE_REGISTRY],
          useFactory: (
            { sql, runner }: { sql: SqlExecutor; runner: Parameters<typeof createPostgresConversationRunCoordinator>[1] },
            redis: Redis,
            toolRegistry: ReturnType<typeof createToolRegistry>,
          ): ResolverDeps => {
            const runs = createPostgresRunStore(sql);
            const interactions = createPostgresInteractionStore(sql);
            const queue = createBullMqRunQueue({ url: config.redisUrl });
            const dispatcher = createBullMqJobDispatcher(queue);
            const usage = createPostgresUsageStore(sql);
            const rollups = createPostgresUsageRollupStore(sql);

            return {
              conversations: createPostgresConversationStore(sql),
              runs,
              usage,
              toolRegistry,
              // `runs` goes to both services deliberately: without it an approved run is enqueued and stays in
              // `waiting-for-approval`, which `claim` will not accept.
              questions: createQuestionService({ interactions, dispatcher, runs }),
              approvals: createApprovalService({
                interactions,
                grants: createPostgresApprovalGrantStore(sql),
                dispatcher,
                runs,
              }),
              coordinator: createPostgresConversationRunCoordinator(sql, runner),
              dispatcher,
              eventLog: createPostgresRunEventLog(sql),
              rollups,
              quota: createQuotaGuard({
                usage,
                // The same rollup store the panel reads. A guard reading different numbers from the ones shown
                // would tell someone they are fine while refusing their run.
                rollups,
                resolveLimits: createStoredLimitResolver({ limits: createPostgresUsageLimitStore(sql) }),
              }),
              live: createRedisLiveEventSource(redis.duplicate()),
            };
          },
        },
        {
          provide: RETINUE_PROBES,
          inject: [RETINUE_SQL, RETINUE_REDIS],
          useFactory: ({ sql }: { sql: SqlExecutor }, redis: Redis) => [
            postgresProbe(sql),
            // Named separately from Postgres on purpose: "unreachable" and "behind" need different responses
            // from an operator, and one probe would report them identically.
            schemaProbe(createSchemaManager(sql)),
            redisProbe(redis),
          ],
        },
        RetinueConnections,
      ],
      exports: [
        RETINUE_CONFIG,
        RETINUE_AUTHENTICATE,
        RETINUE_SQL,
        RETINUE_POOL,
        RETINUE_REDIS,
        RETINUE_REGISTRY,
        RETINUE_RESOLVER_DEPS,
        RETINUE_PROBES,
        RETINUE_MESSAGES,
        RETINUE_AGENT,
      ],
    };
  }
}

export type { ExecutionContext };
