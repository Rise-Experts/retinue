/**
 * `UsageLimitStore` conformance — admin-configured spend limits (#175).
 *
 * The rule under test is **most specific wins, as a fallback and never a merge**. That distinction is the whole
 * reason this harness exists: an adapter that merged a principal's cost limit with the tenant's token limit would
 * produce a third set of limits nobody configured, and every individual assertion about either would still pass.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { PrincipalId, TenantId } from "../../core/ids.js";
import { windowKey } from "../../persistence/index.js";
import type { QuotaWindow, UsageLimitStore } from "../../persistence/index.js";

/**
 * The window every pre-existing case in here uses — #181 widened `period` into a union, and spelling it out at
 * thirty-odd sites would bury what each case is about.
 */
const MONTH: QuotaWindow = { kind: "calendar", period: "month" };
/** Five hours, the case a workspace admin actually asked for. */
const FIVE_HOURS: QuotaWindow = { kind: "rolling", minutes: 300 };

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const P1 = asId<PrincipalId>("conf-principal-1");
const P2 = asId<PrincipalId>("conf-principal-2");

export function usageLimitStoreConformance(makeStore: () => UsageLimitStore): void {
  describe("UsageLimitStore conformance", () => {
    it("returns null when nothing is configured, which means unbounded", async () => {
      // Not zero. A store that returned a zeroed limit would refuse every run, and an outage is only visible to
      // the customer it is happening to — where an unbounded quota is visible in the rollups.
      expect(await makeStore().resolve({ tenantId: T1, principalId: P1, window: MONTH })).toBeNull();
    });

    it("falls back to the tenant default when a principal has no override", async () => {
      const store = makeStore();
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, window: MONTH, costMinorUnits: 5000, updatedAt: "t" },
      });
      const resolved = await store.resolve({ tenantId: T1, principalId: P1, window: MONTH });
      expect(resolved?.costMinorUnits).toBe(5000);
      expect(resolved?.principalId).toBeUndefined();
    });

    it("prefers a principal's own limit over the tenant default", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: MONTH, costMinorUnits: 5000, updatedAt: "t" } });
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 100, updatedAt: "t" },
      });
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.costMinorUnits).toBe(100);
      // And leaves everyone else on the default.
      expect((await store.resolve({ tenantId: T1, principalId: P2, window: MONTH }))?.costMinorUnits).toBe(5000);
    });

    /**
     * A fallback, never a merge.
     *
     * The principal's row sets a cost limit and no token limit. Resolution must return *that row* — so the token
     * limit is unbounded for them — rather than filling the gap from the tenant default. Merging would invent a
     * limit nobody configured, and it would look correct in every test that checked one field at a time.
     */
    it("does not merge a partial override with the tenant default", async () => {
      const store = makeStore();
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, window: MONTH, costMinorUnits: 5000, inputTokens: 1_000_000, updatedAt: "t" },
      });
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 100, updatedAt: "t" },
      });
      const resolved = await store.resolve({ tenantId: T1, principalId: P1, window: MONTH });
      expect(resolved?.costMinorUnits).toBe(100);
      expect(resolved?.inputTokens).toBeUndefined();
    });

    /**
     * An omitted limit round-trips as **absent**, never as zero.
     *
     * The most dangerous direction in this whole feature, and the one my first pass at this harness missed: a
     * store writing `0` for an unset limit refuses every run, and the quota code cannot tell that apart from an
     * administrator setting a limit of zero on purpose. An outage is only visible to the customer it is happening
     * to, where an unbounded quota is visible in the rollups.
     *
     * Caught by sabotage — replacing `?? null` with `?? 0` in the adapter passed every other test here.
     */
    it("round-trips an omitted limit as absent, not as zero", async () => {
      const store = makeStore();
      await store.put({
        tenantId: T1,
        // Cost only. Tokens are deliberately unset, which means unbounded.
        limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 100, updatedAt: "t" },
      });
      const resolved = await store.resolve({ tenantId: T1, principalId: P1, window: MONTH });
      expect(resolved?.costMinorUnits).toBe(100);
      expect(resolved?.inputTokens).toBeUndefined();
      expect(resolved?.outputTokens).toBeUndefined();
      expect(resolved?.warnAt).toBeUndefined();
    });

    it("stores a deliberate zero as zero, which is a different statement from absent", async () => {
      // An administrator setting a limit of zero is saying "this person may spend nothing", and that has to be
      // distinguishable from "no limit configured" — otherwise the two collapse and one of them is wrong.
      const store = makeStore();
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 0, updatedAt: "t" },
      });
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.costMinorUnits).toBe(0);
    });

    it("keeps periods independent", async () => {
      // A monthly allowance says nothing about a weekly one. Resolving across periods would apply a month's
      // budget to a week.
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: MONTH, costMinorUnits: 5000, updatedAt: "t" } });
      expect(await store.resolve({ tenantId: T1, principalId: P1, window: { kind: "calendar", period: "week" } })).toBeNull();
    });

    it("replaces rather than accumulates when a limit is edited", async () => {
      // Otherwise `resolve` would have to disambiguate between rows, and "which one wins" becomes an accident of
      // insertion order.
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 100, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 250, updatedAt: "t" } });
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.costMinorUnits).toBe(250);
      expect(await store.list({ tenantId: T1 })).toHaveLength(1);
    });

    it("removing an override falls back to the default rather than to zero", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: MONTH, costMinorUnits: 5000, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 100, updatedAt: "t" } });
      await store.remove({ tenantId: T1, principalId: P1, window: MONTH });
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.costMinorUnits).toBe(5000);
    });

    it("removing the tenant default leaves an override in place", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: MONTH, costMinorUnits: 5000, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 100, updatedAt: "t" } });
      await store.remove({ tenantId: T1, window: MONTH });
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.costMinorUnits).toBe(100);
      expect(await store.resolve({ tenantId: T1, principalId: P2, window: MONTH })).toBeNull();
    });

    it("records who changed a limit", async () => {
      // A spend limit is the kind of setting somebody eventually has to explain.
      const store = makeStore();
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 100, updatedAt: "t", updatedBy: "admin@example.com" },
      });
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.updatedBy).toBe("admin@example.com");
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: MONTH, costMinorUnits: 5000, updatedAt: "t" } });
      expect(await store.resolve({ tenantId: T2, principalId: P1, window: MONTH })).toBeNull();
      expect(await store.list({ tenantId: T2 })).toEqual([]);
    });

    /** The rolling window an admin can now configure — #181. */
    it("stores and resolves a rolling window", async () => {
      const store = makeStore();
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, principalId: P1, window: FIVE_HOURS, costMinorUnits: 500, updatedAt: "t" },
      });
      const resolved = await store.resolve({ tenantId: T1, principalId: P1, window: FIVE_HOURS });
      // Round-tripped as the union, not as whatever string the adapter happens to store — the guard branches on
      // `kind`, so a rolling row coming back as a calendar one would enforce the wrong span silently.
      expect(resolved?.window).toEqual(FIVE_HOURS);
      expect(resolved?.costMinorUnits).toBe(500);
    });

    it("keeps a rolling window and a calendar one as separate limits", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 10_000, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: FIVE_HOURS, costMinorUnits: 500, updatedAt: "t" } });
      // Both, because they are both real: "500 in any five hours **and** 10,000 a month" is the normal shape of
      // a plan. If the window were not part of the key, the second `put` would have overwritten the first.
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.costMinorUnits).toBe(10_000);
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: FIVE_HOURS }))?.costMinorUnits).toBe(500);
      expect(await store.list({ tenantId: T1 })).toHaveLength(2);
    });

    it("keeps two rolling windows of different lengths apart", async () => {
      const store = makeStore();
      const ninety: QuotaWindow = { kind: "rolling", minutes: 90 };
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: FIVE_HOURS, costMinorUnits: 500, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: ninety, costMinorUnits: 200, updatedAt: "t" } });
      // The length is part of the identity. A key that dropped it would make every rolling limit the same row.
      expect((await store.resolve({ tenantId: T1, window: FIVE_HOURS }))?.costMinorUnits).toBe(500);
      expect((await store.resolve({ tenantId: T1, window: ninety }))?.costMinorUnits).toBe(200);
    });

    it("falls back from a principal's rolling window to the tenant's, and never merges them", async () => {
      const store = makeStore();
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, window: FIVE_HOURS, costMinorUnits: 5000, inputTokens: 1_000_000, updatedAt: "t" },
      });
      await store.put({
        tenantId: T1,
        limit: { tenantId: T1, principalId: P1, window: FIVE_HOURS, costMinorUnits: 100, updatedAt: "t" },
      });
      const resolved = await store.resolve({ tenantId: T1, principalId: P1, window: FIVE_HOURS });
      expect(resolved?.costMinorUnits).toBe(100);
      // The rule #175 established, restated for the new window kind: a fallback, never a merge. Inheriting the
      // tenant's token limit alongside the principal's cost limit would be a third set nobody configured.
      expect(resolved?.inputTokens).toBeUndefined();
    });

    it("removes a rolling window without touching the calendar one beside it", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: MONTH, costMinorUnits: 10_000, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: FIVE_HOURS, costMinorUnits: 500, updatedAt: "t" } });
      await store.remove({ tenantId: T1, principalId: P1, window: FIVE_HOURS });
      expect(await store.resolve({ tenantId: T1, principalId: P1, window: FIVE_HOURS })).toBeNull();
      expect((await store.resolve({ tenantId: T1, principalId: P1, window: MONTH }))?.costMinorUnits).toBe(10_000);
    });

    it("keys a window the same way in every adapter", () => {
      // Not a store test — a guard on the codec both adapters key on. The memory store builds its map key from
      // `windowKey` and the SQL store writes the same string to `window_key`; if the two ever spelled a window
      // differently, both would stay self-consistent and neither could read the other's rows, and every case
      // above would still pass.
      expect(windowKey(MONTH)).toBe("month");
      expect(windowKey(FIVE_HOURS)).toBe("rolling:300");
    });

    it("lists every configured limit for an admin screen, in a stable order", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P2, window: MONTH, costMinorUnits: 1, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, window: MONTH, costMinorUnits: 2, updatedAt: "t" } });
      await store.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: { kind: "calendar", period: "week" }, costMinorUnits: 3, updatedAt: "t" } });
      const listed = await store.list({ tenantId: T1 });
      expect(listed).toHaveLength(3);
      // The tenant default first, then principals — so a screen does not reshuffle between refreshes.
      expect(listed[0]?.principalId).toBeUndefined();
    });
  });
}
