/**
 * Shared storage conformance harness — `docs/02` "Conformance suite".
 *
 * Every `ConversationStore` adapter (memory today, Postgres/Supabase later) must pass the same
 * suite, so "swap the database" is provably safe. Adapter packages call this from a test file.
 * Not part of the published build (excluded in tsconfig); imported by tests only.
 */

import { describe, expect, it } from "vitest";
import type { ConversationId, TenantId } from "../core/ids.js";
import type { ConversationStore } from "../persistence/index.js";

export function conversationStoreConformance(makeStore: () => ConversationStore): void {
  const t1 = "tenant-1" as TenantId;
  const t2 = "tenant-2" as TenantId;
  const cid = (s: string) => s as ConversationId;

  describe("ConversationStore conformance", () => {
    it("create then findById returns the row, scoped to its tenant", async () => {
      const store = makeStore();
      const created = await store.create({ tenantId: t1, id: cid("c1"), title: "Hello" });
      expect(created).toMatchObject({ id: "c1", tenantId: t1, title: "Hello", version: 1 });
      expect(await store.findById({ tenantId: t1, id: cid("c1") })).toMatchObject({ id: "c1" });
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await store.create({ tenantId: t1, id: cid("c1"), title: "t1 only" });
      expect(await store.findById({ tenantId: t2, id: cid("c1") })).toBeNull();
      expect((await store.list({ tenantId: t2, limit: 10 })).items).toHaveLength(0);
    });

    it("rejects a duplicate id", async () => {
      const store = makeStore();
      await store.create({ tenantId: t1, id: cid("c1"), title: "a" });
      await expect(store.create({ tenantId: t1, id: cid("c1"), title: "b" })).rejects.toThrow();
    });

    it("paginates by stable cursor", async () => {
      const store = makeStore();
      for (const n of [1, 2, 3, 4, 5]) await store.create({ tenantId: t1, id: cid(`c${n}`), title: `#${n}` });
      const first = await store.list({ tenantId: t1, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      const second = await store.list({ tenantId: t1, limit: 2, cursor: first.nextCursor });
      expect(second.items).toHaveLength(2);
      // no overlap between pages
      const ids = new Set(first.items.map((c) => c.id));
      expect(second.items.some((c) => ids.has(c.id))).toBe(false);
    });

    it("optimistic concurrency: a stale expectedVersion is rejected", async () => {
      const store = makeStore();
      await store.create({ tenantId: t1, id: cid("c1"), title: "v1" });
      const updated = await store.update({ tenantId: t1, id: cid("c1"), expectedVersion: 1, patch: { title: "v2" } });
      expect(updated.version).toBe(2);
      await expect(
        store.update({ tenantId: t1, id: cid("c1"), expectedVersion: 1, patch: { title: "stale" } }),
      ).rejects.toThrow();
    });

    it("soft delete hides the row from findById and list", async () => {
      const store = makeStore();
      await store.create({ tenantId: t1, id: cid("c1"), title: "bye" });
      await store.softDelete({ tenantId: t1, id: cid("c1") });
      expect(await store.findById({ tenantId: t1, id: cid("c1") })).toBeNull();
      expect((await store.list({ tenantId: t1, limit: 10 })).items).toHaveLength(0);
    });
  });
}
