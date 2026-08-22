/**
 * PostgreSQL `RunEventLog` (#94). The durable half of streaming: catch-up after a reconnect reads
 * this log, and worker crash-recovery reconciles against it (the C1 fix from the REQ-005 review).
 *
 * Two decisions carry the design:
 *
 *   1. **The caller's `sequence` is stored verbatim.** It is the worker's checkpoint cursor and the
 *      client's reconnect cursor, so the store must never renumber. The SPEC originally called for
 *      server-side allocation (`MAX(sequence)+1`), which would have overwritten both.
 *   2. **`ON CONFLICT DO NOTHING`.** A duplicate sequence is a silent no-op, matching the reference
 *      adapter — a recovered worker re-emits events, so a retried append is normal rather than
 *      exceptional. The composite primary key makes the collision impossible; this turns it into the
 *      idempotent no-op the port promises. The first write wins, so history never mutates under a
 *      client that already read it.
 *
 * `append` takes whatever executor it is handed, so a transaction-scoped executor puts the write
 * inside that transaction — which is what lets `emit()` keep writing the event *before* the
 * checkpoint, atomically, without this store knowing about transactions at all.
 */
import type { RunEvent, RunEventLog } from "../../core/events.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { parseRunEvent } from "../../core/validation.js";
import type { SqlExecutor } from "./sql.js";

type Row = { event: unknown };

/**
 * Validate on read rather than trusting the column. A corrupt or hand-edited row otherwise flows
 * straight into a client's event stream, where the failure surfaces far from its cause.
 */
const toEvent = (row: Row): RunEvent =>
  parseRunEvent(typeof row.event === "string" ? JSON.parse(row.event) : row.event);

export const createPostgresRunEventLog = (sql: SqlExecutor): RunEventLog => ({
  async append({ tenantId, event }) {
    await sql.query(
      `INSERT INTO run_events (tenant_id, run_id, sequence, type, event)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (tenant_id, run_id, sequence) DO NOTHING`,
      [tenantId, event.runId, event.sequence, event.type, JSON.stringify(event)],
    );
  },

  async listAfter({ tenantId, runId, after, limit }) {
    // `sequence > $3 ORDER BY sequence` is a forward range scan on the primary key — the whole point
    // of keying on (tenant_id, run_id, sequence) rather than a surrogate id.
    const rows = await sql.query<Row>(
      `SELECT event FROM run_events
        WHERE tenant_id = $1 AND run_id = $2 AND sequence > $3
        ORDER BY sequence
        ${limit === undefined ? "" : "LIMIT $4"}`,
      limit === undefined ? [tenantId, runId, after] : [tenantId, runId, after, limit],
    );
    return rows.map(toEvent);
  },

  async latestSequence({ tenantId, runId }) {
    // COALESCE, not an empty-result branch: a run with no events has head 0, which is the cursor a
    // fresh client sends. Recovery compares against this to decide what the checkpoint missed.
    const rows = await sql.query<{ head: number | string | null }>(
      `SELECT COALESCE(MAX(sequence), 0) AS head FROM run_events WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    );
    const head = rows[0]?.head ?? 0;
    return typeof head === "number" ? head : Number(head);
  },
});

/** Re-exported for tests that need the row shape without importing the module's internals. */
export type { RunId, TenantId };
