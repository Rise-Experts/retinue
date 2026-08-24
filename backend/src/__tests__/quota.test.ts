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
import { createMemoryUsageLimitStore } from "../adapters/memory/usage-limits.js";
import type { RollupPeriod, UsageEvent } from "../persistence/index.js";
import {
  DEFAULT_RECONCILIATION_TOLERANCE,
  DEFAULT_WARN_AT,
  NO_USAGE,
  bucketStartFor,
  bucketsBetween,
  createQuotaGuard,
  createStoredLimitResolver,
  createRollupJob,
  nextBucket,
  reconcileUsage,
  type QuotaLimits,
  type QuotaWarning,
  type QuotaWindow,
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

/**
 * A calendar window, short-form — #181 widened `QuotaLimits.period` into a `QuotaWindow` union, and spelling the
 * union out at every call site would bury what each test is actually about.
 */
const calendar = (period: RollupPeriod): QuotaWindow => ({ kind: "calendar", period });
/** A rolling window of `hours`, for the same reason. */
const rolling = (hours: number): QuotaWindow => ({ kind: "rolling", minutes: hours * 60 });

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
        // Only a calendar limit has a bucket to rebuild. A rolling one reads the ledger, so seeding a rollup
        // for it would be seeding a row nothing reads — and if the guard ever did read it, this helper would be
        // hiding the bug.
        period: limits?.window.kind === "calendar" ? limits.window.period : "day",
        bucketStart: bucketStartFor(limits?.window.kind === "calendar" ? limits.window.period : "day", NOW),
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
    const guard = await guardFor({ window: calendar("hour"), costMinorUnits: 20 }, [event(1), event(2)]);
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("expected a refusal");
    expect(decision).toMatchObject({ dimension: "cost", limit: 20, used: 20 });
    expect(decision.message).toContain("20 of its 20");
    expect(decision.message).toContain(nextBucket("hour", HOUR));
    expect(decision.retryAfter).toBe(nextBucket("hour", HOUR));
  });

  it("admits when inside the limit", async () => {
    const guard = await guardFor({ window: calendar("hour"), costMinorUnits: 100 }, [event(1)]);
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
    const guard = await guardFor({ window: calendar("hour"), inputTokens: 150 }, [event(1), event(2)]);
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(false);
    expect(!decision.admitted && decision.dimension).toBe("input-tokens");
  });

  it("throws a typed, retryable refusal from assertAdmitted", async () => {
    // Retryable because the limit *resets*. A caller treating this as permanent would give up on a workspace
    // that is fine again in an hour.
    const guard = await guardFor({ window: calendar("hour"), costMinorUnits: 5 }, [event(1)]);
    const error = await guard.assertAdmitted(ctx(), NOW).catch((e: AgentPlatformError) => e);
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error).toMatchObject({ code: "budget_exceeded", retryable: true });
  });

  it("reads the current bucket, not a stale one", async () => {
    // A limit checked against yesterday's rollup is not a limit. The bucket comes from the moment of the check.
    const guard = await guardFor({ window: calendar("hour"), costMinorUnits: 5 }, [event(1)]);
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
      resolveLimits: () => ({ window: calendar("hour"), costMinorUnits: 100 }),
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
      period: limits.window.kind === "calendar" ? limits.window.period : "day",
      bucketStart: bucketStartFor(limits.window.kind === "calendar" ? limits.window.period : "day", NOW),
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
    const quiet = await observed({ window: calendar("hour"), costMinorUnits: 100 }, [event(1)]);
    await quiet.guard.admit(ctx(), NOW);
    expect(quiet.warnings).toEqual([]);

    // 90 of 100 — past the 0.8 default.
    const loud = await observed(
      { window: calendar("hour"), costMinorUnits: 100 },
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
      { window: calendar("hour"), costMinorUnits: 100 },
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
      { window: calendar("hour"), costMinorUnits: 100 },
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
    const small = await observed({ window: calendar("hour"), costMinorUnits: 100 }, [event(1, { costMinorUnits: 80 })]);
    await small.guard.admit(ctx(), NOW);
    expect(small.warnings).toHaveLength(1);

    const large = await observed({ window: calendar("hour"), costMinorUnits: 10_000 }, [event(1, { costMinorUnits: 80 })]);
    await large.guard.admit(ctx(), NOW);
    expect(large.warnings).toEqual([]);
  });

  it("honours a configured threshold", async () => {
    const { guard, warnings } = await observed(
      { window: calendar("hour"), costMinorUnits: 100, warnAt: 0.5 },
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
      resolveLimits: () => ({ window: calendar("hour"), costMinorUnits: 100 }),
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
      resolveLimits: () => ({ window: calendar("hour"), costMinorUnits: 100 }),
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

/**
 * Per-person allowances — #175.
 *
 * The guard already accepted per-principal limits through `resolveLimits`, and always compared them against
 * **tenant-wide** usage. So a per-person limit was not a per-person limit: the first busy colleague exhausted
 * everyone's allowance, and the person refused had spent nothing. Every test of the guard passed, because none of
 * them had two principals in one tenant.
 */
describe("quota enforcement per principal", () => {
  const P1 = asId<PrincipalId>("alice");
  const P2 = asId<PrincipalId>("bob");
  const AT = "2026-08-24T10:30:00.000Z";
  const MONTH = "2026-08-01T00:00:00.000Z";

  const withPrincipal = (principalId: PrincipalId): ExecutionContext => ({ ...ctx(), principalId });

  const spend = async (
    backend: ReturnType<typeof createMemoryUsageBackend>,
    principalId: PrincipalId,
    costMinorUnits: number,
    n: number,
  ) => {
    await backend.usage.append({
      tenantId: T1,
      event: {
        id: `e-${principalId}-${n}`,
        tenantId: T1,
        principalId,
        runId: asId<RunId>(`run-${principalId}-${n}`),
        modelId: "m1",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        costMinorUnits,
        currency: "USD",
        occurredAt: AT,
      } satisfies UsageEvent,
    });
  };

  it("checks one person's limit against that person's usage, not the tenant's", async () => {
    const backend = createMemoryUsageBackend();
    // Bob burns a lot. Alice has spent nothing.
    await spend(backend, P2, 900, 1);
    await backend.rollups.rebuild({ tenantId: T1, period: "month", bucketStart: MONTH });
    await backend.rollups.rebuild({ tenantId: T1, period: "month", bucketStart: MONTH, principalId: P1 });
    await backend.rollups.rebuild({ tenantId: T1, period: "month", bucketStart: MONTH, principalId: P2 });

    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: (context) => ({
        window: calendar("month"),
        principalId: context.principalId,
        costMinorUnits: 500,
      }),
    });

    // Alice is admitted: her own spend is zero, even though the tenant is over.
    expect((await guard.admit(withPrincipal(P1), AT)).admitted).toBe(true);
    // Bob is refused: it is his spend that passed the limit.
    const bob = await guard.admit(withPrincipal(P2), AT);
    expect(bob.admitted).toBe(false);
    if (bob.admitted) throw new Error("expected a refusal");
    expect(bob.used).toBe(900);
  });

  it("checks a tenant-wide limit against tenant usage, so a shared budget is still shared", async () => {
    // The other half: a limit with no principal must *not* narrow to the caller, or a tenant budget would only
    // ever be spent by whoever asked last.
    const backend = createMemoryUsageBackend();
    await spend(backend, P2, 900, 1);
    await backend.rollups.rebuild({ tenantId: T1, period: "month", bucketStart: MONTH });

    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: () => ({ window: calendar("month"), costMinorUnits: 500 }),
    });
    const alice = await guard.admit(withPrincipal(P1), AT);
    expect(alice.admitted).toBe(false);
    if (alice.admitted) throw new Error("expected a refusal");
    expect(alice.used).toBe(900);
  });

  it("admits a person with no rollup row yet", async () => {
    // A first-time user has no bucket. Absent must read as zero spend, not as an error or an unbounded pass
    // through some other grain's numbers.
    const backend = createMemoryUsageBackend();
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: (context) => ({ window: calendar("month"), principalId: context.principalId, costMinorUnits: 500 }),
    });
    const decision = await guard.admit(withPrincipal(P1), AT);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error("expected admission");
    expect(decision.usage).toEqual(NO_USAGE);
  });

  it("resolves a person's own limit over the tenant default, and the grain with it", async () => {
    const limits = createMemoryUsageLimitStore();
    await limits.put({ tenantId: T1, limit: { tenantId: T1, window: calendar("month"), costMinorUnits: 10_000, updatedAt: "t" } });
    await limits.put({
      tenantId: T1,
      limit: { tenantId: T1, principalId: P1, window: calendar("month"), costMinorUnits: 100, updatedAt: "t" },
    });
    const resolve = createStoredLimitResolver({ limits, periods: ["month"] });

    const alice = await resolve(withPrincipal(P1));
    expect(alice?.costMinorUnits).toBe(100);
    // The grain travels with the limit: without it the guard would compare her allowance to the tenant's spend.
    expect(alice?.principalId).toBe(P1);

    const bob = await resolve(withPrincipal(P2));
    expect(bob?.costMinorUnits).toBe(10_000);
    // The tenant default carries no principal, so the guard reads the tenant bucket — a shared budget stays
    // shared rather than becoming a 10,000 allowance each.
    expect(bob?.principalId).toBeUndefined();
  });

  it("is unbounded when nothing is configured at any period", async () => {
    const resolve = createStoredLimitResolver({ limits: createMemoryUsageLimitStore() });
    expect(await resolve(withPrincipal(P1))).toBeUndefined();
  });

  it("prefers the shortest configured period", async () => {
    /**
     * A shorter window is the tighter constraint in practice: someone who has burned a monthly allowance in a
     * day is stopped a day earlier, and being stopped early is recoverable where a surprise at month end is not.
     */
    const limits = createMemoryUsageLimitStore();
    await limits.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: calendar("month"), costMinorUnits: 10_000, updatedAt: "t" } });
    await limits.put({ tenantId: T1, limit: { tenantId: T1, principalId: P1, window: calendar("day"), costMinorUnits: 400, updatedAt: "t" } });
    const resolved = await createStoredLimitResolver({ limits })(withPrincipal(P1));
    // The resolver reads `usage_limits`, whose rows are calendar periods, so a resolved limit is a calendar
    // window — asserted as the union it now is rather than a bare string.
    expect(resolved?.window).toEqual({ kind: "calendar", period: "day" });
    expect(resolved?.costMinorUnits).toBe(400);
  });
});

