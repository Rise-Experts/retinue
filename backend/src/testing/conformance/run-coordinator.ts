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

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const C1 = asId<ConversationId>("conf-convo-1");
const C2 = asId<ConversationId>("conf-convo-2");
const r = (s: string) => asId<RunId>(s);

export function conversationRunCoordinatorConformance(
  makeCoordinator: () => ConversationRunCoordinator,
): void {
  describe("ConversationRunCoordinator conformance", () => {
    it("starts the first run and queues the rest", async () => {
      const co = makeCoordinator();
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
      const co = makeCoordinator();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      expect(await co.active({ tenantId: T1, conversationId: C1 })).toBe("a");
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(1);
    });

    it("is idempotent for the run that already holds the slot", async () => {
      const co = makeCoordinator();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") })).toMatchObject({
        status: "started",
      });
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(0);
    });

    it("does not enqueue the same run twice", async () => {
      const co = makeCoordinator();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(1);
    });

    it("promotes the backlog in FIFO order, one run per release", async () => {
      const co = makeCoordinator();
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
      const co = makeCoordinator();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") });
      // "b" is queued, not active — releasing it must not promote anything or unseat "a".
      await co.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: r("b") });
      expect(await co.active({ tenantId: T1, conversationId: C1 })).toBe("a");
    });

    it("keeps conversations independent", async () => {
      const co = makeCoordinator();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C2, runId: r("b") })).toMatchObject({
        status: "started",
      });
    });

    it("enforces tenant isolation — the same conversation id in another tenant is a separate slot", async () => {
      const co = makeCoordinator();
      await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
      expect(await co.claimOrEnqueue({ tenantId: T2, conversationId: C1, runId: r("b") })).toMatchObject({
        status: "started",
      });
      expect(await co.active({ tenantId: T2, conversationId: C1 })).toBe("b");
    });

    it("admits exactly one starter under concurrent claims — single-flight", async () => {
      const co = makeCoordinator();
      const results = await Promise.all(
        ["a", "b", "c", "d"].map((id) =>
          co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r(id) }),
        ),
      );
      expect(results.filter((x) => x.status === "started")).toHaveLength(1);
      expect(await co.depth({ tenantId: T1, conversationId: C1 })).toBe(3);
    });
  });
}
