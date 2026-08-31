/**
 * PostgreSQL `RunStore` (#93). Pure SQL over a `SqlExecutor`; verified by `runStoreConformance`,
 * the same suite the in-memory adapter passes.
 *
 * Every state change is a **single compare-and-set `UPDATE … RETURNING`**, never read-then-write.
 * That is the whole point of this adapter: the in-memory store's "two workers cannot claim one run"
 * guarantee comes from JavaScript being single-threaded, which says nothing about two worker
 * processes. Here the database adjudicates, so the guarantee survives real deployment.
 *
 * Where a caller needs to distinguish *why* no row changed (missing vs. illegal vs. held by someone
 * else), the follow-up read happens only on the failure path — so the happy path stays one
 * statement.
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { PlatformError } from "../../core/errors.js";
import type { AgentId, ConversationId, PrincipalId, RunId, TenantId } from "../../core/ids.js";
import type { RunStore } from "../../persistence/index.js";
import { canTransition, isTerminal, type Run, type RunStatus } from "../../runtime/index.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  tenant_id: string;
  id: string;
  conversation_id: string | null;
  agent_id: string;
  agent_version: number;
  input: unknown;
  limits: unknown;
  status: string;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  error: unknown;
  claimed_by: string | null;
  keepalive_at: string | Date | null;
  lease_expires_at: string | Date | null;
  cancel_requested_at: string | Date | null;
  principal_id: string | null;
  role_ids: readonly string[] | null;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const toRun = (r: Row): Run => ({
  id: r.id as RunId,
  tenantId: r.tenant_id as TenantId,
  // Spread conditionally, so an absent conversation is *absent* from the object rather than an explicit
  // `undefined` — `"conversationId" in run` then answers "does this belong to a conversation" without a
  // second convention, which is how every other optional field in these adapters behaves (#198).
  ...(r.conversation_id === null ? {} : { conversationId: r.conversation_id as ConversationId }),
  agentId: r.agent_id as AgentId,
  agentVersion: r.agent_version,
  // Absent stays absent: a run with no recorded input is different from one whose input was null.
  ...(r.input === null || r.input === undefined
    ? {}
    : { input: typeof r.input === "string" ? JSON.parse(r.input) : r.input }),
  ...(r.limits === null || r.limits === undefined
    ? {}
    : { limits: (typeof r.limits === "string" ? JSON.parse(r.limits) : r.limits) as Run["limits"] }),
  status: r.status as RunStatus,
  createdAt: iso(r.created_at),
  ...(r.started_at === null ? {} : { startedAt: iso(r.started_at) }),
  ...(r.finished_at === null ? {} : { finishedAt: iso(r.finished_at) }),
  ...(r.error === null || r.error === undefined ? {} : { error: r.error as PlatformError }),
  ...(r.claimed_by === null ? {} : { claimedBy: r.claimed_by }),
  ...(r.keepalive_at === null ? {} : { keepaliveAt: iso(r.keepalive_at) }),
  ...(r.lease_expires_at === null ? {} : { leaseExpiresAt: iso(r.lease_expires_at) }),
  ...(r.cancel_requested_at === null ? {} : { cancelRequestedAt: iso(r.cancel_requested_at) }),
  // #164. Null-and-undefined both mean "not recorded": the column is nullable for rows written before it
  // existed, and `??` here rather than a `?? []` default because an empty role list and an unknown one are
  // different facts — one is a caller with no roles, the other is a run nobody can attribute.
  ...(r.principal_id === null || r.principal_id === undefined ? {} : { principalId: r.principal_id as PrincipalId }),
  ...(r.role_ids === null || r.role_ids === undefined ? {} : { roleIds: r.role_ids }),
});

const conflict = (m: string) => new AgentPlatformError({ code: "conflict", message: m, retryable: false });
const notFound = (id: string) =>
  new AgentPlatformError({ code: "not_found", message: `Run ${id} not found`, retryable: false });

/** The statuses that can never hold a lease or transition further. Mirrors `isTerminal`. */
const TERMINAL_SQL = `('completed', 'failed', 'cancelled')`;

