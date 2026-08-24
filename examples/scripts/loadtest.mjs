#!/usr/bin/env node
/**
 * A large-dataset and performance probe for the example app.
 *
 * Not the platform's load harness (#144) — that one drives the durable runtime with failure injection. This
 * measures the things running a *real app* against a real database makes visible and a unit test cannot:
 *
 * - **Read latency at size.** A notebook of three notes says nothing about a notebook of thousands. History
 *   paging, message round-trips and citation search are all "fine" until the table is big.
 * - **Context utilization as a conversation grows.** The interesting number is not "does it fit" but *when* it
 *   stops fitting, and whether compaction catches it before the provider does.
 * - **Whether anything is O(n) that should not be.** Timings are reported per operation *at several sizes*, so a
 *   linear scan hiding behind a small fixture shows up as a slope rather than a number.
 *
 * Percentiles, not averages. A mean hides the tail, and the tail is what a person experiences — one slow request
 * in twenty is a page that feels broken, and it does not move the mean.
 *
 * Model calls are **not** in the hot loop. They dominate every timing and vary by provider load, so a figure
 * including them measures OpenAI rather than this code. `--with-model` opts in for an end-to-end reading.
 */

import pg from "pg";
import { performance } from "node:perf_hooks";

const SCHEMA = process.env.AGENTKIT_EXAMPLE_SCHEMA ?? "agentkit_example";
const BASE = process.env.AGENTKIT_EXAMPLE_URL ?? "http://localhost:4000";
const TENANT = process.env.AGENTKIT_LOADTEST_TENANT ?? "loadtest";
const PRINCIPAL = "loadtest-principal";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const MESSAGES = Number(arg("messages", 2000));
const NOTES = Number(arg("notes", 500));
const SAMPLES = Number(arg("samples", 40));

if (!process.env.AGENTKIT_DATABASE_URL) {
  console.error("✗ AGENTKIT_DATABASE_URL is required.");
  process.exit(2);
}

const url = new URL(process.env.AGENTKIT_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
const q = async (text, params) => (await pool.query(text, params)).rows;

const headers = {
  "content-type": "application/json",
  "x-agentkit-tenant": TENANT,
  "x-agentkit-principal": PRINCIPAL,
  "x-agentkit-roles": "editor",
};

/** Percentiles over a sorted copy. Nearest-rank, which is the honest reading for a few dozen samples. */
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] ?? 0 };
};

const time = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
};

const measure = async (label, n, fn) => {
  const samples = [];
  for (let i = 0; i < n; i += 1) samples.push((await time(() => fn(i))).ms);
  const p = percentiles(samples);
  console.log(
    `  ${label.padEnd(34)} p50 ${p.p50.toFixed(1).padStart(7)}ms  p95 ${p.p95.toFixed(1).padStart(7)}ms  ` +
      `p99 ${p.p99.toFixed(1).padStart(7)}ms  max ${p.max.toFixed(1).padStart(7)}ms`,
  );
  return p;
};

/**
 * Seed directly through SQL, not through the API.
 *
 * Two thousand messages through `/api/message` would be two thousand model calls — hours, and a bill. The rows
 * are the same rows; what is being measured is reading them.
 */
const seed = async (conversationId, count) => {
  await q(
    // No `status` column: active/archived/deleted are `archived_at` and `deleted_at` being null, which is the
    // shape that lets "when was it archived" be answerable rather than only "is it".
    `INSERT INTO conversations (tenant_id, id, title, version, created_at, updated_at)
     VALUES ($1, $2, 'loadtest', 1, now(), now())
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [TENANT, conversationId],
  );
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const id = `lt-${conversationId}-${String(i).padStart(6, "0")}`;
    const role = i % 2 === 0 ? "user" : "assistant";
    // Realistic length. A one-word message would make every token figure meaningless.
    const text =
      role === "user"
        ? `Turn ${i}: can you look at the quarterly numbers and tell me whether the renewal trend held?`
        : `Turn ${i}: renewals held at about nine percent quarter on quarter, with the platform team's two ` +
          `hires landing in November. The hiring plan note has the detail.`;
    rows.push([
      TENANT,
      id,
      conversationId,
      `lt-run-${conversationId}-${i}`,
      role,
      JSON.stringify([{ id: `${id}-p0`, type: "text", schemaVersion: 1, createdAt: new Date(Date.now() - (count - i) * 1000).toISOString(), text }]),
      new Date(Date.now() - (count - i) * 1000).toISOString(),
    ]);
  }
  // One multi-row insert per 500, rather than 2000 round trips.
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values = batch
      .map((_, n) => `($${n * 7 + 1}, $${n * 7 + 2}, $${n * 7 + 3}, $${n * 7 + 4}, $${n * 7 + 5}, $${n * 7 + 6}::jsonb, $${n * 7 + 7}::timestamptz)`)
      .join(", ");
    await q(
      `INSERT INTO messages (tenant_id, id, conversation_id, run_id, role, parts, created_at)
       VALUES ${values} ON CONFLICT (tenant_id, id) DO NOTHING`,
      batch.flat(),
    );
  }
};

