/**
 * Postgres `FileMetadataStore` (#129).
 *
 * Metadata only. `FileContentStore` has no Postgres implementation and is classified `notApplicable` in the
 * conformance matrix, because a relational adapter holding file bytes means base64 in a column — the
 * antipattern #102 rejected when it declined to make `blobs` a pointer table.
 *
 * Two properties are in the SQL rather than above it, for the reason every other adapter here puts them
 * there: a check the caller performs is a check a second caller can skip.
 *
 * - **`transition` is a compare-and-set in the statement**, `WHERE state = $from`, so two workers racing a
 *   resumed upload and a conversation delete cannot both succeed. `rowCount` is the answer.
 * - **Deletion is scheduled, not cascaded.** The foreign key is `ON DELETE RESTRICT`: a cascade would drop
 *   the metadata and leave the bytes, which is exactly the orphan this design exists to avoid.
 */

import { AgentPlatformError } from "../../core/errors.js";
import { asId } from "../../core/ids.js";
import type { ConversationId, FileId, PrincipalId } from "../../core/ids.js";
import type { Page } from "../../core/context.js";
import type { BlobRef } from "../../core/ids.js";
import type {
  FileExtraction,
  FileMetadata,
  FileMetadataStore,
  FileState,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  id: string;
  conversation_id: string;
  filename: string;
  media_type: string;
  byte_size: string | number;
  content_key: string;
  checksum: string | null;
  state: string;
  uploaded_by: string;
  created_at: string | Date;
  deleted_at: string | Date | null;
  extraction_state: string | null;
  extraction_ref: string | null;
  extraction_failure_reason: string | null;
  extraction_failure_message: string | null;
  extraction_pages: number | string | null;
  extraction_blocks: number | string | null;
  extraction_truncated: boolean | null;
  extraction_confidence: number | string | null;
  extracted_at: string | Date | null;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

const toFile = (r: Row): FileMetadata => ({
  id: asId<FileId>(r.id),
  conversationId: asId<ConversationId>(r.conversation_id),
  filename: r.filename,
  mediaType: r.media_type,
  // `bigint` comes back as a string from node-postgres, which is correct for values past 2^53 and wrong
  // for arithmetic. A file size is well inside the safe range, so it is narrowed here rather than left as
  // a string a caller would have to remember to convert.
  byteSize: Number(r.byte_size),
  contentKey: r.content_key,
  ...(r.checksum === null ? {} : { checksum: r.checksum }),
  state: r.state as FileState,
  uploadedBy: asId<PrincipalId>(r.uploaded_by),
  createdAt: iso(r.created_at),
  ...(r.deleted_at === null ? {} : { deletedAt: iso(r.deleted_at) }),
  // Absent rather than a record with a null state: "nothing has tried to extract this" and "extraction is
  // pending" are different facts, and the column being null is how the first one is spelled.
  ...(r.extraction_state === null
    ? {}
    : {
        extraction: {
          state: r.extraction_state as FileExtraction["state"],
          ...(r.extraction_ref === null ? {} : { ref: asId<BlobRef>(r.extraction_ref) }),
          ...(r.extraction_failure_reason === null ? {} : { failureReason: r.extraction_failure_reason }),
          ...(r.extraction_failure_message === null ? {} : { failureMessage: r.extraction_failure_message }),
          ...(r.extraction_pages === null ? {} : { pageCount: Number(r.extraction_pages) }),
          ...(r.extraction_blocks === null ? {} : { blockCount: Number(r.extraction_blocks) }),
          ...(r.extraction_truncated === null ? {} : { truncated: r.extraction_truncated }),
          ...(r.extraction_confidence === null ? {} : { confidence: Number(r.extraction_confidence) }),
          ...(r.extracted_at === null ? {} : { at: iso(r.extracted_at) }),
        },
      }),
});

const COLUMNS = `id, conversation_id, filename, media_type, byte_size, content_key, checksum, state,
                 uploaded_by, created_at, deleted_at, extraction_state, extraction_ref,
                 extraction_failure_reason, extraction_failure_message, extraction_pages,
                 extraction_blocks, extraction_truncated, extraction_confidence, extracted_at`;

/**
 * Keyset cursor on `(created_at, id)`.
 *
 * The same encoding the other Postgres stores use. An offset cursor shifts when a row is inserted, so a
 * caller paging a conversation's files while one uploads either sees a file twice or misses one.
 */
const encodeCursor = (f: FileMetadata): string =>
  Buffer.from(`${f.createdAt} ${f.id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): { createdAt: string; id: string } | null => {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split(" ");
  return createdAt === undefined || id === undefined ? null : { createdAt, id };
};

const page = (rows: readonly Row[], limit: number): Page<FileMetadata> => {
  // One row over the limit is fetched, so "is there more" is answered by its presence rather than by a
  // second COUNT that could disagree with the page it describes.
  const items = rows.slice(0, limit).map(toFile);
  const last = items[items.length - 1];
  return rows.length > limit && last !== undefined
    ? { items, nextCursor: encodeCursor(last) }
    : { items };
};

export const createPostgresFileMetadataStore = (sql: SqlExecutor): FileMetadataStore => ({
  async create({ tenantId, file }) {
    const rows = await sql.query<{ id: string }>(
      `INSERT INTO files (tenant_id, id, conversation_id, filename, media_type, byte_size,
                          content_key, checksum, state, uploaded_by, created_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       -- Nothing is updated on conflict: a duplicate id is a caller bug, and quietly overwriting the
       -- existing row would repoint a file at different bytes.
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        file.id,
        file.conversationId,
        file.filename,
        file.mediaType,
        file.byteSize,
        file.contentKey,
        file.checksum ?? null,
        file.state,
        file.uploadedBy,
        file.createdAt,
        file.deletedAt ?? null,
      ],
    );
    if (rows.length === 0)
      throw new AgentPlatformError({
        code: "conflict",
        message: `file ${file.id} already exists`,
        retryable: false,
      });
  },

  async get({ tenantId, id }) {
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM files WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    // A foreign id yields no row, so it is null without a comparison anyone could get wrong.
    return rows[0] === undefined ? null : toFile(rows[0]);
  },

  async listByConversation({ tenantId, conversationId, limit, cursor }) {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM files
        WHERE tenant_id = $1 AND conversation_id = $2
          -- Live rows only: this is what a user sees, and a soft-deleted row here would be a deleted
          -- attachment coming back. 'deleting' is excluded as well as 'deleted', because deletion is
          -- scheduled before the bytes go and a file listed in between is one a read would fail on.
          AND deleted_at IS NULL AND state NOT IN ('deleting','deleted')
          AND ($3::text IS NULL OR (created_at, id) > ($3::timestamptz, $4::text))
        ORDER BY created_at, id
        LIMIT $5`,
      [tenantId, conversationId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );
    return page(rows, limit);
  },

  async transition({ tenantId, id, from, to, at, checksum }) {
    const rows = await sql.query<{ id: string }>(
      `UPDATE files
          SET state = $4,
              checksum = COALESCE($5, checksum),
              -- Soft delete is a property of reaching 'deleted', so a row can never be deleted without a
              -- time. The schema's CHECK says the same thing, twice on purpose.
              deleted_at = CASE WHEN $4 = 'deleted' THEN $6::timestamptz ELSE deleted_at END
        WHERE tenant_id = $1 AND id = $2
          -- The compare, in the statement. A read-then-write would let a conversation delete land between
          -- the two and leave a 'stored' file whose bytes are scheduled for removal -- and nothing sweeps
          -- a stored file's object.
          AND state = $3
        RETURNING id`,
      [tenantId, id, from, to, checksum ?? null, at],
    );
    return { moved: rows.length > 0 };
  },

  async scheduleConversationDeletion({ tenantId, conversationId, at }) {
    const rows = await sql.query<{ id: string }>(
      `UPDATE files
          SET state = 'deleting', deleted_at = $3::timestamptz
        WHERE tenant_id = $1 AND conversation_id = $2
          -- 'pending' as well as 'stored': an upload in flight when the conversation is deleted must not
          -- complete into a conversation that no longer exists, and moving it here is what makes its own
          -- transition to 'stored' fail.
          AND state IN ('stored','pending')
        RETURNING id`,
      [tenantId, conversationId, at],
    );
    // One statement rather than a list and a loop: a file uploaded between the two would be missed, and
    // missed silently.
    return { scheduled: rows.length };
  },

  async recordExtraction({ tenantId, id, extraction }) {
    const rows = await sql.query<{ id: string }>(
      `UPDATE files
          SET extraction_state = $3,
              extraction_ref = $4,
              extraction_failure_reason = $5,
              extraction_failure_message = $6,
              extraction_pages = $7,
              extraction_blocks = $8,
              extraction_truncated = $9,
              extraction_confidence = $10,
              extracted_at = $11::timestamptz
        -- No compare on the previous extraction state, unlike transition(). A worker retrying after a crash
        -- does not know what it wrote before the crash, and requiring it to would make recovery impossible.
        WHERE tenant_id = $1 AND id = $2
        RETURNING id`,
      [
        tenantId,
        id,
        extraction.state,
        extraction.ref ?? null,
        extraction.failureReason ?? null,
        extraction.failureMessage ?? null,
        extraction.pageCount ?? null,
        extraction.blockCount ?? null,
        extraction.truncated ?? null,
        extraction.confidence ?? null,
        extraction.at ?? null,
      ],
    );
    // Zero rows means the file is gone -- a conversation deleted while extraction ran. An ordinary race, so
    // it is reported rather than thrown; a worker that threw would retry it forever.
    return { recorded: rows.length > 0 };
  },

  async listByExtractionState({ tenantId, state, olderThan, limit, cursor }) {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM files
        WHERE tenant_id = $1
          -- A file nothing has touched has a NULL state, and that is the same fact as 'pending': the row is
          -- waiting. Coalescing here is what lets this query find the files a lost enqueue dropped, which is
          -- the whole reason the method exists.
          AND COALESCE(extraction_state, 'pending') = $2
          AND created_at < $3::timestamptz
          AND ($4::text IS NULL OR (created_at, id) > ($4::timestamptz, $5::text))
        ORDER BY created_at, id
        LIMIT $6`,
      [tenantId, state, olderThan, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );
    return page(rows, limit);
  },

  async listByState({ tenantId, state, olderThan, limit, cursor }) {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM files
        WHERE tenant_id = $1 AND state = $2
          -- Strictly older, so a file that entered the state a second ago is an upload in progress rather
          -- than an orphan. Without it the job reports every upload happening while it runs.
          AND created_at < $3::timestamptz
          AND ($4::text IS NULL OR (created_at, id) > ($4::timestamptz, $5::text))
        ORDER BY created_at, id
        LIMIT $6`,
      [tenantId, state, olderThan, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );
    return page(rows, limit);
  },
});
