/**
 * Redis `DistributedLockStore` (#106) — per-conversation mutual exclusion across worker processes.
 *
 * **Read this before relying on it for safety, because you should not.** This is a single-instance
 * lock. Under a Redis failover, a network partition, or a clock jump, two holders are possible. It is
 * *not* a consensus lock and no amount of care in this file makes it one.
 *
 * The safety property lives in the database, where #98 put it: the run coordinator's slot table with
 * `SELECT … FOR UPDATE`, and `RunStore`'s lease compare-and-set. The worker already says as much where
 * it declares this dependency — *"Optional belt-and-suspenders mutual exclusion around the atomic
 * claim"* — and `locks?` is optional precisely so a deployment can run without it.
 *
 * What this buys is **contention**: workers that would otherwise all pile onto the same slot row back
 * off at Redis instead. That is worth having on a hot path, and it is all it is worth.
 */
import { randomUUID } from "node:crypto";
import type { DistributedLockStore } from "../../runtime/index.js";

/**
 * The Redis surface this lock needs, kept narrow deliberately.
 *
 * Not `ioredis`'s `Redis` directly: its `set` is heavily overloaded, so relying on structural
 * compatibility would make an accidental argument-order change typecheck. `createIoredisLockClient`
 * adapts it explicitly instead.
 */
export interface LockRedis {
  /** `SET key value PX ttl NX` — returns "OK" when it took the lock, null when someone else holds it. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<string | null>;
  /** `EVAL script numKeys key arg…` — returns the script's integer reply. */
  runScript(script: string, key: string, args: readonly string[]): Promise<number>;
}

/**
 * Release, guarded by the token.
 *
 * A plain `DEL` is the bug this exists to avoid: a holder whose lease expired *while it was still
 * working* would delete its successor's lock, and two workers would then believe they hold the
 * conversation. That turns "the lock is slow" into "the lock is broken", which is AC-2.
 */
export const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/**
 * Renew, guarded by the same token.
 *
 * `PEXPIRE` on its own is the same bug one step later: a stale holder would extend a lock it no longer
 * owns, keeping the rightful holder out.
 */
export const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

/** What the adapter actually returns. Wider than the port, which has no `renew`. */
export type LockHandle = {
  /** Compare-and-delete. Safe to call twice; safe to call after expiry. */
  readonly released: () => Promise<void>;
  /** Compare-and-extend. `false` means the lock is no longer ours — stop working. */
  readonly renew: (ttlMs?: number) => Promise<boolean>;
  /** Unique per acquisition, not per worker. See `createRedisLockStore`. */
  readonly token: string;
  readonly key: string;
};

export type RedisLockOptions = {
  /** Namespace, so a lock cannot collide with the queue's own keys. */
  readonly keyPrefix?: string;
  /** Injectable for tests. Production uses `crypto.randomUUID`. */
  readonly newToken?: () => string;
};

/**
 * What this adapter's handle actually carries — declared, because it was not.
 *
 * `acquire` was typed as returning the port's `LockHandle`, which is `{ released }` and nothing else, while the
 * implementation returned `token`, `key` and `renew` as well. Three real capabilities, invisible to every typed
 * caller: `renew` in particular is the whole lease-extension mechanism and could not be called at all without
 * casting. The port stays narrow on purpose — a Postgres advisory lock has no token or namespaced key in this
 * sense — so the *adapter* is the right place to say what it adds.
 */
export type RedisLockHandle = LockHandle & {
  /** Per acquisition, never per store — see `newToken`. Releasing checks it, so it is the ownership proof. */
  readonly token: string;
  /** The namespaced key, so a lock cannot collide with the queue's own keys in a shared Redis. */
  readonly key: string;
  /** Extends the lease. Returns false once released, and false if another holder has taken the key. */
  renew(nextTtlMs?: number): Promise<boolean>;
};

/**
 * `Omit` rather than an intersection, and the difference is not cosmetic.
 *
 * `DistributedLockStore & { acquire(...) }` makes `acquire` an *overload set*, and a call resolves against the
 * first signature — the port's, returning the narrow `LockHandle`. So the widened return type was written,
 * compiled, and had no effect on any caller. Omitting the member first replaces it instead of adding to it.
 */
