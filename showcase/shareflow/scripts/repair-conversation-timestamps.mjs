/**
 * Repair conversations stamped by the adapter's **test** clock.
 *
 * `createPostgresConversationStore(sql)` defaults to a deterministic clock —
 * `new Date(Date.UTC(2020, 0, 1, 0, 0, 0, ++n))` — described in the adapter as "injectable for
 * deterministic ordering in tests". The host never passed a real one, so every conversation this
 * deployment created is dated 2020-01-01 with a counter in the milliseconds. `module.ts` now passes
 * `() => new Date().toISOString()`; this repairs the rows written before it did.
 *
 * The real times are recoverable because the **message** store was never affected: a conversation's
 * first and last message carry genuine timestamps, and those are exactly what `created_at` and
 * `updated_at` are supposed to mean.
 *
 *   created_at  ← the first message in the conversation
 *   updated_at  ← the last message in the conversation
 *
 * Safe to run more than once, and narrow by construction:
 *
 *  - it only touches rows whose `updated_at` is before 2021, which no real row can be — the deployment
 *    did not exist then, and the value it is replacing is a synthetic constant rather than data;
 *  - a conversation with no messages is left alone, because there is nothing to derive a time from;
 *  - `--dry-run` prints the changes and writes nothing.
 *
 * Usage, with `RETINUE_DATABASE_URL` and `RETINUE_DATABASE_SCHEMA` set the way the host has them:
 *
 *     node scripts/repair-conversation-timestamps.mjs --dry-run
 *     node scripts/repair-conversation-timestamps.mjs
 */

import { Pool } from "pg";

const dryRun = process.argv.includes("--dry-run");

const url = process.env["RETINUE_DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("RETINUE_DATABASE_URL is required.");
  process.exit(1);
}

const schema = process.env["RETINUE_DATABASE_SCHEMA"] ?? "retinue";
const pool = new Pool({
  connectionString: url,
  // The startup parameter, not a `SET`: applied before the connection is usable, and no space after
  // the comma — libpq reads a space as the end of one option.
  options: `-c search_path=${schema},public`,
});

/** The cut-off. Anything before this is the synthetic constant, not a real time. */
const SENTINEL_BEFORE = "2021-01-01";

const SELECT = `
  SELECT c.tenant_id, c.id, c.title, c.updated_at,
         MIN(m.created_at) AS first_message,
         MAX(m.created_at) AS last_message,
         COUNT(m.id)::int  AS messages
    FROM conversations c
    JOIN messages m ON m.tenant_id = c.tenant_id AND m.conversation_id = c.id
   WHERE c.updated_at < $1
GROUP BY c.tenant_id, c.id, c.title, c.updated_at
ORDER BY MAX(m.created_at) DESC`;

const UPDATE = `
  UPDATE conversations c
     SET created_at = t.first_message,
         updated_at = t.last_message
    FROM (
      SELECT m.tenant_id, m.conversation_id,
             MIN(m.created_at) AS first_message,
             MAX(m.created_at) AS last_message
        FROM messages m
    GROUP BY m.tenant_id, m.conversation_id
    ) t
   WHERE c.tenant_id = t.tenant_id
     AND c.id = t.conversation_id
     AND c.updated_at < $1`;

try {
  const { rows } = await pool.query(SELECT, [SENTINEL_BEFORE]);

  const orphans = await pool.query(
    `SELECT count(*)::int AS n FROM conversations c
      WHERE c.updated_at < $1
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id)`,
    [SENTINEL_BEFORE],
  );

  console.log(`${rows.length} conversation(s) to repair; ${orphans.rows[0]?.n ?? 0} with no messages, left alone.`);
  for (const row of rows.slice(0, 10)) {
    console.log(
      `  ${String(row.updated_at.toISOString())} → ${row.last_message.toISOString()}  ` +
        `(${row.messages} msg) ${String(row.title ?? "").slice(0, 48)}`,
    );
  }
  if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
  } else {
    const result = await pool.query(UPDATE, [SENTINEL_BEFORE]);
    console.log(`\nrepaired ${result.rowCount} conversation(s).`);
  }
} finally {
  await pool.end();
}
