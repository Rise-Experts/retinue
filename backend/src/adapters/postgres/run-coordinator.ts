/**
 * PostgreSQL `ConversationRunCoordinator` (#98) — at most one run executing per conversation, the
 * rest queued FIFO, across processes rather than within one.
 *
 * The memory adapter gets its atomicity free: every method is synchronous end-to-end, so the
 * single-threaded event loop closes the check-then-act race. Postgres has no such luxury — two
 * workers really do interleave — so the claim runs inside a short transaction that takes a row lock
 * with `SELECT … FOR UPDATE`. Short is the operative word: the lock is held for microseconds around
 * the decision, *not* for the lifetime of the run. See migration `0007` for why an advisory lock held
 * for a run's lifetime was the wrong shape.
 *
 * `FOR UPDATE` rather than a single clever statement because the claim's condition includes whether
 * the current holder is still alive, which is a question about another table. Expressing that inline
 * in an `ON CONFLICT … DO UPDATE` produced a statement no reviewer could check; the row lock makes it
 * read like the invariant it enforces.
 */
import type { RunId } from "../../core/ids.js";
import type { ConversationRunCoordinator } from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";
import type { TransactionRunner } from "./transaction.js";

type SlotRow = { active_run_id: string | null; queued: unknown };

/** jsonb comes back parsed from PGlite and as text from some drivers; normalise both. */
const toQueue = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
};

const SELECT_SLOT_FOR_UPDATE = `SELECT active_run_id, queued
     FROM conversation_run_slots
    WHERE tenant_id = $1 AND conversation_id = $2
      FOR UPDATE`;

const WRITE_SLOT = `UPDATE conversation_run_slots
      SET active_run_id = $3, queued = $4::jsonb, updated_at = now()
    WHERE tenant_id = $1 AND conversation_id = $2`;

export const createPostgresConversationRunCoordinator = (
  sql: SqlExecutor,
  runner: TransactionRunner,
): ConversationRunCoordinator => {
  /**
   * Whether the slot's current holder can be displaced.
   *
   * Liveness comes from the run's own lease (#93) rather than a second clock on the slot. Two leases
   * for one fact drift, and when they disagree there is no principled tiebreak.
   *
   * The `rows[0]?.dead === true` shape carries the load-bearing half: **no run row means unknown, not
   * dead.** `claimOrEnqueue` is legitimately called before the run row is committed, so treating a
   * missing row as dead would let a fresh claim steal a live run's slot — a correctness bug much
   * worse than recovering a crashed worker's slot slowly.
   */
  const holderIsDead = async (
    tx: SqlExecutor,
    tenantId: string,
    activeRunId: string,
  ): Promise<boolean> => {
    const rows = await tx.query<{ dead: boolean }>(
      `SELECT (
                status IN ('completed', 'failed', 'cancelled')
                OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
              ) AS dead
         FROM runs
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, activeRunId],
    );
    return rows[0]?.dead === true;
  };

  return {
    async claimOrEnqueue({ tenantId, conversationId, runId }) {
      return runner.transaction(async (tx) => {
        // An idle conversation still needs a row to lock. Separate from the lock because
        // `INSERT … ON CONFLICT DO NOTHING` does not lock the conflicting row it declined to touch.
        await tx.query(
          `INSERT INTO conversation_run_slots (tenant_id, conversation_id, queued, updated_at)
           VALUES ($1, $2, '[]'::jsonb, now())
           ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
          [tenantId, conversationId],
        );
        const rows = await tx.query<SlotRow>(SELECT_SLOT_FOR_UPDATE, [tenantId, conversationId]);
        const row = rows[0];
        // Unreachable in practice: the insert above guarantees a row, and the lock is held. Kept
        // because returning a wrong "started" here would break single-flight silently.
        if (!row) throw new Error(`conversation_run_slots row missing for ${conversationId}`);

        const queue = toQueue(row.queued);
        const active = row.active_run_id;
        const free =
          active === null || active === runId || (await holderIsDead(tx, tenantId, active));

        if (free) {
          // Claiming also drops the run from the backlog: a queued run that gets promoted by its own
          // retry must not remain listed behind itself.
          const remaining = queue.filter((r) => r !== runId);
          await tx.query(WRITE_SLOT, [tenantId, conversationId, runId, JSON.stringify(remaining)]);
          return { status: "started" as const, position: 0 };
        }

        const next = queue.includes(runId) ? queue : [...queue, runId];
        if (next !== queue) {
          await tx.query(WRITE_SLOT, [tenantId, conversationId, active, JSON.stringify(next)]);
        }
        return { status: "queued" as const, position: next.indexOf(runId) + 1 };
      });
    },

    async releaseAndPromote({ tenantId, conversationId, runId }) {
      return runner.transaction(async (tx) => {
        const rows = await tx.query<SlotRow>(SELECT_SLOT_FOR_UPDATE, [tenantId, conversationId]);
        const row = rows[0];
        if (!row) return null;
        // A release from a run that does not hold the slot changes nothing — it must not unseat the
        // holder and must not promote anyone. Matches the reference adapter.
        if (row.active_run_id !== runId) return null;

        const queue = toQueue(row.queued);
        const promoted = queue.shift() ?? null;
        // Release and promote in the same statement, inside the same lock: the port's "no
        // release→dequeue→claim gap" requirement is exactly the window this closes.
        await tx.query(WRITE_SLOT, [tenantId, conversationId, promoted, JSON.stringify(queue)]);
        return promoted as RunId | null;
      });
    },

    async active({ tenantId, conversationId }) {
      const rows = await sql.query<{ active_run_id: string | null }>(
        `SELECT active_run_id FROM conversation_run_slots
          WHERE tenant_id = $1 AND conversation_id = $2`,
        [tenantId, conversationId],
      );
      return (rows[0]?.active_run_id ?? null) as RunId | null;
    },

    async depth({ tenantId, conversationId }) {
      // Counted in the database rather than by fetching the array: depth is asked for far more often
      // than the queue's contents are needed.
      const rows = await sql.query<{ depth: string | number }>(
        `SELECT jsonb_array_length(queued) AS depth FROM conversation_run_slots
          WHERE tenant_id = $1 AND conversation_id = $2`,
        [tenantId, conversationId],
      );
      const raw = rows[0]?.depth;
      return raw === undefined ? 0 : Number(raw);
    },
  };
};
