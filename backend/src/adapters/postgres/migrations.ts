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
  {
    // #95 — the resume point a recovered worker restarts from.
    //
    // Keyed per run, NOT per sequence. The port documents `save` as overwriting the run's checkpoint
    // and `latest(runId)` is the only read, so a (tenant_id, run_id, sequence) key would store a row
    // per agent-loop step on a table nothing reads historically — run_events-shaped growth with no
    // reader. One slot per run, upserted, matching the reference adapter.
    //
    // `step` is the agent-loop index (an integer bounded by ExecutionLimits.maxSteps), not text.
    //
    // ON DELETE CASCADE: deleting a run must not be able to leave an orphan checkpoint, and nothing
    // that deletes a run should have to know checkpoints exist. RESTRICT would make run deletion
    // fail while a checkpoint lives, which is strictly worse.
    id: "0004_checkpoints",
    up: [
      `CREATE TABLE IF NOT EXISTS checkpoints (
        tenant_id  text        NOT NULL,
        run_id     text        NOT NULL,
        sequence   integer     NOT NULL,
        step       integer     NOT NULL,
        state      jsonb       NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, run_id),
        CONSTRAINT checkpoints_run_fk
          FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT checkpoints_counters_non_negative CHECK (sequence >= 0 AND step >= 0)
      )`,
    ],
    down: [`DROP TABLE IF EXISTS checkpoints`],
  },
  {
    // #96 — the conversation itself: its messages, the agent manifests, and the binding that says
    // which agent version owns a thread.
    id: "0005_messages_agents",
    up: [
      `CREATE TABLE IF NOT EXISTS messages (
        tenant_id       text        NOT NULL,
        id              text        NOT NULL,
        conversation_id text        NOT NULL,
        run_id          text,
        role            text        NOT NULL,
        parts           jsonb       NOT NULL,
        created_at      timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT messages_conversation_fk
          FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
          ON DELETE CASCADE
      )`,
      // The composite ordering the stable cursor pages on. `id` breaks ties, which is what makes
      // paging safe under concurrent inserts sharing a created_at — a timestamp alone would let a
      // row slip between pages.
      `CREATE INDEX IF NOT EXISTS messages_tenant_conversation_created_idx
        ON messages (tenant_id, conversation_id, created_at, id)`,
      // One row per version: a thread pinned to v1 must still resolve v1 after v2 is registered.
      // Tenant-leading — this is the store whose in-memory version leaked across tenants (#91).
      `CREATE TABLE IF NOT EXISTS agents (
        tenant_id  text        NOT NULL,
        id         text        NOT NULL,
        version    integer     NOT NULL,
        manifest   jsonb       NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, id, version),
        CONSTRAINT agents_version_positive CHECK (version > 0)
      )`,
      // agent_version_policy was absent from the SPEC. Without it a binding cannot express what it
      // exists to express, and agent_version is NULL for a 'latest' binding — hence nullable, with a
      // constraint tying the two together instead of leaving the pair free to contradict itself.
      //
      // No foreign key to `agents`: a 'latest' binding carries no version, so a composite
      // (agent_id, agent_version) reference cannot be enforced for it, and binding to an agent whose
      // manifest is not yet registered is legitimate.
      `CREATE TABLE IF NOT EXISTS conversation_bindings (
        tenant_id            text        NOT NULL,
        conversation_id      text        NOT NULL,
        agent_id             text        NOT NULL,
        agent_version_policy text        NOT NULL,
        agent_version        integer,
        bound_at             timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, conversation_id),
        CONSTRAINT conversation_bindings_conversation_fk
          FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
          ON DELETE CASCADE,
        CONSTRAINT conversation_bindings_policy_check
          CHECK (agent_version_policy IN ('pinned', 'latest')),
        CONSTRAINT conversation_bindings_pinned_has_version
          CHECK ((agent_version_policy = 'pinned' AND agent_version IS NOT NULL)
              OR (agent_version_policy = 'latest'))
      )`,
    ],
    down: [
      `DROP TABLE IF EXISTS conversation_bindings`,
      `DROP TABLE IF EXISTS agents`,
      `DROP INDEX IF EXISTS messages_tenant_conversation_created_idx`,
      `DROP TABLE IF EXISTS messages`,
    ],
  },
];

export const migrate = async (sql: SqlExecutor): Promise<void> => {
  for (const m of MIGRATIONS) for (const stmt of m.up) await sql.query(stmt);
};

export const rollback = async (sql: SqlExecutor): Promise<void> => {
  for (const m of [...MIGRATIONS].reverse()) for (const stmt of m.down) await sql.query(stmt);
};
