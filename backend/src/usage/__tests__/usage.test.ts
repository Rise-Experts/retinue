import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { createMemoryUsageStore } from "../../adapters/memory/index.js";
import { type PricingResolver } from "../index.js";
import { createUsageRecorder } from "../index.js";
import { bucketStartFor, bucketsBetween, nextBucket } from "../quota.js";
import { ROLLUP_PERIODS } from "../../persistence/index.js";

const T = asId<TenantId>("t1");
const R = asId<RunId>("r1");

const ctx = (): ExecutionContext => ({
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  runId: R,
});

// $0.001/input-token, $0.002/output-token expressed per-million (integer minor units).
const pricing: PricingResolver = {
  resolve: (id) => (id === "m1" ? { currency: "USD", inputPerMillion: 1000, outputPerMillion: 2000 } : null),
};

describe("usage recorder — recording", () => {
  it("appends events and reconciles totals to what was recorded", async () => {
    const store = createMemoryUsageStore();
    let n = 0;
    const rec = createUsageRecorder({ store, pricing, clock: () => "t", idFactory: () => `u${(n += 1)}` });

    await rec.record(ctx(), { runId: R, modelId: "m1", inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costMinorUnits: 30, currency: "USD", stepId: "s1" });
    await rec.record(ctx(), { runId: R, modelId: "m1", inputTokens: 200, outputTokens: 10, cachedInputTokens: 0, costMinorUnits: 25, currency: "USD", stepId: "s2" });

    const totals = await store.totals({ tenantId: T, runId: R });
    expect(totals).toMatchObject({ inputTokens: 300, outputTokens: 60, costMinorUnits: 55, eventCount: 2 });
  });

  it("is append-only and idempotent on (runId, stepId) — recovery never double-counts", async () => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, clock: () => "t", idFactory: () => "same-id" });
    const event = { runId: R, modelId: "m1", inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costMinorUnits: 30, currency: "USD", stepId: "s1" };
    await rec.record(ctx(), event);
    await rec.record(ctx(), event); // e.g. re-recorded after a crash/recovery
    const totals = await store.totals({ tenantId: T, runId: R });
    expect(totals.eventCount).toBe(1);
  });
});

describe("usage recorder — ceilings (reserve)", () => {
  it("denies a call that would exceed the run's cost ceiling", async () => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, resolveCeiling: () => ({ costMinorUnits: 500 }) });
    // 1,000,000 input tokens at 1000/M = 1000 minor units > 500 ceiling.
    const denied = await rec.reserve(ctx(), { modelId: "m1", inputTokens: 1_000_000, maxOutputTokens: 0 });
    expect(denied.withinCeiling).toBe(false);
    const allowed = await rec.reserve(ctx(), { modelId: "m1", inputTokens: 100_000, maxOutputTokens: 0 });
    expect(allowed.withinCeiling).toBe(true);
  });

  it("counts already-spent usage against the ceiling", async () => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, resolveCeiling: () => ({ costMinorUnits: 1000 }) });
    await rec.record(ctx(), { runId: R, modelId: "m1", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMinorUnits: 900, currency: "USD", stepId: "s1" });
    // 900 already spent + 200 estimated = 1100 > 1000.
    const denied = await rec.reserve(ctx(), { modelId: "m1", inputTokens: 200_000, maxOutputTokens: 0 });
    expect(denied.withinCeiling).toBe(false);
  });

  it("treats a run with no ceiling as unbounded", async () => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing });
    const r = await rec.reserve(ctx(), { modelId: "m1", inputTokens: 10_000_000, maxOutputTokens: 0 });
    expect(r.withinCeiling).toBe(true);
  });

  it("enforces a token ceiling independently of cost", async () => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, resolveCeiling: () => ({ inputTokens: 1000 }) });
    const denied = await rec.reserve(ctx(), { modelId: "m1", inputTokens: 2000, maxOutputTokens: 0 });
    expect(denied.withinCeiling).toBe(false);
  });
});

/**
 * The **default** id factory — #174.
 *
 * Every test above supplies its own `idFactory`, which is exactly why the default was never exercised. It was
 * `usage-${counter += 1}` over a module-level counter: per-process, so a worker restart reset it to 1 and the
 * next record collided with the `usage-1` already in the table —
 * `duplicate key value violates unique constraint "usage_records_pkey"`, and the run failed. Two workers in one
 * deployment collided without restarting at all.
 *
 * Invisible to a suite where every test gets a fresh schema *and* a fresh module, so the counter and the table are
 * always in step. It only breaks against a database that outlives the process, which is the only kind a
 * deployment has.
 */
