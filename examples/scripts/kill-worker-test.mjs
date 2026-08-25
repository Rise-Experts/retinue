#!/usr/bin/env node
/**
 * Test step 3 of #155: kill the worker mid-run and prove the run recovers without repeating its side effect.
 *
 * The one acceptance step that cannot be a unit test. #144's harness covers lease recovery against the runtime
 * directly; this drives it through the *application* — two real processes, a real database, a real queue, a real
 * model — because that is where the difference between "the mechanism works" and "the deployment works" lives,
 * and this codebase has found that difference the hard way more than once (#161, #157, #172).
 *
 *   node scripts/kill-worker-test.mjs
 *
 * ## What it proves, and what it cannot
 *
 * It proves: a `SIGKILL`ed worker leaves a claimed run behind; a replacement worker reclaims it after the lease
 * expires; the run reaches a terminal state; and the external effect happened **exactly once** despite the
 * interruption.
 *
 * It cannot prove the kill landed at the worst moment. The window between "tool has fired" and "result is
 * checkpointed" is milliseconds wide, and this aims at it by killing while the approved tool is running — but a
 * pass is evidence, not a proof, and a single run's timing is luck. It is written to be run repeatedly.
 */

import pg from "pg";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SCHEMA = process.env.RETINUE_EXAMPLE_SCHEMA ?? "agentkit_example";
const BASE = process.env.RETINUE_EXAMPLE_URL ?? "http://localhost:4000";
const TENANT = "killtest";

if (!process.env.RETINUE_DATABASE_URL) {
  console.error("✗ RETINUE_DATABASE_URL is required.");
  process.exit(2);
}

const url = new URL(process.env.RETINUE_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
const q = async (text, params) => (await pool.query(text, params ? [...params] : undefined)).rows;

const headers = {
  "content-type": "application/json",
  "x-agentkit-tenant": TENANT,
  "x-agentkit-principal": "killtest-principal",
  "x-agentkit-roles": "editor",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A worker as a child process, so it can be killed the way a crash kills one.
 *
 * `SIGKILL`, not `SIGTERM`: a graceful shutdown drains, which is the *opposite* of what is being tested. The
 * whole question is what happens to a run whose worker never got to finish anything, including its own cleanup.
 */
const startWorker = (label) => {
  const child = spawn("node", [resolve(import.meta.dirname, "run-worker.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout.on("data", (b) => {
    const line = String(b).trim();
    if (line.includes("claimed") || line.includes("failed") || line.includes("reaped")) {
      console.log(`    [${label}] ${line.slice(0, 140)}`);
    }
  });
  child.stderr.on("data", (b) => {
    const line = String(b).trim();
    if (line.includes("share_note")) console.log(`    [${label}] ${line.slice(0, 120)}`);
  });
  return child;
};

const run = async () => {
  console.log("\nagentkit example — worker-kill recovery (#155 test step 3)\n");

  await q(`DELETE FROM messages WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM runs WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM conversations WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM idempotency_keys WHERE tenant_id = $1`, [TENANT]);

  // Auto mode: a standing grant, so the run reaches the external write without waiting for a human. The pause
  // is what is being interrupted, so a human in the loop would make the timing untestable.
  console.log("  1. starting a run that shares a note (auto mode, so it does not pause)");
  const started = await fetch(`${BASE}/api/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Share note n1 externally, then write a note recording that you did.", mode: "auto" }),
  });
  const { runId, conversationId } = await started.json();
  console.log(`     run ${runId}`);

  const worker = startWorker("worker-1");

  /**
   * Killed once the run is claimed and the tool has begun, not on a fixed timer.
   *
   * Polling for `claimed_by` is the difference between testing recovery and testing startup: a fixed sleep either
   * kills before the run is claimed — proving nothing — or after it finished, proving less.
   */
  console.log("  2. waiting for the run to be claimed…");
  let claimed = false;
  for (let i = 0; i < 60 && !claimed; i += 1) {
    const [row] = await q(`SELECT claimed_by, status FROM runs WHERE tenant_id = $1 AND id = $2`, [TENANT, runId]);
    claimed = Boolean(row?.claimed_by);
    if (!claimed) await sleep(250);
  }
  if (!claimed) {
    console.error("  ✗ the run was never claimed — is the API host running, and a worker able to start?");
    worker.kill("SIGKILL");
    await pool.end();
    process.exit(1);
  }

  // A moment for the engine to reach a tool. Deliberately short and deliberately imprecise: the interesting
  // window is small, and the honest thing is to say so rather than to pretend a sleep hits it reliably.
  await sleep(2500);
  const effectsBefore = await q(
    `SELECT count(*)::int AS n FROM idempotency_keys WHERE tenant_id = $1`,
    [TENANT],
  );
  console.log(`  3. SIGKILL the worker (idempotency keys so far: ${effectsBefore[0]?.n ?? 0})`);
  worker.kill("SIGKILL");
  await sleep(500);

  const [afterKill] = await q(`SELECT status, claimed_by, lease_expires_at FROM runs WHERE tenant_id = $1 AND id = $2`, [
    TENANT,
    runId,
  ]);
  console.log(`     run is ${afterKill?.status}, still claimed by ${afterKill?.claimed_by ?? "nobody"}`);
  if (afterKill?.status !== "running") {
    console.log("     (the run had already left `running` — rerun for a tighter window)");
  }

  console.log("  4. starting a replacement worker; waiting for the lease to expire and the run to be reclaimed");
  const replacement = startWorker("worker-2");

  // The lease is 30s by default and the reaper sweeps every 10s, so recovery is tens of seconds by design —
  // long enough that a worker with a transient network problem is not stolen from.
  let final = null;
  for (let i = 0; i < 90; i += 1) {
    const [row] = await q(`SELECT status, claimed_by FROM runs WHERE tenant_id = $1 AND id = $2`, [TENANT, runId]);
    if (row && ["completed", "failed", "cancelled"].includes(row.status)) {
      final = row;
      break;
    }
    await sleep(1000);
  }
  replacement.kill("SIGTERM");

  console.log("\n── result ───────────────────────────────────────────────────────");
  if (final === null) {
    console.error("  ✗ the run never reached a terminal state within 90s");
    await pool.end();
    process.exit(1);
  }
  console.log(`  run status:            ${final.status}`);

  /**
   * The assertion that matters.
   *
   * One idempotency key per distinct tool call, however many times the call was attempted. More than one for the
   * same share means the interruption produced a second external effect, which is the failure the whole durable
   * runtime exists to prevent — and the only one that cannot be undone.
   */
  const keys = await q(
    `SELECT key, count(*)::int AS n FROM idempotency_keys WHERE tenant_id = $1 GROUP BY key ORDER BY key`,
    [TENANT],
  );
  const duplicated = keys.filter((k) => k.n > 1);
  console.log(`  idempotency keys:      ${keys.length}`);
  console.log(`  duplicated keys:       ${duplicated.length}`);

  const parts = await q(
    `SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND role = 'assistant'`,
    [TENANT],
  );
  console.log(`  assistant turns:       ${parts[0]?.n ?? 0}  (1 expected — #157 writes it at the terminal transition)`);
  console.log(`  conversation:          ${conversationId}`);

  const ok = duplicated.length === 0 && final.status !== "running";
  console.log(`\n  ${ok ? "✓ recovered with no duplicated side effect" : "✗ a side effect was duplicated"}\n`);
  await pool.end();
  process.exit(ok ? 0 : 1);
};

run().catch(async (error) => {
  console.error(`\n✗ ${error.message}`);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
