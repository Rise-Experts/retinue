/**
 * File bytes in Postgres — REQ-036 (#185).
 *
 * The platform had two content stores: in-memory, which loses everything on restart and is not shared between
 * the API and the worker, and Supabase Storage, which needs a Supabase project. So a deployment running plain
 * Postgres and Redis — the arrangement the example and the Nest service both use — could not accept an
 * attachment at all. That is what made the multimodal path unreachable in practice rather than in principle.
 *
 * ## `bytea`, and when that is the wrong answer
 *
 * Bytes in a row are not how anyone should store a hundred megabytes: TOAST compresses and out-of-lines them, so
 * a large object costs a second read and sits in the same backup, the same replication stream and the same
 * connection memory as the data you actually query. This adapter exists because "no object storage" is a real
 * deployment shape and "no attachments" is a worse answer, not because a database is a good filesystem.
 *
 * `signedUrl` therefore returns `null` — deliberately, and it is the honest answer rather than a gap. There is no
 * URL that reaches a row without going through this process, so reads are proxied through `readFile` and the
 * caller streams them. An adapter that returned a URL it could not actually sign would be worse than one that
 * says it cannot.
 *
 * ## What the port demands and this respects
 *
 * `maxBytes` is enforced **while reading**, and nothing is written when it is passed. The declared size is a
 * claim; the cap is the defence. Buffering to the cap and then refusing keeps the failure bounded, and inserting
 * a partial row would leave an orphan on every oversized upload — precisely what reconciliation then has to hunt.
 */

import { createHash } from "node:crypto";
import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type { FileContentStore, StoredContent, StoredObject } from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

const int = (value: number | string): number => (typeof value === "number" ? value : Number.parseInt(value, 10));

export const createPostgresFileContentStore = (sql: SqlExecutor): FileContentStore => ({
  async putFile({ tenantId, contentKey, mediaType, bytes, maxBytes }): Promise<StoredContent> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of bytes) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        /**
         * Nothing has been written yet, and that is the point of buffering rather than streaming into the row.
         *
         * A streaming insert would have to either write and then delete — leaving the oversized object in the
         * WAL and briefly readable — or hold an open transaction for the duration of an upload. Buffering to the
         * cap bounds the memory at exactly `maxBytes`, which is the number the caller already agreed to.
         */
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `the file exceeds the ${maxBytes} byte limit`,
          retryable: false,
        });
      }
      chunks.push(chunk);
    }

    const joined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const checksum = createHash("sha256").update(joined).digest("hex");

    /**
     * `ON CONFLICT … DO UPDATE`, not `DO NOTHING`.
     *
     * A content key is minted per upload, so a conflict means a retry of the *same* upload — and the bytes may
     * differ from the first attempt if that attempt was truncated. Keeping the first write would leave a partial
     * object that every later read returns, so the last complete write wins.
     */
    await sql.query(
      `INSERT INTO file_objects (tenant_id, content_key, media_type, byte_size, checksum, bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, content_key)
       DO UPDATE SET media_type = EXCLUDED.media_type, byte_size = EXCLUDED.byte_size,
                     checksum = EXCLUDED.checksum, bytes = EXCLUDED.bytes`,
      [tenantId, contentKey, mediaType, joined.byteLength, checksum, joined],
    );

    return { contentKey, byteSize: joined.byteLength, checksum };
  },

  async readFile({ tenantId, contentKey }) {
    // Tenant in the predicate, always: a content key from one tenant must not resolve another's bytes, and the
    // key is opaque precisely so that guessing one is useless.
    const rows = await sql.query<{ bytes: Buffer | Uint8Array }>(
      `SELECT bytes FROM file_objects WHERE tenant_id = $1 AND content_key = $2`,
      [tenantId, contentKey],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const bytes = Buffer.isBuffer(row.bytes) ? new Uint8Array(row.bytes) : row.bytes;
    return (async function* () {
      yield bytes;
    })();
  },

  /**
   * `null`, because there is no URL that reaches a database row.
   *
   * The port documents this as the answer for an adapter with no signing mechanism, and the caller streams
   * through `readFile` instead. Returning a URL this process would have to serve itself would be a durable URL
   * wearing a signed one's name — the thing #129's AC-6 made structurally impossible.
   */
  async signedUrl() {
    return null;
  },

  async deleteFile({ tenantId, contentKey }) {
    // Idempotent: deleting an absent row affects nothing, and a retried sweep depends on that.
    await sql.query(`DELETE FROM file_objects WHERE tenant_id = $1 AND content_key = $2`, [tenantId, contentKey]);
  },

  async listObjects({ tenantId, prefix, limit, cursor }): Promise<Page<StoredObject>> {
    const take = Math.max(1, Math.min(limit ?? 100, 1_000));
    const rows = await sql.query<{ content_key: string; byte_size: number | string }>(
      `SELECT content_key, byte_size FROM file_objects
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR content_key LIKE $2 || '%')
          AND ($3::text IS NULL OR content_key > $3)
        ORDER BY content_key
        LIMIT $4`,
      [tenantId, prefix ?? null, cursor ?? null, take + 1],
    );

    // One more than asked for, so "there is another page" is a fact rather than an inference from a full page.
    const page = rows.slice(0, take);
    const items: StoredObject[] = page.map((r) => ({ contentKey: r.content_key, byteSize: int(r.byte_size) }));
    return {
      items,
      ...(rows.length > take && page.length > 0 ? { nextCursor: page[page.length - 1]!.content_key } : {}),
    };
  },
});