describe("usage recorder — ids across processes and restarts", () => {
  const event = (stepId: string) => ({
    runId: R,
    modelId: "m1",
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    costMinorUnits: 1,
    currency: "USD",
    stepId,
  });

  /**
   * A **fresh module**, which is what a restart actually is.
   *
   * My first attempt at this test built two recorders in one process and passed against the broken code, because
   * a module-level counter keeps incrementing across instances — the first got 1, the second got 2, and nothing
   * collided. The bug needs the module itself to be new, so `resetModules` plus a re-import is the only faithful
   * simulation short of restarting node.
   *
   * Worth recording, because the weaker version of this test would have shipped looking like coverage.
   */
  it("does not reuse ids after a restart, when the module's own state is new", async () => {
    const store = createMemoryUsageStore();

    for (let restart = 0; restart < 2; restart += 1) {
      vi.resetModules();
      const { createUsageRecorder: fresh } = await import("../recorder.js");
      const rec = fresh({ store, pricing, clock: () => "t" });
      await rec.record(ctx(), event(`s${restart}`));
    }

    /**
     * Asserted over the whole set, not by index.
     *
     * The first version of this read `items[items.length - 1]` after each restart, and failed intermittently:
     * both records share a fixed `clock`, so their order is not defined and the same row came back twice. The
     * property is "no two records share an id", which is a statement about the set.
     *
     * Equal ids are a primary-key violation against a real table; the in-memory store is too forgiving to
     * surface it, which is why this asserts the ids rather than the row count.
     */
    const page = await store.listByRun({ tenantId: T, runId: R, limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(new Set(page.items.map((e) => e.id)).size).toBe(2);
  });

  it("gives every event a distinct id within one recorder too", async () => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, clock: () => "t" });
    for (const step of ["s1", "s2", "s3", "s4", "s5"]) await rec.record(ctx(), event(step));
    const page = await store.listByRun({ tenantId: T, runId: R, limit: 10 });
    expect(new Set(page.items.map((e) => e.id)).size).toBe(5);
  });

  it("still dedupes a re-recorded step, which is a different guarantee from a unique id", async () => {
    /**
     * The two must not be confused, and confusing them is how the wrong fix gets made.
     *
     * A unique **id** stops two distinct events colliding on a surrogate key. The **dedupe key** stops one event
     * being counted twice after a recovery. Fixing the collision by tolerating a duplicate primary key would have
     * silently dropped a real record — and the dropped one would be revenue.
     */
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, clock: () => "t" });
    await rec.record(ctx(), event("s1"));
    await rec.record(ctx(), event("s1"));
    expect((await store.totals({ tenantId: T, runId: R })).eventCount).toBe(1);
  });
});

/**
 * Week and month buckets — #175.
 *
 * They are the periods a person's allowance is expressed in: "500k tokens a month" is a plan, "500k a day" is
 * not. And they cannot be derived by summing days — a month is 28 to 31 days and a week crosses month
 * boundaries — so a caller doing it themselves reimplements calendar arithmetic, and two callers doing it
 * differently is two answers to what a month cost.
 */
