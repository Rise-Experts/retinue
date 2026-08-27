/**
 * The rate-limit counter in Redis — task #248, AC-2 and AC-3.
 *
 * The real implementation. An in-memory one exists for tests and is explicitly *not* usable in a deployment: two
 * workers each holding their own `Map` would each allow the full rate, so a limit of 60/minute becomes 60×N.
 *
 * ## One script, not INCR then EXPIRE
 *
 * The obvious version is `INCR key` followed by `EXPIRE key ttl`. It is wrong, and not subtly: a process that
 * dies, is killed, or loses its connection between the two leaves a key with **no TTL**, and that tenant is
 * refused for ever — a permanent outage caused by the rate limiter, with no way to notice except a customer
 * reporting it. Redis has no combined increment-and-expire command, so this is one `EVAL`, which Redis runs
 * atomically.
 *
 * `PEXPIRE … NX` inside the script would also work and is not used: the key's TTL is a constant derived from the
 * window, so setting it every increment is idempotent and one fewer thing to reason about.
 *
 * ## Why the key carries the window start
 *
 * `windowStartMs` truncates, so the key is a pure function of the moment — every process derives the same key for
 * the same instant without coordinating, and an old window's key expires on its own rather than needing a sweep.
 * It also makes the TTL safe to set unconditionally: a key is only ever written for the window it names.
 */

import type { RateLimitStore } from "../../usage/index.js";

/**
 * The one command needed, structurally — the reasoning `RedisPublishClient` gives.
 *
 * `eval` rather than `defineCommand`/`evalsha`: this runs once per admitted run, not in a tight loop, and a
 * script cache miss would need a fallback path that is more code than the saving is worth.
 */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Namespaced, so a counter cannot collide with BullMQ's keys, the realtime channels, or another app's. */
export const rateLimitKey = (tenantId: string, windowStartMs: number): string =>
  `agentkit:ratelimit:${tenantId}:${windowStartMs}`;

/**
 * Increment and set the expiry in one atomic step, returning the count after incrementing.
 *
 * The TTL is the window plus a second of slack. The slack matters: a client whose clock is a few hundred
 * milliseconds behind the server may still be admitting against a window Redis has already expired, and the
 * result would be a counter that silently restarts mid-window — the failure being prevented, arriving by a
 * different route.
 */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return count
`;

export const createRedisRateLimitStore = (client: RedisEvalClient): RateLimitStore => ({
  async consume({ tenantId, windowStartMs, windowSeconds }) {
    const count = await client.eval(
      RATE_LIMIT_SCRIPT,
      1,
      rateLimitKey(tenantId, windowStartMs),
      windowSeconds + 1,
    );
    /**
     * Coerced, and a non-numeric reply is a failure rather than a zero.
     *
     * `eval` is typed `unknown` because the client is structural. Treating an unexpected reply as `0` would make
     * a broken Redis look like an empty counter and admit everything — a rate limiter that fails open silently.
     * A throw is the right direction here: admission already refuses on a thrown error.
     */
    const used = typeof count === "number" ? count : Number(count);
    if (!Number.isFinite(used))
      throw new Error(`rate limit: Redis returned ${JSON.stringify(count)} for INCR, which is not a count`);
    return used;
  },
});
