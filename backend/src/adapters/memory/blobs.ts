/**
 * In-memory blob store — `docs/03` → Tool results. Holds spilled tool output for read-back via
 * `read_tool_output`. Tenant-partitioned so a `BlobRef` never resolves another tenant's bytes.
 */

import { asId } from "../../core/ids.js";
import type { BlobRef } from "../../core/ids.js";
import type { BlobStore } from "../../persistence/index.js";

export const createMemoryBlobStore = (): BlobStore => {
  const byTenant = new Map<string, Map<string, unknown>>();
  let counter = 0;
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  return {
    async put({ tenantId, value }) {
      const ref = `blob:${tenantId}:${(counter += 1)}`;
      tenant(tenantId).set(ref, value);
      return asId<BlobRef>(ref);
    },
    async get({ tenantId, ref }) {
      const store = tenant(tenantId);
      return store.has(ref) ? store.get(ref) : null;
    },
  };
};
