/**
 * PostgreSQL `MessageStore`, `AgentStore` and `ConversationBindingStore` (#96) — the stores that make
 * a conversation durable rather than a thing that exists until the next deploy.
 *
 * Paging uses the same `(created_at, id)` composite cursor as `createPostgresConversationStore`. That
 * pairing is the whole of AC-2: a timestamp alone lets a concurrently-inserted row sharing the same
 * `created_at` slip between pages, and `OFFSET` shifts every subsequent page when a row lands early.
 * The `id` tiebreak plus a keyset comparison makes the sequence stable while the conversation is
 * still being written to.
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type { Message } from "../../core/content-parts.js";
import type { AgentManifest } from "../../agents/index.js";
import type { AgentId, ConversationId, MessageId, RunId, TenantId } from "../../core/ids.js";
import type {
  AgentStore,
  ConversationBinding,
  ConversationBindingStore,
  MessageStore,
} from "../../persistence/index.js";
import { parseMessagePart } from "../../core/validation.js";
import type { SqlExecutor } from "./sql.js";

type MessageRow = {
  tenant_id: string;
  id: string;
  conversation_id: string;
  run_id: string | null;
  role: string;
  parts: unknown;
  created_at: string | Date;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const invalid = (message: string) =>
  new AgentPlatformError({ code: "invalid_input", message, retryable: false });

/**
 * Validate on read. A hand-edited or half-migrated `parts` column otherwise flows into a client's
 * stream, where the failure surfaces far from its cause — so the error names the message that carries
 * the bad payload (AC-5).
 */
const toMessage = (r: MessageRow): Message => {
  const stored = typeof r.parts === "string" ? JSON.parse(r.parts) : r.parts;
  if (!Array.isArray(stored)) throw invalid(`Message ${r.id} has a non-array parts column`);
  // There is no whole-message validator, so each part goes through `parseMessagePart`. Wrapping the
  // failure keeps the message id in the error — otherwise a bad row reports only "invalid part" and
  // leaves you grepping a table for it (AC-5).
  let parts;
  try {
    parts = stored.map(parseMessagePart);
  } catch (cause) {
    throw invalid(`Message ${r.id} has an invalid stored part: ${(cause as Error).message}`);
  }
  return {
    id: r.id as MessageId,
    conversationId: r.conversation_id as ConversationId,
    ...(r.run_id === null ? {} : { runId: r.run_id as RunId }),
    role: r.role as Message["role"],
    parts,
    createdAt: iso(r.created_at),
  };
};

const encodeCursor = (r: MessageRow): string =>
  Buffer.from(JSON.stringify({ c: iso(r.created_at), i: r.id })).toString("base64");
const decodeCursor = (cursor: string): { c: string; i: string } =>
  JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));

export const createPostgresMessageStore = (
  sql: SqlExecutor,
): MessageStore => ({
  /**
   * On the port as of #157, no longer a "test-only affordance".
   *
   * The signature changed from `(tenantId, message)` to the object form every other port method uses — a
   * positional pair was the shape a test-only helper could get away with, and it is the wrong shape for
   * something callers depend on.
   *
   * Messages stay immutable: `DO NOTHING` on conflict, no update, no delete. Editing one would rewrite history a
   * client has already streamed and a model has already been shown, and a repeat of the same id is a retry
   * rather than an error.
   */
  async append({ tenantId, message }) {
    await sql.query(
      `INSERT INTO messages (tenant_id, id, conversation_id, run_id, role, parts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        tenantId,
        message.id,
        message.conversationId,
        message.runId ?? null,
        message.role,
        JSON.stringify(message.parts),
        message.createdAt,
      ],
    );
  },

  async findById({ tenantId, id }) {
    const rows = await sql.query<MessageRow>(
      `SELECT * FROM messages WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toMessage(row) : null;
  },

  async listByConversation({ tenantId, conversationId, limit, cursor }) {
    const params: unknown[] = [tenantId, conversationId, limit + 1];
    let where = `tenant_id = $1 AND conversation_id = $2`;
    if (cursor) {
      const { c, i } = decodeCursor(cursor);
      // Keyset, not OFFSET: strictly after (created_at, id), so an insert landing earlier in the
      // ordering cannot shift this page or duplicate a row into the next one.
      where += ` AND (created_at, id) > ($4::timestamptz, $5)`;
      params.push(c, i);
    }
    const rows = await sql.query<MessageRow>(
      `SELECT * FROM messages WHERE ${where} ORDER BY created_at, id LIMIT $3`,
      params,
    );
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toMessage);
    const last = hasMore ? rows[limit - 1] : undefined;
    const page: Page<Message> = last ? { items, nextCursor: encodeCursor(last) } : { items };
    return page;
  },
});

