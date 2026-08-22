/**
 * `ConversationRunCoordinator` conformance — `docs/13` → run ordering. The port's own docstrings
 * are emphatic that both methods MUST be atomic: `claimOrEnqueue` with "no claim→enqueue gap" so a
 * run cannot strand itself in an idle-but-unclaimed slot, and `releaseAndPromote` with "no
 * release→dequeue→claim gap" so two runs can never both become active.
 *
 * Atomicity itself is not observable from a single-threaded caller, so these tests pin the
 * *consequences* an adapter must produce: single-flight, FIFO order, and a promotion that hands
 * back exactly one run.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../../core/ids.js";
import type { ConversationRunCoordinator } from "../../persistence/index.js";
import { gatedIt, type AdapterDeclaration } from "./capability.js";
import { openFixture, type Fixture, type FixtureOrStore } from "./parents.js";

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const C1 = asId<ConversationId>("conf-convo-1");
const C2 = asId<ConversationId>("conf-convo-2");
const r = (s: string) => asId<RunId>(s);

/** Every conversation the harness touches, so an adapter with a foreign key can seed them all. */
const CONVERSATIONS = [
  { tenantId: T1, conversationId: C1 },
  { tenantId: T1, conversationId: C2 },
  { tenantId: T2, conversationId: C1 },
] as const;

/**
 * A coordinator, plus — for adapters whose slot state lives outside the process — a way to build a
 * *second* coordinator over the same backend.
 *
 * `sibling` is what makes the `distributed-locking` case below able to discriminate at all. Two
 * independently constructed coordinators either share a slot (state is in the database) or they do
 * not (state is in the object). That is the difference between distributed and in-process, and it is
 * the most an in-process test can honestly check.
 */
export type RunCoordinatorFixture = Fixture<ConversationRunCoordinator> & {
  readonly sibling?: () => ConversationRunCoordinator;
};

export function conversationRunCoordinatorConformance(
  makeFixture: () => FixtureOrStore<ConversationRunCoordinator> | RunCoordinatorFixture,
  declaration?: AdapterDeclaration,
): void {
  /** Seed the conversations an adapter's foreign keys require, then hand back the coordinator. */
  const open = async (): Promise<ConversationRunCoordinator> => {
    const fixture = openFixture(makeFixture());
    if (fixture.seedConversation) for (const c of CONVERSATIONS) await fixture.seedConversation(c);
    return fixture.store;
  };

  describe("ConversationRunCoordinator conformance", () => {
    it("starts the first run and queues the rest", async () => {
      const co = await open();
      expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") })).toMatchObject({
        status: "started",
        position: 0,
      });
      expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") })).toMatchObject({
        status: "queued",
        position: 1,
      });
      expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("c") })).toMatchObject({
        status: "queued",
        position: 2,
      });
    });

    it("reports the active run and the backlog depth", async () => {
      const co = await open();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      expect(await co.active({ tenantId: T1, conversationId: C1 })).toBe("a");
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(1);
    });

    it("is idempotent for the run that already holds the slot", async () => {
      const co = await open();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") })).toMatchObject({
        status: "started",
      });
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(0);
    });

    it("does not enqueue the same run twice", async () => {
      const co = await open();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(1);
    });

    it("promotes the backlog in FIFO order, one run per release", async () => {
      const co = await open();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("c") });

      expect(await co.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: r("a") })).toBe("b");
      expect(await co.active({ tenantId: T1, conversationId: C1 })).toBe("b");
      expect(await co.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: r("b") })).toBe("c");
      expect(await co.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: r("c") })).toBeNull();
      expect(await co.active({ tenantId: T1, conversationId: C1 })).toBeNull();
    });

    it("ignores a release from a run that does not hold the slot", async () => {
      const co = await open();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      // "b" is queued, not active — releasing it must not promote anything or unseat "a".
      await co.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: r("b") });
      expect(await co.active({ tenantId: T1, conversationId: C1 })).toBe("a");
    });

    it("keeps conversations independent", async () => {
      const co = await open();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C2, runId: r("b") })).toMatchObject({
        status: "started",
      });
    });

    it("enforces tenant isolation — the same conversation id in another tenant is a separate slot", async () => {
      const co = await open();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      expect(await co.claimOrEnqueue({ tenantId: T2, conversationId: C1, runId: r("b") })).toMatchObject({
        status: "started",
      });
      expect(await co.active({ tenantId: T2, conversationId: C1 })).toBe("b");
    });

    it("admits exactly one starter under concurrent claims — single-flight", async () => {
      const co = await open();
      const results = await Promise.all(
        ["a", "b", "c", "d"].map((id) =>
          co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r(id) }),
        ),
      );
      expect(results.filter((x) => x.status === "started")).toHaveLength(1);
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(3);
    });

    /**
     * The first case in this suite that can actually tell a distributed coordinator from an
     * in-process one.
     *
     * Every test above passes for an adapter whose entire state is a `Map` in one object — which is
     * correct for the reference adapter and useless as a claim about `distributed-locking`. Real
     * distribution means the slot lives in the *backend*, so two coordinators built independently
     * contend for the same slot. The reference adapter fails this by construction (two calls to its
     * factory make two Maps), which is why it declares no capabilities and this case stands down for
     * it with a printed reason.
     *
     * What it still cannot prove: that the lock holds across *processes*. No in-process test can —
     * the property is about other processes. That half is covered by the two-connection test in
     * `postgres-run-coordination.test.ts`, which only runs against a real server. AC-5 of #98 is
     * therefore backed by these two together, and by neither alone.
     */
    gatedIt(
      declaration,
      "distributed-locking",
      "shares one slot between two independently constructed coordinators",
      async () => {
        const fixture = openFixture(makeFixture()) as RunCoordinatorFixture;
        if (fixture.seedConversation) for (const c of CONVERSATIONS) await fixture.seedConversation(c);
        const sibling = fixture.sibling?.();
        expect(
          sibling,
          "an adapter declaring distributed-locking must supply a sibling coordinator, or this case proves nothing",
        ).toBeDefined();
        if (!sibling) return;

        expect(
          await fixture.store.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") }),
        ).toMatchObject({ status: "started" });
        // A different coordinator object over the same database must see the slot as taken.
        expect(
          await sibling.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") }),
        ).toMatchObject({ status: "queued", position: 1 });
        // And a promotion driven through one is visible through the other.
        expect(
          await sibling.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: r("a") }),
        ).toBe("b");
        expect(await fixture.store.active({ tenantId: T1, conversationId: C1 })).toBe("b");
      },
    );
  });
}
