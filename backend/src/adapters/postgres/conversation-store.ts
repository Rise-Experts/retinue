/**
 * PostgreSQL `ConversationStore`. Pure SQL over a `SqlExecutor`; verified by the shared
 * conformance harness (the same suite the in-memory adapter passes).
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type { ConversationId, TenantId } from "../../core/ids.js";
import type { Conversation, ConversationStore } from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  tenant_id: string;
  id: string;
  title: string;
  version: number;
  archived_at: string | Date | null;
  deleted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const toConversation = (r: Row): Conversation => ({
  id: r.id as ConversationId,
  tenantId: r.tenant_id as TenantId,
  title: r.title,
  version: r.version,
  ...(r.archived_at === null ? {} : { archivedAt: iso(r.archived_at) }),
  ...(r.deleted_at === null ? {} : { deletedAt: iso(r.deleted_at) }),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const conflict = (m: string) => new AgentPlatformError({ code: "conflict", message: m, retryable: false });
const notFound = (id: string) =>
  new AgentPlatformError({ code: "not_found", message: `Conversation ${id} not found`, retryable: false });

const encodeCursor = (r: Row): string =>
  Buffer.from(JSON.stringify({ c: iso(r.created_at), i: r.id })).toString("base64");
const decodeCursor = (cursor: string): { c: string; i: string } =>
  JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));

/** Monotonic ISO clock, injectable for deterministic ordering in tests. */
const defaultClock = (): (() => string) => {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1, 0, 0, 0, ++n)).toISOString();
};

export const createPostgresConversationStore = (
  sql: SqlExecutor,
  clock: () => string = defaultClock(),
): ConversationStore => ({
  async create({ tenantId, id, title }) {
    const now = clock();
    const rows = await sql.query<Row>(
      `INSERT INTO conversations (tenant_id, id, title, version, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $4)
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING *`,
      [tenantId, id, title, now],
    );
    const row = rows[0];
    if (!row) throw conflict(`Conversation ${id} already exists`);
    return toConversation(row);
  },

  async findById({ tenantId, id }) {
    const rows = await sql.query<Row>(
      `SELECT * FROM conversations WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toConversation(row) : null;
  },

  async list({ tenantId, limit, cursor }) {
    const params: unknown[] = [tenantId, limit + 1];
    let where = `tenant_id = $1 AND deleted_at IS NULL`;
    if (cursor) {
      const { c, i } = decodeCursor(cursor);
      where += ` AND (created_at, id) > ($3, $4)`;
      params.push(c, i);
    }
    const rows = await sql.query<Row>(
      `SELECT * FROM conversations WHERE ${where} ORDER BY created_at, id LIMIT $2`,
      params,
    );
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toConversation);
    const last = hasMore ? rows[limit - 1] : undefined;
    const page: Page<Conversation> = last ? { items, nextCursor: encodeCursor(last) } : { items };
    return page;
  },

  async update({ tenantId, id, expectedVersion, patch }) {
    const changeArchived = patch.archivedAt !== undefined;
    const rows = await sql.query<Row>(
      `UPDATE conversations
         SET title = COALESCE($4, title),
             archived_at = CASE WHEN $5 THEN $6 ELSE archived_at END,
             version = version + 1,
             updated_at = $7
       WHERE tenant_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL
       RETURNING *`,
      [tenantId, id, expectedVersion, patch.title ?? null, changeArchived, patch.archivedAt ?? null, clock()],
    );
    const row = rows[0];
    if (row) return toConversation(row);
    // No row updated: distinguish a missing row from a stale version.
    const exists = await this.findById({ tenantId, id });
    throw exists ? conflict(`Conversation ${id} version ${expectedVersion} is stale`) : notFound(id);
  },

  async softDelete({ tenantId, id }) {
    const now = clock();
    const rows = await sql.query<Row>(
      `UPDATE conversations SET deleted_at = $3, version = version + 1, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id`,
      [tenantId, id, now],
    );
    if (!rows[0]) throw notFound(id);
  },
});
