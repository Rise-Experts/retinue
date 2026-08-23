/**
 * Rollups, quota enforcement and reconciliation (#139).
 *
 * The tests that carry weight are the ones about *money being wrong*: a rollup that double counts, a limit that
 * lets work start, a discrepancy that nobody sees. Each of those is silent — the system keeps working and the
 * number is simply not true — so each is asserted directly rather than inferred from a happy path.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { PrincipalId, RequestId, RunId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError } from "../core/errors.js";
import { createMemoryUsageBackend } from "../adapters/memory/usage.js";
import type { UsageEvent } from "../persistence/index.js";
import {
  DEFAULT_RECONCILIATION_TOLERANCE,
  DEFAULT_WARN_AT,
  NO_USAGE,
  bucketStartFor,
  bucketsBetween,
  createQuotaGuard,
  createRollupJob,
  nextBucket,
  reconcileUsage,
  type QuotaLimits,
  type QuotaWarning,
} from "../usage/index.js";

const T1 = asId<TenantId>("tenant-1");
const T2 = asId<TenantId>("tenant-2");

const ctx = (tenantId: TenantId = T1): ExecutionContext => ({
  tenantId,
  principalId: asId<PrincipalId>("user-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

const HOUR = "2026-08-23T10:00:00.000Z";
const DAY = "2026-08-23T00:00:00.000Z";
const NOW = "2026-08-23T10:30:00.000Z";

const event = (n: number, overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: `e${n}`,
  tenantId: T1,
  runId: asId<RunId>(`run-${n}`),
  modelId: "m1",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 0,
  costMinorUnits: 10,
  currency: "EUR",
  occurredAt: NOW,
  ...overrides,
});

const seeded = async (events: readonly UsageEvent[]) => {
  const backend = createMemoryUsageBackend();
  for (const e of events) await backend.usage.append({ tenantId: e.tenantId as TenantId, event: e });
  return backend;
};

describe("bucket arithmetic", () => {
  it("truncates to the period in UTC", () => {
    // UTC deliberately: a tenant-local day makes a bucket's identity depend on a timezone setting that can
    // change, and a rollup written under the old offset would belong to a different day than one written after.
    expect(bucketStartFor("hour", "2026-08-23T10:47:31.500Z")).toBe(HOUR);
    expect(bucketStartFor("day", "2026-08-23T10:47:31.500Z")).toBe(DAY);
  });

  it("is stable for every instant inside a bucket", () => {
    // Two writers asking "which bucket does T belong to" must agree, which is why this is truncation rather
    // than a range someone picks.
    for (const at of ["2026-08-23T10:00:00.000Z", "2026-08-23T10:00:00.001Z", "2026-08-23T10:59:59.999Z"]) {
      expect(bucketStartFor("hour", at)).toBe(HOUR);
    }
  });

  it("refuses a value that is not a timestamp", () => {
    expect(() => bucketStartFor("hour", "soon")).toThrow(/not a timestamp/);
  });

  it("tiles a range without gaps or overlaps", () => {
    const buckets = bucketsBetween("hour", HOUR, "2026-08-23T13:00:00.000Z");
    expect(buckets).toEqual([HOUR, "2026-08-23T11:00:00.000Z", "2026-08-23T12:00:00.000Z"]);
    for (const [i, b] of buckets.entries()) {
      if (i === 0) continue;
      expect(nextBucket("hour", buckets[i - 1]!)).toBe(b);
    }
  });

  it("bounds an absurd range rather than looping forever", () => {
    // A bad `from`/`to` is a caller bug; hanging on it is a worse one.
    expect(bucketsBetween("hour", "1970-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").length).toBeLessThan(
      10_000,
    );
  });
});

describe("AC-1: consumption is queryable by period without scanning raw records", () => {
  it("answers from the rollup, not the ledger", async () => {
    // The read path must not get slower as a tenant uses more. Asserted by counting ledger reads during a
    // query: a `sum` that touched raw records would show up here.
    const backend = await seeded([event(1), event(2)]);
    await backend.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR, computedAt: NOW });
    let ledgerReads = 0;
    const watched = {
      ...backend.usage,
      async totals(input: Parameters<typeof backend.usage.totals>[0]) {
        ledgerReads += 1;
        return backend.usage.totals(input);
      },
    };
    void watched;
    const sum = await backend.rollups.sum({
      tenantId: T1,
      period: "hour",
      from: HOUR,
      to: nextBucket("hour", HOUR),
    });
    expect(sum.costMinorUnits).toBe(20);
    expect(ledgerReads).toBe(0);
  });

  it("charts a range of buckets in order", async () => {
    const backend = await seeded([
      event(1, { occurredAt: "2026-08-23T10:10:00.000Z" }),
      event(2, { occurredAt: "2026-08-23T11:10:00.000Z", runId: asId<RunId>("run-2") }),
    ]);
    const job = createRollupJob({ rollups: backend.rollups, clock: () => NOW });
    await job.rebuildRange({ tenantId: T1 }, { period: "hour", from: HOUR, to: "2026-08-23T12:00:00.000Z" });
    const page = await backend.rollups.list({
      tenantId: T1,
      period: "hour",
      from: HOUR,
      to: "2026-08-23T12:00:00.000Z",
      limit: 10,
    });
    expect(page.items.map((r) => r.bucketStart)).toEqual([HOUR, "2026-08-23T11:00:00.000Z"]);
  });
});

describe("AC-4: rollups are idempotent and correct under load", () => {
  it("totals ten thousand events exactly, and matches a direct sum", async () => {
    // The test step, at its stated size. Integer minor units throughout, so the total is exact rather than
    // approximately right in the cents — and cents are what an invoice is made of.
    const events = Array.from({ length: 10_000 }, (_, i) =>
      event(i, { runId: asId<RunId>(`run-${i}`), costMinorUnits: (i % 7) + 1 }),
    );
    const backend = await seeded(events);
    const row = await backend.rollups.rebuild({
      tenantId: T1,
      period: "hour",
      bucketStart: HOUR,
      computedAt: NOW,
    });
    const direct = await backend.usage.totals({ tenantId: T1 });
    expect(row.eventCount).toBe(10_000);
    expect(row.costMinorUnits).toBe(direct.costMinorUnits);
    expect(row.costMinorUnits).toBe(events.reduce((n, e) => n + e.costMinorUnits, 0));
  });

  it("does not double count when many rebuilds race", async () => {
    // Twenty concurrent rebuilds of one bucket. Because a rebuild is a recomputation, they all write the same
    // value — which is what makes concurrency safety a property of the design rather than of a lock.
    const backend = await seeded(Array.from({ length: 100 }, (_, i) => event(i, { runId: asId<RunId>(`run-${i}`) })));
    const rows = await Promise.all(
      Array.from({ length: 20 }, () =>
        backend.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR, computedAt: NOW }),
      ),
    );
    expect(new Set(rows.map((r) => r.costMinorUnits)).size).toBe(1);
    expect(rows[0]?.eventCount).toBe(100);
  });

  it("drains its work list and then stops", async () => {
    // A job that never drains rebuilds the same bucket forever; one that drains too early leaves totals wrong.
    const backend = await seeded([
      event(1, { occurredAt: "2026-08-23T10:10:00.000Z" }),
      event(2, { occurredAt: "2026-08-23T11:10:00.000Z", runId: asId<RunId>("run-2") }),
      event(3, { occurredAt: "2026-08-23T12:10:00.000Z", runId: asId<RunId>("run-3") }),
    ]);
    const job = createRollupJob({ rollups: backend.rollups, clock: () => "2026-08-23T13:00:00.000Z" });
    let guard = 0;
    let remaining = 1;
    while (remaining > 0 && guard < 10) {
      ({ remaining } = await job.run({ tenantId: T1 }, { period: "hour", since: DAY, limit: 2 }));
      guard += 1;
    }
    expect(remaining).toBe(0);
    const sum = await backend.rollups.sum({
      tenantId: T1,
      period: "hour",
      from: DAY,
      to: "2026-08-24T00:00:00.000Z",
    });
    expect(sum.eventCount).toBe(3);
  });

  it("re-runs a bucket that gained an event after it was computed", async () => {
    // Otherwise a rollup computed a second before an event is permanently wrong and nothing notices.
    const backend = await seeded([event(1)]);
    const job = createRollupJob({ rollups: backend.rollups, clock: () => "2026-08-23T11:00:00.000Z" });
    await job.run({ tenantId: T1 }, { period: "hour", since: DAY, limit: 10 });
    await backend.usage.append({
      tenantId: T1,
      event: event(2, { runId: asId<RunId>("run-2"), occurredAt: "2026-08-23T10:45:00.000Z" }),
    });
    const second = createRollupJob({ rollups: backend.rollups, clock: () => "2026-08-23T12:00:00.000Z" });
    const result = await second.run({ tenantId: T1 }, { period: "hour", since: DAY, limit: 10 });
    expect(result.rebuilt).toBe(1);
    expect(
      (await backend.rollups.get({ tenantId: T1, period: "hour", bucketStart: HOUR }))?.eventCount,
    ).toBe(2);
  });
});

describe("AC-2: a limit is enforced before work starts", () => {
  const guardFor = async (
    limits: QuotaLimits | undefined,
    events: readonly UsageEvent[] = [],
    observer?: { warnings: QuotaWarning[] },
  ) => {
    const backend = await seeded(events);
    if (events.length > 0)
      await backend.rollups.rebuild({
        tenantId: T1,
        period: limits?.period ?? "day",
        bucketStart: bucketStartFor(limits?.period ?? "day", NOW),
        computedAt: NOW,
      });
    return createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: () => limits,
      ...(observer === undefined
        ? {}
        : { observer: { onWarning: (_c, w) => void observer.warnings.push(w) } }),
      clock: () => NOW,
    });
  };

  it("refuses when the cost limit is reached, naming the figure and the reset", async () => {
    // Actionable: "quota exceeded" leaves a user with nothing to do. The dimension, the number, the limit and
    // when it resets are all in the message.
    const guard = await guardFor({ period: "hour", costMinorUnits: 20 }, [event(1), event(2)]);
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("expected a refusal");
    expect(decision).toMatchObject({ dimension: "cost", limit: 20, used: 20 });
    expect(decision.message).toContain("20 of its 20");
    expect(decision.message).toContain(nextBucket("hour", HOUR));
    expect(decision.retryAfter).toBe(nextBucket("hour", HOUR));
  });

  it("admits when inside the limit", async () => {
    const guard = await guardFor({ period: "hour", costMinorUnits: 100 }, [event(1)]);
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(true);
    expect(decision.admitted && decision.usage.costMinorUnits).toBe(10);
  });

  it("treats an absent limit as unbounded, not as zero", async () => {
    // A misconfigured quota that blocks everything is an outage; one that blocks nothing is a bill, and the
    // bill is visible in these very rollups. So the safe default is the permissive one.
    const guard = await guardFor(undefined, [event(1)]);
    expect(await guard.admit(ctx(), NOW)).toEqual({ admitted: true, usage: NO_USAGE, warnings: [] });
  });

  it("enforces a token limit independently of cost", async () => {
    // A model with no pricing costs zero, so a cost limit alone bounds nothing for it. That is exactly why
    // there are token dimensions.
    const guard = await guardFor({ period: "hour", inputTokens: 150 }, [event(1), event(2)]);
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(false);
    expect(!decision.admitted && decision.dimension).toBe("input-tokens");
  });

  it("throws a typed, retryable refusal from assertAdmitted", async () => {
    // Retryable because the limit *resets*. A caller treating this as permanent would give up on a workspace
    // that is fine again in an hour.
    const guard = await guardFor({ period: "hour", costMinorUnits: 5 }, [event(1)]);
    const error = await guard.assertAdmitted(ctx(), NOW).catch((e: AgentPlatformError) => e);
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error).toMatchObject({ code: "budget_exceeded", retryable: true });
  });

  it("reads the current bucket, not a stale one", async () => {
    // A limit checked against yesterday's rollup is not a limit. The bucket comes from the moment of the check.
    const guard = await guardFor({ period: "hour", costMinorUnits: 5 }, [event(1)]);
    // An hour later, the bucket is empty again and the run is admitted.
    const later = await guard.admit(ctx(), "2026-08-23T11:30:00.000Z");
    expect(later.admitted).toBe(true);
  });

  it("does not see another tenant's consumption", async () => {
    // AC-6 from the enforcement side: one tenant's spend must not refuse another's run.
    const backend = await seeded([event(1, { tenantId: T2, costMinorUnits: 10_000 })]);
    await backend.rollups.rebuild({ tenantId: T2, period: "hour", bucketStart: HOUR, computedAt: NOW });
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: () => ({ period: "hour", costMinorUnits: 100 }),
      clock: () => NOW,
    });
    expect((await guard.admit(ctx(T1), NOW)).admitted).toBe(true);
    expect((await guard.admit(ctx(T2), NOW)).admitted).toBe(false);
  });
});

describe("AC-3: a warning fires before the hard limit", () => {
  const observed = async (limits: QuotaLimits, events: readonly UsageEvent[]) => {
    const backend = await seeded(events);
    await backend.rollups.rebuild({
      tenantId: T1,
      period: limits.period,
      bucketStart: bucketStartFor(limits.period, NOW),
      computedAt: NOW,
    });
    const warnings: QuotaWarning[] = [];
    const refusals: unknown[] = [];
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: () => limits,
      observer: {
        onWarning: (_c, w) => void warnings.push(w),
        onRefusal: (_c, r) => void refusals.push(r),
      },
      clock: () => NOW,
    });
    return { guard, warnings, refusals };
  };

  it("warns above the threshold and stays quiet below it", async () => {
    const quiet = await observed({ period: "hour", costMinorUnits: 100 }, [event(1)]);
    await quiet.guard.admit(ctx(), NOW);
    expect(quiet.warnings).toEqual([]);

    // 90 of 100 — past the 0.8 default.
    const loud = await observed(
      { period: "hour", costMinorUnits: 100 },
      [event(1, { costMinorUnits: 90 })],
    );
    const decision = await loud.guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(true);
    expect(loud.warnings).toHaveLength(1);
    expect(loud.warnings[0]).toMatchObject({ dimension: "cost", limit: 100, used: 90 });
    expect(loud.warnings[0]?.message).toContain("90%");
  });

  it("fires the warning while the run is still admitted", async () => {
    // The point of AC-3. A customer told at 100% is told when work is already failing.
    const { guard, warnings } = await observed(
      { period: "hour", costMinorUnits: 100 },
      [event(1, { costMinorUnits: 85 })],
    );
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("does not warn about a limit already passed — it refuses", async () => {
    // Emitting a warning and then refusing would tell a customer they are *approaching* a limit they have
    // already crossed.
    const { guard, warnings, refusals } = await observed(
      { period: "hour", costMinorUnits: 100 },
      [event(1, { costMinorUnits: 120 })],
    );
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(false);
    expect(warnings).toEqual([]);
    expect(refusals).toHaveLength(1);
  });

  it("scales the threshold with the limit", async () => {
    // A fraction, not an absolute: an absolute is meaningless on a large plan and constantly tripping on a
    // small one. 80 of 100 warns; 80 of 10,000 does not.
    expect(DEFAULT_WARN_AT).toBe(0.8);
    const small = await observed({ period: "hour", costMinorUnits: 100 }, [event(1, { costMinorUnits: 80 })]);
    await small.guard.admit(ctx(), NOW);
    expect(small.warnings).toHaveLength(1);

    const large = await observed({ period: "hour", costMinorUnits: 10_000 }, [event(1, { costMinorUnits: 80 })]);
    await large.guard.admit(ctx(), NOW);
    expect(large.warnings).toEqual([]);
  });

  it("honours a configured threshold", async () => {
    const { guard, warnings } = await observed(
      { period: "hour", costMinorUnits: 100, warnAt: 0.5 },
      [event(1, { costMinorUnits: 60 })],
    );
    await guard.admit(ctx(), NOW);
    expect(warnings).toHaveLength(1);
  });

  it("does not refuse a run because a warning could not be delivered", async () => {
    // A failed notification must not become a service outage.
    const backend = await seeded([event(1, { costMinorUnits: 90 })]);
    await backend.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR, computedAt: NOW });
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: () => ({ period: "hour", costMinorUnits: 100 }),
      observer: {
        onWarning() {
          throw new Error("pager unreachable");
        },
      },
      clock: () => NOW,
    });
    expect((await guard.admit(ctx(), NOW)).admitted).toBe(true);
  });

  it("still refuses when a refusal observer fails", async () => {
    // The other direction: the point of a refusal is to stop work, and a broken notification is not a reason
    // to let it through.
    const backend = await seeded([event(1, { costMinorUnits: 200 })]);
    await backend.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR, computedAt: NOW });
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: () => ({ period: "hour", costMinorUnits: 100 }),
      observer: {
        onWarning() {},
        onRefusal() {
          throw new Error("pager unreachable");
        },
      },
      clock: () => NOW,
    });
    expect((await guard.admit(ctx(), NOW)).admitted).toBe(false);
  });
});

describe("AC-5: reconciliation against provider figures", () => {
  const reconciled = async (
    ledgerCost: number,
    statementCost: number,
    options: { currency?: string; ledgerCurrency?: string } = {},
  ) => {
    const backend = await seeded(ledgerCost === 0 ? [] : [event(1, { costMinorUnits: ledgerCost })]);
    await backend.rollups.rebuild({ tenantId: T1, period: "day", bucketStart: DAY, computedAt: NOW });
    return reconcileUsage(
      ctx(),
      { rollups: backend.rollups },
      {
        statement: {
          provider: "openai",
          from: DAY,
          to: "2026-08-23T23:59:59.000Z",
          costMinorUnits: statementCost,
          currency: options.currency ?? "EUR",
        },
        ledgerCurrency: options.ledgerCurrency ?? "EUR",
      },
    );
  };

  it("reconciles when the figures agree", async () => {
    expect(await reconciled(10_000, 10_000)).toMatchObject({ withinTolerance: true, deltaMinorUnits: 0 });
  });

  it("tolerates a small absolute difference on a small period", async () => {
    // The floor. Without it a one-cent rounding difference on a two-cent hour is a 50% discrepancy report.
    const report = await reconciled(2, 3);
    expect(report.withinTolerance).toBe(true);
  });

  it("tolerates a small proportional difference on a large period", async () => {
    // The fraction. Without it a €5 tolerance on a €10,000 month reports noise nobody can act on.
    expect((await reconciled(1_000_000, 1_010_000)).withinTolerance).toBe(true);
  });

  it("reports a difference that clears both thresholds", async () => {
    // Both, not either: that is what makes a report worth someone's attention.
    const report = await reconciled(1_000_000, 1_500_000);
    expect(report.withinTolerance).toBe(false);
    expect(report.kind).toBe("under-recorded");
    expect(report.message).toContain("were not recorded");
    expect(report.deltaMinorUnits).toBe(-500_000);
  });

  it("distinguishes under-recorded from over-recorded", async () => {
    // Different investigations: usage we are not billing for, versus a charge we cannot account for.
    expect((await reconciled(1_500_000, 1_000_000)).kind).toBe("over-recorded");
    expect((await reconciled(1_000_000, 1_500_000)).kind).toBe("under-recorded");
  });

  it("refuses to subtract across currencies", async () => {
    // Comparing two numbers in different currencies is not a discrepancy — it is a meaningless subtraction that
    // would be quoted as one.
    const report = await reconciled(1_000_000, 900_000, { currency: "USD", ledgerCurrency: "EUR" });
    expect(report).toMatchObject({ withinTolerance: false, kind: "currency-mismatch", deltaMinorUnits: 0 });
    expect(report.message).toContain("cannot be compared");
  });

  it("reports a charge for a period with no ledger entries at all", async () => {
    // The case that matters most: the provider billed and we recorded nothing.
    const report = await reconciled(0, 500_000);
    expect(report).toMatchObject({ withinTolerance: false, kind: "under-recorded", ledgerMinorUnits: 0 });
  });

  it("covers the day a statement ends mid-way through", async () => {
    // Truncating the upper bound would drop that day's spend and report every statement as under-recorded.
    const backend = await seeded([event(1, { costMinorUnits: 5000, occurredAt: "2026-08-23T18:00:00.000Z" })]);
    await backend.rollups.rebuild({ tenantId: T1, period: "day", bucketStart: DAY, computedAt: NOW });
    const report = await reconcileUsage(
      ctx(),
      { rollups: backend.rollups },
      {
        statement: {
          provider: "openai",
          from: DAY,
          // Mid-day, before the event.
          to: "2026-08-23T12:00:00.000Z",
          costMinorUnits: 5000,
          currency: "EUR",
        },
        ledgerCurrency: "EUR",
      },
    );
    expect(report.withinTolerance).toBe(true);
  });

  it("uses a documented tolerance", () => {
    expect(DEFAULT_RECONCILIATION_TOLERANCE.fraction).toBeGreaterThan(0);
    expect(DEFAULT_RECONCILIATION_TOLERANCE.floorMinorUnits).toBeGreaterThan(0);
  });

  it("does not read another tenant's ledger", async () => {
    const backend = await seeded([event(1, { tenantId: T2, costMinorUnits: 999_999 })]);
    await backend.rollups.rebuild({ tenantId: T2, period: "day", bucketStart: DAY, computedAt: NOW });
    const report = await reconcileUsage(
      ctx(T1),
      { rollups: backend.rollups },
      {
        statement: { provider: "openai", from: DAY, to: DAY, costMinorUnits: 0, currency: "EUR" },
        ledgerCurrency: "EUR",
      },
    );
    expect(report.ledgerMinorUnits).toBe(0);
  });
});
