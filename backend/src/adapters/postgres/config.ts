/**
 * PostgreSQL `SkillStore` and `McpConnectionStore` (#101) — tenant configuration.
 *
 * Two things worth stating up front, because both are places the SPEC and the code disagree.
 *
 * **`listCatalog` returns the latest *active* version per name.** That is what the reference adapter
 * does, and the SPEC says nothing about it. The consequence is deliberate: a draft or archived
 * version is invisible to discovery while remaining resolvable by `findVersion`, so a run pinned to
 * an archived version keeps working and no new run picks it up.
 *
 * **A credential is a reference and nothing else.** `McpAuth` has no field capable of holding a
 * secret value, and this table has no column that could either. That is the whole guarantee — and it
 * is stronger than the pattern-matching constraint the SPEC proposed, which could not distinguish a
 * reference from a secret in the general case.
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { SkillId, TenantId } from "../../core/ids.js";
import { validateEndpoint, type EgressPolicy } from "../../mcp/egress.js";
import type { McpAuth, McpServerConnection, McpTransport } from "../../mcp/index.js";
import type { McpConnectionStore } from "../../mcp/provider.js";
import type { SkillStore } from "../../persistence/index.js";
import { validateSkillInput } from "../../skills/resolver.js";
import type { SkillCatalogEntry, SkillSource, SkillStatus, SkillVersion } from "../../skills/index.js";
import type { SqlExecutor } from "./sql.js";

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// ---------------------------------------------------------------------------------------- skills

type SkillRow = {
  tenant_id: string;
  id: string;
  name: string;
  description: string;
  source: string;
  version: number;
  instructions: string;
  status: string;
  created_at: string | Date;
  created_by: string | null;
};

const toSkill = (r: SkillRow): SkillVersion => ({
  id: r.id as SkillId,
  name: r.name,
  description: r.description,
  source: r.source as SkillSource,
  version: Number(r.version),
  instructions: r.instructions,
  status: r.status as SkillStatus,
  tenantId: r.tenant_id as TenantId,
  createdAt: iso(r.created_at),
  ...(r.created_by === null ? {} : { createdBy: r.created_by }),
});

const SKILL_COLUMNS = `tenant_id, id, name, description, source, version, instructions, status,
         created_at, created_by`;

export const createPostgresSkillStore = (
  sql: SqlExecutor,
): SkillStore & { add(tenantId: string, skill: SkillVersion): Promise<void> } => ({
  /**
   * Validated before the write, with the same function the reference adapter uses, so the two agree
   * on what is storable rather than only on the happy path. The schema repeats the same bounds as
   * CHECK constraints for the path that bypasses this method entirely.
   */
  async add(tenantId, skill) {
    validateSkillInput(skill);
    await sql.query(
      `INSERT INTO skills
         (tenant_id, id, name, description, source, version, instructions, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)
       ON CONFLICT (tenant_id, name, version) DO UPDATE
          SET id = excluded.id,
              description = excluded.description,
              source = excluded.source,
              instructions = excluded.instructions,
              status = excluded.status,
              created_at = excluded.created_at,
              created_by = excluded.created_by`,
      [
        tenantId,
        skill.id,
        skill.name,
        skill.description,
        skill.source,
        skill.version,
        skill.instructions,
        skill.status,
        skill.createdAt,
        skill.createdBy ?? null,
      ],
    );
  },

  async listCatalog({ tenantId }) {
    // Latest active version per name. DISTINCT ON is the direct expression of that, and it reads off
    // the partial index rather than sorting the tenant's whole skill history.
    //
    // Bodies are deliberately not selected: `SkillCatalogEntry` is documented as what discovery puts
    // in context, and pulling 20k-character instructions into a catalog listing would defeat the
    // lazy-loading the split exists for (AC-5).
    const rows = await sql.query<{
      id: string;
      name: string;
      description: string;
      source: string;
      version: number;
    }>(
      `SELECT DISTINCT ON (name) id, name, description, source, version
         FROM skills
        WHERE tenant_id = $1 AND status = 'active'
        ORDER BY name, version DESC`,
      [tenantId],
    );
    return rows.map<SkillCatalogEntry>((r) => ({
      id: r.id as SkillId,
      name: r.name,
      description: r.description,
      source: r.source as SkillSource,
      version: Number(r.version),
    }));
  },

  async findVersion({ tenantId, name, version }) {
    // Exact version, never the nearest: a run records the version it used, and resolving to a
    // neighbour would silently change behaviour on replay.
    const rows = await sql.query<SkillRow>(
      `SELECT ${SKILL_COLUMNS} FROM skills
        WHERE tenant_id = $1 AND name = $2 AND version = $3`,
      [tenantId, name, version],
    );
    const row = rows[0];
    return row ? toSkill(row) : null;
  },
});

