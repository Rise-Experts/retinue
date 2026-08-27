/**
 * Capacity is bounded per tenant — REQ-058 (#246), task #248.
 *
 * Cost quotas already gated admission. Rate did not: a thousand runs a second, each costing a fraction of a
 * cent, passed every check that existed. The tests that matter are the ones about *failing safely* — the wrong
 * default here is an outage caused by adding a safety feature.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import { isAgentPlatformError } from "../../core/errors.js";
import { createMemoryRateLimitStore } from "../../adapters/memory/rate-limit.js";
import { createRateLimitGuard, windowStartMs, type RateLimitDecision } from "../rate-limit.js";

const ctx = (tenant: string): ExecutionContext => ({
  tenantId: asId<TenantId>(tenant),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

const guard = (over: Record<string, unknown> = {}) => {
  // Exactly a 60s window start (1_699_999_980_000 % 60_000 === 0). Deliberate: windows are aligned to absolute
  // time, not to the first call, so a test that starts mid-window and ticks 59.999s crosses a boundary and reads
  // as a bug in the limiter. Starting on the boundary makes each tick's window position obvious.
  let clock = 1_699_999_980_000;
  const g = createRateLimitGuard({
    store: createMemoryRateLimitStore(),
    policyFor: () => ({ max: 3, windowSeconds: 60 }),
    now: () => clock,
    ...over,
  });
  return { g, tick: (ms: number) => { clock += ms; }, at: () => clock };
};

describe("the window is a pure function of the moment", () => {
  it("truncates, so every process agrees without coordinating", () => {
    // The same decision `bucketStartFor` makes for rollups. Two workers must derive the same key for the same
    // instant, or each counts its own window and the limit is N× what it says.
    expect(windowStartMs(60_000, 60)).toBe(60_000);
    expect(windowStartMs(119_999, 60)).toBe(60_000);
    expect(windowStartMs(120_000, 60)).toBe(120_000);
  });

  it("refuses a nonsensical window rather than inventing one", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => windowStartMs(1_000, bad)).toThrow(/positive integer/);
    }
  });
});

describe("an absent or zero limit means unlimited — AC-7", () => {
  it("admits everything when no policy is configured", async () => {
    // The branch that matters on the day this ships. A deployment that upgrades into this feature having
    // configured nothing must keep working; an outage caused by adding a safety feature is how safety features
    // get removed.
    const { g } = guard({ policyFor: () => undefined });
    for (let i = 0; i < 50; i += 1) expect((await g.admit(ctx("t1"))).admitted).toBe(true);
  });

  it("treats max: 0 as unlimited, not deny-everything", async () => {
    const { g } = guard({ policyFor: () => ({ max: 0, windowSeconds: 60 }) });
    for (let i = 0; i < 10; i += 1) expect((await g.admit(ctx("t1"))).admitted).toBe(true);
  });
});

describe("the limit binds, and reports itself honestly", () => {
  it("admits up to the limit and refuses past it", async () => {
    const { g } = guard();
    const first = await g.admit(ctx("t1"));
    expect(first).toMatchObject({ admitted: true, remaining: 2 });
    expect((await g.admit(ctx("t1"))).admitted).toBe(true);
    const last = await g.admit(ctx("t1"));
    expect(last).toMatchObject({ admitted: true, remaining: 0 });
    const refused = await g.admit(ctx("t1"));
    expect(refused.admitted).toBe(false);
  });

  it("carries when the caller may retry, never zero", async () => {
    // "Retryable" without a time is not actionable, and a zero reads as "immediately" — putting the client
    // straight back into the same refusal.
    const { g, tick } = guard();
    for (let i = 0; i < 4; i += 1) await g.admit(ctx("t1"));
    tick(30_000); // still inside the window that opened at `clock`
    const refused = (await g.admit(ctx("t1"))) as Extract<RateLimitDecision, { admitted: false }>;
    expect(refused.admitted).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    // 30s of a 60s window remain.
    expect(refused.retryAfterMs).toBe(30_000);
  });

  it("recovers when the window rolls over", async () => {
    const { g, tick } = guard();
    for (let i = 0; i < 4; i += 1) await g.admit(ctx("t1"));
    expect((await g.admit(ctx("t1"))).admitted).toBe(false);
    tick(60_000);
    expect((await g.admit(ctx("t1"))).admitted).toBe(true);
  });

  it("tells the observer about a refusal, since there is no run to hang an event on", async () => {
    // The reasoning `QuotaObserver` already gives: a `RunEvent` carries a `runId`, and this fires before a run
    // exists. Inventing a run id for an event about not starting one would be worse than a separate sink.
    const seen: unknown[] = [];
    const { g } = guard({ observer: { onRefusal: (_c: unknown, r: unknown) => { seen.push(r); } } });
    for (let i = 0; i < 4; i += 1) await g.admit(ctx("t1"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ admitted: false, limit: 3 });
  });
});

describe("one tenant cannot consume another's allowance — AC-5", () => {
  it("counts per tenant", async () => {
    const { g } = guard();
    for (let i = 0; i < 4; i += 1) await g.admit(ctx("t1"));
    expect((await g.admit(ctx("t1"))).admitted).toBe(false);
    // t2 has spent nothing, and must be unaffected by t1 exhausting its window.
    expect((await g.admit(ctx("t2"))).admitted).toBe(true);
  });
});

describe("the refusal is its own error, not a provider 429 — AC-4/AC-6", () => {
  it("throws admission_rate_limited with a retry time", async () => {
    const { g } = guard();
    for (let i = 0; i < 4; i += 1) await g.admit(ctx("t1"));
    try {
      await g.assertAdmitted(ctx("t1"));
      throw new Error("expected a refusal");
    } catch (thrown) {
      expect(isAgentPlatformError(thrown)).toBe(true);
      const e = thrown as { code: string; retryable: boolean; retryAfterMs?: number; details?: Record<string, unknown> };
      // Not `rate_limited`: that means a *provider* throttled us and `decideRetry` treats it as retryable inside
      // the run. This happens at admission, before a run exists.
      expect(e.code).toBe("admission_rate_limited");
      expect(e.code).not.toBe("rate_limited");
      // Not `budget_exceeded` either: that is spend over a period, this is capacity right now.
      expect(e.code).not.toBe("budget_exceeded");
      expect(e.retryable).toBe(true);
      expect(e.retryAfterMs).toBeGreaterThan(0);
      expect(e.details?.limit).toBe(3);
    }
  });

  it("returns the decision rather than throwing when admitted", async () => {
    const { g } = guard();
    expect((await g.assertAdmitted(ctx("t1"))).admitted).toBe(true);
  });
});

describe("the window is absolute, not relative to the first call", () => {
  it("rolls over at the boundary even when the first admission was late in the window", async () => {
    // Worth its own test because it is counter-intuitive and it broke this file's first draft: a tenant that
    // starts asking 59s into a window gets the remainder of it, not a fresh 60s. That is the cost of a fixed
    // window, and it is the *reason* two processes can agree on a key without coordinating.
    let clock = 1_699_999_980_000 + 59_000;
    const g = createRateLimitGuard({
      store: createMemoryRateLimitStore(),
      policyFor: () => ({ max: 2, windowSeconds: 60 }),
      now: () => clock,
    });
    expect((await g.admit(ctx("t1"))).admitted).toBe(true);
    expect((await g.admit(ctx("t1"))).admitted).toBe(true);
    expect((await g.admit(ctx("t1"))).admitted).toBe(false);
    clock += 1_000; // crosses into the next window
    expect((await g.admit(ctx("t1"))).admitted).toBe(true);
  });
});

// The port contract lives in `src/__tests__/memory-conformance.test.ts` with every other memory harness —
// `scripts/conformance-matrix.mjs` reads the adapter from the *file name*, so a harness run anywhere else is
// invisible to the matrix and the cell reports MISSING. This file holds the guard's own behaviour.
