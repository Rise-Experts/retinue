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

const SCHEMA = process.env.AGENTKIT_EXAMPLE_SCHEMA ?? "agentkit_example";
const PORT = Number(process.env.PORT ?? 4000);
if (!process.env.AGENTKIT_DATABASE_URL) {
  console.error("✗ AGENTKIT_DATABASE_URL is required. Copy .env.example to .env.");
  process.exit(2);
}

const url = new URL(process.env.AGENTKIT_DATABASE_URL);
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
const { createTransactionScope, createPoolOpener } = await import("@agentkit/backend");
const scope = createTransactionScope(createPoolOpener(pool, SCHEMA));
const sql = scope.scoped(base);
const runner = scope.runner;

const [{ search_path: path }] = await sql.query("SHOW search_path");
if (!path.includes(SCHEMA)) throw new Error(`search_path is "${path}", expected ${SCHEMA}`);

// The module and its default export: `deps`/`authenticate` are the app module's contract, and
// `closeExampleMcp` is a named export beside it.
const appModule = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href);
const app = appModule.default;
const { startExampleServer } = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/server.js")).href);

const deps = await app.deps({ config: { redisUrl: process.env.AGENTKIT_REDIS_URL ?? "" }, sql, runner });
const { port } = await startExampleServer({ deps, authenticate: app.authenticate, sql, port: PORT });

console.log(`
  agentkit example — app

    page      http://localhost:${port}/
    graphql   http://localhost:${port}/graphql
    sse       http://localhost:${port}/runs/events
    schema    ${SCHEMA}
    model     ${process.env.AGENTKIT_MODEL_ID ?? "gpt-4o-mini"} at ${process.env.AGENTKIT_MODEL_BASE_URL ?? "https://api.openai.com/v1"}

  Nothing executes until the worker runs — start it in a second terminal:
    npm run worker -w @agentkit/example-app
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
