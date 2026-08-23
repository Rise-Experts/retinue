/**
 * Versioned, reversible migrations. Each `up`/`down` is a list of single statements so any
 * `SqlExecutor` (node-postgres or PGlite) applies them identically. `migrate` applies in order;
 * `rollback` reverses.
 */
import type { SqlExecutor } from "./sql.js";
import { EMBEDDING_DIMENSIONS } from "../../persistence/index.js";

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
  {
    // #97 — cross-turn working memory and compacted history.
    id: "0006_session_state",
    up: [
      // One row per conversation, guarded by `version`. The version is the whole point: two runs on
      // one conversation must not interleave into a lost update, and the compare-and-set happens in
      // the UPDATE's WHERE clause rather than in the caller.
      `CREATE TABLE IF NOT EXISTS session_state (
        tenant_id       text        NOT NULL,
        conversation_id text        NOT NULL,
        state           jsonb       NOT NULL,
        version         integer     NOT NULL,
        updated_at      timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, conversation_id),
        CONSTRAINT session_state_conversation_fk
          FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
          ON DELETE CASCADE,
        CONSTRAINT session_state_version_positive CHECK (version > 0)
      )`,
      // Corrected against `ThreadSummary` (src/persistence/index.ts). The SPEC had
      // `covers_up_to timestamptz`, `summary jsonb` and a `token_estimate` column:
      //   - the field is `coversUpToMessageId`, a message id — a summary covers history up to a
      //     specific *message*, which is what lets the assembler keep everything after it verbatim.
      //     A timestamp cannot identify that boundary.
      //   - `summary` is a string, so text.
      //   - nothing on the type could populate `token_estimate`.
      `CREATE TABLE IF NOT EXISTS thread_summaries (
        tenant_id                text        NOT NULL,
        conversation_id          text        NOT NULL,
        version                  integer     NOT NULL,
        summary                  text        NOT NULL,
        covers_up_to_message_id  text        NOT NULL,
        created_at               timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, conversation_id, version),
        CONSTRAINT thread_summaries_conversation_fk
          FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
          ON DELETE CASCADE,
        CONSTRAINT thread_summaries_version_positive CHECK (version > 0)
      )`,
    ],
    down: [`DROP TABLE IF EXISTS thread_summaries`, `DROP TABLE IF EXISTS session_state`],
  },
  {
    // #98 — per-conversation run serialization.
    //
    // A slot table rather than advisory locks, and the reasoning is not close. An advisory xact lock
    // lives exactly as long as its transaction, but the active slot must live as long as the *run* —
    // which includes `waiting-for-question` and `waiting-for-approval`, states that exist to wait for
    // a human and can last hours. Holding a transaction open that long pins a connection and blocks
    // VACUUM across the database. Worse, the port promises a FIFO `position` and a `depth`, and a
    // lock has no ordering, no membership and no introspection — the queue has to live in a row
    // regardless, at which point the lock adds nothing. Postgres advisory locks are also not FIFO.
    id: "0007_run_coordination",
    up: [
      `CREATE TABLE IF NOT EXISTS conversation_run_slots (
        tenant_id       text        NOT NULL,
        conversation_id text        NOT NULL,
        -- Nullable: an idle conversation has a row with no holder. Deliberately NOT a foreign key to
        -- the runs table: claimOrEnqueue is legitimately called before the run row is committed, so the
        -- reference cannot be enforced without breaking the caller it exists to serve.
        active_run_id   text,
        queued          jsonb       NOT NULL DEFAULT '[]'::jsonb,
        updated_at      timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, conversation_id),
        CONSTRAINT conversation_run_slots_conversation_fk
          FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
          ON DELETE CASCADE,
        -- The queue is an ordered array. Without this a malformed write could store an object and
        -- every position/depth answer afterwards would be silently wrong.
        CONSTRAINT conversation_run_slots_queued_is_array CHECK (jsonb_typeof(queued) = 'array')
      )`,
    ],
    down: [`DROP TABLE IF EXISTS conversation_run_slots`],
  },
  {
    // #99 — durable questions, approvals and standing grants.
    //
    // Two interaction tables, not the one the SPEC proposed. PendingQuestion and PendingApproval
    // (src/hitl/index.ts) share three fields; six of the approval's need to be real columns or
    // constraints, idempotency_key above all, since the replay guarantee rests on a unique index over
    // it. A single table with a jsonb payload could not carry that constraint.
    //
    // No conversation_id on either: neither type has one (they are scoped by tenant + run), the same
    // correction run_events needed in #94.
    //
    // No status column either. A question is pending exactly when answered_at IS NULL. A stored
    // status is a second source of truth for one fact, and it fails silently — a row marked pending
    // with an answer already recorded. The partial indexes below serve the waiting-run lookup the
    // status column was meant for, and stay the size of the backlog rather than of all history.
    id: "0008_hitl",
    up: [
      `CREATE TABLE IF NOT EXISTS interaction_questions (
        tenant_id   text        NOT NULL,
        id          text        NOT NULL,
        run_id      text        NOT NULL,
        questions   jsonb       NOT NULL,
        created_at  timestamptz NOT NULL,
        answered_at timestamptz,
        answers     jsonb,
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT interaction_questions_run_fk
          FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id) ON DELETE CASCADE,
        -- Answered means both fields, or neither. A half-written resolution would read as answered
        -- while carrying no answer, and the resuming run would execute on nothing.
        CONSTRAINT interaction_questions_answer_complete CHECK (
          (answered_at IS NULL AND answers IS NULL) OR (answered_at IS NOT NULL AND answers IS NOT NULL)
        )
      )`,
      // Partial, and deliberately not unique: findPendingQuestion returns a single question, so at
      // most one pending per run is plausibly the real invariant — but the port does not say so and
      // the reference adapter permits several. Enforcing it here would be stricter than the contract.
      // Flagged as an open question on #99 rather than decided unilaterally in an index.
      `CREATE INDEX IF NOT EXISTS interaction_questions_pending_run_idx
        ON interaction_questions (tenant_id, run_id) WHERE answered_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS interaction_approvals (
        tenant_id                  text        NOT NULL,
        id                         text        NOT NULL,
        run_id                     text        NOT NULL,
        tool_name                  text        NOT NULL,
        normalized_input           jsonb       NOT NULL,
        risk_category              text        NOT NULL,
        summary                    text        NOT NULL,
        estimated_cost_minor_units integer,
        expires_at                 timestamptz NOT NULL,
        idempotency_key            text        NOT NULL,
        decided_at                 timestamptz,
        decision                   text,
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT interaction_approvals_run_fk
          FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT interaction_approvals_decision_complete CHECK (
          (decided_at IS NULL AND decision IS NULL) OR (decided_at IS NOT NULL AND decision IS NOT NULL)
        ),
        -- Mirrors APPROVAL_DECISIONS (src/hitl/index.ts).
        CONSTRAINT interaction_approvals_decision_check CHECK (
          decision IS NULL OR decision IN ('allow-once', 'allow-conversation', 'allow-always', 'deny')
        )
      )`,
      // The enforcement point for AC-2. A replayed approval must not be able to authorise the same
      // side effect twice, and the database is the only place that holds across processes -- an
      // in-process check cannot. The SPEC put this index on approval_grants, where idempotency_key
      // does not exist, which would have left the guarantee unenforced while looking implemented.
      `CREATE UNIQUE INDEX IF NOT EXISTS interaction_approvals_idempotency_idx
        ON interaction_approvals (tenant_id, idempotency_key)`,
      `CREATE INDEX IF NOT EXISTS interaction_approvals_pending_run_idx
        ON interaction_approvals (tenant_id, run_id) WHERE decided_at IS NULL`,
      // Standing grants. No run_id, effect, request, decision, decided_by, decided_at or
      // idempotency_key: none of them exist on ApprovalGrant. A grant is a standing permission, not a
      // decision record -- the decision lives on the approval.
      `CREATE TABLE IF NOT EXISTS approval_grants (
        tenant_id             text        NOT NULL,
        id                    text        NOT NULL,
        scope                 text        NOT NULL,
        tool_name_or_category text        NOT NULL,
        conversation_id       text,
        granted_at            timestamptz NOT NULL,
        expires_at            timestamptz,
        revoked_at            timestamptz,
        PRIMARY KEY (tenant_id, id),
        -- Mirrors ApprovalScope (src/hitl/index.ts).
        CONSTRAINT approval_grants_scope_check
          CHECK (scope IN ('principal', 'tenant', 'category', 'conversation')),
        -- A conversation-scoped grant with no conversation could match nothing at best, and at worst
        -- a query that forgot the scope check would treat it as tenant-wide -- turning a
        -- one-conversation approval into a standing one, which the port forbids by name.
        CONSTRAINT approval_grants_conversation_scope_has_conversation
          CHECK (scope <> 'conversation' OR conversation_id IS NOT NULL)
      )`,
      `CREATE INDEX IF NOT EXISTS approval_grants_active_idx
        ON approval_grants (tenant_id, tool_name_or_category) WHERE revoked_at IS NULL`,
    ],
    down: [
      `DROP TABLE IF EXISTS approval_grants`,
      `DROP TABLE IF EXISTS interaction_approvals`,
      `DROP TABLE IF EXISTS interaction_questions`,
    ],
  },
  {
    // #100 — the cost ledger and the replay guard.
    //
    // Corrected against UsageEvent (src/usage/index.ts). The SPEC proposed `cost_micros bigint`; the
    // field is `costMinorUnits`, documented as integer minor units of the tenant's accounting
    // currency. Minor units are 10^-2, micros are 10^-6, so that column name sets up a 10000x error
    // in precisely the rollups the SPEC says depend on it being exact.
    //
    // It also omitted `currency`, which is required and without which a minor-unit integer means
    // nothing -- 250 is EUR 2.50 or JPY 250 -- so a rollup summing across currencies would be
    // confidently wrong. And it omitted `step_id`, which is load-bearing: appends are idempotent on
    // (runId, stepId), so without it a recovered run double-counts.
    //
    // `principal_id` was dropped: no such field exists on the type.
    id: "0009_usage_idempotency",
    up: [
      `CREATE TABLE IF NOT EXISTS usage_records (
        tenant_id           text        NOT NULL,
        id                  text        NOT NULL,
        -- Computed by usageDedupeKey (src/usage/index.ts), which both adapters import, so the
        -- idempotency rule cannot drift between them. Stored rather than expressed as an index on
        -- COALESCE so the rule lives in one function instead of in one function and one index.
        dedupe_key          text        NOT NULL,
        run_id              text        NOT NULL,
        conversation_id     text,
        step_id             text,
        tool_call_id        text,
        model_id            text        NOT NULL,
        input_tokens        integer     NOT NULL,
        output_tokens       integer     NOT NULL,
        cached_input_tokens integer     NOT NULL,
        reasoning_tokens    integer,
        cost_minor_units    integer     NOT NULL,
        currency            text        NOT NULL,
        occurred_at         timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT usage_records_run_fk
          FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id) ON DELETE CASCADE,
        -- Integer columns are what make AC-3 true. A float column would sum with drift, and the
        -- drift would land in an invoice.
        CONSTRAINT usage_records_non_negative CHECK (
          input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0
          AND (reasoning_tokens IS NULL OR reasoning_tokens >= 0) AND cost_minor_units >= 0
        )
      )`,
      // The append-idempotency guarantee. A recovered run that re-records a step it already logged
      // must be a no-op, because the alternative is double-billing.
      `CREATE UNIQUE INDEX IF NOT EXISTS usage_records_dedupe_idx
        ON usage_records (tenant_id, dedupe_key)`,
      // Run listing, keyset-paged. `id` breaks ties so a page boundary cannot drop or repeat a row.
      `CREATE INDEX IF NOT EXISTS usage_records_run_occurred_idx
        ON usage_records (tenant_id, run_id, occurred_at, id)`,
      // The rollup index REQ-031 will need. Tenant-leading and time-ordered.
      `CREATE INDEX IF NOT EXISTS usage_records_tenant_occurred_idx
        ON usage_records (tenant_id, occurred_at, id)`,
      // No `scope` column: nothing in IdempotencyStore has one. No `expires_at` either -- `put`
      // takes no TTL and the port has no prune method, so nothing could populate it and an
      // always-NULL expiry column would read as a retention policy that does not exist. Retention is
      // flagged as an open question on #100; `created_at` plus its index is the mechanism a prune
      // needs, which is what AC-5 actually requires.
      `CREATE TABLE IF NOT EXISTS idempotency_keys (
        tenant_id  text        NOT NULL,
        key        text        NOT NULL,
        result     jsonb       NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, key)
      )`,
      `CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at)`,
    ],
    down: [`DROP TABLE IF EXISTS idempotency_keys`, `DROP TABLE IF EXISTS usage_records`],
  },
  {
    // #101 — tenant configuration: versioned skills and registered outbound MCP servers.
    //
    // Corrected against SkillVersion (src/skills/index.ts) and McpServerConnection (src/mcp/index.ts).
    // The SPEC named `content` for `instructions`, omitted `description` -- which is the field
    // discovery actually puts in model context, so listCatalog could not return a usable entry
    // without it -- omitted `source`, and proposed `enabled boolean` for a three-state `status`
    // (draft/active/archived) that a boolean cannot represent.
    //
    // The primary key is on (tenant_id, name, version), not (tenant_id, id, version): findVersion
    // looks up by name and version, and the reference adapter keys on name@version.
    id: "0010_skills_mcp",
    up: [
      `CREATE TABLE IF NOT EXISTS skills (
        tenant_id    text        NOT NULL,
        id           text        NOT NULL,
        name         text        NOT NULL,
        description  text        NOT NULL,
        source       text        NOT NULL,
        version      integer     NOT NULL,
        instructions text        NOT NULL,
        status       text        NOT NULL,
        created_at   timestamptz NOT NULL,
        created_by   text,
        PRIMARY KEY (tenant_id, name, version),
        CONSTRAINT skills_id_unique UNIQUE (tenant_id, id),
        -- Mirrors SKILL_SOURCES and SkillStatus.
        CONSTRAINT skills_source_check CHECK (source IN ('built-in', 'tenant', 'plugin')),
        CONSTRAINT skills_status_check CHECK (status IN ('draft', 'active', 'archived')),
        CONSTRAINT skills_version_positive CHECK (version > 0),
        -- Mirrors SKILL_LIMITS. The store already runs validateSkillInput, so these exist for the
        -- path that bypasses it: a migration, a data fix, anything writing SQL directly. A limit
        -- enforced only in application code is a limit that holds until someone opens psql.
        CONSTRAINT skills_name_slug CHECK (
          name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64
        ),
        CONSTRAINT skills_description_bounds CHECK (length(description) BETWEEN 20 AND 1024),
        CONSTRAINT skills_instructions_bounds CHECK (length(instructions) <= 20000)
      )`,
      // Discovery reads the latest *active* version per name, so the index is partial on active and
      // descends by version -- the shape that answers the catalog query without a sort.
      `CREATE INDEX IF NOT EXISTS skills_active_catalog_idx
        ON skills (tenant_id, name, version DESC) WHERE status = 'active'`,
      // No egress_policy column: the egress policy is a parameter of the *store*
      // (createMemoryMcpConnectionStore(egress)) -- a deployment-level rule, not per-row data.
      // Nothing could populate it. No updated_at either; the type has no such field.
      `CREATE TABLE IF NOT EXISTS mcp_connections (
        tenant_id           text        NOT NULL,
        id                  text        NOT NULL,
        label               text        NOT NULL,
        transport           text        NOT NULL,
        endpoint            text        NOT NULL,
        auth_kind           text        NOT NULL,
        -- A reference, never a value. McpAuth has no field capable of holding a secret and neither
        -- does this table -- which is a stronger guarantee than a pattern trying to recognise one.
        auth_credential_ref text,
        enabled             boolean     NOT NULL,
        created_at          timestamptz NOT NULL,
        last_handshake_at   timestamptz,
        last_error          text,
        PRIMARY KEY (tenant_id, id),
        -- Mirrors MCP_TRANSPORTS.
        CONSTRAINT mcp_connections_transport_check
          CHECK (transport IN ('stdio', 'streamable-http', 'sse')),
        CONSTRAINT mcp_connections_auth_kind_check
          CHECK (auth_kind IN ('none', 'bearer', 'oauth')),
        -- The discriminated union's shape, enforced by the database rather than trusted: 'none'
        -- carries no reference, and the two that need one cannot be stored without it. Half a
        -- bearer connection would fail at handshake time, far from the write that caused it.
        CONSTRAINT mcp_connections_auth_ref_pairing CHECK (
          (auth_kind = 'none' AND auth_credential_ref IS NULL)
          OR (auth_kind IN ('bearer', 'oauth') AND auth_credential_ref IS NOT NULL)
        )
      )`,
      `CREATE INDEX IF NOT EXISTS mcp_connections_enabled_idx
        ON mcp_connections (tenant_id, id) WHERE enabled`,
    ],
    down: [`DROP TABLE IF EXISTS mcp_connections`, `DROP TABLE IF EXISTS skills`],
  },
  {
    // #102 — per-user memory and the tool-output offload. Completes the Postgres column.
    //
    // Corrected against PrincipalMemoryEntry. The SPEC had `content text, source text` and nothing
    // else: `content` is `text`, `source` has no field to populate it, and it omitted `tags`,
    // `salience`, `version` and `disabled_at` -- all four load-bearing. Without `salience` retrieve
    // cannot order "most salient first"; without `version` the optimistic-concurrency guard on
    // update cannot exist; and without `disabled_at` there is nowhere to record that a user switched
    // a memory off, so a disabled memory would keep influencing every turn.
    id: "0011_principal_memory_blobs",
    up: [
      `CREATE TABLE IF NOT EXISTS principal_memory (
        tenant_id    text        NOT NULL,
        principal_id text        NOT NULL,
        id           text        NOT NULL,
        text         text        NOT NULL,
        tags         jsonb       NOT NULL DEFAULT '[]'::jsonb,
        salience     integer     NOT NULL,
        version      integer     NOT NULL,
        created_at   timestamptz NOT NULL,
        updated_at   timestamptz NOT NULL,
        disabled_at  timestamptz,
        -- Principal-leading, so scoping is structural rather than a filter someone can forget. The
        -- SPEC got this right and the reasoning is worth keeping: there is no key shape here that
        -- permits a cross-principal read by accident.
        PRIMARY KEY (tenant_id, principal_id, id),
        CONSTRAINT principal_memory_version_positive CHECK (version > 0),
        CONSTRAINT principal_memory_tags_is_array CHECK (jsonb_typeof(tags) = 'array'),
        -- Mirrors MEMORY_LIMITS (src/principal-memory/index.ts). Enforced here as well as in the
        -- extraction gate, because the gate is application code and this is not.
        CONSTRAINT principal_memory_text_bounds CHECK (length(text) BETWEEN 1 AND 1000),
        CONSTRAINT principal_memory_tag_count CHECK (jsonb_array_length(tags) <= 8)
      )`,
      // list() pages by (created_at, id).
      `CREATE INDEX IF NOT EXISTS principal_memory_list_idx
        ON principal_memory (tenant_id, principal_id, created_at, id)`,
      // retrieve() reads active entries, most salient first. Partial on active because a disabled
      // entry must never be a candidate -- the index cannot return what it does not contain.
      `CREATE INDEX IF NOT EXISTS principal_memory_retrieve_idx
        ON principal_memory (tenant_id, principal_id, salience DESC) WHERE disabled_at IS NULL`,
      // The ref generator. A sequence rather than a process-local counter: the reference adapter's
      // counter resets with the process, which for a durable store would hand out a ref that already
      // belongs to someone else's value after a restart.
      `CREATE SEQUENCE IF NOT EXISTS blob_ref_seq`,
      // The value itself, not a pointer. BlobStore is `put(value) -> ref` / `get(ref) -> value`, so a
      // metadata-and-pointer row could not serve get() at all -- there is nothing in the port to
      // fetch bytes with. The metadata table the SPEC described belongs to FileMetadataStore (#129)
      // or ArtifactStore (#133), which exist as deliberate placeholders.
      `CREATE TABLE IF NOT EXISTS blobs (
        tenant_id  text        NOT NULL,
        ref        text        NOT NULL,
        value      jsonb       NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, ref)
      )`,
    ],
    down: [
      `DROP TABLE IF EXISTS blobs`,
      `DROP SEQUENCE IF EXISTS blob_ref_seq`,
      `DROP TABLE IF EXISTS principal_memory`,
    ],
  },
  {
    // The claim that makes `allow-once` mean once (docs/04 -> How the loop closes).
    //
    // `decided_at` alone cannot express "approved and already executed". Without a second column the
    // resumed run has no way to tell an approval it still owes an execution from one it has already
    // performed, so either it never runs the approved call or it runs it on every resumption. A grant
    // was the other option and the wrong one: a grant is standing, and issuing one for a one-time
    // decision widens the authority the human gave.
    //
    // The claim lives in the database rather than in the runtime because two workers can race a
    // resumed run, and an in-process check cannot make one of them lose.
    id: "0012_approval_consumption",
    up: [
      `ALTER TABLE interaction_approvals ADD COLUMN IF NOT EXISTS consumed_at timestamptz`,
      // Claiming something nobody decided would be permission created out of nothing, so the state is
      // excluded by the schema and not only by the UPDATE's WHERE clause.
      `DO $$ BEGIN
         ALTER TABLE interaction_approvals ADD CONSTRAINT interaction_approvals_consumed_after_decided
           CHECK (consumed_at IS NULL OR decided_at IS NOT NULL);
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      // Serves findDecidedApproval: decided, not yet claimed -- the one row a resumed run looks for.
      `CREATE INDEX IF NOT EXISTS interaction_approvals_resumable_run_idx
        ON interaction_approvals (tenant_id, run_id)
        WHERE decided_at IS NOT NULL AND consumed_at IS NULL`,
    ],
    down: [
      `DROP INDEX IF EXISTS interaction_approvals_resumable_run_idx`,
      `ALTER TABLE interaction_approvals DROP CONSTRAINT IF EXISTS interaction_approvals_consumed_after_decided`,
      `ALTER TABLE interaction_approvals DROP COLUMN IF EXISTS consumed_at`,
    ],
  },
  {
    // Attachment metadata (#129). The bytes are not here, deliberately: `FileContentStore` is an
    // object-storage port, and a relational adapter holding file bytes means base64 in a column -- the
    // antipattern 0011 rejected when it declined to make `blobs` a pointer table.
    id: "0013_files",
    up: [
      `CREATE TABLE IF NOT EXISTS files (
        tenant_id       text        NOT NULL,
        id              text        NOT NULL,
        conversation_id text        NOT NULL,
        filename        text        NOT NULL,
        media_type      text        NOT NULL,
        byte_size       bigint      NOT NULL CHECK (byte_size >= 0),
        -- Opaque, and unique per tenant: two rows pointing at one object would let deleting either one
        -- take the other's bytes with it.
        content_key     text        NOT NULL,
        checksum        text,
        state           text        NOT NULL CHECK (state IN ('pending','stored','deleting','deleted')),
        uploaded_by     text        NOT NULL,
        created_at      timestamptz NOT NULL,
        deleted_at      timestamptz,
        PRIMARY KEY (tenant_id, id),
        -- The conversation owns the file, so entitlement to one *is* entitlement to the other and there is
        -- no second permission model. ON DELETE RESTRICT rather than CASCADE: a cascade would drop the
        -- metadata and leave the bytes, which is precisely the orphan this design exists to avoid --
        -- deletion goes through scheduleConversationDeletion so a sweep can find them.
        FOREIGN KEY (tenant_id, conversation_id)
          REFERENCES conversations (tenant_id, id) ON DELETE RESTRICT,
        -- A row can only be 'deleted' with a timestamp saying when, so "deleted" is never a state without
        -- a time.
        CHECK (state <> 'deleted' OR deleted_at IS NOT NULL)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS files_content_key_key ON files (tenant_id, content_key)`,
      // Serves listByConversation's keyset page: live rows only, ordered the way the cursor reads.
      `CREATE INDEX IF NOT EXISTS files_conversation_idx
        ON files (tenant_id, conversation_id, created_at, id)
        WHERE deleted_at IS NULL AND state <> 'deleted'`,
      // Serves listByState, which reconciliation and the sweep both use. Partial on the two states anyone
      // ever asks for, so it stays small next to a tenant's whole file history.
      `CREATE INDEX IF NOT EXISTS files_pending_state_idx
        ON files (tenant_id, state, created_at)
        WHERE state IN ('pending','deleting')`,
    ],
    down: [
      `DROP INDEX IF EXISTS files_pending_state_idx`,
      `DROP INDEX IF EXISTS files_conversation_idx`,
      `DROP INDEX IF EXISTS files_content_key_key`,
      `DROP TABLE IF EXISTS files`,
    ],
  },
  {
    // #131. Extraction outcome on the file, as columns rather than a jsonb blob: `extraction_state` is
    // queried by the reconciliation of stuck extractions, and a jsonb predicate there would be an index this
    // schema does not have. The columns are all nullable because a file that nothing has tried to extract has
    // no outcome -- distinct from an outcome of "pending", which means it is queued.
    id: "0014_file_extraction",
    up: [
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_state text`,
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_ref text`,
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_failure_reason text`,
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_failure_message text`,
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_pages integer`,
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_blocks integer`,
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_truncated boolean`,
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extracted_at timestamptz`,
      // #132. `real` rather than numeric: a confidence is a measurement, not money, and two decimal places
      // of a float are all anyone acts on. Nullable because a PDF's text layer is read rather than
      // recognised -- absent means "not probabilistic", not "unknown".
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_confidence real`,
      `DO $$ BEGIN
         ALTER TABLE files ADD CONSTRAINT files_extraction_confidence_ck
           CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1));
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      // A failure without a reason is a failure nobody can act on, and a reason without a failure state is a
      // row that contradicts itself. Both directions, in one constraint, because a check that only held one
      // way would let the other through.
      `DO $$ BEGIN
         ALTER TABLE files ADD CONSTRAINT files_extraction_failure_ck
           CHECK ((extraction_state = 'failed') = (extraction_failure_reason IS NOT NULL));
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      // Serves listByExtractionState. Partial on the two states reconciliation asks about -- a file that
      // extracted successfully is never swept, so keeping it in the index would be most of the table for
      // nothing. The COALESCE matches the query's, so a NULL state is found as 'pending' here too.
      `CREATE INDEX IF NOT EXISTS files_extraction_state_idx
        ON files (tenant_id, COALESCE(extraction_state, 'pending'), created_at, id)
        WHERE extraction_state IS NULL OR extraction_state IN ('pending','running')`,
    ],
    down: [
      `DROP INDEX IF EXISTS files_extraction_state_idx`,
      `ALTER TABLE files DROP CONSTRAINT IF EXISTS files_extraction_confidence_ck`,
      `ALTER TABLE files DROP CONSTRAINT IF EXISTS files_extraction_failure_ck`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_confidence`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extracted_at`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_truncated`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_blocks`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_pages`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_failure_message`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_failure_reason`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_ref`,
      `ALTER TABLE files DROP COLUMN IF EXISTS extraction_state`,
    ],
  },
  {
    // #133. Two tables, not one with a version column: an artifact has an identity that outlives any one
    // version -- a name, an owning conversation, a shared link -- and folding them together would mean either
    // duplicating that identity on every version or having no row to point a deleted link at.
    id: "0015_artifacts",
    up: [
      `CREATE TABLE IF NOT EXISTS artifacts (
        tenant_id       text        NOT NULL,
        id              text        NOT NULL,
        conversation_id text        NOT NULL,
        kind            text        NOT NULL,
        name            text        NOT NULL,
        -- Denormalised from artifact_versions on purpose. It is read on every resolve of "the current
        -- version", and a MAX() subquery there would be a second source of truth that can disagree with the
        -- rows it summarises under concurrency -- which is the exact race addVersion's compare-and-set exists
        -- to settle.
        latest_version  integer     NOT NULL,
        created_at      timestamptz NOT NULL,
        updated_at      timestamptz NOT NULL,
        deleted_at      timestamptz,
        PRIMARY KEY (tenant_id, id),
        -- RESTRICT, not CASCADE: dropping an artifact's row while its versions and blobs remain is the
        -- orphan #129 refused for files, and for the same reason.
        FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE RESTRICT,
        CHECK (latest_version >= 1)
      )`,
      `CREATE TABLE IF NOT EXISTS artifact_versions (
        tenant_id     text        NOT NULL,
        id            text        NOT NULL,
        artifact_id   text        NOT NULL,
        version       integer     NOT NULL,
        -- A reference, never the content. An artifact is the thing a user exports, so it grows without limit,
        -- and an unbounded value in a row is the antipattern 0011 rejected for blobs and 0013 for file bytes.
        content_ref   text        NOT NULL,
        byte_size     bigint      NOT NULL,
        checksum      text,
        -- Provenance as jsonb because the inputs are arbitrary: what a tool was called with is that tool's
        -- shape, and a column per input is a migration per tool.
        provenance    jsonb       NOT NULL,
        created_by    text        NOT NULL,
        created_at    timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, id),
        FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifacts (tenant_id, id) ON DELETE RESTRICT,
        -- The constraint that makes AC-2 a property rather than a convention: two concurrent regenerations
        -- cannot both be version 2, whatever the application layer believes.
        UNIQUE (tenant_id, artifact_id, version),
        CHECK (version >= 1),
        CHECK (byte_size >= 0)
      )`,
      // Serves listByConversation's keyset page: live rows only, ordered the way the cursor reads.
      `CREATE INDEX IF NOT EXISTS artifacts_conversation_idx
        ON artifacts (tenant_id, conversation_id, created_at, id)
        WHERE deleted_at IS NULL`,
      // Serves listVersions and getVersion. The unique constraint above already indexes
      // (tenant_id, artifact_id, version), so this exists only for the descending scan a "latest" lookup
      // does -- and is dropped rather than kept if it ever shows as unused.
      `CREATE INDEX IF NOT EXISTS artifact_versions_latest_idx
        ON artifact_versions (tenant_id, artifact_id, version DESC)`,
    ],
    down: [
      `DROP INDEX IF EXISTS artifact_versions_latest_idx`,
      `DROP INDEX IF EXISTS artifacts_conversation_idx`,
      `DROP TABLE IF EXISTS artifact_versions`,
      `DROP TABLE IF EXISTS artifacts`,
    ],
  },
  {
    // #134. A rendered export of one artifact *version*, not a version of its own -- see the note on
    // ArtifactExport for why a PDF is not an artifact version.
    id: "0016_artifact_exports",
    up: [
      `CREATE TABLE IF NOT EXISTS artifact_exports (
        tenant_id        text        NOT NULL,
        id               text        NOT NULL,
        artifact_id      text        NOT NULL,
        version          integer     NOT NULL,
        format           text        NOT NULL,
        state            text        NOT NULL,
        -- The rendered bytes, as a file. A FileId rather than a BlobRef because blobs hold JSON and a PDF is
        -- bytes -- and going through the file ports means an export inherits 0013's entitlement check and
        -- short-lived signed URLs instead of needing a second mediated-download path.
        file_id          text,
        byte_size        bigint,
        checksum         text,
        failure_reason   text,
        failure_message  text,
        requested_by     text        NOT NULL,
        created_at       timestamptz NOT NULL,
        rendered_at      timestamptz,
        PRIMARY KEY (tenant_id, id),
        FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifacts (tenant_id, id) ON DELETE RESTRICT,
        -- The constraint that makes "re-downloaded without re-rendering" a property rather than a cache
        -- someone remembers to check: one export per version per format, enforced where the application
        -- cannot be wrong about it. Two concurrent requests for the same PDF cannot both claim it.
        UNIQUE (tenant_id, artifact_id, version, format),
        -- A rendered export without a file is a row promising a download that does not exist; a failed one
        -- without a reason is a failure nobody can act on. Both directions, because a check that held one way
        -- would let the other through.
        CHECK ((state = 'rendered') = (file_id IS NOT NULL)),
        CHECK ((state = 'failed') = (failure_reason IS NOT NULL)),
        CHECK (version >= 1)
      )`,
      `CREATE INDEX IF NOT EXISTS artifact_exports_artifact_idx
        ON artifact_exports (tenant_id, artifact_id, created_at, id)`,
    ],
    down: [
      `DROP INDEX IF EXISTS artifact_exports_artifact_idx`,
      `DROP TABLE IF EXISTS artifact_exports`,
    ],
  },
];