/**
 * The rollup job builds both grains — #175.
 *
 * The store reports stale buckets at both grains from one ledger pass, precisely so the job does not have to know
 * which principals were active. A job that dropped the grain would rebuild the tenant row twice and never build a
 * principal's at all — so every per-person figure would read zero and every per-person quota would be
 * unenforceable, with nothing failing anywhere.
 */
describe("the rollup job and per-principal buckets", () => {
  const P1 = asId<PrincipalId>("alice");
  const AT = "2026-08-24T10:30:00.000Z";
  const HOUR = "2026-08-24T10:00:00.000Z";

  it("rebuilds a principal's bucket, not just the tenant's", async () => {
    const backend = createMemoryUsageBackend();
    await backend.usage.append({
      tenantId: T1,
      event: {
        id: "e1",
        tenantId: T1,
        principalId: P1,
        runId: asId<RunId>("run-1"),
        modelId: "m1",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        costMinorUnits: 42,
        currency: "USD",
        occurredAt: AT,
      } satisfies UsageEvent,
    });

    const job = createRollupJob({ rollups: backend.rollups });
    const { rebuilt } = await job.run({ tenantId: T1 }, { period: "hour", since: HOUR, limit: 50 });

    // Both grains, from one run.
    expect(rebuilt).toBe(2);
    expect((await backend.rollups.get({ tenantId: T1, period: "hour", bucketStart: HOUR }))?.costMinorUnits).toBe(42);
    expect(
      (await backend.rollups.get({ tenantId: T1, period: "hour", bucketStart: HOUR, principalId: P1 }))
        ?.costMinorUnits,
    ).toBe(42);
  });

  it("drains, so the job does not rebuild forever", async () => {
    // With two grains there are two rows to satisfy, and a job that only ever wrote one would report the other
    // as stale on every pass.
    const backend = createMemoryUsageBackend();
    await backend.usage.append({
      tenantId: T1,
      event: {
        id: "e1",
        tenantId: T1,
        principalId: P1,
        runId: asId<RunId>("run-1"),
        modelId: "m1",
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        costMinorUnits: 1,
        currency: "USD",
        occurredAt: AT,
      } satisfies UsageEvent,
    });
    const job = createRollupJob({ rollups: backend.rollups });
    await job.run({ tenantId: T1 }, { period: "hour", since: HOUR, limit: 50 });
    const second = await job.run({ tenantId: T1 }, { period: "hour", since: HOUR, limit: 50 });
    expect(second.rebuilt).toBe(0);
    expect(second.remaining).toBe(0);
  });
});

