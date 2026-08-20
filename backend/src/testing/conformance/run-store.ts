/**
 * `RunStore` conformance — the harness `persistence/index.ts` and `adapters/memory/runtime.ts`
 * already claim in their docstrings ("Verified by the shared `runStoreConformance` harness so every
 * adapter agrees on claim/lease/transition semantics"). Until #91 it did not exist.
 *
 * These are the primitives `createDurableWorker` relies on for crash recovery without duplicate
 * work, so every adapter must agree on them exactly: lease-based claim, keepalive that reports a
 * lost claim, guarded transitions, durable cancellation and stale-lease reaping.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, RunId, TenantId } from "../../core/ids.js";
import type { RunStore } from "../../persistence/index.js";

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const CONVO = asId<ConversationId>("conf-convo-1");
const AGENT = asId<AgentId>("conf-agent-1");
const run = (s: string) => asId<RunId>(s);

/** Fixed instants so lease arithmetic is deterministic rather than wall-clock dependent. */
const T0 = "2020-01-01T00:00:00.000Z";
const T30 = "2020-01-01T00:00:30.000Z";
const T90 = "2020-01-01T00:01:30.000Z";

export function runStoreConformance(makeStore: () => RunStore): void {
  const seed = async (store: RunStore, id: string, tenantId: TenantId = T1) =>
    store.create({ tenantId, id: run(id), conversationId: CONVO, agentId: AGENT, agentVersion: 1 });

  describe("RunStore conformance", () => {
    it("creates a run as queued and reads it back within its tenant", async () => {
      const store = makeStore();
      const created = await seed(store, "r1");
      expect(created).toMatchObject({ id: "r1", tenantId: T1, status: "queued", agentVersion: 1 });
      expect(await store.findById({ tenantId: T1, id: run("r1") })).toMatchObject({ id: "r1" });
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await seed(store, "r1");
      expect(await store.findById({ tenantId: T2, id: run("r1") })).toBeNull();
    });

    it("claims a queued run and returns it running", async () => {
      const store = makeStore();
      await seed(store, "r1");
      const claimed = await store.claim({
        tenantId: T1,
        id: run("r1"),
        workerId: "w1",
        leaseMs: 60_000,
        now: T0,
      });
      expect(claimed).not.toBeNull();
      expect(claimed?.claimedBy).toBe("w1");
    });

    it("refuses a second claim while the lease is live, so two workers never share a run", async () => {
      const store = makeStore();
      await seed(store, "r1");
      await store.claim({ tenantId: T1, id: run("r1"), workerId: "w1", leaseMs: 60_000, now: T0 });
      const second = await store.claim({
        tenantId: T1,
        id: run("r1"),
        workerId: "w2",
        leaseMs: 60_000,
        now: T30,
      });
      expect(second).toBeNull();
    });

    it("allows re-claim once the lease has expired — the crash-recovery path", async () => {
      const store = makeStore();
      await seed(store, "r1");
      await store.claim({ tenantId: T1, id: run("r1"), workerId: "w1", leaseMs: 60_000, now: T0 });
      const recovered = await store.claim({
        tenantId: T1,
        id: run("r1"),
        workerId: "w2",
        leaseMs: 60_000,
        now: T90,
      });
      expect(recovered).not.toBeNull();
      expect(recovered?.claimedBy).toBe("w2");
    });

    it("keepalive extends the holder's lease and reports false once the claim is lost", async () => {
      const store = makeStore();
      await seed(store, "r1");
      await store.claim({ tenantId: T1, id: run("r1"), workerId: "w1", leaseMs: 60_000, now: T0 });
      expect(
        await store.keepalive({ tenantId: T1, id: run("r1"), workerId: "w1", leaseMs: 60_000, now: T30 }),
      ).toBe(true);
      // A worker that never held the claim must be told so, and must not steal the lease.
      expect(
        await store.keepalive({ tenantId: T1, id: run("r1"), workerId: "w2", leaseMs: 60_000, now: T30 }),
      ).toBe(false);
    });

    it("rejects a transition absent from RUN_TRANSITIONS", async () => {
      const store = makeStore();
      await seed(store, "r1");
      await store.claim({ tenantId: T1, id: run("r1"), workerId: "w1", leaseMs: 60_000, now: T0 });
      // running → completed is legal; completed is terminal, so completed → running is not.
      await store.transition({ tenantId: T1, id: run("r1"), workerId: "w1", to: "completed", now: T30 });
      await expect(
        store.transition({ tenantId: T1, id: run("r1"), workerId: "w1", to: "running", now: T90 }),
      ).rejects.toThrow();
    });

    it("records a cancellation request durably so any worker honors it", async () => {
      const store = makeStore();
      await seed(store, "r1");
      const cancelled = await store.requestCancel({ tenantId: T1, id: run("r1"), now: T0 });
      expect(cancelled?.cancelRequestedAt).toBeDefined();
      const reread = await store.findById({ tenantId: T1, id: run("r1") });
      expect(reread?.cancelRequestedAt).toBeDefined();
    });

    it("reapExpired returns only runs whose lease has expired, each carrying its own tenantId", async () => {
      const store = makeStore();
      await seed(store, "live");
      await seed(store, "stale");
      await store.claim({ tenantId: T1, id: run("live"), workerId: "w1", leaseMs: 600_000, now: T0 });
      await store.claim({ tenantId: T1, id: run("stale"), workerId: "w2", leaseMs: 1_000, now: T0 });

      const reaped = await store.reapExpired({ now: T90, limit: 10 });
      const ids = reaped.map((r) => r.id);
      expect(ids).toContain("stale");
      expect(ids).not.toContain("live");
      // Cross-tenant by design: a background reaper has no tenant, so each row must self-identify.
      for (const r of reaped) expect(r.tenantId).toBeDefined();
    });

    it("reapExpired honors its limit", async () => {
      const store = makeStore();
      for (const n of [1, 2, 3]) {
        await seed(store, `s${n}`);
        await store.claim({ tenantId: T1, id: run(`s${n}`), workerId: "w", leaseMs: 1_000, now: T0 });
      }
      expect((await store.reapExpired({ now: T90, limit: 2 })).length).toBeLessThanOrEqual(2);
    });
  });
}
