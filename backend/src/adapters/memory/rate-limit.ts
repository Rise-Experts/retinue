/**
 * The rate-limit counter in memory — task #248.
 *
 * **For tests and a single-process deployment only.** Two workers each hold their own `Map`, so each allows the
 * full rate and a limit of 60/minute becomes 60×N. That is not a caveat to be worked around; it is why
 * `createRedisRateLimitStore` exists, and why the cross-process test in this task's suite runs against a real
 * Redis rather than this.
 *
 * Old windows are dropped on write rather than on a timer: a timer in a store would keep a process alive and
 * would need clearing, and the number of live windows is one per tenant.
 */

import type { RateLimitStore } from "../../usage/index.js";

export const createMemoryRateLimitStore = (): RateLimitStore => {
  const counts = new Map<string, number>();
  return {
    async consume({ tenantId, windowStartMs }) {
      const key = `${tenantId}:${windowStartMs}`;
      // Every other window for this tenant is over, so nothing else can be incremented again.
      for (const existing of counts.keys()) {
        if (existing.startsWith(`${tenantId}:`) && existing !== key) counts.delete(existing);
      }
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
};