export const createPostgresRunStore = (sql: SqlExecutor): RunStore => {
  const read = async (tenantId: string, id: string): Promise<Run | null> => {
    const rows = await sql.query<Row>(`SELECT * FROM runs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    const row = rows[0];
    return row ? toRun(row) : null;
  };

  return {
    async create({ tenantId, id, conversationId, agentId, agentVersion, principalId, roleIds, input, limits }) {
      const rows = await sql.query<Row>(
        `INSERT INTO runs (tenant_id, id, conversation_id, agent_id, agent_version, status, created_at,
                           principal_id, role_ids, input, limits)
         VALUES ($1, $2, $3, $4, $5, 'queued', now(), $6, $7, $8::jsonb, $9::jsonb)
         ON CONFLICT (tenant_id, id) DO NOTHING
         RETURNING *`,
        // `?? null` on the conversation since #198: absent means the run belongs to none, and a
        // fabricated id here would be indistinguishable from a real conversation in every later query.
        // `input` and `limits` since #202: a conversation-less run's request has nowhere else to live, and a
        // flow's remaining budget has to reach the child it admits.
        [
          tenantId,
          id,
          conversationId ?? null,
          agentId,
          agentVersion,
          principalId ?? null,
          roleIds ?? null,
          input === undefined ? null : JSON.stringify(input),
          limits === undefined ? null : JSON.stringify(limits),
        ],
      );
      const row = rows[0];
      if (!row) throw conflict(`Run ${id} already exists`);
      return toRun(row);
    },

    async findById({ tenantId, id }) {
      return read(tenantId, id);
    },

    /**
     * Lease-based claim, in one statement. Two claimable cases:
     *   - `queued` — a cold start.
     *   - `running` with an expired lease — **crash recovery**, the case the SPEC's original
     *     `WHERE status='queued'` would have removed.
     * A live lease held by *another* worker excludes the row; the current holder re-claiming is
     * allowed (idempotent re-entry after a transient failure).
     */
    async claim({ tenantId, id, workerId, leaseMs, now, maxConcurrent }) {
      /**
       * The per-tenant concurrency cap, **in the same statement as the claim** — #265.
       *
       * A correlated subquery rather than a count read beforehand, and that is the whole point. Reading the
       * count and then updating is check-then-act across processes: two workers both read "3 of 4 used", both
       * claim, and the tenant runs at 5. Inside the `WHERE`, the count is evaluated against the row versions
       * this statement locks, so the two claims serialise and the second one's subquery sees the first.
       *
       * `id <> $2` keeps the run from counting against itself, so recovering an expired lease is never blocked
       * by the limit it is trying to restore. A non-positive or absent limit is passed as NULL and the clause
       * short-circuits to true.
       */
      const rows = await sql.query<Row>(
        `UPDATE runs
            SET status           = 'running',
                claimed_by       = $3,
                keepalive_at     = $4::timestamptz,
                lease_expires_at = $4::timestamptz + ($5 || ' milliseconds')::interval,
                -- Only on the first claim: a recovered run keeps its original start time.
                started_at       = COALESCE(started_at, $4::timestamptz)
          WHERE tenant_id = $1
            AND id = $2
            AND status NOT IN ${TERMINAL_SQL}
            AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= $4::timestamptz))
            AND (claimed_by IS NULL
                 OR claimed_by = $3
                 OR lease_expires_at IS NULL
                 OR lease_expires_at <= $4::timestamptz)
            AND ($6::int IS NULL
                 OR (SELECT count(*) FROM runs live
                      WHERE live.tenant_id = $1
                        AND live.id <> $2
                        AND live.status = 'running'
                        AND live.lease_expires_at > $4::timestamptz) < $6::int)
          RETURNING *`,
        [tenantId, id, workerId, now, String(leaseMs), maxConcurrent !== undefined && maxConcurrent > 0 ? maxConcurrent : null],
      );
      const row = rows[0];
      return row ? toRun(row) : null;
    },

    async countLive({ tenantId, now }) {
      const rows = await sql.query<{ live: string }>(
        `SELECT count(*) AS live FROM runs
          WHERE tenant_id = $1 AND status = 'running' AND lease_expires_at > $2::timestamptz`,
        [tenantId, now],
      );
      // Postgres returns count() as bigint, which the driver hands back as a string.
      return Number(rows[0]?.live ?? 0);
    },

    /** False when the claim was lost (reaped or stolen) so the worker aborts rather than continuing. */
    async keepalive({ tenantId, id, workerId, leaseMs, now }) {
      const rows = await sql.query<{ id: string }>(
        `UPDATE runs
            SET keepalive_at     = $4::timestamptz,
                lease_expires_at = $4::timestamptz + ($5 || ' milliseconds')::interval
          WHERE tenant_id = $1
            AND id = $2
            AND claimed_by = $3
            AND status NOT IN ${TERMINAL_SQL}
          RETURNING id`,
        [tenantId, id, workerId, now, String(leaseMs)],
      );
      return rows.length > 0;
    },

    /**
     * Guarded transition by the claiming worker. Legality is decided in TypeScript from
     * `RUN_TRANSITIONS` rather than duplicated in SQL — one source of truth, and the error message
     * can name the illegal move. A same-status transition is a no-op rather than an error.
     *
     * Terminal and `waiting-for-*` states release the claim and lease, so a continuation can
     * re-claim the run without waiting for the lease to expire.
     */
    async transition({ tenantId, id, workerId, to, now, error }) {
      const current = await read(tenantId, id);
      if (!current) throw notFound(id);
      if (current.claimedBy !== undefined && current.claimedBy !== workerId)
        throw conflict(`Run ${id} is held by another worker`);
      if (current.status !== to && !canTransition(current.status, to))
        throw conflict(`Illegal run transition ${current.status} -> ${to}`);

      const releases = isTerminal(to) || to === "waiting-for-question" || to === "waiting-for-approval";
      const rows = await sql.query<Row>(
        `UPDATE runs
            SET status      = $3,
                error       = COALESCE($4::jsonb, error),
                finished_at = CASE WHEN $5 THEN $6::timestamptz ELSE finished_at END,
                claimed_by       = CASE WHEN $7 THEN NULL ELSE claimed_by END,
                lease_expires_at = CASE WHEN $7 THEN NULL ELSE lease_expires_at END
          WHERE tenant_id = $1
            AND id = $2
            -- Re-check the status we based the legality decision on, so a concurrent transition
            -- cannot slip between the read and this write.
            AND status = $8
          RETURNING *`,
        [
          tenantId,
          id,
          to,
          error === undefined ? null : JSON.stringify(error),
          isTerminal(to),
          now,
          releases,
          current.status,
        ],
      );
      const row = rows[0];
      // Lost the race: another worker moved the run between our read and our write.
      if (!row) throw conflict(`Run ${id} changed status concurrently; transition to ${to} abandoned`);
      return toRun(row);
    },

    /** Durable cancel request. Idempotent — the first timestamp wins — and a no-op once terminal. */
    async requestCancel({ tenantId, id, now }) {
      const rows = await sql.query<Row>(
        `UPDATE runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, $3::timestamptz)
          WHERE tenant_id = $1 AND id = $2 AND status NOT IN ${TERMINAL_SQL}
          RETURNING *`,
        [tenantId, id, now],
      );
      const row = rows[0];
      // No row updated ⇒ either missing or already terminal. The port returns the run as-is for a
      // terminal run and null when it does not exist, so fall back to a read.
      return row ? toRun(row) : await read(tenantId, id);
    },

    /**
     * Recovery candidates: running runs whose lease expired. Cross-tenant by design — a background
     * reaper has no tenant — so each row carries its own `tenantId` for re-claim, and the supporting
     * index is deliberately not tenant-leading.
     */
    async reapExpired({ now, limit }) {
      const rows = await sql.query<Row>(
        `SELECT * FROM runs
          WHERE status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= $1::timestamptz
          ORDER BY lease_expires_at
          LIMIT $2`,
        [now, limit],
      );
      return rows.map(toRun);
    },
  };
};
