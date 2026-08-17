/**
 * In-memory principal memory store — `docs/15`. Partitioned by (tenant, principal) so a query can
 * never reach another principal's or tenant's memory. Versioned; hard-delete cannot resurface.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type { PrincipalMemoryEntry, PrincipalMemoryStore } from "../../principal-memory/index.js";

const conflict = (m: string) => new AgentPlatformError({ code: "conflict", message: m, retryable: false });
const notFound = (id: string) => new AgentPlatformError({ code: "not_found", message: `Memory ${id} not found`, retryable: false });

export const createMemoryPrincipalMemoryStore = (
  clock: () => string = () => new Date().toISOString(),
): PrincipalMemoryStore => {
  const byKey = new Map<string, Map<string, PrincipalMemoryEntry>>();
  let counter = 0;
  const key = (t: string, p: string) => `${t} ${p}`;
  const bucket = (t: string, p: string) => {
    const k = key(t, p);
    let m = byKey.get(k);
    if (!m) byKey.set(k, (m = new Map()));
    return m;
  };
  const active = (e: PrincipalMemoryEntry) => e.disabledAt === undefined;

  return {
    async put({ tenantId, principalId, id, text, tags, salience }) {
      const rows = bucket(tenantId, principalId);
      const entryId = id ?? `mem-${(counter += 1)}`;
      const now = clock();
      const existing = rows.get(entryId);
      const entry: PrincipalMemoryEntry = {
        id: entryId,
        tenantId,
        principalId,
        text,
        tags: tags ?? [],
        salience: salience ?? 1,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(entryId, entry);
      return entry;
    },
    async get({ tenantId, principalId, id }) {
      return bucket(tenantId, principalId).get(id) ?? null;
    },
    async list({ tenantId, principalId, limit, cursor }) {
      const all = [...bucket(tenantId, principalId).values()].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
      );
      const start = cursor ? all.findIndex((e) => e.id === cursor) + 1 : 0;
      const items = all.slice(start, start + limit);
      const nextCursor = start + limit < all.length ? items[items.length - 1]?.id : undefined;
      const page: Page<PrincipalMemoryEntry> = nextCursor === undefined ? { items } : { items, nextCursor };
      return page;
    },
    async update({ tenantId, principalId, id, expectedVersion, patch }) {
      const rows = bucket(tenantId, principalId);
      const row = rows.get(id);
      if (!row) throw notFound(id);
      if (row.version !== expectedVersion) throw conflict(`Memory ${id} version ${expectedVersion} is stale (current ${row.version})`);
      const next: PrincipalMemoryEntry = {
        ...row,
        ...(patch.text === undefined ? {} : { text: patch.text }),
        ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        ...(patch.salience === undefined ? {} : { salience: patch.salience }),
        ...(patch.disabled === undefined ? {} : patch.disabled ? { disabledAt: clock() } : { disabledAt: undefined }),
        version: row.version + 1,
        updatedAt: clock(),
      };
      rows.set(id, next);
      return next;
    },
    async delete({ tenantId, principalId, id }) {
      bucket(tenantId, principalId).delete(id); // hard delete — cannot resurface
    },
    async retrieve({ tenantId, principalId, query, limit }) {
      const q = query?.trim().toLowerCase();
      return [...bucket(tenantId, principalId).values()]
        .filter(active)
        .filter((e) => !q || e.text.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)))
        .sort((a, b) => b.salience - a.salience)
        .slice(0, limit);
    },
  };
};
