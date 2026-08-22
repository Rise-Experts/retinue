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
  makeFixture: () => FixtureOrStore<SessionStateStore>,
  options: { readonly maxBytes?: number } = {},
): void {
  // Session state references a conversation, and Postgres enforces it with a foreign key (#97).
  const open = () => withConversation(makeFixture(), [{ tenantId: T1, conversationId: C1 }]);

  describe("SessionStateStore conformance", () => {
    it("returns null before anything is written", async () => {
      const store = await open();
      expect(await store.get({ tenantId: T1, conversationId: C1 })).toBeNull();
    });

    it("writes at expectedVersion 0 and reads back version 1", async () => {
      const store = await open();
      const put = await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { a: 1 } });
      expect(put).toMatchObject({ version: 1, data: { a: 1 } });
      expect(await store.get({ tenantId: T1, conversationId: C1 })).toMatchObject({ version: 1 });
    });

    it("increments the version on each write", async () => {
      const store = await open();
      await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { n: 1 } });
      const second = await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 1, data: { n: 2 } });
      expect(second.version).toBe(2);
    });

    it("rejects a stale expectedVersion, so concurrent runs cannot clobber each other", async () => {
      const store = await open();
      await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { n: 1 } });
      await expect(
        store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { n: 99 } }),
      ).rejects.toThrow();
      expect((await store.get({ tenantId: T1, conversationId: C1 }))?.data).toEqual({ n: 1 });
    });

    it("rejects a write beyond the size ceiling — working memory, not a document store", async () => {
      const store = await open();
      const maxBytes = options.maxBytes ?? 64 * 1024;
      const oversized = { blob: "x".repeat(maxBytes + 1_000) };
      await expect(
        store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: oversized }),
      ).rejects.toThrow();
    });

    it("enforces tenant isolation", async () => {
      const store = await open();
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

export function threadSummaryStoreConformance(
  makeFixture: () => FixtureOrStore<ThreadSummaryStore>,
): void {
  // Same foreign key as session state (#97).
  const open = () => withConversation(makeFixture(), [{ tenantId: T1, conversationId: C1 }]);

  describe("ThreadSummaryStore conformance", () => {
    it("returns null before any summary exists", async () => {
      const store = await open();
      expect(await store.latest({ tenantId: T1, conversationId: C1 })).toBeNull();
    });

    it("appends version 1 first", async () => {
      const store = await open();
      const s = await store.append({
        tenantId: T1,
        conversationId: C1,
        summary: "first",
        coversUpToMessageId: MSG,
      });
      expect(s).toMatchObject({ version: 1, summary: "first" });
    });

    it("versions successive summaries rather than overwriting", async () => {
      const store = await open();
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
      const store = await open();
      await store.append({ tenantId: T1, conversationId: C1, summary: "s", coversUpToMessageId: MSG });
      expect((await store.latest({ tenantId: T1, conversationId: C1 }))?.coversUpToMessageId).toBe(MSG);
    });

    it("enforces tenant isolation", async () => {
      const store = await open();
      await store.append({ tenantId: T1, conversationId: C1, summary: "s", coversUpToMessageId: MSG });
      expect(await store.latest({ tenantId: T2, conversationId: C1 })).toBeNull();
    });
  });
}

/**
 * A unit of work together with the store it must roll back, from **one** backend.
 *
 * The previous signature took two independent factories, which was fine for the reference adapter
 * (its compensations are in-process) and quietly wrong for Postgres: two factories produce two
 * databases, so the transaction and the write would land in different places and the rollback
 * assertion would pass or fail for reasons unrelated to transactions. A single fixture makes the
 * shared backend a requirement of the type rather than something each adapter has to remember.
 */
export type UnitOfWorkFixture = {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: SessionStateStore;
  /** Seeds the conversation the session-state foreign key requires (#97). Omitted when there is none. */
  readonly seedConversation?: (input: {
    readonly tenantId: TenantId;
    readonly conversationId: ConversationId;
  }) => Promise<void>;
};

export function unitOfWorkConformance(
  makeFixture: () => UnitOfWorkFixture,
  declaration?: AdapterDeclaration,
): void {
  /** A fresh backend per test, with its parent row seeded — so no case depends on another's order. */
  const open = async (): Promise<UnitOfWorkFixture> => {
    const fixture = makeFixture();
    // Committed before any transaction opens, so a rolled-back unit does not take the parent with it.
    await fixture.seedConversation?.({ tenantId: T1, conversationId: C1 });
    return fixture;
  };

  describe("UnitOfWork conformance", () => {
    it("returns the callback's value on success", async () => {
      const { unitOfWork } = await open();
      expect(await unitOfWork.run(async () => 42)).toBe(42);
    });

    it("propagates the callback's error", async () => {
      const { unitOfWork } = await open();
      await expect(
        unitOfWork.run(async () => {
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
     *
     * As of #98 Postgres is the first adapter for which this gate opens, so the case finally runs
     * somewhere instead of standing down everywhere — which is what AC-5 of #98 is really about.
     */
    gatedIt(
      declaration,
      "transactions",
      "leaves no partial write behind when the unit fails",
      async () => {
        const { unitOfWork, sessions } = await open();
        await expect(
          unitOfWork.run(async () => {
            await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { staged: true } });
            throw new Error("fail after the write");
          }),
        ).rejects.toThrow("fail after the write");
        // The all-or-nothing guarantee: usage and session state commit together or not at all.
        expect(await sessions.get({ tenantId: T1, conversationId: C1 })).toBeNull();
      },
    );

    it("commits the write when the unit succeeds", async () => {
      const { unitOfWork, sessions } = await open();
      await unitOfWork.run(async () => {
        await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { committed: true } });
      });
      expect((await sessions.get({ tenantId: T1, conversationId: C1 }))?.data).toEqual({ committed: true });
    });
  });
}
