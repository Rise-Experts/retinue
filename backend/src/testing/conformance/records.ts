/**
 * Record-store conformance: `MessageStore`, `AgentStore`, `SkillStore`, `BlobStore`,
 * `IdempotencyStore`, `PrincipalMemoryStore`, `McpConnectionStore`.
 *
 * Two of these carry a safety property rather than merely a data contract, and both are asserted
 * here rather than assumed:
 *  - `BlobStore` — "tenant-scoped so a ref from one tenant can never resolve another's bytes".
 *  - `PrincipalMemoryStore` — every method takes `{ tenantId, principalId }`, so a query "can never
 *    reach another principal's or tenant's memory". Tenant isolation alone is not enough; the
 *    cross-*principal* case inside one tenant is the one that would leak between colleagues.
 */

import { describe, expect, it } from "vitest";
import { withConversation, type FixtureOrStore } from "./parents.js";
import { asId } from "../../core/ids.js";
import type { MessageId, PrincipalId, RunId, TenantId, ToolCallId } from "../../core/ids.js";
import type {
  AgentStore,
  BlobStore,
  MessageStore,
  SkillStore,
} from "../../persistence/index.js";
import { deriveIdempotencyKey, type IdempotencyStore } from "../../idempotency/index.js";
import type { PrincipalMemoryStore } from "../../principal-memory/index.js";
import type { McpConnectionStore } from "../../mcp/provider.js";
import type { ConversationId } from "../../core/ids.js";

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const P1 = asId<PrincipalId>("conf-principal-1");
const P2 = asId<PrincipalId>("conf-principal-2");
const RUN = asId<RunId>("conf-run-1");
const C1 = asId<ConversationId>("conf-convo-1");

export function messageStoreConformance(
  makeFixture: () => FixtureOrStore<MessageStore>,
  seed: (store: MessageStore, input: { tenantId: TenantId; conversationId: ConversationId; count: number }) => Promise<void>,
): void {
  // A message references a conversation, and Postgres enforces that with a foreign key (#96). The
  // seed callback only receives the store, so it cannot create the parent itself — the fixture's
  // `seedConversation` does, sharing the adapter's executor. See ./parents.ts.
  const open = (conversationId: ConversationId = C1) =>
    withConversation(makeFixture(), [{ tenantId: T1, conversationId }]);

  describe("MessageStore conformance", () => {
    it("returns null for an unknown id", async () => {
      const store = await open();
      expect(await store.findById({ tenantId: T1, id: asId<MessageId>("nope") })).toBeNull();
    });

    it("lists a conversation's messages in order", async () => {
      const store = await open();
      await seed(store, { tenantId: T1, conversationId: C1, count: 3 });
      const page = await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 10 });
      expect(page.items).toHaveLength(3);
    });

    it("pages by stable cursor with no overlap between pages", async () => {
      const store = await open();
      await seed(store, { tenantId: T1, conversationId: C1, count: 5 });
      const first = await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      const second = await store.listByConversation({
        tenantId: T1,
        conversationId: C1,
        limit: 2,
        cursor: first.nextCursor,
      });
      const firstIds = new Set(first.items.map((m) => m.id));
      expect(second.items.some((m) => firstIds.has(m.id))).toBe(false);
    });

    it("preserves typed content parts through a round-trip", async () => {
      const store = await open();
      await seed(store, { tenantId: T1, conversationId: C1, count: 1 });
      const page = await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 1 });
      const message = page.items[0];
      expect(message).toBeDefined();
      expect(Array.isArray(message?.parts)).toBe(true);
    });

    it("enforces tenant isolation", async () => {
      const store = await open();
      await seed(store, { tenantId: T1, conversationId: C1, count: 2 });
      const other = await store.listByConversation({ tenantId: T2, conversationId: C1, limit: 10 });
      expect(other.items).toHaveLength(0);
    });
  });
}