const seedNotes = async (count) => {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push([TENANT, PRINCIPAL, `Note ${i}: the renewal rate for segment ${i % 20} was ${(i % 15) + 2} percent.`]);
  }
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values = batch.map((_, n) => `($${n * 3 + 1}, $${n * 3 + 2}, $${n * 3 + 3})`).join(", ");
    await q(
      // `disabled_at IS NULL` is what `retrieve` filters on — an active memory has no disabled_at, rather than
      // a `disabled` boolean. Seeding the wrong column would have made every seeded memory invisible.
      `INSERT INTO principal_memory (tenant_id, principal_id, id, text, tags, salience, version, created_at, updated_at)
       SELECT v.tenant_id, v.principal_id, 'lt-mem-' || (${i} + row_number() over ()), v.text, '[]'::jsonb, 50, 1, now(), now()
       FROM (VALUES ${values}) AS v(tenant_id, principal_id, text)
       ON CONFLICT DO NOTHING`,
      batch.flat(),
    );
  }
};

const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
};

const run = async () => {
  console.log(`\nagentkit example — load probe`);
  console.log(`  schema ${SCHEMA}   tenant ${TENANT}   base ${BASE}\n`);

  // A clean slate for this tenant only. Never `TRUNCATE`: the schema is shared with the interactive example.
  await q(`DELETE FROM messages WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM conversations WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM principal_memory WHERE tenant_id = $1`, [TENANT]);

  console.log(`Seeding ${NOTES} memories…`);
  const memSeed = await time(() => seedNotes(NOTES));
  console.log(`  ${memSeed.ms.toFixed(0)}ms\n`);

  /**
   * Several sizes, so a linear scan shows as a slope.
   *
   * One measurement at one size cannot distinguish "fast" from "fast at this size", which is the whole question.
   */
  const sizes = [100, 500, MESSAGES];
  const results = [];
  for (const size of sizes) {
    const conversationId = `lt-conv-${size}`;
    process.stdout.write(`Seeding ${size} messages…`);
    const s = await time(() => seed(conversationId, size));
    console.log(` ${s.ms.toFixed(0)}ms`);

    console.log(`\n── ${size} messages ─────────────────────────────────────────────`);
    const history = await measure("GET /api/history", SAMPLES, () =>
      api(`/api/history?conversationId=${conversationId}`),
    );
    const context = await measure("GET /api/context", SAMPLES, () =>
      api(`/api/context?conversationId=${conversationId}`),
    );
    const usage = await measure("GET /api/usage", Math.max(5, Math.floor(SAMPLES / 4)), () => api(`/api/usage`));

    const window = await api(`/api/context?conversationId=${conversationId}`);
    console.log(
      `  window: ~${window.usedTokens} / ${window.limit} tokens ` +
        `(${(window.fraction * 100).toFixed(1)}%, prompt ${window.promptTokens})`,
    );
    console.log(
      `  history: ${window.windowedMessages} of ${window.totalMessages} messages in the window` +
        `${window.overflowing ? `  ← ${window.totalMessages - window.windowedMessages} beyond the read limit` : ""}` +
        `${window.shouldCompact ? "  ← would compact" : ""}`,
    );
    results.push({ size, history, context, usage, window });
  }

  console.log(`\n── scaling ──────────────────────────────────────────────────────`);
  const first = results[0];
  for (const r of results) {
    const ratio = first.history.p50 === 0 ? 0 : r.history.p50 / first.history.p50;
    const sizeRatio = r.size / first.size;
    console.log(
      `  ${String(r.size).padStart(5)} messages: history p50 ×${ratio.toFixed(2)} for ×${sizeRatio.toFixed(1)} data ` +
        `→ ${ratio / sizeRatio < 0.5 ? "sub-linear" : ratio / sizeRatio < 1.5 ? "roughly linear" : "worse than linear"}`,
    );
  }

  /**
   * Compaction on the largest conversation, measured.
   *
   * This is the one operation that *should* be slow — it is a model call over the whole prefix — so it is timed
   * separately and reported as such rather than folded into an average that would then look alarming.
   */
  if (process.argv.includes("--with-model")) {
    const largest = `lt-conv-${MESSAGES}`;
    console.log(`\n── compaction (${MESSAGES} messages, includes a model call) ─────`);
    const before = await api(`/api/context?conversationId=${largest}`);
    const compact = await time(() => api(`/api/compact`, { method: "POST", body: JSON.stringify({ conversationId: largest }) }));
    const after = await api(`/api/context?conversationId=${largest}`);
    console.log(`  POST /api/compact                  ${compact.ms.toFixed(0)}ms`);
    console.log(`  outcome: ${JSON.stringify(compact.value)}`);
    console.log(
      `  window: ~${before.usedTokens} → ~${after.usedTokens} tokens ` +
        `(${(before.fraction * 100).toFixed(1)}% → ${(after.fraction * 100).toFixed(1)}%)`,
    );
  } else {
    console.log(`\n  (compaction not measured — pass --with-model to include it)`);
  }

  console.log(`\n── row counts ───────────────────────────────────────────────────`);
  for (const table of ["messages", "conversations", "principal_memory", "runs", "run_events", "usage_records"]) {
    const [row] = await q(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [TENANT]);
    console.log(`  ${table.padEnd(20)} ${String(row.n).padStart(7)}`);
  }
  console.log();
  await pool.end();
};

run().catch(async (error) => {
  console.error(`\n✗ ${error.message}`);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
