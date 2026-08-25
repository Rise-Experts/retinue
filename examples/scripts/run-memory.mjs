#!/usr/bin/env node
/**
 * The whole example in one process, with no database, queue or network — #155 AC-7.
 *
 *   RETINUE_MODEL_API_KEY=sk-… node scripts/run-memory.mjs
 *
 * A model key and nothing else. No `docker`, no migration, no second terminal.
 *
 * ## Read this before trusting anything you see here
 *
 * The adapters are `Map`s, so this mode cannot demonstrate the guarantees the platform exists for:
 *
 * - **Nothing survives the process.** Every conversation, memory and note is gone on restart. Checkpointing still
 *   happens and you can watch it in the event stream, which proves the mechanism and not the guarantee.
 * - **There is no API/worker boundary.** The queue drains in-process, so the very split that #144 found had never
 *   been exercised is not exercised here either. A run that works in this mode can still fail across two
 *   processes — which is exactly how #161 (a no-op publisher) and #157 (an unwired message store) survived for
 *   as long as they did.
 * - **No lease contention.** Nothing else can claim a run, so the atomic claim is never contended and the reaper
 *   sweeps a set of one.
 * - **No slot contention.** Runs drain one at a time, so the FIFO serialisation is real code doing nothing.
 * - **No RLS.** Tenant isolation rests entirely on the adapters partitioning by tenant — which the conformance
 *   suite checks, but it is defence in depth minus a layer.
 * - **No SQL.** A query that is wrong against Postgres is not wrong here, because there are none.
 *
 * Use `npm run app` for anything past a first look.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT ?? 4010);

if (!process.env.RETINUE_MODEL_API_KEY) {
  console.error("✗ RETINUE_MODEL_API_KEY is required — the model is the one thing this mode cannot fake.");
  process.exit(2);
}
/**
 * The dev-auth flag is required here too.
 *
 * It would be easy to argue that a single-process demo needs no gate. That argument is how a permissive default
 * reaches a deployment: the flag exists so header auth is never implicit, and "it is only the memory mode" is a
 * sentence nobody will re-read before copying this file.
 */
const dist = (name) => pathToFileURL(resolve(import.meta.dirname, `../dist/${name}.js`)).href;
try {
  const { assertDevAuthEnabled } = await import(dist("auth"));
  assertDevAuthEnabled();
} catch (error) {
  // The shared assertion rather than a second check of the same variable: one message, one rule, and it says
  // *why* rather than just naming the variable.
  console.error(`✗ ${error.message}`);
  process.exit(2);
}

const { createMemoryBackend, createInProcessWorker } = await import(dist("memory-app"));
const { startExampleServer } = await import(dist("server"));
const { buildMemoryComposition } = await import(dist("memory-composition"));

const backend = createMemoryBackend();
const composition = buildMemoryComposition(backend);
const worker = createInProcessWorker({
  backend,
  engine: composition.engine,
  buildContext: composition.buildContext,
});

const { port } = await startExampleServer({
  deps: composition.deps(worker.dispatcher),
  authenticate: composition.authenticate,
  stores: composition.stores,
  providers: composition.providers,
  // No `sql`: the context meter reports an honest "unknown" message count rather than a wrong one.
  port: PORT,
});

/**
 * The queue is kicked after each response, not inside it.
 *
 * Draining inline would make `/api/message` block until the model finished, and the page would receive one
 * finished answer instead of a stream — hiding the streaming this example exists to show. A small interval is
 * enough and keeps the runner from having to reach into the server's request path.
 */
const timer = setInterval(() => {
  if (worker.pending() > 0) worker.kick();
}, 100);
timer.unref?.();

console.log(`
  agentkit example — single process, in memory

    page      http://localhost:${port}/
    graphql   http://localhost:${port}/graphql
    model     ${process.env.RETINUE_MODEL_ID ?? "gpt-4o"}

  Nothing is persisted. Restarting loses every conversation, and this mode cannot demonstrate
  durability, the API/worker split, lease recovery, slot contention or RLS — see the header of this
  file. Use \`npm run app\` for anything past a first look.
`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n  ${signal} — stopping.`);
    clearInterval(timer);
    backend.bus.close();
    void composition.close().then(() => process.exit(0));
  });
}
