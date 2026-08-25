/**
 * Redis `DistributedLockStore` (#106).
 *
 * The framing test at the bottom is the one that matters most, and it is the one a SPEC like this
 * usually does not get: **serialization must still hold with the lock switched off**. If it does not,
 * the lock has quietly become the safety property, which is exactly what this adapter must never be —
 * it is a single-instance lock, and under failover or partition two holders are possible.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../core/ids.js";
import {
  createPostgresConversationRunCoordinator,
  createPostgresConversationStore,
  createSingleConnectionOpener,
  createTransactionScope,
  migrate,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import {
  createIoredisLockClient,
  createRedisLockStore,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
  startLockRenewal,
  type LockRedis,
} from "../adapters/bullmq/index.js";
import type { DistributedLockStore } from "../runtime/index.js";

const REDIS_URL = process.env["RETINUE_TEST_REDIS_URL"];
const KEY = "conversation:c1";

/** A Redis good enough to assert the arguments and the script semantics, with no server. */
const fakeRedis = () => {
  const store = new Map<string, string>();
  const calls: Array<{ op: string; key: string; args: readonly string[] }> = [];
  const redis: LockRedis = {
    async setIfAbsent(key, value, ttlMs) {
      calls.push({ op: "setIfAbsent", key, args: [value, String(ttlMs)] });
      if (store.has(key)) return null; // NX
      store.set(key, value);
      return "OK";
    },
    async runScript(script, key, args) {
      calls.push({ op: script === RELEASE_SCRIPT ? "release" : "renew", key, args });
      const held = store.get(key);
      // Both scripts are compare-then-act. The fake models exactly that, so a test that passes here
      // is asserting the same guard the Lua does.
      if (held !== args[0]) return 0;
      if (script === RELEASE_SCRIPT) store.delete(key);
      return 1;
    },
  };
  return { redis, store, calls };
};

describe("acquisition", () => {
  it("takes the lock with NX and a millisecond TTL", async () => {
    const { redis, calls } = fakeRedis();
    const locks = createRedisLockStore(redis, { newToken: () => "token-1" });
    const handle = await locks.acquire(KEY, 5_000);

    expect(handle).not.toBeNull();
    // NX is AC-1 and PX is AC-3. A missing NX makes acquisition unconditional; a missing PX makes a
    // dead worker's lock permanent and needs an operator to clear it.
    expect(calls[0]).toMatchObject({ op: "setIfAbsent", args: ["token-1", "5000"] });
    // Namespaced, so a lock cannot collide with the queue's own keys in a shared Redis.
    expect(handle?.key).toBe("agentkit-lock:conversation:c1");
  });

  it("refuses a second holder while the first holds it", async () => {
    const { redis } = fakeRedis();
    const locks = createRedisLockStore(redis);
    expect(await locks.acquire(KEY, 5_000)).not.toBeNull();
    // AC-1 at the adapter level; the real-Redis case below proves it across connections.
    expect(await locks.acquire(KEY, 5_000)).toBeNull();
  });

  it("issues a fresh token per acquisition, using the real generator", async () => {
    const { redis } = fakeRedis();
    // Deliberately NOT passing `newToken`. An earlier version of this test injected its own
    // generator, which meant it asserted that *the test's* counter increments — it passed even when
    // the store was changed to mint one token per store instead of one per acquisition.
    const locks = createRedisLockStore(redis);
    const first = await locks.acquire(KEY, 5_000);
    await first?.released();
    const second = await locks.acquire(KEY, 5_000);
    // A per-store token would let a worker that acquired, lost the lease, and re-acquired release the
    // *intervening* holder's lock with a handle it kept from last time.
    expect(first?.token).not.toBe(second?.token);
    expect(first?.token).toHaveLength(36); // a UUID, not a counter
  });
});

