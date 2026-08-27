/**
 * The rate limiter against a real Redis — task #248, AC-2 and AC-3.
 *
 * These are the cases a fake cannot show, and they are the ones the whole task turns on:
 *
 * - **Correct across processes.** Two independent connections sharing a tenant's limit must not each allow the
 *   full rate. A per-process `Map` passes every unit test and makes a 60/minute limit into 60×N in a fleet.
 * - **The counter has a TTL.** `INCR` then `EXPIRE` is the obvious implementation and it is wrong: a process
 *   dying between the two leaves a key with no expiry and refuses that tenant for ever. Only a real Redis can
 *   show a TTL was actually set.
 * - **State survives a restart.** A new connection must see the count a previous one left, or a worker restart
 *   hands a tenant a fresh allowance.
 */
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import { createRedisRateLimitStore, rateLimitKey } from "../adapters/redis/rate-limit.js";
import { createRateLimitGuard, windowStartMs } from "../usage/rate-limit.js";
import { rateLimitStoreConformance } from "../testing/conformance/rate-limit.js";

const REDIS_URL = process.env["RETINUE_TEST_REDIS_URL"];

/** Connections the conformance block opens, closed once at the end of the file. */
const conformanceClosers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of conformanceClosers) await close();
});

const ctx = (tenant: string): ExecutionContext => ({
  tenantId: asId<TenantId>(tenant),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

describe("rate limiting against a real Redis", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers) await close();
  });

  if (REDIS_URL === undefined) {
    it("[skipped: RETINUE_TEST_REDIS_URL unset — a per-process Map cannot show cross-process correctness or a TTL]", () => {
      expect(REDIS_URL).toBeUndefined();
    });
  } else {
    const client = async () => {
      const { Redis } = await import("ioredis");
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      closers.push(async () => {
        await redis.quit();
      });
      return redis;
    };

    /** A distinct tenant per test, so a rerun inside the same window cannot inherit a count. */
    const tenant = (suffix: string) => `rl-${suffix}-${windowStartMs(Date.now(), 60)}`;

    it("shares one tenant's allowance across two independent connections — AC-2", async () => {
      // The property that makes this a rate limit rather than a per-process suggestion. Two clients, one limit
      // of 5: exactly 5 admissions between them, not 5 each.
      const a = createRateLimitGuard({
        store: createRedisRateLimitStore(await client()),
        policyFor: () => ({ max: 5, windowSeconds: 60 }),
      });
      const b = createRateLimitGuard({
        store: createRedisRateLimitStore(await client()),
        policyFor: () => ({ max: 5, windowSeconds: 60 }),
      });
      const t = tenant("shared");
      const results: boolean[] = [];
      for (let i = 0; i < 4; i += 1) {
        results.push((await a.admit(ctx(t))).admitted);
        results.push((await b.admit(ctx(t))).admitted);
      }
      expect(results.filter(Boolean)).toHaveLength(5);
      expect(results.slice(0, 5).every(Boolean)).toBe(true);
      expect(results.slice(5).some(Boolean)).toBe(false);
    }, 30_000);

    it("is correct when both connections admit concurrently", async () => {
      // Sequential alternation could pass with a read-then-write race still present. Twenty concurrent
      // admissions against a limit of 5 must admit exactly 5 — which is what the atomic script buys.
      const stores = await Promise.all([client(), client()].map(async (c) => createRedisRateLimitStore(await c)));
      const guards = stores.map((store) =>
        createRateLimitGuard({ store, policyFor: () => ({ max: 5, windowSeconds: 60 }) }),
      );
      const t = tenant("concurrent");
      const decisions = await Promise.all(
        Array.from({ length: 20 }, (_, i) => guards[i % guards.length]!.admit(ctx(t))),
      );
      expect(decisions.filter((d) => d.admitted)).toHaveLength(5);
    }, 30_000);

    it("sets a TTL on the counter, so a dead process cannot lock a tenant out for ever — AC-3", async () => {
      // The specific defect of INCR-then-EXPIRE. A key with no TTL refuses that tenant permanently, and nothing
      // notices except a customer.
      const redis = await client();
      const guard = createRateLimitGuard({
        store: createRedisRateLimitStore(redis),
        policyFor: () => ({ max: 2, windowSeconds: 60 }),
      });
      const t = tenant("ttl");
      await guard.admit(ctx(t));
      const ttl = await redis.ttl(rateLimitKey(t, windowStartMs(Date.now(), 60)));
      expect(ttl).toBeGreaterThan(0);
      // Window plus the second of slack, and never unbounded (`-1` means no expiry).
      expect(ttl).toBeLessThanOrEqual(61);
    }, 30_000);

    it("survives a restart — a new connection sees what the old one counted", async () => {
      const t = tenant("restart");
      const first = createRedisRateLimitStore(await client());
      const g1 = createRateLimitGuard({ store: first, policyFor: () => ({ max: 3, windowSeconds: 60 }) });
      await g1.admit(ctx(t));
      await g1.admit(ctx(t));
      await g1.admit(ctx(t));
      // A wholly new client, as a restarted worker would have.
      const g2 = createRateLimitGuard({
        store: createRedisRateLimitStore(await client()),
        policyFor: () => ({ max: 3, windowSeconds: 60 }),
      });
      expect((await g2.admit(ctx(t))).admitted).toBe(false);
    }, 30_000);

    it("keeps tenants separate — AC-5", async () => {
      const store = createRedisRateLimitStore(await client());
      const guard = createRateLimitGuard({ store, policyFor: () => ({ max: 1, windowSeconds: 60 }) });
      const a = tenant("iso-a");
      const b = tenant("iso-b");
      expect((await guard.admit(ctx(a))).admitted).toBe(true);
      expect((await guard.admit(ctx(a))).admitted).toBe(false);
      // b is untouched by a exhausting its window.
      expect((await guard.admit(ctx(b))).admitted).toBe(true);
    }, 30_000);

    it("fails closed on a nonsense reply rather than admitting everything", async () => {
      // A rate limiter that fails *open* silently is worse than none: the failure is invisible until the bill.
      const store = createRedisRateLimitStore({ async eval() { return "not-a-number"; } });
      const guard = createRateLimitGuard({ store, policyFor: () => ({ max: 1, windowSeconds: 60 }) });
      await expect(guard.admit(ctx("whatever"))).rejects.toThrow(/is not a count/);
    });
  }
});

/**
 * The port contract against the real adapter — AC-6.
 *
 * Outside the gated block above because the harness must be *registered* for the coverage guard to find it; when
 * `RETINUE_TEST_REDIS_URL` is unset it runs against a stub that satisfies the contract, so the suite still
 * passes on a machine with no Redis while the real run exercises the same clauses.
 */
rateLimitStoreConformance(
  REDIS_URL === undefined ? "redis (stubbed — RETINUE_TEST_REDIS_URL unset)" : "redis",
  async () => {
    if (REDIS_URL === undefined) {
      const counts = new Map<string, number>();
      return {
        async consume({ tenantId, windowStartMs: w }) {
          const key = `${tenantId}:${w}`;
          const next = (counts.get(key) ?? 0) + 1;
          counts.set(key, next);
          return next;
        },
      };
    }
    const { Redis } = await import("ioredis");
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    conformanceClosers.push(async () => {
      await redis.quit();
    });
    return createRedisRateLimitStore(redis);
  },
  () => `${process.pid}-${windowStartMs(Date.now(), 60)}`,
);
