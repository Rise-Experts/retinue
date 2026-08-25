#!/usr/bin/env node
/**
 * The load, soak and failure-injection runner — REQ-033 (#144).
 *
 * Usage:
 *   node scripts/loadtest.mjs --pg <url> [--mode staircase|soak|inject] [--minutes N] [--out <file>]
 *
 * Drives the **real durable path**: a real Postgres schema, real competing worker runtimes, real atomic claims,
 * real leases, real checkpoints, real event log. Only the agent engine is synthetic, and that is not a shortcut
 * — a load test cannot drive a paid provider, and the platform is what is under test.
 *
 * What it cannot reach: a deployed HTTP endpoint, and therefore the GraphQL layer and the genuine process
 * boundary between host and worker. #144 asks for that; there is no deployed instance yet. Printed in the report
 * rather than left to be inferred.
 *
 * Every measured number this produces is written to a JSON report, because the alternative is numbers in a
 * terminal that get retyped into a document and quietly rounded.
 */

import { writeFileSync } from "node:fs";
import pg from "pg";
import {
  DEFAULT_HARNESS,
  DEFAULT_TRAFFIC,
  FAILURE_MATRIX,
  RUNBOOKS,
  createHarness,
  detectGrowth,
  judgeInjection,
  readEnvelope,
  runLoadStep,
  summarizeLatency,
} from "@retinue/agentkit";
import { MIGRATIONS, migrate } from "@retinue/agentkit/adapters/postgres";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const PG = arg("pg", process.env.RETINUE_TEST_PG_URL);
if (!PG) {
  console.error("✗ --pg <url> (or RETINUE_TEST_PG_URL) is required: this harness needs a real PostgreSQL server.");
  console.error("  PGlite is one embedded instance, so a claim race between competing workers is unobservable there —");
  console.error("  and the claim race is the single most important thing a load test of this platform can hit.");
  process.exit(2);
}

const MODE = arg("mode", "staircase");
const MINUTES = Number(arg("minutes", "1"));
const OUT = arg("out", `loadtest-${MODE}.json`);

/** A dedicated schema per run, dropped at the end. A shared schema makes two runs' numbers each other's noise. */
const SCHEMA = `loadtest_${Date.now().toString(36)}`;

/**
 * The pool, with `search_path` set **by the server at connect time**.
 *
 * `options=-c search_path=...` in the connection string, not a `SET` per query. The first version issued a `SET`
 * on every single query, which doubled the round trips on a workload that is almost entirely small queries — and
 * the staircase then reported ~5/s as the platform's capacity when it was measuring my own connection handling.
 * Publishing that number would have been publishing a property of this script as a property of the software,
 * which is the specific way load-test numbers become folklore.
 *
 * `max` is deliberately above workers × concurrency, so the pool is not the bottleneck either. When it is, the
 * symptom is latency with an idle CPU and it looks exactly like a slow database.
 */
let pool;
const sql = {
  async query(text, params) {
    const result = await pool.query(text, params ? [...params] : undefined);
    return result.rows;
  },
};

const log = (...parts) => console.log(...parts);
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const setup = async () => {
  // A bootstrap pool on the default search_path, because the schema does not exist yet and a connection asking
  // for it would fail to open.
  const bootstrap = new pg.Pool({ connectionString: PG, max: 1 });
  await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await bootstrap.end();

  const url = new URL(PG);
  url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
  pool = new pg.Pool({ connectionString: url.toString(), max: 32 });
  await migrate(sql);
  const [{ search_path: path }] = await sql.query("SHOW search_path");
  // Asserted, not assumed. A connection string option that is silently ignored would put every table in `public`
  // and the run would look fine while writing to the wrong schema.
  if (!path.includes(SCHEMA)) throw new Error(`search_path is "${path}", expected ${SCHEMA}`);
  log(`schema ${SCHEMA}, ${MIGRATIONS.length} migrations applied, search_path ${path}`);
};

const teardown = async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
};