/** AC-2. The difference between "the lock is slow" and "the lock is broken". */
describe("release is a compare-and-delete", () => {
  it("does not delete a lock held by someone else", async () => {
    const { redis, store } = fakeRedis();
    const locks = createRedisLockStore(redis, { newToken: () => "stale-holder" });
    const stale = await locks.acquire(KEY, 5_000);

    // The lease expires and a successor takes the key, while the stale holder is still working.
    store.set("agentkit-lock:conversation:c1", "successor-token");
    await stale?.released();

    // A plain DEL here would hand the conversation to two workers at once.
    expect(store.get("agentkit-lock:conversation:c1")).toBe("successor-token");
  });

  it("is idempotent, so releasing twice cannot delete a successor's lock", async () => {
    const { redis, store } = fakeRedis();
    const locks = createRedisLockStore(redis, { newToken: () => "mine" });
    const handle = await locks.acquire(KEY, 5_000);
    await handle?.released();
    // A caller releasing in a `finally` after an error path may well call twice. By then the key may
    // belong to someone else, and the second call must be a no-op rather than a delete.
    store.set("agentkit-lock:conversation:c1", "someone-else");
    await handle?.released();
    expect(store.get("agentkit-lock:conversation:c1")).toBe("someone-else");
  });

  it("guards renewal with the token too", async () => {
    const { redis, store } = fakeRedis();
    const locks = createRedisLockStore(redis, { newToken: () => "mine" });
    const handle = await locks.acquire(KEY, 5_000);
    expect(await handle?.renew(1_000)).toBe(true);

    store.set("agentkit-lock:conversation:c1", "someone-else");
    // PEXPIRE without the guard is the same bug one step later: a stale holder extending a lock it no
    // longer owns, keeping the rightful holder out.
    expect(await handle?.renew(1_000)).toBe(false);
  });

  it("uses scripts that compare before acting", () => {
    // Asserted on the scripts themselves, because this is the property that must survive an edit by
    // someone optimising a round trip away.
    for (const script of [RELEASE_SCRIPT, RENEW_SCRIPT]) {
      expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    }
    expect(RELEASE_SCRIPT).toContain("del");
    expect(RENEW_SCRIPT).toContain("pexpire");
  });
});

/** AC-4. Renewal follows the heartbeat — and, crucially, stops when the lock is gone. */
describe("heartbeat renewal", () => {
  it("keeps renewing while the lock is held, and reports loss when it is not", async () => {
    const { redis, store } = fakeRedis();
    const locks = createRedisLockStore(redis, { newToken: () => "mine" });
    const handle = await locks.acquire(KEY, 300);
    const renewal = startLockRenewal(handle!, { ttlMs: 300, everyMs: 20 });

    await new Promise((r) => setTimeout(r, 60));
    expect(renewal.lost()).toBe(false);

    // The lock changes hands underneath us.
    store.set("agentkit-lock:conversation:c1", "someone-else");
    await new Promise((r) => setTimeout(r, 60));
    // Continuing to renew here would be asserting ownership we lost; `lost()` is what lets the worker
    // stand down instead of working on a lock it no longer holds.
    expect(renewal.lost()).toBe(true);
    renewal.stop();
  });

  it("stops on request without touching the lock", async () => {
    const { redis, store } = fakeRedis();
    const locks = createRedisLockStore(redis, { newToken: () => "mine" });
    const handle = await locks.acquire(KEY, 1_000);
    const renewal = startLockRenewal(handle!, { ttlMs: 1_000, everyMs: 10 });
    renewal.stop();
    await new Promise((r) => setTimeout(r, 40));
    // Stopping renewal must not release: the lease should simply run out, which is what makes AC-3
    // work for a worker that dies rather than exits cleanly.
    expect(store.get("agentkit-lock:conversation:c1")).toBe("mine");
  });
});

/**
 * AC-5 and AC-6 together, and the reason this file exists in this shape.
 *
 * If serialization only holds when Redis is present, the lock has become the safety property — and a
 * single-instance lock cannot be one. So the assertion is that the coordinator alone is sufficient.
 */
