/**
 * Runnable command-line entrypoints (#110 AC-5).
 *
 * These exist because the documented commands have to actually start something. `startServer` and
 * `createWorkerRuntime` are composition functions — they need an authentication function, an agent
 * engine and a tool registry, none of which a generic entrypoint can invent. Without a CLI,
 * `node server/dist/main.js` loads a module and exits, and the README would be fiction.
 *
 * The contract is one environment variable: `AGENTKIT_APP_MODULE`, a module that default-exports the
 * application's wiring. That keeps the deployment-specific parts — identity above all — in the
 * deployment, while the command itself stays the same everywhere.
 */
import { boot } from "./boot.js";
import { createAgentkitHost, type Authenticate } from "./host.js";
import { createHealthRoutes, postgresProbe, redisProbe, schemaProbe } from "./health.js";
import { loadConfig, type AgentkitConfig } from "./config.js";
import type { ResolverDeps } from "../index.js";
import type { SqlExecutor } from "../entries/adapters-postgres.js";

/**
 * What a deployment's app module must default-export.
 *
 * `authenticate` has no default on purpose. A permissive default would serve an open API to anyone who
 * forgot to set it, and that is a worse failure than refusing to start.
 */
export type AgentkitApp = {
  readonly authenticate: Authenticate;
  readonly deps: (input: { readonly config: AgentkitConfig; readonly sql: SqlExecutor }) => Promise<ResolverDeps> | ResolverDeps;
  /** Optional liveness/readiness extras beyond Postgres, Redis and the schema version. */
  readonly redis?: (config: AgentkitConfig) => { ping(): Promise<string> };
};

export const APP_MODULE_VARIABLE = "AGENTKIT_APP_MODULE";

const loadApp = async (env: Readonly<Record<string, string | undefined>>): Promise<AgentkitApp> => {
  const specifier = env[APP_MODULE_VARIABLE];
  if (specifier === undefined || specifier.trim() === "") {
    throw new Error(
      `${APP_MODULE_VARIABLE} is required: it must point at a module default-exporting ` +
        `{ authenticate, deps }. There is deliberately no default — an authentication fallback would ` +
        `serve an open API to anyone who forgot to set this.`,
    );
  }
  const loaded = (await import(specifier)) as { default?: AgentkitApp };
  const app = loaded.default;
  if (app === undefined || typeof app.authenticate !== "function" || typeof app.deps !== "function") {
    throw new Error(`${specifier} must default-export { authenticate, deps }`);
  }
  return app;
};

export const runApiHost = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> => {
  // Configuration is validated before the app module is loaded, so a deployment that removed
  // AGENTKIT_DATABASE_URL is told about *that* rather than about AGENTKIT_APP_MODULE. Cheap to do
  // twice: `loadConfig` is pure and `boot` validates again.
  loadConfig(env);
  const app = await loadApp(env);
  const { config, sql } = await boot({
    env,
    connect: async (loaded) => {
      const { Pool } = await import("pg");
      const { createPgExecutor } = await import("../entries/adapters-postgres.js");
      return { sql: createPgExecutor(new Pool({ connectionString: loaded.databaseUrl })) };
    },
  });

  const deps = await app.deps({ config, sql });
  const { createSchemaManager } = await import("../entries/adapters-postgres.js");
  const probes = [postgresProbe(sql), schemaProbe(createSchemaManager(sql))];
  if (app.redis) probes.push(redisProbe(app.redis(config)));

  const yoga = createAgentkitHost({
    deps,
    authenticate: app.authenticate,
    sse: { enabled: true },
    health: createHealthRoutes({ probes }),
  });

  const { createServer } = await import("node:http");
  const server = createServer(yoga);
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(JSON.stringify({ event: "listening", port: config.port }));

  return {
    port: config.port,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
};

// Run when invoked directly, not when imported — so a test can call `runApiHost` without a listener
// appearing as a side effect of importing this module.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runApiHost().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
