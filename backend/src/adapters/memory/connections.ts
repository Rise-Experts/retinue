/**
 * The reference `ConnectionStore` — task #261.
 *
 * The baseline the other adapters are compared against, and the one the conformance suite runs first. It holds
 * `SealedSecret`s exactly as Postgres does: an in-memory adapter that stored plaintext would make the raw-row
 * assertion pass for the wrong reason, and the suite would then be asserting a different guarantee per adapter.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { TenantScope } from "../../core/context.js";
import type { Connection, ConnectionId, ConnectionInput, ConnectionPatch, ConnectionStore } from "../../connections/index.js";

const notFound = (id: ConnectionId): AgentPlatformError =>
  new AgentPlatformError({ code: "not_found", message: `no connection "${id}" for this tenant`, retryable: false });

export const createMemoryConnectionStore = (now: () => string = () => new Date().toISOString()): ConnectionStore => {
  // Keyed by tenant, so a missing tenant filter is a missing map rather than a leak.
  const byTenant = new Map<string, Map<ConnectionId, Connection>>();
  const of = (tenantId: string): Map<ConnectionId, Connection> => {
    const existing = byTenant.get(tenantId);
    if (existing !== undefined) return existing;
    const created = new Map<ConnectionId, Connection>();
    byTenant.set(tenantId, created);
    return created;
  };

  return {
    async create({ tenantId, connection }: TenantScope & { connection: ConnectionInput }) {
      const rows = of(tenantId);
      if (rows.has(connection.id))
        throw new AgentPlatformError({
          code: "conflict",
          message: `connection "${connection.id}" already exists for this tenant`,
          retryable: false,
        });
      const at = now();
      const row: Connection = { ...connection, createdAt: at, updatedAt: at };
      rows.set(connection.id, row);
      return row;
    },

    async get({ tenantId, id, kind }) {
      const row = of(tenantId).get(id);
      // A caller that did not ask for an app registration must not receive one — see `ConnectionKind`.
      if (row !== undefined && (row.kind ?? "connection") !== (kind ?? "connection")) return null;
      // A revoked connection reads as absent. Anything else would let a caller resolve a credential somebody
      // deliberately withdrew.
      return row === undefined || row.revokedAt !== undefined ? null : row;
    },

    async list({ tenantId, provider, kind }) {
      return [...of(tenantId).values()]
        .filter(
          (c) =>
            c.revokedAt === undefined &&
            (provider === undefined || c.provider === provider) &&
            (c.kind ?? "connection") === (kind ?? "connection"),
        )
        .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
    },

    async update({ tenantId, id, patch }: TenantScope & { id: ConnectionId; patch: ConnectionPatch }) {
      const rows = of(tenantId);
      const existing = rows.get(id);
      if (existing === undefined || existing.revokedAt !== undefined) throw notFound(id);
      const updated: Connection = {
        ...existing,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.sealed === undefined ? {} : { sealed: patch.sealed }),
        ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
        ...(patch.grantedScopes === undefined ? {} : { grantedScopes: patch.grantedScopes }),
        ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
        updatedAt: now(),
      };
      rows.set(id, updated);
      return updated;
    },

    async revoke({ tenantId, id }) {
      const rows = of(tenantId);
      const existing = rows.get(id);
      if (existing === undefined) throw notFound(id);
      // Idempotent: revoking twice is not an error, because a caller retrying a disconnect should not have to
      // distinguish "already gone" from "failed".
      if (existing.revokedAt !== undefined) return;
      rows.set(id, { ...existing, revokedAt: now(), updatedAt: now() });
    },

    async purge({ tenantId }) {
      const rows = byTenant.get(tenantId);
      const count = rows?.size ?? 0;
      byTenant.delete(tenantId);
      return count;
    },
  };
};