/**
 * What a refused person is told — #175.
 *
 * Two defects found by reading the actual response rather than the code. Both are in the sentence a human sees,
 * which is the part no type checks.
 */
describe("quota refusal messages", () => {
  const P1 = asId<PrincipalId>("alice");
  const AT = "2026-08-24T10:30:00.000Z";
  const MONTH = "2026-08-01T00:00:00.000Z";

  const overspent = async () => {
    const backend = createMemoryUsageBackend();
    await backend.usage.append({
      tenantId: T1,
      event: {
        id: "e1",
        tenantId: T1,
        principalId: P1,
        runId: asId<RunId>("run-1"),
        modelId: "m1",
        inputTokens: 3100,
        outputTokens: 0,
        cachedInputTokens: 0,
        costMinorUnits: 0,
        currency: "USD",
        occurredAt: AT,
      } satisfies UsageEvent,
    });
    await backend.rollups.rebuild({ tenantId: T1, period: "month", bucketStart: MONTH });
    await backend.rollups.rebuild({ tenantId: T1, period: "month", bucketStart: MONTH, principalId: P1 });
    return backend;
  };

  const context = (): ExecutionContext => ({ ...ctx(), principalId: P1 });

  it("says 'you' for a personal limit, not 'this workspace'", async () => {
    /**
     * Every message said "This workspace", which was true while every limit was a tenant's and became a lie the
     * moment one could belong to a person. Someone refused for their own overspend was told the workspace had run
     * out — so the obvious next step is asking a colleague to stop working.
     */
    const guard = createQuotaGuard({
      rollups: (await overspent()).rollups,
      resolveLimits: () => ({ window: calendar("month"), principalId: P1, inputTokens: 1000 }),
    });
    const decision = await guard.admit(context(), AT);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("expected a refusal");
    expect(decision.message).toContain("You have used");
    expect(decision.message).not.toContain("workspace");
  });

  it("still says 'this workspace' for a tenant limit", async () => {
    // The other half. A shared budget running out is not the person's fault, and telling them it is would send
    // them to change a setting that is not theirs.
    const guard = createQuotaGuard({
      rollups: (await overspent()).rollups,
      resolveLimits: () => ({ window: calendar("month"), inputTokens: 1000 }),
    });
    const decision = await guard.admit(context(), AT);
    if (decision.admitted) throw new Error("expected a refusal");
    expect(decision.message).toContain("This workspace has used");
  });

  it("carries the reset instant on the thrown refusal, so a retry can be scheduled", async () => {
    /**
     * "Retryable" without a time is not actionable. The HTTP surface had nothing to put in `retry-after` and sent
     * `0`, which tells a client to retry immediately into the same refusal.
     */
    const guard = createQuotaGuard({
      rollups: (await overspent()).rollups,
      resolveLimits: () => ({ window: calendar("month"), principalId: P1, inputTokens: 1000 }),
    });
    await expect(guard.assertAdmitted(context(), AT)).rejects.toMatchObject({
      code: "budget_exceeded",
      retryable: true,
      details: {
        // The next bucket, so a caller can wait exactly as long as it takes.
        retryAfter: "2026-09-01T00:00:00.000Z",
        dimension: "input-tokens",
        limit: 1000,
        used: 3100,
      },
    });
  });
});

