/**
 * PostgreSQL `SessionStateStore` and `ThreadSummaryStore` (#97) — cross-turn working memory and
 * compacted history, the two pieces that replace Agno's fixed 20-turn re-injection.
 *
 * The optimistic-concurrency guard lives in the statement. `put` is one upsert whose `DO UPDATE`
 * carries `WHERE session_state.version = $expectedVersion`; zero rows returned means the caller's
 * version was stale. Read-then-write would reintroduce the lost-update race the `version` column
 * exists to prevent — and two runs on one conversation is not hypothetical, it is precisely what the
 * run coordinator (#98) exists to serialise.
 *
 * Note the deliberate asymmetry with `run_events` (#94): there the *caller* owns the sequence, because
 * it is the client's reconnect cursor. Here the store allocates the version, because `append` takes
 * none and returns the created one. Similar-looking tables, opposite correct answers.
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { ConversationId, MessageId } from "../../core/ids.js";
import { DEFAULT_SESSION_STATE_MAX_BYTES } from "../../persistence/index.js";
import type {
  SessionState,
  SessionStateStore,
  ThreadSummary,
  ThreadSummaryStore,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const conflict = (m: string) => new AgentPlatformError({ code: "conflict", message: m, retryable: false });
const invalid = (m: string) => new AgentPlatformError({ code: "invalid_input", message: m, retryable: false });

type StateRow = {
  conversation_id: string;
  state: unknown;
  version: number;
  updated_at: string | Date;
};

const toSessionState = (r: StateRow): SessionState => ({
  conversationId: r.conversation_id as ConversationId,
  version: r.version,
  data: (typeof r.state === "string" ? JSON.parse(r.state) : r.state) as Readonly<Record<string, unknown>>,
  updatedAt: iso(r.updated_at),
});

export const createPostgresSessionStateStore = (
  sql: SqlExecutor,
  options: { readonly maxBytes?: number } = {},
): SessionStateStore => {
  const maxBytes = options.maxBytes ?? DEFAULT_SESSION_STATE_MAX_BYTES;

  return {
    async get({ tenantId, conversationId }) {
      const rows = await sql.query<StateRow>(
        `SELECT conversation_id, state, version, updated_at
           FROM session_state WHERE tenant_id = $1 AND conversation_id = $2`,
        [tenantId, conversationId],
      );
      const row = rows[0];
      return row ? toSessionState(row) : null;
    },

    async put({ tenantId, conversationId, expectedVersion, data }) {
      const encoded = JSON.stringify(data);
      const bytes = Buffer.byteLength(encoded, "utf8");
      // Checked before the write, and with the same message shape as the reference adapter, so the
      // two agree on what is storable rather than only on the happy path.
      if (bytes > maxBytes) throw invalid(`Session state ${bytes}B exceeds the ${maxBytes}B ceiling`);

      const rows = await sql.query<StateRow>(
        `INSERT INTO session_state (tenant_id, conversation_id, state, version, updated_at)
         VALUES ($1, $2, $3::jsonb, 1, now())
         ON CONFLICT (tenant_id, conversation_id) DO UPDATE
            SET state      = excluded.state,
                version    = session_state.version + 1,
                updated_at = now()
          -- The compare-and-set. A stale expectedVersion matches no row, so the write is refused
          -- rather than silently overwriting a newer value.
          WHERE session_state.version = $4
          RETURNING conversation_id, state, version, updated_at`,
        [tenantId, conversationId, encoded, expectedVersion],
      );
      const row = rows[0];
      if (row) return toSessionState(row);

      // No row: either the caller expected 0 but a row exists (a first write racing a second), or a
      // genuinely stale version. Read to say which, since the distinction is the caller's next move.
      const current = await this.get({ tenantId, conversationId });
      throw conflict(
        `Session state for ${conversationId} version ${expectedVersion} is stale (current ${current?.version ?? 0})`,
      );
    },
  };
};

type SummaryRow = {
  conversation_id: string;
  version: number;
  summary: string;
  covers_up_to_message_id: string;
  created_at: string | Date;
};

const toSummary = (r: SummaryRow): ThreadSummary => ({
  conversationId: r.conversation_id as ConversationId,
  version: r.version,
  summary: r.summary,
  coversUpToMessageId: r.covers_up_to_message_id as MessageId,
  createdAt: iso(r.created_at),
});

export const createPostgresThreadSummaryStore = (sql: SqlExecutor): ThreadSummaryStore => ({
  async latest({ tenantId, conversationId }) {
    const rows = await sql.query<SummaryRow>(
      `SELECT conversation_id, version, summary, covers_up_to_message_id, created_at
         FROM thread_summaries
        WHERE tenant_id = $1 AND conversation_id = $2
        ORDER BY version DESC
        LIMIT 1`,
      [tenantId, conversationId],
    );
    const row = rows[0];
    return row ? toSummary(row) : null;
  },

  async append({ tenantId, conversationId, summary, coversUpToMessageId }) {
    // Version allocated in the INSERT rather than read-then-write, so two concurrent appends cannot
    // both compute the same next version — the primary key would reject the loser, which is the
    // behaviour we want, but computing it in-statement means the winner does not need a retry.
    const rows = await sql.query<SummaryRow>(
      `INSERT INTO thread_summaries
         (tenant_id, conversation_id, version, summary, covers_up_to_message_id, created_at)
       SELECT $1, $2,
              COALESCE(MAX(version), 0) + 1,
              $3, $4, now()
         FROM thread_summaries
        WHERE tenant_id = $1 AND conversation_id = $2
       RETURNING conversation_id, version, summary, covers_up_to_message_id, created_at`,
      [tenantId, conversationId, summary, coversUpToMessageId],
    );
    const row = rows[0];
    // Append is not optional: a caller that asked for a summary and got nothing back would have no
    // way to know its compaction was lost.
    if (!row) throw conflict(`Could not append a thread summary for ${conversationId}`);
    return toSummary(row);
  },
});
