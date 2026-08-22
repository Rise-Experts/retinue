/**
 * PostgreSQL `CheckpointStore` (#95). The durable resume point: a recovered worker reloads the
 * latest checkpoint, finalises any tool calls that were mid-flight, and continues from there.
 *
 * The monotonic guarantee lives in the statement, not in the caller. `save` is a single upsert whose
 * `DO UPDATE` carries `WHERE excluded.sequence >= checkpoints.sequence`, so a late write from a
 * worker whose lease was already reaped cannot rewind the run. Read-then-write could not hold that
 * across two processes — and "two workers, one run, briefly overlapping" is exactly what lease
 * expiry produces.
 */
import type { RunId, TenantId } from "../../core/ids.js";
import type { CheckpointStore } from "../../persistence/index.js";
import type { RunCheckpoint } from "../../runtime/checkpoint.js";
import type { SqlExecutor } from "./sql.js";

type Row = { state: unknown };

/**
 * The whole checkpoint round-trips through `state`; `sequence` and `step` are lifted into columns for
 * the monotonic guard and the non-negative constraint. Reading from `state` rather than reassembling
 * from columns keeps one source of truth, so a column and the payload cannot disagree.
 */
const toCheckpoint = (row: Row): RunCheckpoint =>
  (typeof row.state === "string" ? JSON.parse(row.state) : row.state) as RunCheckpoint;

export const createPostgresCheckpointStore = (sql: SqlExecutor): CheckpointStore => ({
  async latest({ tenantId, runId }) {
    const rows = await sql.query<Row>(
      `SELECT state FROM checkpoints WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    );
    const row = rows[0];
    return row ? toCheckpoint(row) : null;
  },

  async save({ tenantId, checkpoint }) {
    await sql.query(
      `INSERT INTO checkpoints (tenant_id, run_id, sequence, step, state, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
       ON CONFLICT (tenant_id, run_id) DO UPDATE
          SET sequence   = excluded.sequence,
              step       = excluded.step,
              state      = excluded.state,
              updated_at = excluded.updated_at
        -- Monotonic: a save at a lower sequence is ignored, so a reaped worker's late write cannot
        -- rewind a run that a newer claim has already advanced. Greater-or-equal rather than
        -- strictly-greater, so an equal sequence is an idempotent refresh, not a rejected write.
        WHERE excluded.sequence >= checkpoints.sequence`,
      [
        tenantId,
        checkpoint.runId,
        checkpoint.sequence,
        checkpoint.step,
        JSON.stringify(checkpoint),
        checkpoint.updatedAt,
      ],
    );
  },
});

export type { RunId, TenantId };