// ----------------------------------------------------------------------------------------- MCP

type ConnectionRow = {
  id: string;
  tenant_id: string;
  label: string;
  transport: string;
  endpoint: string;
  auth_kind: string;
  auth_credential_ref: string | null;
  enabled: boolean;
  created_at: string | Date;
  last_handshake_at: string | Date | null;
  last_error: string | null;
};

/** Rebuilds the discriminated union from the two columns the pairing CHECK keeps consistent. */
const toAuth = (kind: string, ref: string | null): McpAuth => {
  if (kind === "bearer" || kind === "oauth") {
    // Unreachable while the pairing constraint holds; throwing rather than defaulting because a
    // bearer connection with no reference would otherwise fail later, at handshake, far from here.
    if (ref === null) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `MCP auth kind ${kind} is missing its credential reference`,
        retryable: false,
      });
    }
    return { kind, credentialRef: ref };
  }
  return { kind: "none" };
};

const toConnection = (r: ConnectionRow): McpServerConnection => ({
  id: r.id,
  tenantId: r.tenant_id as TenantId,
  label: r.label,
  transport: r.transport as McpTransport,
  endpoint: r.endpoint,
  auth: toAuth(r.auth_kind, r.auth_credential_ref),
  enabled: r.enabled,
  createdAt: iso(r.created_at),
  ...(r.last_handshake_at === null ? {} : { lastHandshakeAt: iso(r.last_handshake_at) }),
  ...(r.last_error === null ? {} : { lastError: r.last_error }),
});

const CONNECTION_COLUMNS = `id, tenant_id, label, transport, endpoint, auth_kind,
         auth_credential_ref, enabled, created_at, last_handshake_at, last_error`;

/**
 * The egress policy is a constructor parameter, not a column — it is a deployment-level rule rather
 * than per-connection data, which is why the SPEC's `egress_policy jsonb` had nothing to populate it.
 * What survives a restart is the connection; the policy comes from whatever store is built at boot.
 */
export const createPostgresMcpConnectionStore = (
  sql: SqlExecutor,
  egress: EgressPolicy,
): McpConnectionStore => ({
  async register({ tenantId, connection }) {
    // Validated at registration and again at handshake by the client. Registration is the cheaper
    // place to refuse, and it stops a policy-violating endpoint from ever being persisted.
    validateEndpoint(egress, connection.transport, connection.endpoint);
    if (connection.tenantId !== tenantId) {
      throw new AgentPlatformError({
        code: "forbidden",
        message: "connection tenant mismatch",
        retryable: false,
      });
    }
    const ref = connection.auth.kind === "none" ? null : connection.auth.credentialRef;
    await sql.query(
      `INSERT INTO mcp_connections
         (tenant_id, id, label, transport, endpoint, auth_kind, auth_credential_ref,
          enabled, created_at, last_handshake_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11)
       ON CONFLICT (tenant_id, id) DO UPDATE
          SET label = excluded.label,
              transport = excluded.transport,
              endpoint = excluded.endpoint,
              auth_kind = excluded.auth_kind,
              auth_credential_ref = excluded.auth_credential_ref,
              enabled = excluded.enabled,
              created_at = excluded.created_at,
              last_handshake_at = excluded.last_handshake_at,
              last_error = excluded.last_error`,
      [
        tenantId,
        connection.id,
        connection.label,
        connection.transport,
        connection.endpoint,
        connection.auth.kind,
        ref,
        connection.enabled,
        connection.createdAt,
        connection.lastHandshakeAt ?? null,
        connection.lastError ?? null,
      ],
    );
  },

  async get({ tenantId, id }) {
    const rows = await sql.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM mcp_connections WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toConnection(row) : null;
  },

  async list({ tenantId }) {
    const rows = await sql.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM mcp_connections WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows.map(toConnection);
  },

  async setEnabled({ tenantId, id, enabled }) {
    // Silent on a missing connection, matching the reference adapter: disabling something absent has
    // already achieved its purpose.
    await sql.query(`UPDATE mcp_connections SET enabled = $3 WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      id,
      enabled,
    ]);
  },
});
