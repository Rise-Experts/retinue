/**
 * In-memory MCP connection store — `docs/10`. Tenant-partitioned so one tenant can never see
 * another's connections/tools. Endpoints are egress-validated at registration; a credential is
 * only ever a `credentialRef`, never an inlined secret (structurally enforced by `McpAuth`).
 */

import { AgentPlatformError } from "../../core/errors.js";
import { validateEndpoint, type EgressPolicy } from "../../mcp/egress.js";
import type { McpConnectionStore } from "../../mcp/provider.js";
import type { McpServerConnection } from "../../mcp/index.js";

export const createMemoryMcpConnectionStore = (egress: EgressPolicy): McpConnectionStore => {
  const byTenant = new Map<string, Map<string, McpServerConnection>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  return {
    async register({ tenantId, connection }) {
      // Reject endpoints failing egress at registration (again at handshake by the client).
      validateEndpoint(egress, connection.transport, connection.endpoint);
      if (connection.tenantId !== tenantId)
        throw new AgentPlatformError({ code: "forbidden", message: "connection tenant mismatch", retryable: false });
      tenant(tenantId).set(connection.id, connection);
    },
    async get({ tenantId, id }) {
      return tenant(tenantId).get(id) ?? null;
    },
    async list({ tenantId }) {
      return [...tenant(tenantId).values()];
    },
    async setEnabled({ tenantId, id, enabled }) {
      const c = tenant(tenantId).get(id);
      if (c) tenant(tenantId).set(id, { ...c, enabled });
    },
  };
};
