/**
 * Postgres `ArtifactExportStore` (#134).
 *
 * One property is in the SQL rather than above it: **`claim` is an insert that loses gracefully.**
 * `ON CONFLICT DO NOTHING` against `UNIQUE (tenant_id, artifact_id, version, format)` means two concurrent
 * requests for the same PDF cannot both claim it, whatever the application layer believes — and the loser
 * reads the winner's row rather than erroring, because its next move is the same either way.
 */

import { asId } from "../../core/ids.js";
import type { ArtifactId, FileId, PrincipalId } from "../../core/ids.js";
import type { Page } from "../../core/context.js";
import type {
  ArtifactExport,
  ArtifactExportStore,
  ExportFormat,
  ExportState,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  id: string;
  artifact_id: string;
  version: number | string;
  format: string;
  state: string;
  file_id: string | null;
  byte_size: number | string | null;
  checksum: string | null;
  failure_reason: string | null;
  failure_message: string | null;
  requested_by: string;
  created_at: string | Date;
  rendered_at: string | Date | null;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

const toExport = (r: Row): ArtifactExport => ({
  id: r.id,
  artifactId: asId<ArtifactId>(r.artifact_id),
  version: Number(r.version),
  format: r.format as ExportFormat,
  state: r.state as ExportState,
  ...(r.file_id === null ? {} : { fileId: asId<FileId>(r.file_id) }),
  // `bigint` comes back as a string from node-postgres, correct past 2^53 and wrong for arithmetic. An
  // export is well inside the safe range, so it is narrowed here rather than left for a caller.
  ...(r.byte_size === null ? {} : { byteSize: Number(r.byte_size) }),
  ...(r.checksum === null ? {} : { checksum: r.checksum }),
  ...(r.failure_reason === null ? {} : { failureReason: r.failure_reason }),
  ...(r.failure_message === null ? {} : { failureMessage: r.failure_message }),
  requestedBy: asId<PrincipalId>(r.requested_by),
  createdAt: iso(r.created_at),
  ...(r.rendered_at === null ? {} : { renderedAt: iso(r.rendered_at) }),
});

const COLUMNS = `id, artifact_id, version, format, state, file_id, byte_size, checksum,
                 failure_reason, failure_message, requested_by, created_at, rendered_at`;

const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt} ${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): { createdAt: string; id: string } | null => {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split(" ");
  return createdAt === undefined || id === undefined ? null : { createdAt, id };
};

export const createPostgresArtifactExportStore = (sql: SqlExecutor): ArtifactExportStore => ({
  async claim({ tenantId, export: requested }) {
    const inserted = await sql.query<Row>(
      `INSERT INTO artifact_exports (tenant_id, id, artifact_id, version, format, state,
                                     requested_by, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)
       -- The claim. Against the unique constraint, so two concurrent requests for the same export cannot both
       -- proceed to render -- and the loser gets zero rows rather than an error it would have to interpret.
       ON CONFLICT (tenant_id, artifact_id, version, format) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        requested.id,
        requested.artifactId,
        requested.version,
        requested.format,
        requested.requestedBy,
        requested.createdAt,
      ],
    );
    const created = inserted[0];
    if (created !== undefined) return { claimed: true, export: toExport(created) };

    const existing = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM artifact_exports
        WHERE tenant_id = $1 AND artifact_id = $2 AND version = $3 AND format = $4`,
      [tenantId, requested.artifactId, requested.version, requested.format],
    );
    const row = existing[0];
    if (row === undefined)
      // Deleted between the insert and this read. Treated as a fresh claim rather than thrown, because the
      // caller has nothing better to do and rendering again is correct.
      return { claimed: true, export: { ...requested, state: "pending" } };
    return { claimed: false, export: toExport(row) };
  },

  async complete({ tenantId, id, state, fileId, byteSize, checksum, failureReason, failureMessage, at }) {
    const rows = await sql.query<{ id: string }>(
      `UPDATE artifact_exports
          SET state = $3,
              file_id = $4,
              byte_size = $5,
              checksum = $6,
              failure_reason = $7,
              failure_message = $8,
              rendered_at = $9::timestamptz
        -- No compare on the previous state: a worker retrying after a crash does not know what it wrote, and
        -- requiring it to would make recovery impossible.
        WHERE tenant_id = $1 AND id = $2
        RETURNING id`,
      [
        tenantId,
        id,
        state,
        fileId ?? null,
        byteSize ?? null,
        checksum ?? null,
        failureReason ?? null,
        failureMessage ?? null,
        at,
      ],
    );
    return { recorded: rows.length > 0 };
  },

  async get({ tenantId, id }) {
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM artifact_exports WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    // A foreign id yields no row, so it is null without a comparison anyone could get wrong.
    return rows[0] === undefined ? null : toExport(rows[0]);
  },

  async find({ tenantId, artifactId, version, format }) {
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM artifact_exports
        WHERE tenant_id = $1 AND artifact_id = $2 AND version = $3 AND format = $4`,
      [tenantId, artifactId, version, format],
    );
    return rows[0] === undefined ? null : toExport(rows[0]);
  },

  async listByArtifact({ tenantId, artifactId, limit, cursor }) {
    // Keyset on `(created_at, id)`, matching the ORDER BY. An earlier version cursored on `id` alone while
    // ordering by both, which is a cursor that does not describe the sequence it pages -- the page would skip
    // or repeat rows whenever two exports shared a timestamp, which for two formats requested together is the
    // normal case rather than a rare one.
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM artifact_exports
        WHERE tenant_id = $1 AND artifact_id = $2
          AND ($3::text IS NULL OR (created_at, id) > ($3::timestamptz, $4::text))
        ORDER BY created_at, id
        LIMIT $5`,
      [tenantId, artifactId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map(toExport);
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: encodeCursor(last.createdAt, last.id) }
      : ({ items } satisfies Page<ArtifactExport>);
  },
});
