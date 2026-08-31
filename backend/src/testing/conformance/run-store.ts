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
import type { AgentId, ConversationId, PrincipalId, RunId, TenantId } from "../../core/ids.js";
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

    /**
     * The run remembers who it is for — #164.
     *
     * A run carried a tenant and no principal, so a durable worker had nothing to rebuild the caller's identity
     * from and every host invented one. An adapter that dropped these on write would restore that bug while
     * every other test still passed.
     */
    it("records the principal and roles a run was admitted for", async () => {
      const store = makeStore();
      await store.create({
        tenantId: T1,
        id: run("r-who"),
        conversationId: CONVO,
        agentId: AGENT,
        agentVersion: 1,
        principalId: asId<PrincipalId>("conf-principal-1"),
        roleIds: ["viewer", "auditor"],
      });
      const found = await store.findById({ tenantId: T1, id: run("r-who") });
      expect(found?.principalId).toBe("conf-principal-1");
      // Order preserved and nothing added: roles are compared against a policy, and a reordered or padded list
      // is a different authorization question.
      expect(found?.roleIds).toEqual(["viewer", "auditor"]);
    });

    /**
     * Absent is absent. A run created before this was recorded, or by a caller that supplied nothing, must not
     * come back with an invented identity or an empty role list that reads like "a caller with no roles".
     */
    it("leaves the principal and roles undefined when none were supplied", async () => {
      const store = makeStore();
      await seed(store, "r-anon");
      const found = await store.findById({ tenantId: T1, id: run("r-anon") });
      expect(found?.principalId).toBeUndefined();
      expect(found?.roleIds).toBeUndefined();
    });

    it("creates a run that belongs to no conversation", async () => {
      /**
       * The whole point of #198. A triggered automation — a webhook, a schedule, a flow step — has no
       * conversation, and until now had to invent one to exist at all.
       *
       * `conversationId` must come back **absent**, not as an empty string or a placeholder. That is what
       * distinguishes "belongs to no conversation" from "belongs to a conversation whose id we lost", and the
       * difference decides whether every conversation-scoped query silently matches it.
       */
      const store = makeStore();
      const created = await store.create({ tenantId: T1, id: run("no-convo"), agentId: AGENT, agentVersion: 1 });
      expect(created.conversationId).toBeUndefined();
      expect(created.status).toBe("queued");

      const read = await store.findById({ tenantId: T1, id: run("no-convo") });
      expect(read?.conversationId).toBeUndefined();
      // Not the empty string, which a NOT NULL column would have forced a caller to write.
      expect(read?.conversationId).not.toBe("");
    });

    it("keeps a conversation-less run separate from one in a conversation", async () => {
      // Both exist, and neither acquires the other's conversation. A store that defaulted the absent one to
      // some sentinel would make them collide in any query grouped by conversation.
      const store = makeStore();
      await store.create({ tenantId: T1, id: run("in-convo"), conversationId: CONVO, agentId: AGENT, agentVersion: 1 });
      await store.create({ tenantId: T1, id: run("free"), agentId: AGENT, agentVersion: 1 });
      expect((await store.findById({ tenantId: T1, id: run("in-convo") }))?.conversationId).toBe(CONVO);
      expect((await store.findById({ tenantId: T1, id: run("free") }))?.conversationId).toBeUndefined();
    });

    it("claims and completes a conversation-less run like any other", async () => {
      // The lifecycle must not depend on having a conversation, or an automation could be admitted and never
      // executed — which would be the worst possible reading of "supported".
      const store = makeStore();
      await store.create({ tenantId: T1, id: run("free-2"), agentId: AGENT, agentVersion: 1 });
      const claimed = await store.claim({
        tenantId: T1, id: run("free-2"), workerId: "w1", leaseMs: 30_000, now: T0,
      });
      expect(claimed?.status).toBe("running");
      const done = await store.transition({
        tenantId: T1, id: run("free-2"), workerId: "w1", to: "completed", now: T30,
      });
      expect(done.status).toBe("completed");
      expect(done.conversationId).toBeUndefined();
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

  /**
   * The per-tenant concurrent-run limit — REQ-058 (#246), task #265.
   *
   * In the conformance harness rather than beside the memory adapter, deliberately: the guarantee is that the
   * count and the claim are **one atomic operation**, and that is a claim about SQL as much as about
   * JavaScript. The reference adapter gets atomicity free — no await between the count and the write — so
   * testing only there would prove nothing about the adapter where it is hard.
   */
  describe("per-tenant concurrency, on the lease", () => {
    it("refuses a claim once the tenant holds its limit of live leases", async () => {
      const store = makeStore();
      for (const n of [1, 2, 3]) await seed(store, `c${n}`);

      expect(await store.claim({ tenantId: T1, id: run("c1"), workerId: "w1", leaseMs: 60_000, now: T0, maxConcurrent: 2 })).not.toBeNull();
      expect(await store.claim({ tenantId: T1, id: run("c2"), workerId: "w2", leaseMs: 60_000, now: T0, maxConcurrent: 2 })).not.toBeNull();
      // Two live leases, limit two: the third gets nothing.
      expect(await store.claim({ tenantId: T1, id: run("c3"), workerId: "w3", leaseMs: 60_000, now: T0, maxConcurrent: 2 })).toBeNull();
      expect(await store.countLive({ tenantId: T1, now: T0 })).toBe(2);
      // And it is still queued, not lost — the run waits rather than being discarded.
      expect((await store.findById({ tenantId: T1, id: run("c3") }))?.status).toBe("queued");
    });

    it("two concurrent claims for one free slot admit exactly one — AC-3", async () => {
      const store = makeStore();
      await seed(store, "race-holder");
      await seed(store, "race-a");
      await seed(store, "race-b");
      await store.claim({ tenantId: T1, id: run("race-holder"), workerId: "w0", leaseMs: 60_000, now: T0, maxConcurrent: 2 });

      /**
       * Issued without awaiting between them, which is what makes this a race rather than a sequence.
       *
       * Against the reference adapter both run in one turn of the event loop; against SQL they are two
       * statements in flight at once. A check-then-act implementation passes the sequential test above and
       * fails this one — which is why both exist.
       */
      const [a, b] = await Promise.all([
        store.claim({ tenantId: T1, id: run("race-a"), workerId: "wa", leaseMs: 60_000, now: T0, maxConcurrent: 2 }),
        store.claim({ tenantId: T1, id: run("race-b"), workerId: "wb", leaseMs: 60_000, now: T0, maxConcurrent: 2 }),
      ]);
      expect([a, b].filter((claimed) => claimed !== null)).toHaveLength(1);
      expect(await store.countLive({ tenantId: T1, now: T0 })).toBe(2);
    });

    it("reclaims a crashed worker's slot with no operator action — AC-2", async () => {
      const store = makeStore();
      await seed(store, "crashed");
      await seed(store, "waiting");
      // A worker takes the only slot, then dies: no transition, no release, just a lease that stops being
      // renewed. This is the case a decrement-on-completion counter never recovers from.
      await store.claim({ tenantId: T1, id: run("crashed"), workerId: "dead", leaseMs: 1_000, now: T0, maxConcurrent: 1 });
      expect(await store.claim({ tenantId: T1, id: run("waiting"), workerId: "w2", leaseMs: 60_000, now: T0, maxConcurrent: 1 })).toBeNull();

      // Time passes. Nothing else happens — no reaper, no restart, no intervention.
      expect(await store.countLive({ tenantId: T1, now: T90 })).toBe(0);
      expect(await store.claim({ tenantId: T1, id: run("waiting"), workerId: "w2", leaseMs: 60_000, now: T90, maxConcurrent: 1 })).not.toBeNull();
    });

    it("does not count a run against its own recovery", async () => {
      const store = makeStore();
      await seed(store, "recovering");
      await store.claim({ tenantId: T1, id: run("recovering"), workerId: "dead", leaseMs: 1_000, now: T0, maxConcurrent: 1 });
      // The lease has expired and this run is the tenant's only one. A limit of 1 must not block the recovery
      // of the very run whose lease is being replaced.
      expect(await store.claim({ tenantId: T1, id: run("recovering"), workerId: "w2", leaseMs: 60_000, now: T90, maxConcurrent: 1 })).not.toBeNull();
    });

    it("counts each tenant separately — AC-5", async () => {
      const store = makeStore();
      await seed(store, "t1-a", T1);
      await seed(store, "t2-a", T2);
      await store.claim({ tenantId: T1, id: run("t1-a"), workerId: "w1", leaseMs: 60_000, now: T0, maxConcurrent: 1 });
      // T1 is full. T2 is untouched by that, and a shared counter would be the bug this catches.
      expect(await store.claim({ tenantId: T2, id: run("t2-a"), workerId: "w2", leaseMs: 60_000, now: T0, maxConcurrent: 1 })).not.toBeNull();
      expect(await store.countLive({ tenantId: T1, now: T0 })).toBe(1);
      expect(await store.countLive({ tenantId: T2, now: T0 })).toBe(1);
    });

    it("absent or zero means unlimited — AC-6", async () => {
      const store = makeStore();
      for (const n of [1, 2, 3, 4]) await seed(store, `u${n}`);
      // The branch that matters on the day this ships: a deployment that has configured nothing keeps working.
      expect(await store.claim({ tenantId: T1, id: run("u1"), workerId: "w", leaseMs: 60_000, now: T0 })).not.toBeNull();
      expect(await store.claim({ tenantId: T1, id: run("u2"), workerId: "w", leaseMs: 60_000, now: T0 })).not.toBeNull();
      expect(await store.claim({ tenantId: T1, id: run("u3"), workerId: "w", leaseMs: 60_000, now: T0, maxConcurrent: 0 })).not.toBeNull();
      expect(await store.claim({ tenantId: T1, id: run("u4"), workerId: "w", leaseMs: 60_000, now: T0, maxConcurrent: 0 })).not.toBeNull();
      expect(await store.countLive({ tenantId: T1, now: T0 })).toBe(4);
    });

    it("a released slot is available immediately", async () => {
      const store = makeStore();
      await seed(store, "first");
      await seed(store, "second");
      await store.claim({ tenantId: T1, id: run("first"), workerId: "w1", leaseMs: 60_000, now: T0, maxConcurrent: 1 });
      expect(await store.claim({ tenantId: T1, id: run("second"), workerId: "w2", leaseMs: 60_000, now: T0, maxConcurrent: 1 })).toBeNull();
      // A terminal transition releases the lease, so the slot returns without waiting for an expiry.
      await store.transition({ tenantId: T1, id: run("first"), workerId: "w1", to: "completed", now: T0 });
      expect(await store.countLive({ tenantId: T1, now: T0 })).toBe(0);
      expect(await store.claim({ tenantId: T1, id: run("second"), workerId: "w2", leaseMs: 60_000, now: T0, maxConcurrent: 1 })).not.toBeNull();
    });
  });
  });
}
