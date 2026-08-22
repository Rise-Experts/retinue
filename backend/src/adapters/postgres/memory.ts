/**
 * PostgreSQL `PrincipalMemoryStore` and `BlobStore` (#102) — per-user memory and the tool-output
 * offload. Completes the Postgres column at 19/19.
 *
 * Per-user memory is the feature most visibly broken by memory-only storage: a user says "remember
 * this" and it is gone after the next deploy. Two properties carry the weight, and both are enforced
 * in the statement rather than by convention:
 *
 * - **Cross-principal isolation is structural.** Every method takes `principalId` and every statement
 *   filters on it as part of the primary key. There is no method that *could* read across principals,
 *   which is a stronger guarantee than a policy that each query remembers to apply.
 * - **A disabled entry is never a retrieval candidate.** `retrieve` filters `disabled_at IS NULL`, and
 *   the index it reads is partial on the same predicate — an index cannot return what it does not
 *   contain. A user switching a memory off and having it still shape answers is the failure this
 *   prevents, and it is a privacy failure, not a correctness nicety.
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { BlobRef } from "../../core/ids.js";
import type { BlobStore } from "../../persistence/index.js";
import type {
  PrincipalMemoryEntry,
  PrincipalMemoryStore,
} from "../../principal-memory/index.js";
import type { SqlExecutor } from "./sql.js";

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const notFound = (id: string) =>
  new AgentPlatformError({ code: "not_found", message: `Memory ${id} not found`, retryable: false });
const conflict = (m: string) => new AgentPlatformError({ code: "conflict", message: m, retryable: false });

const json = <T>(value: unknown): T => (typeof value === "string" ? (JSON.parse(value) as T) : (value as T));

type MemoryRow = {
  tenant_id: string;
  principal_id: string;
  id: string;
  text: string;
  tags: unknown;
  salience: number;
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
  disabled_at: string | Date | null;
};

const toEntry = (r: MemoryRow): PrincipalMemoryEntry => ({
  id: r.id,
  tenantId: r.tenant_id,
  principalId: r.principal_id,
  text: r.text,
  tags: json<readonly string[]>(r.tags) ?? [],
  salience: Number(r.salience),
  version: Number(r.version),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  ...(r.disabled_at === null ? {} : { disabledAt: iso(r.disabled_at) }),
});

const MEMORY_COLUMNS = `tenant_id, principal_id, id, text, tags, salience, version,
         created_at, updated_at, disabled_at`;

export const createPostgresPrincipalMemoryStore = (
  sql: SqlExecutor,
  options: { readonly clock?: () => string } = {},
): PrincipalMemoryStore => {
  const clock = options.clock ?? (() => new Date().toISOString());

  return {
    async put({ tenantId, principalId, id, text, tags, salience }) {
      const now = clock();
      // Version incremented and created_at preserved server-side, matching the reference adapter.
      // Doing it in the statement means two concurrent puts on one id cannot both compute version 2.
      const rows = await sql.query<MemoryRow>(
        `INSERT INTO principal_memory
           (tenant_id, principal_id, id, text, tags, salience, version, created_at, updated_at)
         VALUES ($1, $2, COALESCE($3, 'mem-' || nextval('blob_ref_seq')), $4, $5::jsonb, $6, 1,
                 $7::timestamptz, $7::timestamptz)
         ON CONFLICT (tenant_id, principal_id, id) DO UPDATE
            SET text       = excluded.text,
                tags       = excluded.tags,
                salience   = excluded.salience,
                version    = principal_memory.version + 1,
                updated_at = excluded.updated_at
         RETURNING ${MEMORY_COLUMNS}`,
        [
          tenantId,
          principalId,
          id ?? null,
          text,
          JSON.stringify(tags ?? []),
          salience ?? 1,
          now,
        ],
      );
      const row = rows[0];
      // Unreachable: the upsert always returns a row. Throwing rather than returning a fabricated
      // entry, because a caller that thinks a memory was stored when it was not is worse than an error.
      if (!row) throw conflict(`Could not store memory for ${principalId}`);
      return toEntry(row);
    },

    async get({ tenantId, principalId, id }) {
      const rows = await sql.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM principal_memory
          WHERE tenant_id = $1 AND principal_id = $2 AND id = $3`,
        [tenantId, principalId, id],
      );
      const row = rows[0];
      return row ? toEntry(row) : null;
    },

    async list({ tenantId, principalId, limit, cursor }) {
      // Keyset on (created_at, id): the cursor names a row, and paging resumes strictly after it, so
      // a concurrent put cannot shift a page boundary the way an OFFSET would.
      const rows = await sql.query<MemoryRow>(
        `WITH anchor AS (
           SELECT created_at, id FROM principal_memory
            WHERE tenant_id = $1 AND principal_id = $2 AND id = $3
         )
         SELECT ${MEMORY_COLUMNS} FROM principal_memory
          WHERE tenant_id = $1 AND principal_id = $2
            AND ($3::text IS NULL
                 OR (created_at, id) > ((SELECT created_at FROM anchor), (SELECT id FROM anchor)))
          ORDER BY created_at, id
          LIMIT $4`,
        [tenantId, principalId, cursor ?? null, limit + 1],
      );
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(toEntry);
      const last = items[items.length - 1];
      const page: Page<PrincipalMemoryEntry> = hasMore && last ? { items, nextCursor: last.id } : { items };
      return page;
    },

    async update({ tenantId, principalId, id, expectedVersion, patch }) {
      // The version guard is in the WHERE clause, so a stale write matches no row rather than
      // overwriting a newer one. COALESCE leaves an omitted patch field untouched.
      //
      // `disabled` is three-valued on the way in: undefined leaves it alone, true stamps now, false
      // clears it. Expressed as a CASE because COALESCE cannot distinguish "set to null" from "leave".
      const rows = await sql.query<MemoryRow>(
        `UPDATE principal_memory
            SET text        = COALESCE($5, text),
                tags        = COALESCE($6::jsonb, tags),
                salience    = COALESCE($7, salience),
                disabled_at = CASE
                                WHEN $8::boolean IS NULL THEN disabled_at
                                WHEN $8::boolean THEN $9::timestamptz
                                ELSE NULL
                              END,
                version     = version + 1,
                updated_at  = $9::timestamptz
          WHERE tenant_id = $1 AND principal_id = $2 AND id = $3 AND version = $4
          RETURNING ${MEMORY_COLUMNS}`,
        [
          tenantId,
          principalId,
          id,
          expectedVersion,
          patch.text ?? null,
          patch.tags === undefined ? null : JSON.stringify(patch.tags),
          patch.salience ?? null,
          patch.disabled ?? null,
          clock(),
        ],
      );
      const row = rows[0];
      if (row) return toEntry(row);

      // No row: either it does not exist, or the version was stale. The distinction is the caller's
      // next move — retry with a fresh read, versus stop.
      const current = await this.get({ tenantId, principalId, id });
      if (!current) throw notFound(id);
      throw conflict(`Memory ${id} version ${expectedVersion} is stale (current ${current.version})`);
    },

    async delete({ tenantId, principalId, id }) {
      // Hard delete, as the port documents: a deleted entry cannot resurface in a later prompt. A
      // soft delete would leave the text on disk after a user asked for it to be gone.
      await sql.query(
        `DELETE FROM principal_memory WHERE tenant_id = $1 AND principal_id = $2 AND id = $3`,
        [tenantId, principalId, id],
      );
    },

    async retrieve({ tenantId, principalId, query, limit }) {
      const q = query?.trim();
      // Active only, matched against text or any tag, most salient first.
      //
      // `strpos` on lowercased text, deliberately **not** `ILIKE '%' || $3 || '%'`. Binding the query
      // as a parameter stops SQL injection but does nothing about `LIKE` metacharacters: a query of
      // "%" would still be a wildcard and return every memory the principal has. The reference
      // adapter uses `String.includes`, which is literal, so ILIKE also made the two adapters
      // disagree. `strpos` is a literal substring search and matches `includes` exactly.
      //
      // Neither form can use an index for a leading-wildcard search, so nothing is lost by it — see
      // the open question on #102 about whether substring matching is the intended semantics at all.
      const rows = await sql.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM principal_memory
          WHERE tenant_id = $1
            AND principal_id = $2
            AND disabled_at IS NULL
            AND ($3::text IS NULL
                 OR strpos(lower(text), lower($3::text)) > 0
                 OR EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(tags) AS t(tag)
                       WHERE strpos(lower(tag), lower($3::text)) > 0
                    ))
          ORDER BY salience DESC, created_at, id
          LIMIT $4`,
        [tenantId, principalId, q === undefined || q === "" ? null : q, limit],
      );
      return rows.map(toEntry);
    },
  };
};

/**
 * The tool-output offload. Stores the **value**, because that is what the port does: `put(value)`
 * returns a ref and `get(ref)` must hand the value back. The `blob_refs` metadata-and-pointer table
 * the SPEC described cannot implement this — there is nothing in the port to fetch bytes with — and
 * belongs to `FileMetadataStore` (#129) or `ArtifactStore` (#133) instead.
 */
export const createPostgresBlobStore = (sql: SqlExecutor): BlobStore => ({
  async put({ tenantId, value }) {
    // The ref is generated in-statement from a sequence, so it is durable and unique without a
    // read-then-write. The reference adapter's process-local counter would, after a restart, hand out
    // a ref that already belongs to someone else's value.
    const rows = await sql.query<{ ref: string }>(
      `INSERT INTO blobs (tenant_id, ref, value)
       VALUES ($1, 'blob:' || $1 || ':' || nextval('blob_ref_seq'), $2::jsonb)
       RETURNING ref`,
      [tenantId, JSON.stringify(value ?? null)],
    );
    const row = rows[0];
    if (!row) throw conflict(`Could not store a blob for ${tenantId}`);
    return asId<BlobRef>(row.ref);
  },

  async get({ tenantId, ref }) {
    // Tenant-scoped by primary key, so a ref from one tenant cannot resolve another's value even if
    // it is guessed or leaked — the port's docstring calls that out specifically.
    const rows = await sql.query<{ value: unknown }>(
      `SELECT value FROM blobs WHERE tenant_id = $1 AND ref = $2`,
      [tenantId, ref],
    );
    const row = rows[0];
    return row === undefined ? null : json<unknown>(row.value);
  },
});
