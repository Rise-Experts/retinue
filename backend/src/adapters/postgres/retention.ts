/**
 * The Postgres `RunEventPruner` (#151).
 *
 * One statement, and every interesting decision is in it.
 *
 * **`ctid IN (SELECT … LIMIT n)`.** The bound has to be on the *rows selected*, not on the delete, and Postgres
 * has no `DELETE … LIMIT`. Selecting `ctid` — the physical row locator — lets the subquery do a bounded,
 * index-driven scan and the delete touch exactly those rows. The alternative shapes are worse: a correlated
 * `IN (tenant_id, run_id, sequence)` tuple list is a much larger comparison per row, and a CTE with `RETURNING`
 * still needs the same bounded selection to feed it.
 *
 * **The safety join is inside the subquery.** `run_events` has no status of its own, so "is this run terminal?"
 * is a lookup on `runs` by `(tenant_id, run_id)` — which is `runs`' primary key, so it costs an index probe per
 * candidate and no extra index. Putting the join in the subquery means a non-terminal run's rows are never
 * *selected*, so they cannot be deleted by a later mistake in the outer statement.
 *
 * **`FOR UPDATE SKIP LOCKED` is deliberately absent.** Two concurrent prunes selecting overlapping `ctid`s is
 * harmless: the second `DELETE` matches no row for the ones already gone and reports a smaller count. Adding row
 * locks would serialise the sweeps and, worse, hold locks across the join — which is exactly the blocking this
 * batching exists to avoid. Idempotency here comes from the delete being a no-op on an absent row, not from
 * exclusion.
 */

import { PRUNABLE_RUN_STATUSES, type PruneRequest, type PruneResult, type RunEventPruner } from "../../retention/index.js";
import type { SqlExecutor } from "./sql.js";

/**
 * The terminal statuses as a SQL list.
 *
 * Built from the exported constant so the SQL and the documented rule cannot drift. Quoted here rather than
 * passed as a parameter because an array parameter would make the planner treat it as opaque and lose the
 * index probe on `runs`; the values come from a closed list in our own source, never from input.
 */
const TERMINAL_LIST = PRUNABLE_RUN_STATUSES.map((s) => `'${s}'`).join(", ");

export const createPostgresRunEventPruner = (sql: SqlExecutor): RunEventPruner => ({
  async prune({ olderThan, limit }: PruneRequest): Promise<PruneResult> {
    // A zero or negative limit would make `ctid IN (SELECT ... LIMIT 0)` delete nothing, which is correct but
    // costs a scan. Answered without touching the database, because a maintenance loop with a misconfigured
    // batch size should not generate load.
    if (limit <= 0) return { deleted: 0 };

    const rows = await sql.query<{ ctid: string }>(
      `DELETE FROM run_events
        WHERE ctid IN (
          SELECT e.ctid
            FROM run_events e
            JOIN runs r ON r.tenant_id = e.tenant_id AND r.id = e.run_id
           WHERE e.created_at < $1::timestamptz
             -- AC-2. A non-terminal run can still be reconciled against its log, so its events are never
             -- selected however old they are -- including a run that has waited months on a human approval.
             AND r.status IN (${TERMINAL_LIST})
           -- Oldest first, so a bounded sweep makes progress at the end of the table that will never come back
           -- rather than nibbling at whatever the scan happened to reach.
           ORDER BY e.created_at
           LIMIT $2
        )
        RETURNING ctid`,
      [olderThan, limit],
    );
    // The row count from `RETURNING`, not from a driver-specific `rowCount`: the executor port returns rows, and
    // counting them is the one form that is identical across every adapter.
    return { deleted: rows.length };
  },
});
