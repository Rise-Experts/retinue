/**
 * `RateLimitStore` conformance — task #248, AC-6.
 *
 * The contract is small and every clause is a defect somebody would otherwise ship:
 *
 * - **Counting is per key.** A store that ignored the window start would never reset; one that ignored the
 *   tenant would let one customer exhaust another's allowance.
 * - **`consume` returns the count *after* incrementing**, starting at 1. Off by one here means a limit of `max`
 *   admits `max + 1`, which no test of the guard alone would catch because the guard would be consistent with
 *   its own store.
 * - **It is atomic under concurrency.** Twenty concurrent consumes must yield the twenty distinct counts 1..20,
 *   with no value repeated. A read-then-write implementation loses increments and quietly raises the effective
 *   limit — the failure this whole port exists to prevent, arriving from inside.
 *
 * Run against the in-memory store and against Redis. The in-memory one is single-process by construction, so it
 * satisfies the contract while being unusable in a fleet; that is why the Redis suite exists separately and why
 * `createMemoryRateLimitStore`'s header says so.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import type { RateLimitStore } from "../../usage/index.js";

// `export function`, not `export const`: the coverage guard splits harness sources on
// `\nexport function (\w+Conformance)` to locate each body, so an arrow-function export is invisible to it and
// reads as a missing harness.
export function rateLimitStoreConformance(
  /** The adapter under test, for the inner describe block. */
  name: string,
  makeStore: () => RateLimitStore | Promise<RateLimitStore>,
  /** A suffix making keys unique per run, so a rerun inside the same window does not inherit a count. */
  unique: () => string,
): void {
  // Exactly `<Port> conformance`: `scripts/conformance-matrix.mjs` maps that title back to the port. The
  // adapter's name goes on the inner block instead.
  describe("RateLimitStore conformance", () => {
    const T1 = asId<TenantId>(`rlc-t1-${unique()}`);
    const T2 = asId<TenantId>(`rlc-t2-${unique()}`);
    const T = (s: string) => asId<TenantId>(`rlc-${s}-${unique()}`);

    it(`[${name}] returns the count after incrementing, starting at 1`, async () => {
      const store = await makeStore();
      const tenantId = T("count");
      const input = { tenantId, windowStartMs: 60_000, windowSeconds: 60 };
      expect(await store.consume(input)).toBe(1);
      expect(await store.consume(input)).toBe(2);
      expect(await store.consume(input)).toBe(3);
    });

    it("counts each window separately", async () => {
      const store = await makeStore();
      const tenantId = T("window");
      expect(await store.consume({ tenantId, windowStartMs: 60_000, windowSeconds: 60 })).toBe(1);
      expect(await store.consume({ tenantId, windowStartMs: 60_000, windowSeconds: 60 })).toBe(2);
      // A new window is a new count, which is what makes a limit recover rather than latch.
      expect(await store.consume({ tenantId, windowStartMs: 120_000, windowSeconds: 60 })).toBe(1);
    });

    it("counts each tenant separately — T2 is unaffected by T1's consumption", async () => {
      // The isolation clause. There is no cross-tenant *read* to leak here, but there is a cross-tenant
      // *count*: a store keyed on the window alone would let one customer exhaust every other customer's
      // allowance, which is the same class of defect as the AgentStore leak #91 found.
      const store = await makeStore();
      expect(await store.consume({ tenantId: T1, windowStartMs: 60_000, windowSeconds: 60 })).toBe(1);
      expect(await store.consume({ tenantId: T1, windowStartMs: 60_000, windowSeconds: 60 })).toBe(2);
      expect(await store.consume({ tenantId: T2, windowStartMs: 60_000, windowSeconds: 60 })).toBe(1);
    });

    it("loses no increment under concurrency", async () => {
      // Twenty concurrent consumes must produce the twenty distinct counts 1..20. A read-then-write store
      // returns duplicates, and a duplicate is a lost increment — a limit that admits more than it says.
      const store = await makeStore();
      const tenantId = T("concurrent");
      const input = { tenantId, windowStartMs: 60_000, windowSeconds: 60 };
      const counts = await Promise.all(Array.from({ length: 20 }, () => store.consume(input)));
      expect([...counts].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });
  });
}
