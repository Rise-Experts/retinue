/**
 * In-memory `UsageLimitStore` — the reference implementation (#175).
 *
 * Mirrors the SQL adapter's resolution rule exactly, including the part that is easy to get subtly different:
 * **most specific wins**, and a tenant default is the fallback rather than something to merge with. A store that
 * merged the two — taking the principal's cost limit and the tenant's token limit — would be a third behaviour
 * neither adapter documents, and the conformance suite exists to stop precisely that.
 */

import type { PrincipalId, TenantId } from "../../core/ids.js";
import type { RollupPeriod, UsageLimitRecord, UsageLimitStore } from "../../persistence/index.js";

/** Keyed by grain, with the tenant default under an empty principal segment — same shape as the SQL indexes. */
const keyOf = (principalId: PrincipalId | undefined, period: RollupPeriod) => `${principalId ?? ""} ${period}`;

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
      tenant(tenantId).set(keyOf(limit.principalId, limit.period), stored);
      return stored;
    },

    async resolve({ tenantId, principalId, period }) {
      const rows = tenant(tenantId);
      // The principal's own row, else the tenant default, else unbounded. A fallback, never a merge: a partial
      // override that inherited the rest would be a third set of limits nobody configured.
      return rows.get(keyOf(principalId, period)) ?? rows.get(keyOf(undefined, period)) ?? null;
    },

    async list({ tenantId }) {
      return [...tenant(tenantId).values()].sort(
        (a, b) =>
          (a.principalId ?? "").localeCompare(b.principalId ?? "") || a.period.localeCompare(b.period),
      );
    },

    async remove({ tenantId, principalId, period }) {
      tenant(tenantId).delete(keyOf(principalId, period));
    },
  };
};