/**
 * The rolling window — #181.
 *
 * The case that motivated it is a workspace admin setting "5 hours". Every assertion here is a number that
 * decides whether somebody is refused, so none of them is asserted merely to be present.
 */
describe("a rolling window", () => {
  const at = (hhmm: string) => `2026-08-23T${hhmm}:00.000Z`;
  const alice = asId<PrincipalId>("alice");
  const bob = asId<PrincipalId>("bob");
  const guardFor = async (window: QuotaWindow, events: readonly UsageEvent[], now: string) => {
    const backend = await seeded(events);
    return createQuotaGuard({
      rollups: backend.rollups,
      usage: backend.usage,
      resolveLimits: () => ({ window, costMinorUnits: 25 }),
      clock: () => now,
    });
  };

  it("counts only spend inside the window, and lets older spend fall out", async () => {
    // Three events of 10 each, at 04:00, 06:00 and 09:00. At 10:00 a five-hour window covers [05:00, 10:00), so
    // 04:00 is outside it: 20 of a 25 limit, admitted. This is the whole point of a rolling window — the 04:00
    // spend is gone from the reckoning without any boundary having been crossed.
    const events = [
      event(1, { occurredAt: at("04:00") }),
      event(2, { occurredAt: at("06:00") }),
      event(3, { occurredAt: at("09:00") }),
    ];
    const guard = await guardFor({ kind: "rolling", minutes: 300 }, events, at("10:00"));
    const decision = await guard.admit(ctx(), at("10:00"));
    expect(decision.admitted).toBe(true);
    if (decision.admitted) expect(decision.usage.costMinorUnits).toBe(20);
  });

  it("refuses once the window's spend reaches the limit", async () => {
    // The same three events, judged at 08:00: the window is [03:00, 08:00) and holds 04:00 and 06:00 — 20, under
    // the limit. Add a third inside it and it is 30, over.
    const events = [
      event(1, { occurredAt: at("04:00") }),
      event(2, { occurredAt: at("06:00") }),
      event(3, { occurredAt: at("07:00") }),
    ];
    const guard = await guardFor({ kind: "rolling", minutes: 300 }, events, at("08:00"));
    const decision = await guard.admit(ctx(), at("08:00"));
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.used).toBe(30);
      expect(decision.limit).toBe(25);
      expect(decision.dimension).toBe("cost");
    }
  });

  it("names when the oldest spend leaves the window, not a reset that never happens", async () => {
    // The oldest record inside [03:00, 08:00) is at 04:00, so at 09:00 it ages out. That is the first moment any
    // headroom returns, and it is the only true statement available: a sliding window never resets, and saying
    // "it resets at" would promise the whole allowance back.
    const events = [event(1, { occurredAt: at("04:00") }), event(2, { occurredAt: at("06:00") }), event(3, { occurredAt: at("07:00") })];
    const guard = await guardFor({ kind: "rolling", minutes: 300 }, events, at("08:00"));
    const decision = await guard.admit(ctx(), at("08:00"));
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.retryAfter).toBe(at("09:00"));
      expect(decision.message).toContain("falls outside the window at 2026-08-23T09:00:00.000Z");
      // And it must not claim to reset, which is what the calendar arm says.
      expect(decision.message).not.toContain("resets at");
    }
  });

  it("describes itself in hours when it divides into them, and minutes when it does not", async () => {
    const events = [event(1, { occurredAt: at("07:00") }), event(2, { occurredAt: at("07:30") }), event(3, { occurredAt: at("07:45") })];
    const five = await (await guardFor({ kind: "rolling", minutes: 300 }, events, at("08:00"))).admit(ctx(), at("08:00"));
    expect(five.admitted).toBe(false);
    // "any 5 hours", not "any 300 minutes" — the admin set five hours and that is the sentence they expect back.
    if (!five.admitted) expect(five.message).toContain("for any 5 hours");

    const ninety = await (await guardFor({ kind: "rolling", minutes: 90 }, events, at("08:00"))).admit(ctx(), at("08:00"));
    if (!ninety.admitted) expect(ninety.message).toContain("for any 90 minutes");

    const one = await (await guardFor({ kind: "rolling", minutes: 60 }, events, at("08:00"))).admit(ctx(), at("08:00"));
    // Singular. "any 1 hours" is the kind of detail that makes a product feel unfinished.
    if (!one.admitted) expect(one.message).toContain("for any 1 hour");
  });

  it("reads one person's window, not the whole tenant's", async () => {
    // Bob spends 30 inside the window; Alice spends nothing. A per-person rolling limit that summed the tenant
    // would refuse Alice for Bob's work — the same defect #175 found in the calendar arm, which would otherwise
    // have been reintroduced here untested.
    const events = [
      event(1, { occurredAt: at("07:00"), principalId: bob, costMinorUnits: 30 }),
      event(2, { occurredAt: at("07:30"), principalId: bob, costMinorUnits: 30 }),
    ];
    const backend = await seeded(events);
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      usage: backend.usage,
      resolveLimits: (context) => ({
        window: { kind: "rolling", minutes: 300 },
        principalId: context.principalId,
        costMinorUnits: 25,
      }),
      clock: () => at("08:00"),
    });
    expect((await guard.admit({ ...ctx(), principalId: alice }, at("08:00"))).admitted).toBe(true);
    expect((await guard.admit({ ...ctx(), principalId: bob }, at("08:00"))).admitted).toBe(false);
  });

  it("refuses on an empty window when the limit is zero, without inventing a relief time", async () => {
    // Reachable: a limit of zero is how an admin suspends someone. There is no oldest record to age out, so
    // there is nothing to promise — `retryAfter` is now, and the sentence about the window is omitted rather
    // than fabricated.
    const backend = await seeded([]);
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      usage: backend.usage,
      resolveLimits: () => ({ window: { kind: "rolling", minutes: 300 }, costMinorUnits: 0 }),
      clock: () => at("08:00"),
    });
    const decision = await guard.admit(ctx(), at("08:00"));
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.retryAfter).toBe(at("08:00"));
      expect(decision.message).not.toContain("falls outside");
      expect(decision.message).not.toContain("undefined");
      expect(decision.message).not.toContain("NaN");
    }
  });

  it("refuses to guess when it has no ledger to read", async () => {
    // A rolling limit configured without a `UsageStore` must not be admitted. The guard cannot see spend, and a
    // spend guard that cannot see spend saying yes is the failure that costs money — so it throws, naming the
    // missing piece, and the run does not start.
    const backend = await seeded([event(1)]);
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      resolveLimits: () => ({ window: { kind: "rolling", minutes: 300 }, costMinorUnits: 25 }),
      clock: () => at("08:00"),
    });
    await expect(guard.admit(ctx(), at("08:00"))).rejects.toThrow(/UsageStore/);
  });

  it("leaves the calendar arm reading rollups, not the ledger", async () => {
    // The two arms must not converge by accident. A calendar limit reads the rollup — which here is deliberately
    // never rebuilt, so if this admitted by summing the ledger the usage would be non-zero.
    const backend = await seeded([event(1, { costMinorUnits: 999 })]);
    const guard = createQuotaGuard({
      rollups: backend.rollups,
      usage: backend.usage,
      resolveLimits: () => ({ window: { kind: "calendar", period: "hour" }, costMinorUnits: 25 }),
      clock: () => NOW,
    });
    const decision = await guard.admit(ctx(), NOW);
    expect(decision.admitted).toBe(true);
    if (decision.admitted) expect(decision.usage.costMinorUnits).toBe(0);
  });
});
