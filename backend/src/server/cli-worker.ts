/**
 * Runnable worker command (#110 AC-5).
 *
 * Same contract as the API host: `RETINUE_APP_MODULE` supplies the wiring. The worker additionally
 * needs an agent engine, which no generic entrypoint can invent — so the app module provides it, and
 * the command refuses to start without one rather than running a worker that consumes jobs it cannot
 * execute.
 */
import { boot } from "./boot.js";
import { APP_MODULE_VARIABLE, type AgentkitApp } from "./cli.js";
import { loadConfig, type AgentkitConfig } from "./config.js";
import type { AgentEngine, PricingResolver, ResolverDeps } from "../index.js";
import type { SqlExecutor } from "../entries/adapters-postgres.js";

export type AgentkitWorkerApp = AgentkitApp & {
  readonly engine: (input: { readonly config: AgentkitConfig; readonly sql: SqlExecutor }) => AgentEngine;
  readonly buildContext: Parameters<typeof import("../runtime/worker.js").createDurableWorker>[0]["buildContext"];
  /**
   * What a model costs — #166.
   *
   * Optional, and its absence costs **cost** and not usage: tokens are recorded either way, because how many
   * tokens a run consumed is a fact whether or not anyone knows the price. Dropping the record for want of a
   * price would lose the fact to protect a figure.
   *
   * Supplied by the app rather than built here because only the app knows its model catalogue. See
   * `createRegistryPricingResolver` for the usual one-liner over a `ModelRegistry`.
   */
  readonly pricing?: PricingResolver;
};

export const runWorker = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly shutdown: () => Promise<void> }> => {
  // Same ordering as the API host: configuration problems are reported before the app module is
  // even looked for.
  loadConfig(env);
  const specifier = env[APP_MODULE_VARIABLE];
  if (specifier === undefined || specifier.trim() === "") {
    throw new Error(
      `${APP_MODULE_VARIABLE} is required: it must point at a module default-exporting ` +
        `{ authenticate, deps, engine, buildContext }.`,
    );
  }
  const app = ((await import(specifier)) as { default?: AgentkitWorkerApp }).default;
  if (app === undefined || typeof app.engine !== "function") {
    throw new Error(`${specifier} must default-export an \`engine\` for the worker command`);
  }

  const { config, sql } = await boot({
    env,
    connect: async (loaded) => {
      const { Pool } = await import("pg");
      const { createPgExecutor } = await import("../entries/adapters-postgres.js");
      return { sql: createPgExecutor(new Pool({ connectionString: loaded.databaseUrl })) };
    },
  });

  /**
   * Three imports rather than one — #196.
   *
   * The root no longer re-exports the adapters, so the worker names what it needs: the runtime, the Postgres
   * stores, the queue, the realtime publisher. Verbose on purpose — this file is the reference deployment, and
   * what it imports is what a reader copies. A single namespace import taught them that everything came from one
   * place, which is exactly the thing that made the package install six provider SDKs.
   */
  /**
   * The layer entries, not the root barrel — #199.
   *
   * The root is five values now, so `await import("../index.js")` no longer carries `createDurableWorker` or
   * `createUsageRecorder`. Importing the entries the worker actually needs is also the honest shape: this file
   * is a *consumer* of the package's public surface, and reaching for a barrel that happened to contain
   * everything was how it avoided ever saying what it depends on.
   */
  const backend = await import("../entries/runtime.js");
  const workerEntry = await import("../worker/main.js");
  const usageEntry = await import("../entries/usage.js");
  const pgAdapters = await import("../entries/adapters-postgres.js");
  const queueAdapters = await import("../adapters/bullmq/index.js");
  const redisAdapters = await import("../adapters/redis/index.js");
  const deps = (await app.deps({ config, sql })) as ResolverDeps;

  const queue = queueAdapters.createBullMqRunQueue({ url: config.redisUrl });
  const dispatcher = queueAdapters.createBullMqJobDispatcher(queue);

  /**
   * A **real** publisher, over Redis pub/sub (#161).
   *
   * This was `publisher: { async publish() {} }` — a hard-coded no-op, so every deployment using the documented
   * worker command threw its run events away and no client ever saw a token while a run was in progress. The SSE
   * endpoint replayed the durable log and then waited forever on a channel nothing wrote to, which looks exactly
   * like a working system with no streaming rather than a broken one.
   *
   * Redis, because it is already required configuration and already carries the queue: no new dependency and no
   * new operational surface. Pub/sub's at-most-once delivery is the right trade — the durable log is the source of
   * truth and the stream resumes from a sequence, so a dropped message costs latency, not correctness.
   *
   * Not overridable to a no-op. A deployment that wants no realtime can simply have no subscribers; making
   * "publish nothing" reachable by configuration is what produced this bug.
   */
  const realtimeConnection = new (await import("ioredis")).Redis(config.redisUrl);
  const publisher = redisAdapters.createRedisRealtimePublisher(realtimeConnection);

  const worker = backend.createDurableWorker({
    runs: deps.runs,
    checkpoints: pgAdapters.createPostgresCheckpointStore(sql),
    publisher,
    engine: app.engine({ config, sql }),
    eventLog: deps.eventLog,
    /**
     * The assistant's turn is persisted, not reconstructed (#157).
     *
     * Built here from `sql`, exactly as the checkpoint store above is: it is the same database and the same
     * migration set, and an app module that had to remember to supply it would be an app module that ships an
     * amnesiac agent the first time someone forgets.
     */
    messages: pgAdapters.createPostgresMessageStore(sql),
    /**
     * Usage is recorded — #166.
     *
     * `DurableWorkerDeps.usage` is optional and nothing wired it, so no deployment using the documented worker
     * command recorded a single usage event. Every consumer of that ledger was therefore reading zero: the
     * spend panel, the quota guard at admission, and the rollup job. A quota that cannot be exceeded because
     * nothing is ever counted is not a quota.
     *
     * Built here, like the checkpoint and message stores, for the same reason: an app module that has to
     * remember is an app module that bills silently the first time someone forgets.
     */
    usage: usageEntry.createUsageRecorder({
      store: pgAdapters.createPostgresUsageStore(sql),
      // No catalogue means no prices, and `record` writes the tokens regardless.
      pricing: app.pricing ?? { resolve: () => null },
    }),
    buildContext: app.buildContext,
    workerId: `worker-${process.pid}`,
  });

  const { Worker } = await import("bullmq");
  const { Redis } = await import("ioredis");
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const createQueueWorker: Parameters<typeof queueAdapters.createBullMqJobConsumer>[0] = (
    name,
    handler,
    options,
  ) =>
    new Worker(name, async (job) => handler({ data: job.data as never }), {
      connection,
      concurrency: options.concurrency,
    });
  const consumer = queueAdapters.createBullMqJobConsumer(createQueueWorker, {
    concurrency: config.workerConcurrency,
  });

  const runtime = workerEntry.createWorkerRuntime({
    worker,
    consumer,
    dispatcher,
    config: { concurrency: config.workerConcurrency },
    log: (message, detail) => console.log(JSON.stringify({ event: "worker", message, ...detail })),
  });
  await runtime.start();
  workerEntry.installSignalHandlers(runtime);

  return {
    shutdown: async () => {
      await runtime.shutdown("api");
      await queue.close();
      await connection.quit().catch(() => undefined);
      // The realtime connection too, or a drained worker keeps a Redis client open and the process will not exit.
      await realtimeConnection.quit().catch(() => undefined);
    },
  };
};

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runWorker().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
