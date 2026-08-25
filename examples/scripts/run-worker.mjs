#!/usr/bin/env node
/**
 * Start the worker against the example app module — #155.
 *
 * The same wrapper as `run-api.mjs`, and it must be a separate process: the whole point of the durable runtime is
 * that the API host and the worker are different processes that agree only through Postgres and the queue. One
 * process doing both would be the shape the platform exists to avoid, and #144 recorded that the real host↔worker
 * boundary had never been exercised.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SCHEMA = process.env.RETINUE_EXAMPLE_SCHEMA ?? "agentkit_example";
if (process.env.RETINUE_DATABASE_URL && !process.env.RETINUE_DATABASE_URL.includes("search_path")) {
  const url = new URL(process.env.RETINUE_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
  process.env.RETINUE_DATABASE_URL = url.toString();
}
process.env.RETINUE_APP_MODULE = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href;

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

const { runWorker } = await import("@retinue/agentkit/server");
const { shutdown } = await runWorker();
console.log(`  agentkit example — worker running (schema ${SCHEMA}). Ctrl-C to drain.`);

/**
 * Drain, then close the MCP server — #173.
 *
 * The MCP client spawns a child process, so a shutdown that forgets it leaves an orphan behind. Restart a few
 * times while developing and there is a small pile of documentation servers holding stdio open.
 *
 * After `shutdown()`, not before: a run still draining may be part-way through an MCP tool call, and closing the
 * transport under it would turn an in-flight tool into a transport error on a run that was about to finish
 * cleanly.
 */
const { closeExampleMcp } = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n  ${signal} — draining…`);
    void shutdown()
      .then(() => closeExampleMcp())
      .then(() => process.exit(0));
  });
}
