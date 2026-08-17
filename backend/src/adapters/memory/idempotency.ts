/**
 * In-memory idempotency store — `docs/04` → Idempotency. Persists a tool result by key so a resumed
 * or retried external/destructive call returns the original result instead of repeating the side
 * effect. Tenant-partitioned. Verified indirectly through the tool registry's replay path.
 */

import type { IdempotencyKey, IdempotencyStore, IdempotentResult } from "../../idempotency/index.js";

export const createMemoryIdempotencyStore = (): IdempotencyStore => {
  const byTenant = new Map<string, Map<string, unknown>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  return {
    async get<T>({ tenantId, key }: { tenantId: string; key: IdempotencyKey }): Promise<IdempotentResult<T> | null> {
      const rows = tenant(tenantId);
      if (!rows.has(key)) return null;
      // A stored value means the call already ran: firstSeen is false for the replay.
      return { key, firstSeen: false, result: rows.get(key) as T };
    },
    async put<T>({ tenantId, key, result }: { tenantId: string; key: IdempotencyKey; result: T }): Promise<void> {
      tenant(tenantId).set(key, result);
    },
  };
};