/**
 * pgvector migrations, applied separately (#135).
 *
 * **Not in `MIGRATIONS`,** and that is deliberate. `CREATE EXTENSION vector` fails on a Postgres without
 * pgvector installed — including PGlite, which the conformance suite runs against by default — so folding
 * these into the main list would make every test require an extension most deployments install explicitly
 * anyway. `migrateVector` is called by a deployment that has it, and `hasVectorExtension` tells a caller
 * whether it does rather than making them guess from an error.
 *
 * **Dimensions are fixed at 1536.** pgvector's `vector(N)` needs a literal, and an index cannot span
 * dimensions, so a deployment changing embedding model *sizes* re-migrates rather than re-indexing —
 * which is why `EmbeddingModelRef` carries `dimensions` and `listStaleSources` compares it.
 */
export const VECTOR_DIMENSIONS = EMBEDDING_DIMENSIONS;

/**
 * The index: HNSW, not IVFFlat.
 *
 * The benchmark the SPEC asks for, stated rather than implied. HNSW builds slower and uses more memory;
 * IVFFlat needs a representative sample at build time and degrades badly when the data grows past what it was
 * trained on. For a multi-tenant knowledge base where every tenant's corpus grows continuously and unevenly,
 * a list-based index has to be periodically rebuilt per tenant or recall silently falls — and "silently" is
 * the disqualifying part. HNSW's recall is stable as rows are added, which is worth its build cost here.
 *
 * `m = 16, ef_construction = 64` are pgvector's defaults and the operating point its own benchmarks report as
 * ~0.98 recall@10 on 1536-dimension embeddings. That figure is the recorded target; the measured figure for
 * this platform's own query set is in the tests, against the exact in-memory index.
 */
