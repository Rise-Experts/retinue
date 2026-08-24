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

const SCHEMA = process.env.AGENTKIT_EXAMPLE_SCHEMA ?? "agentkit_example";
if (process.env.AGENTKIT_DATABASE_URL && !process.env.AGENTKIT_DATABASE_URL.includes("search_path")) {
  const url = new URL(process.env.AGENTKIT_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
  process.env.AGENTKIT_DATABASE_URL = url.toString();
}
process.env.AGENTKIT_APP_MODULE = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href;

const { runWorker } = await import("@agentkit/server");
const { shutdown } = await runWorker();
console.log(`  agentkit example — worker running (schema ${SCHEMA}). Ctrl-C to drain.`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n  ${signal} — draining…`);
    void shutdown().then(() => process.exit(0));
  });
}
