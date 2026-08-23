/**
 * Postgres `ArtifactStore` (#133).
 *
 * Two properties are in the SQL rather than above it, for the reason every other adapter here puts them
 * there: a check the caller performs is a check a second caller can skip.
 *
 * - **`addVersion` is a compare-and-set in the statement** — `WHERE latest_version = $expected` — so two
 *   concurrent regenerations cannot both become version 2. The `UNIQUE (tenant_id, artifact_id, version)`
 *   constraint says the same thing a second time, at the level where the application cannot be wrong about it.
 * - **Content is a reference and there is no column it could be inlined into.** AC-5 is enforced by the
 *   schema's shape, not by a rule someone follows.
 */

import { AgentPlatformError } from "../../core/errors.js";
import { asId } from "../../core/ids.js";
import type {
  ArtifactId,
  ArtifactVersionId,
  BlobRef,
  ConversationId,
  PrincipalId,
} from "../../core/ids.js";
import type { Page } from "../../core/context.js";
import type {
  Artifact,
  ArtifactKind,
  ArtifactProvenance,
  ArtifactStore,
  ArtifactVersion,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type ArtifactRow = {
  id: string;
  conversation_id: string;
  kind: string;
  name: string;
  latest_version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

type VersionRow = {
  id: string;
  artifact_id: string;
  version: number | string;
  content_ref: string;
  byte_size: number | string;
  checksum: string | null;
  provenance: unknown;
  created_by: string;
  created_at: string | Date;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: asId<ArtifactId>(r.id),
  conversationId: asId<ConversationId>(r.conversation_id),
  kind: r.kind as ArtifactKind,
  name: r.name,
  latestVersion: Number(r.latest_version),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  ...(r.deleted_at === null ? {} : { deletedAt: iso(r.deleted_at) }),
});

const toVersion = (r: VersionRow): ArtifactVersion => ({
  id: asId<ArtifactVersionId>(r.id),
  artifactId: asId<ArtifactId>(r.artifact_id),
  version: Number(r.version),
  contentRef: asId<BlobRef>(r.content_ref),
  // `bigint` comes back as a string from node-postgres, correct past 2^53 and wrong for arithmetic. An
  // artifact's size is well inside the safe range, so it is narrowed here rather than left for a caller to
  // remember.
  byteSize: Number(r.byte_size),
  ...(r.checksum === null ? {} : { checksum: r.checksum }),
  // `jsonb` comes back parsed from node-postgres and as a string from some drivers, so both are handled —
  // a store that assumed one would work in tests and fail on the other.
  provenance: (typeof r.provenance === "string"
    ? JSON.parse(r.provenance)
    : r.provenance) as ArtifactProvenance,
  createdBy: asId<PrincipalId>(r.created_by),
  createdAt: iso(r.created_at),
});

const ARTIFACT_COLUMNS = `id, conversation_id, kind, name, latest_version, created_at, updated_at, deleted_at`;
const VERSION_COLUMNS = `id, artifact_id, version, content_ref, byte_size, checksum, provenance,
                          created_by, created_at`;

const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt} ${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): { createdAt: string; id: string } | null => {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split(" ");
  return createdAt === undefined || id === undefined ? null : { createdAt, id };
};

