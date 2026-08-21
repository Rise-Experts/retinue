/**
 * In-memory message + agent stores — used by the embedded `createAgent` facade and for tests.
 * Tenant-partitioned. The MessageStore adds an `append` beyond the read-only port so the facade can
 * persist user and assistant turns; AgentStore serves manifests by version.
 */

import type { Message } from "../../core/content-parts.js";
import type { Page } from "../../core/context.js";
import type { AgentManifest } from "../../agents/index.js";
import type { AgentStore, MessageStore } from "../../persistence/index.js";

export const createMemoryMessageStore = (): MessageStore & { append(tenantId: string, message: Message): void } => {
  const byTenant = new Map<string, Message[]>();
  const list = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = []));
    return m;
  };
  return {
    append(tenantId, message) {
      list(tenantId).push(message);
    },
    async findById({ tenantId, id }) {
      return list(tenantId).find((m) => m.id === id) ?? null;
    },
    async listByConversation({ tenantId, conversationId, limit, cursor }) {
      const all = list(tenantId).filter((m) => m.conversationId === conversationId);
      const start = cursor ? all.findIndex((m) => m.id === cursor) + 1 : 0;
      const items = all.slice(start, start + limit);
      const nextCursor = start + limit < all.length ? items[items.length - 1]?.id : undefined;
      const page: Page<Message> = nextCursor === undefined ? { items } : { items, nextCursor };
      return page;
    },
  };
};

/** A manifest and the tenant that owns it. Manifests carry no `tenantId`, so ownership is explicit here. */
export type AgentStoreEntry = {
  readonly tenantId: string;
  readonly manifest: AgentManifest;
};

export const createMemoryAgentStore = (
  entries: readonly AgentStoreEntry[] = [],
): AgentStore & { put(tenantId: string, manifest: AgentManifest): void } => {
  // tenantId → (id@version → manifest). Partitioning by tenant makes cross-tenant reads
  // structurally impossible, matching every sibling store in this package. Keying only by
  // `id@version` let one tenant resolve another's manifest — the leak the #91 harness surfaced.
  const byTenant = new Map<string, Map<string, AgentManifest>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  const key = (id: string, v: number) => `${id}@${v}`;
  const put = (tenantId: string, manifest: AgentManifest) =>
    void tenant(tenantId).set(key(manifest.id, manifest.version), manifest);
  for (const entry of entries) put(entry.tenantId, entry.manifest);
  return {
    put,
    async findByVersion({ tenantId, agentId, version }) {
      return byTenant.get(tenantId)?.get(key(agentId, version)) ?? null;
    },
  };
};
