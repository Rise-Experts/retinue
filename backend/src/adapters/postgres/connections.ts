/**
 * `ConnectionStore` over Postgres — task #261.
 *
 * Pure SQL over `SqlExecutor`, like every other adapter here. The store never sees a plaintext secret: it
 * writes the four columns of a `SealedSecret` and reads them back, so an adapter cannot leak something it does
 * not have.
 *
 * Every query is tenant-scoped in its `WHERE`, and there is no `findById(id)` — governing principle 1. That is
 * not belt-and-braces over RLS; it is the layer RLS is defence in depth *for*, and #91 is the reminder that a
 * method accepting a tenant scope and not using it typechecks perfectly.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { TenantScope } from "../../core/context.js";
import type {
  Connection,
  ConnectionId,
  ConnectionInput,
  ConnectionPatch,
  ConnectionStore,
} from "../../connections/index.js";
import type { AuthMode, CredentialScheme } from "../../tools/credentials.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  readonly id: string;
  readonly kind: string;
  readonly provider: string;
  readonly label: string | null;
  readonly mode: string;
  readonly scheme: string;
  readonly metadata: Record<string, string> | null;
  readonly granted_scopes: string[] | null;
  readonly secret_key_id: string;
  readonly secret_algorithm: string;
  readonly secret_nonce: string;
  readonly secret_ciphertext: string;
  readonly expires_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly revoked_at: Date | string | null;
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value);

const toConnection = (row: Row): Connection => ({
  id: row.id,
  kind: row.kind as never,
  provider: row.provider,
  ...(row.label === null ? {} : { label: row.label }),
  mode: row.mode as AuthMode,
  scheme: row.scheme as CredentialScheme,
  ...(row.metadata === null || Object.keys(row.metadata).length === 0 ? {} : { metadata: row.metadata }),
  ...(row.granted_scopes === null ? {} : { grantedScopes: row.granted_scopes }),
  sealed: {
    keyId: row.secret_key_id,
    algorithm: row.secret_algorithm,
    nonce: row.secret_nonce,
    ciphertext: row.secret_ciphertext,
  },
  ...(row.expires_at === null ? {} : { expiresAt: iso(row.expires_at) }),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) }),
});

const COLUMNS = `id, kind, provider, label, mode, scheme, metadata, granted_scopes,
  secret_key_id, secret_algorithm, secret_nonce, secret_ciphertext,
  expires_at, created_at, updated_at, revoked_at`;

const notFound = (id: ConnectionId): AgentPlatformError =>
  new AgentPlatformError({ code: "not_found", message: `no connection "${id}" for this tenant`, retryable: false });

export const createPostgresConnectionStore = (sql: SqlExecutor): ConnectionStore => ({
  async create({ tenantId, connection }: TenantScope & { connection: ConnectionInput }) {
    const rows = await sql.query<Row>(
      `INSERT INTO connections (
         tenant_id, id, kind, provider, label, mode, scheme, metadata, granted_scopes,
         secret_key_id, secret_algorithm, secret_nonce, secret_ciphertext, expires_at
       ) VALUES ($1,$2,$14,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
       -- No upsert: a second create for the same id is a caller bug, and silently overwriting a credential is
       -- the worst possible resolution of it.
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        connection.id,
        connection.provider,
        connection.label ?? null,
        connection.mode,
        connection.scheme,
        JSON.stringify(connection.metadata ?? {}),
        connection.grantedScopes === undefined ? null : [...connection.grantedScopes],
        connection.sealed.keyId,
        connection.sealed.algorithm,
        connection.sealed.nonce,
        connection.sealed.ciphertext,
        connection.expiresAt ?? null,
        connection.kind ?? "connection",
      ],
    );
    const row = rows[0];
    if (row === undefined)
      throw new AgentPlatformError({ code: "conflict", message: `connection "${connection.id}" already exists`, retryable: false });
    return toConnection(row);
  },

  async get({ tenantId, id, kind }) {
    // `revoked_at IS NULL` here rather than in the caller: a revoked connection reading as present is how a
    // withdrawn credential gets used once more.
    const rows = await sql.query<Row>(
      // `kind` in the predicate, not filtered afterwards: a caller that did not ask for an app registration
      // must not receive one, and a post-filter is a place somebody later removes.
      `SELECT ${COLUMNS} FROM connections
       WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND kind = $3`,
      [tenantId, id, kind ?? "connection"],
    );
    return rows[0] === undefined ? null : toConnection(rows[0]);
  },

  async list({ tenantId, provider, kind }) {
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM connections
       WHERE tenant_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR provider = $2) AND kind = $3
       ORDER BY created_at, id`,
      [tenantId, provider ?? null, kind ?? "connection"],
    );
    return rows.map(toConnection);
  },

  async update({ tenantId, id, patch }: TenantScope & { id: ConnectionId; patch: ConnectionPatch }) {
    /**
     * `COALESCE` per column, so an absent field means "leave it" rather than "set it to null".
     *
     * The alternative — building the SET list from the present keys — is how a patch with no fields becomes
     * invalid SQL, and how a field named in one place and not another silently stops being updatable.
     */
    const rows = await sql.query<Row>(
      `UPDATE connections SET
         label = COALESCE($3, label),
         secret_key_id = COALESCE($4, secret_key_id),
         secret_algorithm = COALESCE($5, secret_algorithm),
         secret_nonce = COALESCE($6, secret_nonce),
         secret_ciphertext = COALESCE($7, secret_ciphertext),
         metadata = COALESCE($8::jsonb, metadata),
         granted_scopes = COALESCE($9, granted_scopes),
         expires_at = COALESCE($10, expires_at),
         updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        id,
        patch.label ?? null,
        patch.sealed?.keyId ?? null,
        patch.sealed?.algorithm ?? null,
        patch.sealed?.nonce ?? null,
        patch.sealed?.ciphertext ?? null,
        patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
        patch.grantedScopes === undefined ? null : [...patch.grantedScopes],
        patch.expiresAt ?? null,
      ],
    );
    if (rows[0] === undefined) throw notFound(id);
    return toConnection(rows[0]);
  },

  async revoke({ tenantId, id }) {
    const rows = await sql.query<{ id: string }>(
      `UPDATE connections SET revoked_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [tenantId, id],
    );
    if (rows[0] !== undefined) return;
    // Idempotent: already revoked is success, so a retried disconnect need not distinguish it from a failure.
    const existing = await sql.query<{ id: string }>(
      `SELECT id FROM connections WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (existing[0] === undefined) throw notFound(id);
  },

  async purge({ tenantId }) {
    // The one hard delete — `docs/18`. A soft-deleted credential is still a credential.
    const rows = await sql.query<{ id: string }>(`DELETE FROM connections WHERE tenant_id = $1 RETURNING id`, [tenantId]);
    return rows.length;
  },
});