type AgentRow = { manifest: unknown };

export const createPostgresAgentStore = (
  sql: SqlExecutor,
): AgentStore & { put(tenantId: string, manifest: AgentManifest): Promise<void> } => ({
  async put(tenantId, manifest) {
    await sql.query(
      `INSERT INTO agents (tenant_id, id, version, manifest, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now(), now())
       ON CONFLICT (tenant_id, id, version) DO UPDATE
          SET manifest = excluded.manifest, updated_at = now()`,
      [tenantId, manifest.id, manifest.version, JSON.stringify(manifest)],
    );
  },

  async findByVersion({ tenantId, agentId, version }) {
    // Tenant-scoped, unlike the in-memory adapter before #91 fixed it: a manifest is owned by the
    // tenant that registered it, and the key leads with tenant_id so a cross-tenant read is a miss.
    const rows = await sql.query<AgentRow>(
      `SELECT manifest FROM agents WHERE tenant_id = $1 AND id = $2 AND version = $3`,
      [tenantId, agentId, version],
    );
    const row = rows[0];
    if (!row) return null;
    return (typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest) as AgentManifest;
  },
});

type BindingRow = {
  conversation_id: string;
  agent_id: string;
  agent_version_policy: string;
  agent_version: number | null;
};

const toBinding = (r: BindingRow): ConversationBinding => ({
  conversationId: r.conversation_id as ConversationId,
  agentId: r.agent_id as AgentId,
  agentVersionPolicy: r.agent_version_policy as ConversationBinding["agentVersionPolicy"],
  // Absent rather than null for a `latest` binding: the type makes it optional, and a null here
  // would round-trip as a present-but-empty version.
  ...(r.agent_version === null ? {} : { agentVersion: r.agent_version }),
});

export const createPostgresConversationBindingStore = (sql: SqlExecutor): ConversationBindingStore => ({
  async bind({ tenantId, conversationId, agentId, agentVersionPolicy, agentVersion }) {
    // Idempotent by conversation: re-binding is a legitimate operation (an agent upgrade), not a
    // conflict, so the last write wins rather than erroring.
    await sql.query(
      `INSERT INTO conversation_bindings
         (tenant_id, conversation_id, agent_id, agent_version_policy, agent_version, bound_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id, conversation_id) DO UPDATE
          SET agent_id             = excluded.agent_id,
              agent_version_policy = excluded.agent_version_policy,
              agent_version        = excluded.agent_version,
              bound_at             = excluded.bound_at`,
      [tenantId, conversationId, agentId, agentVersionPolicy, agentVersion ?? null],
    );
  },

  async get({ tenantId, conversationId }) {
    const rows = await sql.query<BindingRow>(
      `SELECT conversation_id, agent_id, agent_version_policy, agent_version
         FROM conversation_bindings WHERE tenant_id = $1 AND conversation_id = $2`,
      [tenantId, conversationId],
    );
    const row = rows[0];
    return row ? toBinding(row) : null;
  },
});

export type { MessageId, RunId, TenantId };
