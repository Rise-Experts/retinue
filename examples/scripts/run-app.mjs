#!/usr/bin/env node
/**
 * Start the example's own server — the page plus `/api/message`, with the platform host behind it (#155).
 *
 * This is the command to run. `run-api.mjs` starts the platform's reference host *alone*, which is useful for
 * checking that the host works unaided; this one is the application.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pg from "pg";

const SCHEMA = process.env.RETINUE_EXAMPLE_SCHEMA ?? "agentkit_example";
const PORT = Number(process.env.PORT ?? 4000);
if (!process.env.RETINUE_DATABASE_URL) {
  console.error("✗ RETINUE_DATABASE_URL is required. Copy .env.example to .env.");
  process.exit(2);
}

const url = new URL(process.env.RETINUE_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
const base = { async query(text, params) { return (await pool.query(text, params ? [...params] : undefined)).rows; } };

/**
 * A transaction scope, because the conversation run coordinator needs one.
 *
 * `createPoolOpener(pool, SCHEMA)` sets the search_path on the transaction's own connection: a transaction takes
 * a *different* connection from the pool than the one that ran the last query, so the schema has to be set there
 * too. Without the second argument the coordinator's `FOR UPDATE` would run against `public` — another project's
 * schema in this setup.
 */
const { createTransactionScope, createPoolOpener } = await import("@retinue/agentkit/adapters/postgres");
const scope = createTransactionScope(createPoolOpener(pool, SCHEMA));
const sql = scope.scoped(base);
const runner = scope.runner;

const [{ search_path: path }] = await sql.query("SHOW search_path");
if (!path.includes(SCHEMA)) throw new Error(`search_path is "${path}", expected ${SCHEMA}`);

// The module and its default export: `deps`/`authenticate` are the app module's contract, and
// `closeExampleMcp` is a named export beside it.
// The dev-auth gate, before anything boots — #155 AC-6. The authenticator itself is built lazily now, so this
// is what keeps "refuses to start" true rather than "fails on the first request".
{
  const { assertDevAuthEnabled } = await import(
    pathToFileURL(resolve(import.meta.dirname, "../dist/auth.js")).href
  );
  try {
    assertDevAuthEnabled();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(2);
  }
}

const appModule = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href);
const app = appModule.default;
const { startExampleServer } = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/server.js")).href);

const deps = await app.deps({ config: { redisUrl: process.env.RETINUE_REDIS_URL ?? "" }, sql, runner });
// The Postgres composition: stores and providers built from the executor, and `sql` still passed for the one
// genuinely-SQL query (the message count behind the context meter).
const { postgresBackend } = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/stores.js")).href);
const { exampleProviders } = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/providers.js")).href);
/**
 * One backend, passed to both — the stores the routes use and the providers the prompt uses.
 *
 * The API host never subscribes to its own realtime source (the platform host does that), so the source throws
 * rather than being a silent stub: a stub would make a missing subscription look like an idle stream.
 */
const backend = postgresBackend(sql, {
  subscribe: () => {
    throw new Error("the API host does not subscribe; the platform host owns the SSE route");
  },
});
const { port } = await startExampleServer({
  deps,
  authenticate: app.authenticate,
  stores: backend,
  providers: exampleProviders(backend),
  sql,
  port: PORT,
});

console.log(`
  agentkit example — app

    page      http://localhost:${port}/
    graphql   http://localhost:${port}/graphql
    sse       http://localhost:${port}/runs/events
    schema    ${SCHEMA}
    model     ${process.env.RETINUE_MODEL_ID ?? "gpt-4o-mini"} at ${process.env.RETINUE_MODEL_BASE_URL ?? "https://api.openai.com/v1"}

  Nothing executes until the worker runs — start it in a second terminal:
    npm run worker -w @retinue/example-app
`);

/**
 * The MCP child process is closed on shutdown — #173.
 *
 * The API host builds a catalogue on every turn, which means it too holds an MCP client and its spawned
 * documentation server. Both processes need this; only the worker having it would leave an orphan per API
 * restart, which is the harder one to notice because the API restarts more often.
 */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n  ${signal} — closing…`);
    void appModule.closeExampleMcp().then(() => process.exit(0));
  });
}