export type RedisLockStore = Omit<DistributedLockStore, "acquire"> & {
  acquire(key: string, ttlMs: number): Promise<RedisLockHandle | null>;
};

export const createRedisLockStore = (
  redis: LockRedis,
  options: RedisLockOptions = {},
): RedisLockStore => {
  const prefix = options.keyPrefix ?? "agentkit-lock:";
  // Per *acquisition*, not per worker. A worker that acquires, loses the lease, and re-acquires must
  // not be able to release the intervening holder's lock with a handle it kept from last time.
  const newToken = options.newToken ?? (() => randomUUID());

  return {
    async acquire(key: string, ttlMs: number): Promise<RedisLockHandle | null> {
      const namespaced = `${prefix}${key}`;
      const token = newToken();
      // NX is the mutual exclusion; PX is AC-3. Together they mean a dead holder's lock frees itself
      // with no reaper, no operator, and no second liveness clock to drift out of step.
      const acquired = await redis.setIfAbsent(namespaced, token, ttlMs);
      if (acquired === null) return null;

      let releasedAlready = false;
      return {
        token,
        key: namespaced,
        async released() {
          // Idempotent: a caller that releases in a `finally` after an error path may well call twice,
          // and the second call must not become a delete of whatever holds the key by then.
          if (releasedAlready) return;
          releasedAlready = true;
          await redis.runScript(RELEASE_SCRIPT, namespaced, [token]);
        },
        async renew(nextTtlMs = ttlMs) {
          if (releasedAlready) return false;
          const extended = await redis.runScript(RENEW_SCRIPT, namespaced, [token, String(nextTtlMs)]);
          return extended === 1;
        },
      };
    },
  };
};

/**
 * Adapts `ioredis` explicitly. The argument order of `SET key value PX ttl NX` matters and is easy to
 * transpose, so it is written once here rather than at every call site.
 */
export const createIoredisLockClient = (redis: {
  set(...args: readonly (string | number)[]): Promise<string | null>;
  eval(...args: readonly (string | number)[]): Promise<unknown>;
}): LockRedis => ({
  async setIfAbsent(key, value, ttlMs) {
    return redis.set(key, value, "PX", Math.max(1, Math.floor(ttlMs)), "NX");
  },
  async runScript(script, key, args) {
    const reply = await redis.eval(script, 1, key, ...args);
    return Number(reply ?? 0);
  },
});

export type RenewalHandle = { readonly stop: () => void; readonly lost: () => boolean };

/**
 * Heartbeat-driven renewal (AC-4).
 *
 * Renews on a timer and **stops the moment a renewal fails**. That is the important half: a renewal
 * that returns false means the lock is no longer ours, and continuing to renew would be asserting
 * ownership we lost. `lost()` lets the worker notice and stand down rather than carrying on with a
 * lock it does not hold — the same shape as the worker's existing `ClaimLostError` path.
 *
 * Renews at a fraction of the TTL rather than at the TTL, so one slow round trip does not drop a lock
 * that is still legitimately held.
 */
export const startLockRenewal = (
  handle: LockHandle,
  options: { readonly ttlMs: number; readonly everyMs?: number },
): RenewalHandle => {
  const everyMs = options.everyMs ?? Math.max(1, Math.floor(options.ttlMs / 3));
  let lost = false;
  const timer = setInterval(() => {
    void handle
      .renew(options.ttlMs)
      .then((ok) => {
        if (!ok) {
          lost = true;
          clearInterval(timer);
        }
      })
      .catch(() => {
        // A failed round trip is not proof the lock is gone, but it is not proof it is held either.
        // Treated as lost, because the alternative is a worker that keeps working on a maybe.
        lost = true;
        clearInterval(timer);
      });
  }, everyMs);
  // Never hold the process open: a renewal timer must not be the reason a worker cannot exit.
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    lost: () => lost,
  };
};
