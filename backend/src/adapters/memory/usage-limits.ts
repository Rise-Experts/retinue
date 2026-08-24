/**
 * In-memory `UsageLimitStore` — the reference implementation (#175).
 *
 * Mirrors the SQL adapter's resolution rule exactly, including the part that is easy to get subtly different:
 * **most specific wins**, and a tenant default is the fallback rather than something to merge with. A store that
 * merged the two — taking the principal's cost limit and the tenant's token limit — would be a third behaviour
 * neither adapter documents, and the conformance suite exists to stop precisely that.
 */

import type { PrincipalId, TenantId } from "../../core/ids.js";
import { windowKey } from "../../persistence/index.js";
import type { QuotaWindow, UsageLimitRecord, UsageLimitStore } from "../../persistence/index.js";

/**
 * Keyed by grain, with the tenant default under an empty principal segment — same shape as the SQL indexes.
 *
 * The window half goes through `windowKey`, the same function the SQL adapter stores, so the two adapters cannot
 * key a rolling window differently. Spelling it `${minutes}` here and `rolling:${minutes}` there would leave both
 * stores self-consistent and mutually unreadable, which conformance would not catch.
 */
const keyOf = (principalId: PrincipalId | undefined, modelId: string | undefined, window: QuotaWindow) =>
  // Three segments with an explicit empty for "absent", matching the SQL index's `COALESCE(col, '')`. Neither id
  // can legitimately be empty, so the marker cannot collide with a real value.
  `${principalId ?? ""} ${modelId ?? ""} ${windowKey(window)}`;

export const createMemoryUsageLimitStore = (config: { readonly clock?: () => string } = {}): UsageLimitStore => {
  const clock = config.clock ?? (() => new Date().toISOString());
  const byTenant = new Map<string, Map<string, UsageLimitRecord>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };

  return {
    async put({ tenantId, limit }) {
      const stored: UsageLimitRecord = { ...limit, tenantId: tenantId as TenantId, updatedAt: clock() };
      tenant(tenantId).set(keyOf(limit.principalId, limit.modelId, limit.window), stored);
      return stored;
    },

    async resolve({ tenantId, principalId, modelId, window }) {
      const rows = tenant(tenantId);
      // The principal's own row, else the tenant default, else unbounded. A fallback, never a merge: a partial
      // override that inherited the rest would be a third set of limits nobody configured.
      return (
        rows.get(keyOf(principalId, modelId, window)) ?? rows.get(keyOf(undefined, modelId, window)) ?? null
      );
    },

    async applicable({ tenantId, principalId, modelId }) {
      // Override within a scope, coexist across scopes — #182. One row per `(window, model)`, the principal's
      // beating the tenant's for that same scope only.
      const bestByScope = new Map<string, UsageLimitRecord>();
      for (const record of tenant(tenantId).values()) {
        // A row for somebody else never applies; a model-scoped row applies only to that model, and not at all
        // when the caller has no model to check.
        if (record.principalId !== undefined && record.principalId !== principalId) continue;
        if (record.modelId !== undefined && record.modelId !== modelId) continue;
        const scope = `${record.modelId ?? ""} ${windowKey(record.window)}`;
        const held = bestByScope.get(scope);
        // A principal's row wins the scope. Where both are the tenant's or both the principal's there is only
        // one row, since that is exactly what the key is.
        if (held === undefined || (held.principalId === undefined && record.principalId !== undefined))
          bestByScope.set(scope, record);
      }
      return [...bestByScope.values()];
    },

    async list({ tenantId }) {
      return [...tenant(tenantId).values()].sort(
        (a, b) =>
          (a.principalId ?? "").localeCompare(b.principalId ?? "") ||
          (a.modelId ?? "").localeCompare(b.modelId ?? "") ||
          windowKey(a.window).localeCompare(windowKey(b.window)),
      );
    },

    async remove({ tenantId, principalId, modelId, window }) {
      tenant(tenantId).delete(keyOf(principalId, modelId, window));
    },
  };
};
