/**
 * Versioned, reversible migrations. Each `up`/`down` is a list of single statements so any
 * `SqlExecutor` (node-postgres or PGlite) applies them identically. `migrate` applies in order;
 * `rollback` reverses.
 */
import type { SqlExecutor } from "./sql.js";

export type Migration = {
  readonly id: string;
  readonly up: readonly string[];
  readonly down: readonly string[];
};

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_conversations",
    up: [
      `CREATE TABLE IF NOT EXISTS conversations (
        tenant_id   text        NOT NULL,
        id          text        NOT NULL,
        title       text        NOT NULL,
        version     integer     NOT NULL DEFAULT 1,
        archived_at timestamptz,
        deleted_at  timestamptz,
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS conversations_tenant_created_idx
        ON conversations (tenant_id, created_at, id) WHERE deleted_at IS NULL`,
    ],
    down: [`DROP TABLE IF EXISTS conversations`],
  },
  {
    // #93 — durable run lifecycle. Columns mirror the `Run` type in `src/runtime/index.ts`; the
    // SPEC's original list named `attempt`/`claimed_at`/`heartbeat_at`, which do not exist on `Run`.
    // The lease is `keepalive_at` + `lease_expires_at`, and retry attempts live in the retry policy
    // rather than the row.
    id: "0002_runs",
    up: [
      `CREATE TABLE IF NOT EXISTS runs (
        tenant_id           text        NOT NULL,
        id                  text        NOT NULL,
        conversation_id     text        NOT NULL,
        agent_id            text        NOT NULL,
        agent_version       integer     NOT NULL,
        status              text        NOT NULL,
        created_at          timestamptz NOT NULL,
        started_at          timestamptz,
        finished_at         timestamptz,
        error               jsonb,
        claimed_by          text,
        keepalive_at        timestamptz,
        lease_expires_at    timestamptz,
        cancel_requested_at timestamptz,
        PRIMARY KEY (tenant_id, id),
        -- Mirrors RUN_STATUSES (src/runtime/index.ts), which is hyphenated. The GraphQL enum is
        -- underscored; a constraint built from that spelling would reject every waiting-state write.
        CONSTRAINT runs_status_check CHECK (status IN (
          'queued', 'running', 'waiting-for-question', 'waiting-for-approval',
          'retry-pending', 'completed', 'failed', 'cancelled'
        ))
      )`,
      // Conversation history, newest-last, stable under concurrent inserts.
      `CREATE INDEX IF NOT EXISTS runs_tenant_conversation_created_idx
        ON runs (tenant_id, conversation_id, created_at, id)`,
      // The reaper sweep. Deliberately NOT tenant-leading: `reapExpired` is cross-tenant by design
      // (a background reaper has no tenant), so a tenant-first index could not serve it. Partial on
      // 'running' because no other status can hold a live lease.
      `CREATE INDEX IF NOT EXISTS runs_running_lease_idx
        ON runs (lease_expires_at) WHERE status = 'running'`,
    ],
    down: [
      `DROP INDEX IF EXISTS runs_running_lease_idx`,
      `DROP INDEX IF EXISTS runs_tenant_conversation_created_idx`,
      `DROP TABLE IF EXISTS runs`,
    ],
  },
  {
    // #94 — the durable event log behind streaming catch-up and crash recovery.
    //
    // The composite primary key is the load-bearing constraint: it makes a duplicate sequence
    // impossible, which is what turns `append` into the idempotent no-op the port promises (via
    // ON CONFLICT DO NOTHING). It does *not* make gaps impossible — gapless numbering is the
    // emitter's contract, and no schema can compel it.
    //
    // No conversation column: `RunEvent` carries no `conversationId` (see `EventBase` in
    // src/core/events.ts), so the conversation-level index the SPEC suggested cannot be built.
    // Replay is per-run and the primary key serves it directly.
    id: "0003_run_events",
    up: [
      `CREATE TABLE IF NOT EXISTS run_events (
        tenant_id  text        NOT NULL,
        run_id     text        NOT NULL,
        sequence   integer     NOT NULL,
        type       text        NOT NULL,
        event      jsonb       NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, run_id, sequence),
        CONSTRAINT run_events_sequence_positive CHECK (sequence > 0)
      )`,
    ],
    down: [`DROP TABLE IF EXISTS run_events`],
  },
];

export const migrate = async (sql: SqlExecutor): Promise<void> => {
  for (const m of MIGRATIONS) for (const stmt of m.up) await sql.query(stmt);
};

export const rollback = async (sql: SqlExecutor): Promise<void> => {
  for (const m of [...MIGRATIONS].reverse()) for (const stmt of m.down) await sql.query(stmt);
};