export function agentStoreConformance(
  makeStore: () => AgentStore,
  seed: (store: AgentStore, input: { tenantId: TenantId; agentId: string; version: number }) => Promise<void>,
): void {
  describe("AgentStore conformance", () => {
    it("returns null for an unknown agent version", async () => {
      expect(await makeStore().findByVersion({ tenantId: T1, agentId: "nope", version: 1 })).toBeNull();
    });

    it("resolves the exact version requested", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, agentId: "a", version: 1 });
      await seed(store, { tenantId: T1, agentId: "a", version: 2 });
      expect(await store.findByVersion({ tenantId: T1, agentId: "a", version: 1 })).not.toBeNull();
      expect(await store.findByVersion({ tenantId: T1, agentId: "a", version: 2 })).not.toBeNull();
    });

    it("does not fall back to another version when the requested one is absent", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, agentId: "a", version: 1 });
      expect(await store.findByVersion({ tenantId: T1, agentId: "a", version: 7 })).toBeNull();
    });

    /**
     * Surfaced by #91 as a real leak and fixed: `createMemoryAgentStore` keyed its map by
     * `id@version` alone and destructured only `{ agentId, version }`, so one tenant could resolve
     * another tenant's manifest. It now partitions by tenant like every sibling store.
     *
     * Kept deliberately as a regression test rather than deleted — an agent manifest carries no
     * `tenantId` of its own, so nothing in the type system stops this from being reintroduced.
     */
    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, agentId: "a", version: 1 });
      expect(await store.findByVersion({ tenantId: T2, agentId: "a", version: 1 })).toBeNull();
    });

    it("keeps same-id manifests separate per tenant", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, agentId: "shared", version: 1 });
      await seed(store, { tenantId: T2, agentId: "shared", version: 1 });
      // Both tenants may legitimately own an agent with the same id; neither may see the other's.
      expect(await store.findByVersion({ tenantId: T1, agentId: "shared", version: 1 })).not.toBeNull();
      expect(await store.findByVersion({ tenantId: T2, agentId: "shared", version: 1 })).not.toBeNull();
    });

    it("does not leak a version one tenant owns and the other does not", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, agentId: "a", version: 1 });
      await seed(store, { tenantId: T2, agentId: "a", version: 2 });
      expect(await store.findByVersion({ tenantId: T1, agentId: "a", version: 2 })).toBeNull();
      expect(await store.findByVersion({ tenantId: T2, agentId: "a", version: 1 })).toBeNull();
    });
  });
}

export function skillStoreConformance(
  makeStore: () => SkillStore,
  seed: (store: SkillStore, input: { tenantId: TenantId; name: string; version: number }) => Promise<void>,
): void {
  describe("SkillStore conformance", () => {
    it("returns an empty catalog for a tenant with no skills", async () => {
      expect(await makeStore().listCatalog({ tenantId: T1 })).toHaveLength(0);
    });

    it("lists the catalog after seeding", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, name: "post-composition", version: 1 });
      expect((await store.listCatalog({ tenantId: T1 })).length).toBeGreaterThan(0);
    });

    it("resolves a specific version, so a run records what it actually used", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, name: "post-composition", version: 1 });
      await seed(store, { tenantId: T1, name: "post-composition", version: 2 });
      const v1 = await store.findVersion({ tenantId: T1, name: "post-composition", version: 1 });
      expect(v1?.version).toBe(1);
    });

    it("returns null for an absent version rather than the nearest one", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, name: "post-composition", version: 1 });
      expect(await store.findVersion({ tenantId: T1, name: "post-composition", version: 9 })).toBeNull();
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, name: "post-composition", version: 1 });
      expect(await store.listCatalog({ tenantId: T2 })).toHaveLength(0);
      expect(await store.findVersion({ tenantId: T2, name: "post-composition", version: 1 })).toBeNull();
    });
  });
}

export function blobStoreConformance(makeStore: () => BlobStore): void {
  describe("BlobStore conformance", () => {
    it("round-trips a stored value by ref", async () => {
      const store = makeStore();
      const ref = await store.put({ tenantId: T1, value: { large: "payload" } });
      expect(await store.get({ tenantId: T1, ref })).toEqual({ large: "payload" });
    });

    it("returns null for an unknown ref", async () => {
      const store = makeStore();
      const ref = await store.put({ tenantId: T1, value: 1 });
      const other = makeStore();
      expect(await other.get({ tenantId: T1, ref })).toBeNull();
    });

    it("a ref from one tenant never resolves another tenant's bytes", async () => {
      const store = makeStore();
      const ref = await store.put({ tenantId: T1, value: { secret: true } });
      expect(await store.get({ tenantId: T2, ref })).toBeNull();
    });

    it("keeps distinct values distinct", async () => {
      const store = makeStore();
      const a = await store.put({ tenantId: T1, value: { v: "a" } });
      const b = await store.put({ tenantId: T1, value: { v: "b" } });
      expect(await store.get({ tenantId: T1, ref: a })).toEqual({ v: "a" });
      expect(await store.get({ tenantId: T1, ref: b })).toEqual({ v: "b" });
    });
  });
}

export function idempotencyStoreConformance(makeStore: () => IdempotencyStore): void {
  const key = deriveIdempotencyKey({ tenantId: T1, runId: RUN, toolCallId: asId<ToolCallId>("tc1") });

  describe("IdempotencyStore conformance", () => {
    it("returns null for an unseen key", async () => {
      expect(await makeStore().get({ tenantId: T1, key })).toBeNull();
    });

    it("returns the stored result for a repeated key, so the operation is not re-executed", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, key, result: { published: true } });
      const seen = await store.get<{ published: boolean }>({ tenantId: T1, key });
      expect(seen?.result).toEqual({ published: true });
    });

    it("reports firstSeen honestly on the replay path", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, key, result: 1 });
      expect((await store.get({ tenantId: T1, key }))?.firstSeen).toBe(false);
    });

    it("enforces tenant isolation — a key is never shared across tenants", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, key, result: { published: true } });
      expect(await store.get({ tenantId: T2, key })).toBeNull();
    });
  });
}