export const createPostgresArtifactStore = (sql: SqlExecutor): ArtifactStore => ({
  async create({ tenantId, artifact, version }) {
    const rows = await sql.query<ArtifactRow>(
      `INSERT INTO artifacts (tenant_id, id, conversation_id, kind, name, latest_version,
                              created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$6,NULL)
       -- Nothing updated on conflict: a duplicate id is a caller bug, and overwriting would repoint a name
       -- at different content while leaving the old versions attached to it.
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING ${ARTIFACT_COLUMNS}`,
      [tenantId, artifact.id, artifact.conversationId, artifact.kind, artifact.name, artifact.createdAt],
    );
    const created = rows[0];
    if (created === undefined)
      throw new AgentPlatformError({
        code: "conflict",
        message: `artifact ${artifact.id} already exists`,
        retryable: false,
      });

    // Version 1 in the same call. An artifact with no version is not something a reader can resolve, so the
    // state is never observable -- and the FK means this insert cannot precede the row above.
    await sql.query(
      `INSERT INTO artifact_versions (tenant_id, id, artifact_id, version, content_ref, byte_size,
                                      checksum, provenance, created_by, created_at)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        tenantId,
        version.id,
        artifact.id,
        version.contentRef,
        version.byteSize,
        version.checksum ?? null,
        JSON.stringify(version.provenance),
        version.createdBy,
        version.createdAt,
      ],
    );
    return toArtifact(created);
  },

  async addVersion({ tenantId, id, expectedLatestVersion, version }) {
    const bumped = await sql.query<{ latest_version: number | string }>(
      `UPDATE artifacts
          SET latest_version = latest_version + 1, updated_at = $4::timestamptz
        WHERE tenant_id = $1 AND id = $2
          -- The compare, in the statement. Two concurrent regenerations both hold expectedLatestVersion = 1;
          -- exactly one UPDATE matches, and the loser is told so rather than overwriting the winner.
          AND latest_version = $3
          -- A deleted artifact gains no versions: a new version would resurrect it in every listing that
          -- filters on deleted_at through the artifact row.
          AND deleted_at IS NULL
        RETURNING latest_version`,
      [tenantId, id, expectedLatestVersion, version.createdAt],
    );
    const next = bumped[0];
    if (next === undefined) return { added: false };

    const nextVersion = Number(next.latest_version);
    await sql.query(
      `INSERT INTO artifact_versions (tenant_id, id, artifact_id, version, content_ref, byte_size,
                                      checksum, provenance, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        tenantId,
        version.id,
        id,
        nextVersion,
        version.contentRef,
        version.byteSize,
        version.checksum ?? null,
        JSON.stringify(version.provenance),
        version.createdBy,
        version.createdAt,
      ],
    );
    return { added: true, version: nextVersion };
  },

  async get({ tenantId, id }) {
    const rows = await sql.query<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    // A foreign id yields no row, so it is null without a comparison anyone could get wrong.
    return rows[0] === undefined ? null : toArtifact(rows[0]);
  },

  async getVersion({ tenantId, id, version }) {
    const rows = await sql.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM artifact_versions
        WHERE tenant_id = $1 AND artifact_id = $2
          -- The latest when none is asked for. Ordering and LIMIT rather than a join on latest_version, so
          -- this answers correctly even if the denormalised counter were ever wrong.
          AND ($3::integer IS NULL OR version = $3::integer)
        ORDER BY version DESC
        LIMIT 1`,
      [tenantId, id, version ?? null],
    );
    return rows[0] === undefined ? null : toVersion(rows[0]);
  },

  async listByConversation({ tenantId, conversationId, limit, cursor }) {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await sql.query<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts
        WHERE tenant_id = $1 AND conversation_id = $2
          -- Live only: a deleted artifact reappearing here is a deleted document coming back.
          AND deleted_at IS NULL
          AND ($3::text IS NULL OR (created_at, id) > ($3::timestamptz, $4::text))
        ORDER BY created_at, id
        LIMIT $5`,
      [tenantId, conversationId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map(toArtifact);
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: encodeCursor(last.createdAt, last.id) }
      : ({ items } satisfies Page<Artifact>);
  },

  async listVersions({ tenantId, id, limit, cursor }) {
    // Paged on the version number: it is 1-based and contiguous, so it is an exact cursor, and two versions
    // created in the same millisecond would tie under a timestamp keyset -- which for a history is the one
    // place order must not be approximate.
    const after = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
    const rows = await sql.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM artifact_versions
        WHERE tenant_id = $1 AND artifact_id = $2 AND version > $3
        ORDER BY version
        LIMIT $4`,
      [tenantId, id, from, limit + 1],
    );
    const items = rows.slice(0, limit).map(toVersion);
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: String(last.version) }
      : ({ items } satisfies Page<ArtifactVersion>);
  },

  async softDelete({ tenantId, id, at }) {
    const rows = await sql.query<{ id: string }>(
      `UPDATE artifacts
          -- COALESCE, so a retried delete keeps the first timestamp: the answer to "when was this deleted"
          -- must not move every time someone clicks again.
          SET deleted_at = COALESCE(deleted_at, $3::timestamptz), updated_at = $3::timestamptz
        WHERE tenant_id = $1 AND id = $2
        RETURNING id`,
      [tenantId, id, at],
    );
    return { deleted: rows.length > 0 };
  },
});