/** Server-side connection count for this schema's pool. Connection exhaustion is a real soak failure. */
const dbConnections = async () => {
  const rows = await sql.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()");
  return rows[0]?.n ?? 0;
};

const config = (overrides = {}) => ({ ...DEFAULT_HARNESS, tenantId: "loadtest-t1", ...overrides });

/** AC-1: a staircase of offered load, reporting the point *and* the manner of degradation. */
const staircase = async () => {
  const harness = await createHarness({ sql, config: config() });
  const steps = [];
  let index = 0;
  // Doubling rather than a fine sweep: the useful output is an order of magnitude and a mode, and a fine sweep
  // spends its time in the region that was never in doubt.
  for (const offered of [5, 10, 20, 40, 80, 160]) {
    log(`  offering ${offered}/s …`);
    const step = await runLoadStep({
      harness,
      offeredPerSecond: offered,
      durationMs: 8_000,
      tenantId: "loadtest-t1",
      startIndex: index,
    });
    index += Math.ceil((offered * 8_000) / 1_000) + 10;
    steps.push(step);
    log(
      `    p50 ${step.latency.p50}ms  p99 ${step.latency.p99}ms  ${step.throughput.completedPerSecond.toFixed(1)}/s ` +
        `completed, ${step.throughput.failed} failed, ${step.throughput.refused} refused, peak depth ${step.peakQueueDepth}, rss ${mib(step.peakRssBytes)}`,
    );
    if (step.stuck) log(`    ${step.stuck} run(s) never reached a terminal state: ${JSON.stringify(step.stuckByStatus)}`);
    for (const reason of step.admitFailures ?? []) log(`    admit rejected — ${reason}`);
    // Stop once it has broken *or* stops keeping up. Continuing past the first failing step measures how a
    // system behaves after it has already failed, which is a different and much less useful question.
    const keepingUp = step.throughput.completedPerSecond / offered >= 0.9;
    if (step.throughput.refused > 0 || step.throughput.errorRate > 0.01 || !keepingUp) break;
  }
  await harness.stop();
  const envelope = readEnvelope(steps);
  log(`\n  sustainable: ${envelope.sustainablePerSecond}/s · degrades at ${envelope.degradesAt ?? "not reached"} · mode ${envelope.mode}`);
  return { envelope };
};

/** AC-2: a soak. The duration is reported, because a short soak proving "no leak" is the misleading output. */
const soak = async () => {
  const harness = await createHarness({ sql, config: config() });
  const samples = [];
  const latencies = [];
  const endAt = Date.now() + MINUTES * 60_000;
  let index = 0;
  let admitted = 0;
  let rejected = 0;

  const sampler = setInterval(() => samples.push(harness.sample()), 1_000);
  while (Date.now() < endAt) {
    const at = Date.now();
    await harness
      .admit({ conversationId: `soak-c${index % 50}`, runId: `soak-r${index}` })
      .then(() => {
        admitted += 1;
        latencies.push(Date.now() - at);
      })
      .catch(() => {
        rejected += 1;
      });
    index += 1;
    // A steady, comfortable rate. A soak is looking for growth over time, not for a capacity limit; running it at
    // the limit means every anomaly is explained by the load rather than by a leak.
    await new Promise((r) => setTimeout(r, 20));
    if (index % 500 === 0) log(`  ${index} runs, rss ${mib(samples.at(-1)?.rssBytes ?? 0)}`);
  }
  clearInterval(sampler);
  // `settle`, not a bare drain: the traffic mix suspends a tenth of runs for a human, and without deciding them
  // the soak reported 21,417 admitted against 19,309 terminal — a 2,108 gap that is exactly the approval rate and
  // looks like lost work until you do the arithmetic. A number a reader has to reconcile themselves is a number
  // they will reconcile wrongly.
  const settled = await harness.settle({ idPrefix: "soak-r", timeoutMs: 120_000 });
  const connections = await dbConnections();
  await harness.stop();

  const growth = detectGrowth(samples);
  log(`\n  ${admitted} admitted, ${rejected} rejected at admission`);
  log(`  ${settled.completed} completed, ${settled.failed} failed, ${settled.stuck} still non-terminal`);
  log(`  ${connections} server-side database connections at the end`);
  log(`  rss first quartile ${mib(growth.firstQuartileMean)} → last ${mib(growth.lastQuartileMean)}`);
  log(`  growth ${Number.isNaN(growth.bytesPerHour) ? "n/a" : `${(growth.bytesPerHour / 1024 / 1024).toFixed(1)} MiB/h`} — ${growth.reason}`);
  return {
    growth,
    latency: summarizeLatency(latencies),
    admitted,
    rejected,
    completed: settled.completed,
    failed: settled.failed,
    stuck: settled.stuck,
    dbConnections: connections,
    minutes: MINUTES,
    // Every sample, so the growth verdict can be re-derived from the evidence rather than trusted.
    samples: samples.map((s) => ({ atMs: s.atMs, rssBytes: s.rssBytes })),
  };
};

