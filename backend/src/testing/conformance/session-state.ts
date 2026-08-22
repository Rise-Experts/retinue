/**
 * `SessionStateStore`, `ConversationBindingStore`, `ThreadSummaryStore` and `UnitOfWork`
 * conformance — `docs/13-sessions-and-threads.md`.
 *
 * Session state is the deliberate replacement for Agno's fixed 20-turn re-injection (see the
 * extraction inventory), so its optimistic concurrency and size ceiling are load-bearing: they are
 * what stop two runs on one conversation from clobbering each other and what keep working memory
 * from growing into a document store.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, MessageId, TenantId } from "../../core/ids.js";
import type {
  ConversationBindingStore,
  SessionStateStore,
  ThreadSummaryStore,
  UnitOfWork,
} from "../../persistence/index.js";
import { gatedIt, type AdapterDeclaration } from "./capability.js";
import { withConversation, type FixtureOrStore } from "./parents.js";

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const C1 = asId<ConversationId>("conf-convo-1");
const AGENT = asId<AgentId>("conf-agent-1");
const MSG = asId<MessageId>("conf-msg-1");

export function sessionStateStoreConformance(
  makeStore: () => SessionStateStore,
  options: { readonly maxBytes?: number } = {},
): void {
  describe("SessionStateStore conformance", () => {
    it("returns null before anything is written", async () => {
      expect(await makeStore().get({ tenantId: T1, conversationId: C1 })).toBeNull();
    });

    it("writes at expectedVersion 0 and reads back version 1", async () => {
      const store = makeStore();
      const put = await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { a: 1 } });
      expect(put).toMatchObject({ version: 1, data: { a: 1 } });
      expect(await store.get({ tenantId: T1, conversationId: C1 })).toMatchObject({ version: 1 });
    });

    it("increments the version on each write", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { n: 1 } });
      const second = await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 1, data: { n: 2 } });
      expect(second.version).toBe(2);
    });

    it("rejects a stale expectedVersion, so concurrent runs cannot clobber each other", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { n: 1 } });
      await expect(
        store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { n: 99 } }),
      ).rejects.toThrow();
      expect((await store.get({ tenantId: T1, conversationId: C1 }))?.data).toEqual({ n: 1 });
    });

    it("rejects a write beyond the size ceiling — working memory, not a document store", async () => {
      const store = makeStore();
      const maxBytes = options.maxBytes ?? 64 * 1024;
      const oversized = { blob: "x".repeat(maxBytes + 1_000) };
      await expect(
        store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: oversized }),
      ).rejects.toThrow();
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { a: 1 } });
      expect(await store.get({ tenantId: T2, conversationId: C1 })).toBeNull();
    });
  });
}

export function conversationBindingStoreConformance(
  makeFixture: () => FixtureOrStore<ConversationBindingStore>,
): void {
  // A binding belongs to a conversation, and Postgres enforces that with a foreign key (#96). The
  // in-memory adapter has no such constraint and passes no seeder — see ./parents.ts.
  const open = () => withConversation(makeFixture(), [{ tenantId: T1, conversationId: C1 }]);

  describe("ConversationBindingStore conformance", () => {
    it("returns null for an unbound conversation rather than a default", async () => {
      const store = await open();
      expect(await store.get({ tenantId: T1, conversationId: C1 })).toBeNull();
    });

    it("round-trips a pinned binding including the version", async () => {
      const store = await open();
      await store.bind({
        tenantId: T1,
        conversationId: C1,
        agentId: AGENT,
        agentVersionPolicy: "pinned",
        agentVersion: 3,
      });
      expect(await store.get({ tenantId: T1, conversationId: C1 })).toMatchObject({
        agentId: AGENT,
        agentVersionPolicy: "pinned",
        agentVersion: 3,
      });
    });

    it("round-trips a latest-policy binding", async () => {
      const store = await open();
      await store.bind({ tenantId: T1, conversationId: C1, agentId: AGENT, agentVersionPolicy: "latest" });
      expect(await store.get({ tenantId: T1, conversationId: C1 })).toMatchObject({
        agentVersionPolicy: "latest",
      });
    });

    it("re-binding is idempotent — the last write wins, without error", async () => {
      const store = await open();
      await store.bind({ tenantId: T1, conversationId: C1, agentId: AGENT, agentVersionPolicy: "latest" });
      await store.bind({
        tenantId: T1,
        conversationId: C1,
        agentId: AGENT,
        agentVersionPolicy: "pinned",
        agentVersion: 2,
      });
      expect(await store.get({ tenantId: T1, conversationId: C1 })).toMatchObject({ agentVersion: 2 });
    });

    it("enforces tenant isolation", async () => {
      const store = await open();
      await store.bind({ tenantId: T1, conversationId: C1, agentId: AGENT, agentVersionPolicy: "latest" });
      expect(await store.get({ tenantId: T2, conversationId: C1 })).toBeNull();
    });
  });
}

export function threadSummaryStoreConformance(makeStore: () => ThreadSummaryStore): void {
  describe("ThreadSummaryStore conformance", () => {
    it("returns null before any summary exists", async () => {
      expect(await makeStore().latest({ tenantId: T1, conversationId: C1 })).toBeNull();
    });

    it("appends version 1 first", async () => {
      const store = makeStore();
      const s = await store.append({
        tenantId: T1,
        conversationId: C1,
        summary: "first",
        coversUpToMessageId: MSG,
      });
      expect(s).toMatchObject({ version: 1, summary: "first" });
    });

    it("versions successive summaries rather than overwriting", async () => {
      const store = makeStore();
      await store.append({ tenantId: T1, conversationId: C1, summary: "first", coversUpToMessageId: MSG });
      const second = await store.append({
        tenantId: T1,
        conversationId: C1,
        summary: "second",
        coversUpToMessageId: MSG,
      });
      expect(second.version).toBe(2);
      expect((await store.latest({ tenantId: T1, conversationId: C1 }))?.summary).toBe("second");
    });

    it("records how far the summary covers, so recent turns stay verbatim", async () => {
      const store = makeStore();
      await store.append({ tenantId: T1, conversationId: C1, summary: "s", coversUpToMessageId: MSG });
      expect((await store.latest({ tenantId: T1, conversationId: C1 }))?.coversUpToMessageId).toBe(MSG);
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await store.append({ tenantId: T1, conversationId: C1, summary: "s", coversUpToMessageId: MSG });
      expect(await store.latest({ tenantId: T2, conversationId: C1 })).toBeNull();
    });
  });
}

export function unitOfWorkConformance(
  makeUnitOfWork: () => UnitOfWork,
  makeSessionStateStore: () => SessionStateStore,
  declaration?: AdapterDeclaration,
): void {
  describe("UnitOfWork conformance", () => {
    it("returns the callback's value on success", async () => {
      expect(await makeUnitOfWork().run(async () => 42)).toBe(42);
    });

    it("propagates the callback's error", async () => {
      await expect(
        makeUnitOfWork().run(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });

    /**
     * Gated on `transactions` deliberately, and this gate documents a real divergence rather than
     * hiding one. An adapter backed by a database transaction rolls a store write back with no
     * cooperation from the caller. The in-memory reference adapter instead offers compensations via
     * its own `runTx(tx => tx.onRollback(...))`, which the bare port cannot express — so through
     * `run()` alone it rolls back nothing. Callers that rely on automatic rollback are therefore
     * only portable to adapters declaring `transactions`. See the PR discussion on #91.
     */
    gatedIt(
      declaration,
      "transactions",
      "leaves no partial write behind when the unit fails",
      async () => {
        const uow = makeUnitOfWork();
        const sessions = makeSessionStateStore();
        await expect(
          uow.run(async () => {
            await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { staged: true } });
            throw new Error("fail after the write");
          }),
        ).rejects.toThrow("fail after the write");
        // The all-or-nothing guarantee: usage and session state commit together or not at all.
        expect(await sessions.get({ tenantId: T1, conversationId: C1 })).toBeNull();
      },
    );

    it("commits the write when the unit succeeds", async () => {
      const uow = makeUnitOfWork();
      const sessions = makeSessionStateStore();
      await uow.run(async () => {
        await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { committed: true } });
      });
      expect((await sessions.get({ tenantId: T1, conversationId: C1 }))?.data).toEqual({ committed: true });
    });
  });
}