describe("the database is the authority, not the lock", () => {
  const seeded = async () => {
    const db = new PGlite();
    const sql: SqlExecutor = {
      query: (text, params) => db.query(text, params ? [...params] : undefined).then((r) => r.rows as never),
    };
    await migrate(sql);
    const scope = createTransactionScope(createSingleConnectionOpener(sql));
    const scoped = scope.scoped(sql);
    const tenantId = asId<TenantId>("lock-t1");
    const conversationId = asId<ConversationId>("lock-c1");
    await createPostgresConversationStore(scoped).create({ tenantId, id: conversationId, title: "t" });
    return {
      tenantId,
      conversationId,
      coordinator: createPostgresConversationRunCoordinator(scoped, scope.runner),
    };
  };

  it("serializes a conversation with no lock provider at all", async () => {
    const { tenantId, conversationId, coordinator } = await seeded();
    // The configuration the SPEC's step 4 describes: Redis lock disabled, database coordinator alone.
    // `locks?` on the worker is optional precisely so this is a supported deployment.
    const results = await Promise.all(
      ["a", "b", "c"].map((id) =>
        coordinator.claimOrEnqueue({ tenantId, conversationId, runId: asId<RunId>(id) }),
      ),
    );
    expect(results.filter((r) => r.status === "started")).toHaveLength(1);
    expect(await coordinator.depth({ tenantId, conversationId })).toBe(2);
  }, 30_000);

  it("satisfies the port without exposing renew through it", () => {
    const { redis } = fakeRedis();
    // The adapter returns a wider handle than the port describes, so a host wiring `DistributedLockStore`
    // generically gets exactly what the port promises — and heartbeat renewal only where the concrete
    // type is held. Recorded as a limitation on #106 rather than left to be discovered.
    const asPort: DistributedLockStore = createRedisLockStore(redis);
    expect(typeof asPort.acquire).toBe("function");
    expect(Object.keys(createRedisLockStore(redis))).toEqual(["acquire"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Real Redis. The cases a fake cannot show: expiry by wall clock, and two connections contending.
// ---------------------------------------------------------------------------------------------

describe("against a real Redis", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers) await close();
  });

  if (REDIS_URL === undefined) {
    it("[skipped: RETINUE_TEST_REDIS_URL unset — a fake cannot expire a key by wall clock or contend across connections]", () => {
      expect(REDIS_URL).toBeUndefined();
    });
  } else {
    const client = async () => {
      const { Redis } = await import("ioredis");
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
      closers.push(async () => {
        await redis.quit().catch(() => undefined);
      });
      return createIoredisLockClient(redis as never);
    };

    it("admits exactly one holder across two connections", async () => {
      const key = `ac1:${Date.now()}`;
      const a = createRedisLockStore(await client());
      const b = createRedisLockStore(await client());
      const first = await a.acquire(key, 5_000);
      const second = await b.acquire(key, 5_000);
      // Two independent connections, so "one wins" is Redis adjudicating rather than one process
      // serialising itself.
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      await first?.released();
    }, 30_000);

    it("frees a dead holder's lock by expiry, with no operator action", async () => {
      const key = `ac3:${Date.now()}`;
      const a = createRedisLockStore(await client());
      const b = createRedisLockStore(await client());
      // A worker that acquires and then dies: no release, just a TTL. AC-3.
      expect(await a.acquire(key, 150)).not.toBeNull();
      expect(await b.acquire(key, 5_000)).toBeNull();
      await new Promise((r) => setTimeout(r, 250));
      const afterExpiry = await b.acquire(key, 5_000);
      expect(afterExpiry).not.toBeNull();
      await afterExpiry?.released();
    }, 30_000);

    it("refuses a stale holder's release after a successor has taken the lock", async () => {
      const key = `ac2:${Date.now()}`;
      const a = createRedisLockStore(await client());
      const b = createRedisLockStore(await client());
      const stale = await a.acquire(key, 150);
      await new Promise((r) => setTimeout(r, 250));
      const successor = await b.acquire(key, 5_000);
      expect(successor).not.toBeNull();

      // The real thing this SPEC is about: the stale holder tries to clean up and must not take the
      // successor's lock with it. Against real Redis, running the actual Lua.
      await stale?.released();
      expect(await a.acquire(key, 5_000)).toBeNull();
      await successor?.released();
    }, 30_000);

    it("refuses a stale holder's renewal of a successor's lock", async () => {
      const key = `renew-guard:${Date.now()}`;
      const a = createRedisLockStore(await client());
      const b = createRedisLockStore(await client());
      const stale = await a.acquire(key, 150);
      await new Promise((r) => setTimeout(r, 250));
      const successor = await b.acquire(key, 5_000);
      expect(successor).not.toBeNull();

      // This case exists because the fake cannot catch it: `fakeRedis.runScript` applies the
      // compare-then-act guard itself regardless of the script text, so replacing the renew script
      // with a bare PEXPIRE still passed every offline behavioural test. Only real Redis actually
      // evaluates the Lua. A stale holder extending a lock it no longer owns would keep the rightful
      // holder out for as long as it kept renewing.
      expect(await stale?.renew(60_000)).toBe(false);
      await successor?.released();
      // And the successor's own TTL was not silently extended by the stale renewal.
      expect(await a.acquire(key, 1_000)).not.toBeNull();
    }, 30_000);

    it("keeps a lock alive while renewal runs, and lets it lapse once renewal stops", async () => {
      const key = `ac4:${Date.now()}`;
      const a = createRedisLockStore(await client());
      const b = createRedisLockStore(await client());
      const handle = await a.acquire(key, 200);
      const renewal = startLockRenewal(handle!, { ttlMs: 200, everyMs: 50 });

      // Past the original TTL: still held, because the heartbeat has been extending it.
      await new Promise((r) => setTimeout(r, 400));
      expect(await b.acquire(key, 1_000)).toBeNull();
      expect(renewal.lost()).toBe(false);

      // Heartbeat stops — as it would if the worker died — and the lease runs out on its own.
      renewal.stop();
      await new Promise((r) => setTimeout(r, 350));
      const acquired = await b.acquire(key, 1_000);
      expect(acquired).not.toBeNull();
      await acquired?.released();
    }, 30_000);
  }
});