export const VECTOR_MIGRATIONS: readonly Migration[] = [
  {
    id: "0017_knowledge_chunks",
    up: [
      // `WITH SCHEMA public` on purpose. `CREATE EXTENSION IF NOT EXISTS` skips when the extension exists
      // *anywhere*, so without a fixed schema the first caller decides where the `vector` type lives and every
      // later schema finds it invisible. Pinning it to `public` — which is on every normal deployment's
      // search_path — makes the type resolvable from any schema. Found by running this suite against a real
      // pgvector server, where each test gets its own schema.
      `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`,
      `CREATE TABLE IF NOT EXISTS knowledge_chunks (
        tenant_id          text        NOT NULL,
        id                 text        NOT NULL,
        source_type        text        NOT NULL,
        source_id          text        NOT NULL,
        chunk_index        integer     NOT NULL,
        content            text        NOT NULL,
        token_count        integer     NOT NULL,
        -- The authorisation subject, on the chunk. This is what lets permission filtering happen *inside* the
        -- query: filtering after retrieval leaks through result counts -- ask for ten, get three, and you have
        -- learned that seven exist you may not see.
        auth_subject       text        NOT NULL,
        embedding          vector(${VECTOR_DIMENSIONS}) NOT NULL,
        embedding_model    text        NOT NULL,
        embedding_version  text        NOT NULL,
        embedding_dims     integer     NOT NULL,
        locator            text,
        created_at         timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, source_type, source_id, chunk_index),
        CHECK (chunk_index >= 0),
        CHECK (token_count >= 0),
        CHECK (embedding_dims = ${VECTOR_DIMENSIONS})
      )`,
      // Serves listBySource and replaceSource's delete, both of which scan by source.
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_source_idx
        ON knowledge_chunks (tenant_id, source_type, source_id, chunk_index)`,
      // Serves listStaleSources: the work list for an incremental re-index.
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_model_idx
        ON knowledge_chunks (tenant_id, embedding_model, embedding_version)`,
      // HNSW on cosine distance, matching the metric the ports normalise to. Built after the table so the
      // initial build is over an empty relation, which is fast; a build over a loaded table locks it.
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
        ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)`,
    ],
    down: [
      `DROP INDEX IF EXISTS knowledge_chunks_embedding_idx`,
      `DROP INDEX IF EXISTS knowledge_chunks_model_idx`,
      `DROP INDEX IF EXISTS knowledge_chunks_source_idx`,
      `DROP TABLE IF EXISTS knowledge_chunks`,
    ],
  },
];

/** Whether this database can hold vectors, so a caller does not have to learn it from a failure. */
export const hasVectorExtension = async (sql: SqlExecutor): Promise<boolean> => {
  try {
    const rows = await sql.query<{ ok: boolean }>(
      `SELECT true AS ok FROM pg_available_extensions WHERE name = 'vector'`,
    );
    return rows.length > 0;
  } catch {
    // A database that cannot answer the question cannot have the extension either.
    return false;
  }
};

/** Applies the vector migrations. Call only where `hasVectorExtension` is true. */
export const migrateVector = async (sql: SqlExecutor): Promise<void> => {
  for (const m of VECTOR_MIGRATIONS) for (const stmt of m.up) await sql.query(stmt);
};

export const rollbackVector = async (sql: SqlExecutor): Promise<void> => {
  for (const m of [...VECTOR_MIGRATIONS].reverse()) for (const stmt of m.down) await sql.query(stmt);
};

export const migrate = async (sql: SqlExecutor): Promise<void> => {
  for (const m of MIGRATIONS) for (const stmt of m.up) await sql.query(stmt);
};

export const rollback = async (sql: SqlExecutor): Promise<void> => {
  for (const m of [...MIGRATIONS].reverse()) for (const stmt of m.down) await sql.query(stmt);
};