describe("bucket arithmetic for week and month", () => {
  it("starts a week on Monday, per ISO 8601", () => {
    // A Sunday start would split a working week across two buckets, so every weekly figure would describe half
    // of one week and half of another.
    expect(bucketStartFor("week", "2026-08-24T13:45:00.000Z")).toBe("2026-08-24T00:00:00.000Z"); // a Monday
    expect(bucketStartFor("week", "2026-08-26T00:00:00.000Z")).toBe("2026-08-24T00:00:00.000Z"); // Wednesday
    expect(bucketStartFor("week", "2026-08-30T23:59:59.000Z")).toBe("2026-08-24T00:00:00.000Z"); // Sunday
  });

  it("puts a Sunday in the week that began the Monday before, not the one starting tomorrow", () => {
    // The `(day + 6) % 7` case that a naive `getUTCDay()` offset gets wrong: Sunday is index 0, so subtracting
    // it would leave Sunday as its own week start.
    expect(bucketStartFor("week", "2026-08-23T12:00:00.000Z")).toBe("2026-08-17T00:00:00.000Z");
  });

  it("truncates a month to its first day", () => {
    expect(bucketStartFor("month", "2026-08-24T13:45:00.000Z")).toBe("2026-08-01T00:00:00.000Z");
    expect(bucketStartFor("month", "2026-02-28T23:59:59.000Z")).toBe("2026-02-01T00:00:00.000Z");
  });

  it("advances a month by calendar, not by thirty days", () => {
    // A fixed span would put February's next bucket on the 2nd or 3rd of March, and every bucket after that
    // further adrift.
    expect(nextBucket("month", "2026-01-01T00:00:00.000Z")).toBe("2026-02-01T00:00:00.000Z");
    expect(nextBucket("month", "2026-02-01T00:00:00.000Z")).toBe("2026-03-01T00:00:00.000Z");
    expect(nextBucket("month", "2026-12-01T00:00:00.000Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("advances a week by exactly seven days, across a month boundary", () => {
    expect(nextBucket("week", "2026-08-31T00:00:00.000Z")).toBe("2026-09-07T00:00:00.000Z");
  });

  it("tiles a range of months without gaps or repeats", () => {
    // `from` inclusive, `to` exclusive, so adjacent ranges tile — a caller asking for two ranges must not
    // double-count the boundary bucket.
    expect(bucketsBetween("month", "2026-01-15T00:00:00.000Z", "2026-04-01T00:00:00.000Z")).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });

  it("tiles a range of weeks across a year boundary", () => {
    const weeks = bucketsBetween("week", "2026-12-28T00:00:00.000Z", "2027-01-18T00:00:00.000Z");
    expect(weeks).toEqual([
      "2026-12-28T00:00:00.000Z",
      "2027-01-04T00:00:00.000Z",
      "2027-01-11T00:00:00.000Z",
    ]);
  });

  it("keeps every period's bucket start idempotent", () => {
    // Truncating a bucket start must return itself, or two writers computing "the period containing T" disagree
    // and write two rows for one bucket.
    for (const period of ROLLUP_PERIODS) {
      const start = bucketStartFor(period, "2026-08-24T13:45:12.345Z");
      expect(bucketStartFor(period, start)).toBe(start);
    }
  });
});

/**
 * The recorder stamps the principal from the context — #175.
 *
 * This test exists because its absence cost me the feature twice over. The stamping was written, then lost to a
 * `cp` restoring a backup taken before it, and **nothing failed**: the column was there, the rollups ran, the
 * limits resolved, and every per-person figure was silently null. It surfaced only by running the app and looking
 * at the table.
 *
 * The lesson is the general one this codebase keeps relearning: a value that is supposed to *arrive* somewhere
 * needs a test at the arrival, not only at the departure.
 */
describe("usage recorder — identity comes from the context", () => {
  const stored = async (over: Partial<ExecutionContext> = {}) => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, clock: () => "t" });
    await rec.record({ ...ctx(), ...over } as ExecutionContext, {
      runId: R,
      modelId: "m1",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costMinorUnits: 1,
      currency: "USD",
      stepId: "s1",
    });
    return (await store.listByRun({ tenantId: T, runId: R, limit: 10 })).items[0];
  };

  it("records the principal from the execution context", async () => {
    expect((await stored())?.principalId).toBe("p1");
  });

  it("records the tenant from the context too", async () => {
    expect((await stored())?.tenantId).toBe(T);
  });

  /**
   * The caller cannot name the principal. `UsageEventInput` omits it from the type, and this asserts the runtime
   * behaviour matches — a caller able to name it could bill someone else's budget, which is the same rule
   * `tenantId` has always followed.
   */
  it("ignores a principal supplied on the event payload", async () => {
    const store = createMemoryUsageStore();
    const rec = createUsageRecorder({ store, pricing, clock: () => "t" });
    await rec.record(ctx(), {
      runId: R,
      modelId: "m1",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costMinorUnits: 1,
      currency: "USD",
      stepId: "s1",
      // Deliberately smuggled past the type, which is what a compromised or careless caller would do.
      principalId: "somebody-else",
    } as never);
    expect((await store.listByRun({ tenantId: T, runId: R, limit: 10 })).items[0]?.principalId).toBe("p1");
  });
});