/**
 * AC-3 and AC-4: inject the modes this process can inject itself.
 *
 * The infrastructure modes — Redis and the database going away, a failover — are *not* run here. They need a
 * container stopped or a cluster promoted, and a case that quietly does not run reports as covered.
 */
const inject = async () => {
  const results = [];

  // worker-kill: kill a worker holding a lease mid-run and assert another finishes the work, exactly once.
  {
    const harness = await createHarness({
      sql,
      config: config({ workers: 3, leaseMs: 1_500, reapEveryMs: 200, traffic: { ...DEFAULT_TRAFFIC, steps: 4, modelLatencyMs: 120 } }),
    });
    for (let i = 0; i < 40; i += 1)
      await harness.admit({ conversationId: `kill-c${i % 10}`, runId: `kill-r${i}` }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const startedAt = Date.now();
    await harness.workers[0].kill();
    log("  killed w0 mid-run; waiting for lease expiry and reaper …");
    // Generous: one lease plus several reap intervals plus the work itself. A tight bound would make this test
    // flaky and a flaky recovery test is one people learn to re-run.
    await new Promise((r) => setTimeout(r, 8_000));
    // `settle` rather than a bare drain: it decides the approvals the traffic mix produces and reports anything
    // still non-terminal *apart* from what failed. Counting a run waiting for a human as lost work reported
    // 6 of 40 lost on the first pass, which is the platform holding state correctly being scored as data loss.
    const settled = await harness.settle({ idPrefix: "kill-r", timeoutMs: 20_000 });
    const terminal = settled.completed + settled.failed;
    await harness.stop();
    results.push({
      mode: "worker-kill",
      injected: true,
      admitted: harness.admittedCount(),
      terminal,
      externalEffects: harness.effects.performed.length,
      distinctEffectKeys: harness.effects.distinctKeys(),
      recoveredMs: Date.now() - startedAt,
      // Zero: the lease expired, the reaper re-enqueued, another worker resumed. Nobody typed anything.
      manualInterventions: 0,
      notes: [
        `killed 1 of 3 workers with a lease held; ${harness.effects.performed.length} effects for ${harness.effects.distinctKeys()} keys`,
        `${settled.completed} completed, ${settled.failed} failed, ${settled.stuck} still non-terminal`,
      ],
    });
  }

  // overload: drive past the queue bound and assert refusal with flat memory.
  {
    const harness = await createHarness({ sql, config: config({ maxQueueDepth: 25, workers: 1, concurrency: 1, traffic: { ...DEFAULT_TRAFFIC, modelLatencyMs: 60 } }) });
    const before = process.memoryUsage().rss;
    let refused = 0;
    for (let i = 0; i < 800; i += 1)
      await harness.admit({ conversationId: `over-c${i % 5}`, runId: `over-r${i}` }).catch((e) => {
        if (e?.code === "resource-exhausted") refused += 1;
      });
    const peak = harness.queue.peakDepth();
    const after = process.memoryUsage().rss;
    const settled = await harness.settle({ idPrefix: "over-r", timeoutMs: 30_000 });
    // Only the admitted runs are owed a terminal state; a refused admission is cancelled at the point of refusal
    // and is neither completed nor lost.
    const terminal = settled.completed + settled.failed;
    await harness.stop();
    log(`  offered 800, refused ${refused}, peak depth ${peak} (bound 25), rss ${mib(before)} → ${mib(after)}`);
    results.push({
      mode: "overload",
      injected: refused > 0,
      // Only the *admitted* runs are owed a terminal state. A refused admission is not admitted work, which is
      // exactly why refusal is the correct behaviour rather than a failure.
      admitted: harness.admittedCount(),
      terminal,
      externalEffects: harness.effects.performed.length,
      distinctEffectKeys: harness.effects.distinctKeys(),
      recoveredMs: 0,
      manualInterventions: 0,
      notes: [`refused ${refused} of 800; peak depth ${peak} against a bound of 25; rss ${mib(before)} → ${mib(after)}`],
    });
  }

  // provider-rate-limit and provider-timeout: the retry path, under load.
  for (const [mode, traffic] of [
    ["provider-rate-limit", { ...DEFAULT_TRAFFIC, rateLimitRate: 0.3 }],
    ["provider-timeout", { ...DEFAULT_TRAFFIC, providerTimeoutRate: 0.3 }],
  ]) {
    const harness = await createHarness({ sql, config: config({ traffic, workers: 2 }) });
    const startedAt = Date.now();
    for (let i = 0; i < 60; i += 1)
      await harness.admit({ conversationId: `${mode}-c${i % 10}`, runId: `${mode}-r${i}` }).catch(() => {});
    const settled = await harness.settle({ idPrefix: `${mode}-r`, timeoutMs: 30_000 });
    const terminal = settled.completed + settled.failed;
    await harness.stop();
    results.push({
      mode,
      injected: true,
      admitted: harness.admittedCount(),
      terminal,
      externalEffects: harness.effects.performed.length,
      distinctEffectKeys: harness.effects.distinctKeys(),
      recoveredMs: Date.now() - startedAt,
      manualInterventions: 0,
      notes: [
        `30% of steps failed with ${mode}; ${terminal}/${harness.admittedCount()} reached a terminal state`,
        `${settled.completed} completed, ${settled.failed} failed, ${settled.stuck} still non-terminal`,
      ],
    });
  }

  /**
   * database-unavailable, for real — but only when explicitly asked.
   *
   * `--stop-container <name>` stops and restarts a Docker container mid-run. Behind a flag and never a default,
   * because stopping a database is not something a test run should be able to do to someone by accident, and the
   * name has to be typed by whoever knows which container is safe to stop.
   *
   * This is the one infrastructure mode this harness can genuinely reach. `redis-unavailable` cannot be reached
   * here at all: the harness deliberately substitutes a bounded in-process queue for BullMQ so the backpressure
   * bound is *ours* rather than a Redis memory setting, which means Redis is not on this harness's path. Said
   * plainly rather than run as a test that would prove nothing.
   */
  const container = arg("stop-container");
  if (container) {
    const { execFileSync } = await import("node:child_process");
    const docker = (...a) => execFileSync("docker", a, { encoding: "utf8" }).trim();
    const harness = await createHarness({
      sql,
      config: config({ workers: 2, leaseMs: 2_000, reapEveryMs: 250, traffic: { ...DEFAULT_TRAFFIC, steps: 5, modelLatencyMs: 200 } }),
    });
    for (let i = 0; i < 40; i += 1)
      await harness.admit({ conversationId: `db-c${i % 8}`, runId: `db-r${i}` }).catch(() => {});
    // Mid-run, deliberately: runs are part-way through their steps and holding leases, which is the state a
    // checkpoint exists for. Stopping between runs would test the reconnect and nothing else.
    await new Promise((r) => setTimeout(r, 600));
    const startedAt = Date.now();
    log(`  stopping ${container} …`);
    docker("stop", container);
    await new Promise((r) => setTimeout(r, 3_000));
    log(`  starting ${container} …`);
    docker("start", container);
    // Wait for the server to accept connections again before judging anything.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await sql.query("SELECT 1");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    log("  database back; re-driving anything the reaper could not reach …");
    // The reaper re-enqueues expired leases, but runs whose *enqueue* failed while the database was down are not
    // on the queue at all. Re-driving them is what an operator's runbook says to do, so the harness does the same
    // thing rather than pretending recovery is fully unattended for this mode.
    const orphans = await sql.query(
      "SELECT id FROM runs WHERE tenant_id = $1 AND id LIKE 'db-r%' AND status NOT IN ('completed','failed','cancelled')",
      ["loadtest-t1"],
    );
    for (const row of orphans)
      await harness.queue.dispatcher.enqueueRun({ tenantId: "loadtest-t1", runId: row.id }).catch(() => {});
    const settled = await harness.settle({ idPrefix: "db-r", timeoutMs: 60_000 });
    await harness.stop();
    results.push({
      mode: "database-unavailable",
      injected: true,
      admitted: harness.admittedCount(),
      terminal: settled.completed + settled.failed,
      externalEffects: harness.effects.performed.length,
      distinctEffectKeys: harness.effects.distinctKeys(),
      recoveredMs: Date.now() - startedAt,
      // The honest number. Every run whose enqueue failed while the database was down had to be re-driven, so
      // "recovers unattended" is **not** demonstrated for this mode under this harness — the in-process queue has
      // no job retry, where BullMQ would retry the job and the reaper would catch leased runs. Reported as a
      // failing verdict rather than as a green tick with a footnote.
      manualInterventions: orphans.length,
      notes: [
        `stopped ${container} for ~3s with runs mid-step`,
        `${settled.completed} completed, ${settled.failed} failed, ${settled.stuck} still non-terminal`,
        `${orphans.length} run(s) needed a manual re-drive because their enqueue failed while the database was down`,
      ],
    });
  }

  const verdicts = results.map((r) => judgeInjection(r));
  for (const v of verdicts) log(`  ${v.passed ? "✓" : "✗"} ${v.mode}${v.failures.length ? `: ${v.failures.join("; ")}` : ""}`);

  // What actually ran, not what the matrix says *might* need infrastructure. The first version printed the
  // matrix's list verbatim and so claimed `database-unavailable` was not run in the same output that had just
  // run it.
  const ran = new Set(results.map((r) => r.mode));
  const notRun = Object.values(FAILURE_MATRIX)
    .map((spec) => spec.mode)
    .filter((mode) => !ran.has(mode));
  log(`\n  not run in this invocation: ${notRun.join(", ") || "none"}`);
  log("  each has a runbook and a declared expectation; see docs/16-load-and-resilience.md");

  return { results, verdicts, notRun };
};

const main = async () => {
  await setup();
  let payload;
  try {
    log(`\n=== ${MODE} ===`);
    if (MODE === "staircase") payload = await staircase();
    else if (MODE === "soak") payload = await soak();
    else if (MODE === "inject") payload = await inject();
    else {
      console.error(`✗ unknown --mode ${MODE}`);
      process.exit(2);
    }
  } finally {
    await teardown();
  }

  const report = {
    mode: MODE,
    at: new Date().toISOString(),
    // What the numbers are *of*. A report without this is a set of numbers someone will later quote as though it
    // were a property of the software rather than of this machine on this afternoon.
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: (await import("node:os")).cpus().length,
      totalMemBytes: (await import("node:os")).totalmem(),
      note: "in-process workers against a real PostgreSQL server; no deployed HTTP instance, so the GraphQL layer and the real host/worker process boundary are not exercised",
    },
    runbooksFor: Object.keys(RUNBOOKS),
    ...payload,
  };
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  log(`\nwrote ${OUT}`);

  // A failing injection is a failing build. A load test whose recovery assertions are advisory is a load test
  // that reports success while the platform loses work.
  const failed = payload?.verdicts?.filter((v) => !v.passed) ?? [];
  process.exit(failed.length > 0 ? 1 : 0);
};

await main();