export function principalMemoryStoreConformance(makeStore: () => PrincipalMemoryStore): void {
  describe("PrincipalMemoryStore conformance", () => {
    it("stores and reads back an entry for its principal", async () => {
      const store = makeStore();
      const entry = await store.put({ tenantId: T1, principalId: P1, text: "prefers concise answers" });
      expect(await store.get({ tenantId: T1, principalId: P1, id: entry.id })).toMatchObject({
        text: "prefers concise answers",
      });
    });

    it("never reaches another principal's memory inside the same tenant", async () => {
      const store = makeStore();
      const entry = await store.put({ tenantId: T1, principalId: P1, text: "private to P1" });
      expect(await store.get({ tenantId: T1, principalId: P2, id: entry.id })).toBeNull();
      expect((await store.list({ tenantId: T1, principalId: P2, limit: 10 })).items).toHaveLength(0);
    });

    it("never reaches another tenant's memory", async () => {
      const store = makeStore();
      const entry = await store.put({ tenantId: T1, principalId: P1, text: "private to T1" });
      expect(await store.get({ tenantId: T2, principalId: P1, id: entry.id })).toBeNull();
    });

    it("rejects a stale expectedVersion on update", async () => {
      const store = makeStore();
      const entry = await store.put({ tenantId: T1, principalId: P1, text: "v1" });
      await store.update({
        tenantId: T1,
        principalId: P1,
        id: entry.id,
        expectedVersion: entry.version,
        patch: { text: "v2" },
      });
      await expect(
        store.update({
          tenantId: T1,
          principalId: P1,
          id: entry.id,
          expectedVersion: entry.version,
          patch: { text: "stale" },
        }),
      ).rejects.toThrow();
    });

    it("hard-deletes, so a deleted entry cannot resurface in a later prompt", async () => {
      const store = makeStore();
      const entry = await store.put({ tenantId: T1, principalId: P1, text: "forget me" });
      await store.delete({ tenantId: T1, principalId: P1, id: entry.id });
      expect(await store.get({ tenantId: T1, principalId: P1, id: entry.id })).toBeNull();
      expect(await store.retrieve({ tenantId: T1, principalId: P1, limit: 10 })).toHaveLength(0);
    });

    it("excludes disabled entries from retrieval but keeps them readable", async () => {
      const store = makeStore();
      const entry = await store.put({ tenantId: T1, principalId: P1, text: "temporarily off" });
      await store.update({
        tenantId: T1,
        principalId: P1,
        id: entry.id,
        expectedVersion: entry.version,
        patch: { disabled: true },
      });
      expect(await store.retrieve({ tenantId: T1, principalId: P1, limit: 10 })).toHaveLength(0);
      expect(await store.get({ tenantId: T1, principalId: P1, id: entry.id })).not.toBeNull();
    });

    it("retrieve returns most salient first and honors the limit", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, principalId: P1, text: "low", salience: 1 });
      await store.put({ tenantId: T1, principalId: P1, text: "high", salience: 9 });
      const top = await store.retrieve({ tenantId: T1, principalId: P1, limit: 1 });
      expect(top).toHaveLength(1);
      expect(top[0]?.text).toBe("high");
    });
  });
}

export function mcpConnectionStoreConformance(
  makeStore: () => McpConnectionStore,
  seed: (store: McpConnectionStore, input: { tenantId: TenantId; id: string }) => Promise<void>,
): void {
  describe("McpConnectionStore conformance", () => {
    it("returns null for an unregistered connection", async () => {
      expect(await makeStore().get({ tenantId: T1, id: "nope" })).toBeNull();
    });

    it("registers and reads back a connection", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, id: "srv1" });
      expect(await store.get({ tenantId: T1, id: "srv1" })).not.toBeNull();
    });

    it("lists a tenant's connections", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, id: "srv1" });
      await seed(store, { tenantId: T1, id: "srv2" });
      expect(await store.list({ tenantId: T1 })).toHaveLength(2);
    });

    it("toggles enabled without losing the record", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, id: "srv1" });
      await store.setEnabled({ tenantId: T1, id: "srv1", enabled: false });
      expect(await store.get({ tenantId: T1, id: "srv1" })).not.toBeNull();
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await seed(store, { tenantId: T1, id: "srv1" });
      expect(await store.get({ tenantId: T2, id: "srv1" })).toBeNull();
      expect(await store.list({ tenantId: T2 })).toHaveLength(0);
    });
  });
}
