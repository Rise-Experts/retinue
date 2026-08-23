/**
 * Runnable worker command (#110 AC-5).
 *
 * Same contract as the API host: `AGENTKIT_APP_MODULE` supplies the wiring. The worker additionally
 * needs an agent engine, which no generic entrypoint can invent — so the app module provides it, and
 * the command refuses to start without one rather than running a worker that consumes jobs it cannot
 * execute.
 */
import { boot } from "./boot.js";
import { APP_MODULE_VARIABLE, type AgentkitApp } from "./cli.js";
import { loadConfig, type AgentkitConfig } from "./config.js";
import type { AgentEngine, ResolverDeps, SqlExecutor } from "@agentkit/backend";

export type AgentkitWorkerApp = AgentkitApp & {
  readonly engine: (input: { readonly config: AgentkitConfig; readonly sql: SqlExecutor }) => AgentEngine;
  readonly buildContext: Parameters<typeof import("@agentkit/backend").createDurableWorker>[0]["buildContext"];
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
      const { createPgExecutor } = await import("@agentkit/backend");
      return { sql: createPgExecutor(new Pool({ connectionString: loaded.databaseUrl })) };
    },
  });

  const backend = await import("@agentkit/backend");
  const deps = (await app.deps({ config, sql })) as ResolverDeps;

  const queue = backend.createBullMqRunQueue({ url: config.redisUrl });
  const dispatcher = backend.createBullMqJobDispatcher(queue);

  const worker = backend.createDurableWorker({
    runs: deps.runs,
    checkpoints: backend.createPostgresCheckpointStore(sql),
    publisher: { async publish() {} },
    engine: app.engine({ config, sql }),
    eventLog: deps.eventLog,
    buildContext: app.buildContext,
    workerId: `worker-${process.pid}`,
  });

  const { Worker } = await import("bullmq");
  const { Redis } = await import("ioredis");
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const createQueueWorker: Parameters<typeof backend.createBullMqJobConsumer>[0] = (
    name,
    handler,
    options,
  ) =>
    new Worker(name, async (job) => handler({ data: job.data as never }), {
      connection,
      concurrency: options.concurrency,
    });
  const consumer = backend.createBullMqJobConsumer(createQueueWorker, {
    concurrency: config.workerConcurrency,
  });

  const runtime = backend.createWorkerRuntime({
    worker,
    consumer,
    dispatcher,
    config: { concurrency: config.workerConcurrency },
    log: (message, detail) => console.log(JSON.stringify({ event: "worker", message, ...detail })),
  });
  await runtime.start();
  backend.installSignalHandlers(runtime);

  return {
    shutdown: async () => {
      await runtime.shutdown("api");
      await queue.close();
      await connection.quit().catch(() => undefined);
    },
  };
};

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runWorker().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
