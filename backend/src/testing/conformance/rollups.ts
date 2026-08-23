/**
 * `UsageRollupStore` conformance (#139).
 *
 * Almost every case is about a property that only shows up under repetition or concurrency: idempotency, no
 * double counting, no lost records, no cross-tenant aggregate. Those are the ones a spend figure has to get
 * right, and the ones a single-write test cannot see.
 *
 * The fixture pairs the rollup store with the ledger it derives from, because a rollup computed from a
 * *different* set of events than the ledger holds is the exact bug this port exists to prevent — and a suite
 * that opened them separately could not notice.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import type { UsageEvent, UsageRollupStore, UsageStore } from "../../persistence/index.js";

const T1 = asId<TenantId>("conf-rollup-tenant-1");
const T2 = asId<TenantId>("conf-rollup-tenant-2");
const HOUR = "2026-08-23T10:00:00.000Z";
const NEXT_HOUR = "2026-08-23T11:00:00.000Z";
const DAY = "2026-08-23T00:00:00.000Z";

/**
 * Both ports over one set of events, which is how a real deployment provides them.
 *
 * `seedRun` because `usage_records` has a foreign key to `runs` — an event belongs to a run, and Postgres
 * enforces it. The in-memory adapter has no such constraint, which is exactly the situation `parents.ts`
 * exists for.
 */
export type RollupFixture = {
  readonly usage: UsageStore;
  readonly rollups: UsageRollupStore;
  readonly seedRun?: (input: { readonly tenantId: TenantId; readonly runId: RunId }) => Promise<void>;
};

const event = (overrides: Partial<UsageEvent> & { readonly n: number }): UsageEvent => ({
  id: overrides.id ?? `e${overrides.n}`,
  tenantId: overrides.tenantId ?? T1,
  runId: overrides.runId ?? asId<RunId>(`run-${overrides.n}`),
  modelId: "m1",
  inputTokens: overrides.inputTokens ?? 100,
  outputTokens: overrides.outputTokens ?? 20,
  cachedInputTokens: overrides.cachedInputTokens ?? 5,
  // Non-zero by default, so every case exercises it. Found by sabotage: with it unset, making
  // `reasoning_tokens` accumulate passed every double-count test — 0 + 0 is 0.
  reasoningTokens: overrides.reasoningTokens ?? 3,
  costMinorUnits: overrides.costMinorUnits ?? 7,
  currency: overrides.currency ?? "EUR",
  occurredAt: overrides.occurredAt ?? "2026-08-23T10:30:00.000Z",
  ...(overrides.stepId === undefined ? {} : { stepId: overrides.stepId }),
});

export function usageRollupStoreConformance(
  make: () => RollupFixture | Promise<RollupFixture>,
): void {
  describe("UsageRollupStore conformance", () => {
    const seeded = async (events: readonly UsageEvent[]): Promise<RollupFixture> => {
      const fixture = await make();
      // Parents first, and de-duplicated: several events share a run in the concurrency cases, and creating a
      // run twice is a conflict rather than a no-op.
      const runs = new Map<string, { tenantId: TenantId; runId: RunId }>();
      for (const e of events) runs.set(`${e.tenantId} ${e.runId}`, { tenantId: e.tenantId as TenantId, runId: e.runId });
      for (const run of runs.values()) await fixture.seedRun?.(run);
      for (const e of events) await fixture.usage.append({ tenantId: e.tenantId as TenantId, event: e });
      return fixture;
    };

    /** Append after seeding, creating the event's run parent first. Two cases need it and both did without. */
    const appendLater = async (fixture: RollupFixture, e: UsageEvent): Promise<void> => {
      await fixture.seedRun?.({ tenantId: e.tenantId as TenantId, runId: e.runId });
      await fixture.usage.append({ tenantId: e.tenantId as TenantId, event: e });
    };

    it("sums a bucket's events exactly", async () => {
      const { rollups } = await seeded([
        event({ n: 1, costMinorUnits: 7 }),
        event({ n: 2, costMinorUnits: 11 }),
        event({ n: 3, costMinorUnits: 13 }),
      ]);
      const row = await rollups.rebuild({
        tenantId: T1,
        period: "hour",
        bucketStart: HOUR,
      });
      expect(row).toMatchObject({
        period: "hour",
        bucketStart: HOUR,
        costMinorUnits: 31,
        inputTokens: 300,
        outputTokens: 60,
        eventCount: 3,
        currency: "EUR",
      });
    });

    it("matches a direct sum of the ledger", async () => {
      // The comparison the test steps ask for. A rollup that disagreed with the ledger would be a plausible
      // wrong number, which is the worst kind for an invoice.
      const events = Array.from({ length: 50 }, (_, i) =>
        event({ n: i, costMinorUnits: i + 1, inputTokens: i * 3, outputTokens: i }),
      );
      const { usage, rollups } = await seeded(events);
      const row = await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      const direct = await usage.totals({ tenantId: T1 });
      expect(row.costMinorUnits).toBe(direct.costMinorUnits);
      expect(row.inputTokens).toBe(direct.inputTokens);
      expect(row.eventCount).toBe(direct.eventCount);
    });

    it("does not double count when rebuilt twice", async () => {
      // AC-4. A rebuild is a *recomputation*, so this is structural rather than bookkept — but it is the one
      // property whose failure is invisible until an invoice is wrong.
      const { rollups } = await seeded([event({ n: 1 }), event({ n: 2 })]);
      const first = await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      const second = await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      // *Every* numeric field, not only cost and count. Found by sabotage: making just `input_tokens`
      // accumulate passed a test that checked the other two, and a rollup with correct money and wrong tokens
      // is the kind of wrong that survives review.
      expect({ ...second, computedAt: "" }).toEqual({ ...first, computedAt: "" });
      // `computedAt` is stamped by the store and moves forward (or stays, within a clock tick) — never
      // backwards, which is what would make a fresh bucket look stale forever.
      expect(second.computedAt >= first.computedAt).toBe(true);
    });

    it("does not double count when two writers race the same bucket", async () => {
      const { rollups } = await seeded([event({ n: 1 }), event({ n: 2 }), event({ n: 3 })]);
      const [a, b] = await Promise.all([
        rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR }),
        rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR }),
      ]);
      // Every field, for the same reason as above: two racing writers agreeing on the money and disagreeing on
      // the tokens is still a corrupt rollup.
      expect({ ...a, computedAt: "" }).toEqual({ ...b, computedAt: "" });
      expect(await rollups.get({ tenantId: T1, period: "hour", bucketStart: HOUR })).toMatchObject({
        costMinorUnits: 21,
        eventCount: 3,
        inputTokens: 300,
      });
    });

    it("loses nothing when events land between two rebuilds", async () => {
      // The "no lost records" half of AC-4: the aggregation and the write are one statement, so an event
      // arriving cannot fall between a read and a write and be dropped from the rollup while sitting in the
      // ledger.
      const fixture = await seeded([event({ n: 1 })]);
      await fixture.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      await appendLater(fixture, event({ n: 2 }));
      const row = await fixture.rollups.rebuild({
        tenantId: T1,
        period: "hour",
        bucketStart: HOUR,
      });
      expect(row.eventCount).toBe(2);
    });

    it("excludes an event from the next bucket", async () => {
      // An off-by-one on the upper bound would put an event in two buckets, so a day total would exceed the
      // sum of its hours.
      const { rollups } = await seeded([
        event({ n: 1, occurredAt: "2026-08-23T10:59:59.999Z" }),
        event({ n: 2, occurredAt: NEXT_HOUR }),
      ]);
      const first = await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      const second = await rollups.rebuild({
        tenantId: T1,
        period: "hour",
        bucketStart: NEXT_HOUR,
      });
      expect(first.eventCount).toBe(1);
      expect(second.eventCount).toBe(1);
    });

    it("makes a day's total the sum of its hours", async () => {
      // The invariant that catches a boundary error in either period: if an event is double-counted or dropped
      // by one of them, the two totals stop agreeing.
      const { rollups } = await seeded([
        event({ n: 1, occurredAt: "2026-08-23T00:15:00.000Z", costMinorUnits: 5 }),
        event({ n: 2, occurredAt: "2026-08-23T10:30:00.000Z", costMinorUnits: 7 }),
        event({ n: 3, occurredAt: "2026-08-23T23:59:00.000Z", costMinorUnits: 11 }),
      ]);
      for (const bucketStart of ["2026-08-23T00:00:00.000Z", HOUR, "2026-08-23T23:00:00.000Z"]) {
        await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart });
      }
      const day = await rollups.rebuild({ tenantId: T1, period: "day", bucketStart: DAY });
      const hours = await rollups.sum({
        tenantId: T1,
        period: "hour",
        from: DAY,
        to: "2026-08-24T00:00:00.000Z",
      });
      expect(day.costMinorUnits).toBe(hours.costMinorUnits);
      expect(day.eventCount).toBe(hours.eventCount);
    });

    it("returns null for a bucket nothing has computed", async () => {
      // Distinct from a zero bucket: "never computed" and "computed and empty" want different responses from a
      // job, and conflating them would either re-run everything forever or never run anything.
      const { rollups } = await seeded([event({ n: 1 })]);
      expect(await rollups.get({ tenantId: T1, period: "hour", bucketStart: NEXT_HOUR })).toBeNull();
    });

    it("computes an empty bucket as zero rather than refusing", async () => {
      const { rollups } = await seeded([]);
      const row = await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      expect(row).toMatchObject({ costMinorUnits: 0, eventCount: 0, inputTokens: 0 });
    });

    it("never aggregates across tenants", async () => {
      // AC-6, and the case a `WHERE` clause someone forgot would fail: both tenants have events in the same
      // bucket, so a missing predicate produces a plausible larger number rather than an error.
      const { rollups } = await seeded([
        event({ n: 1, costMinorUnits: 7 }),
        event({ n: 2, tenantId: T2, costMinorUnits: 1000 }),
      ]);
      const mine = await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      expect(mine.costMinorUnits).toBe(7);
      const theirs = await rollups.rebuild({ tenantId: T2, period: "hour", bucketStart: HOUR });
      expect(theirs.costMinorUnits).toBe(1000);
      // And neither can read the other's bucket.
      expect(await rollups.get({ tenantId: T2, period: "hour", bucketStart: HOUR })).toMatchObject({
        costMinorUnits: 1000,
      });
      expect(await rollups.sum({ tenantId: T1, period: "hour", from: HOUR, to: NEXT_HOUR })).toMatchObject({
        costMinorUnits: 7,
      });
    });

    it("lists a range in order, exclusive at the top", async () => {
      // Exclusive so adjacent ranges tile: a caller asking for two ranges must not get a boundary bucket twice.
      const { rollups } = await seeded([]);
      for (const h of [10, 11, 12]) {
        await rollups.rebuild({
          tenantId: T1,
          period: "hour",
          bucketStart: `2026-08-23T${h}:00:00.000Z`,
        });
      }
      const page = await rollups.list({
        tenantId: T1,
        period: "hour",
        from: HOUR,
        to: "2026-08-23T12:00:00.000Z",
        limit: 10,
      });
      expect(page.items.map((r) => r.bucketStart)).toEqual([HOUR, NEXT_HOUR]);
    });

    it("pages a range without repeating or skipping a bucket", async () => {
      const { rollups } = await seeded([]);
      for (const h of [10, 11, 12, 13, 14]) {
        await rollups.rebuild({
          tenantId: T1,
          period: "hour",
          bucketStart: `2026-08-23T${h}:00:00.000Z`,
        });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await rollups.list({
          tenantId: T1,
          period: "hour",
          from: HOUR,
          to: "2026-08-23T15:00:00.000Z",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((r) => r.bucketStart));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("keeps the hour and day series apart", async () => {
      // Same tenant, same instant, two periods. A key missing `period` would have one overwrite the other and a
      // day total would silently become an hour's.
      const { rollups } = await seeded([event({ n: 1, occurredAt: "2026-08-23T10:30:00.000Z" })]);
      await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      await rollups.rebuild({ tenantId: T1, period: "day", bucketStart: DAY });
      expect(await rollups.get({ tenantId: T1, period: "hour", bucketStart: HOUR })).not.toBeNull();
      expect(await rollups.get({ tenantId: T1, period: "day", bucketStart: DAY })).not.toBeNull();
      expect(await rollups.get({ tenantId: T1, period: "day", bucketStart: HOUR })).toBeNull();
    });

    it("lists a bucket with events but no rollup as stale", async () => {
      const { rollups } = await seeded([event({ n: 1 })]);
      const page = await rollups.listStaleBuckets({ tenantId: T1, period: "hour", since: DAY, limit: 10 });
      expect(page.items).toEqual([{ period: "hour", bucketStart: HOUR }]);
    });

    it("stops listing a bucket once it is computed", async () => {
      // Otherwise the job never drains and rebuilds the same bucket forever.
      const { rollups } = await seeded([event({ n: 1 })]);
      await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      expect(
        (await rollups.listStaleBuckets({ tenantId: T1, period: "hour", since: DAY, limit: 10 })).items,
      ).toEqual([]);
    });

    it("lists a bucket again when a newer event lands in it", async () => {
      // The other direction: a rollup computed before an event is wrong, and nothing else would notice.
      const fixture = await seeded([event({ n: 1 })]);
      await fixture.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      await appendLater(fixture, event({ n: 2, occurredAt: "2026-08-23T12:30:00.000Z" }));
      const page = await fixture.rollups.listStaleBuckets({
        tenantId: T1,
        period: "hour",
        since: DAY,
        limit: 10,
      });
      expect(page.items.map((b) => b.bucketStart)).toContain("2026-08-23T12:00:00.000Z");
    });

    it("lists a bucket again when a *late* event lands in it", async () => {
      // The case that judging staleness by `occurredAt` misses entirely: an event recorded now but stamped in
      // the past — a delayed provider report, or a recovered run replaying its steps. Its bucket looks already
      // computed, so the event is never rolled up and the total is silently short. Found by writing this test
      // and watching the rollup job report nothing to do.
      const fixture = await seeded([event({ n: 1, occurredAt: "2026-08-23T10:50:00.000Z" })]);
      await fixture.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });

      // Recorded *after* the rollup, occurring *before* it — the whole point of the case.
      await appendLater(fixture, event({ n: 2, occurredAt: "2026-08-23T10:05:00.000Z" }));
      expect(
        (await fixture.rollups.listStaleBuckets({ tenantId: T1, period: "hour", since: DAY, limit: 10 })).items,
      ).toEqual([{ period: "hour", bucketStart: HOUR }]);
      // And the rebuild picks the late event up, which is the consequence that matters.
      expect((await fixture.rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR })).eventCount).toBe(2);

      // And the bucket is fresh again once rebuilt. Asserted exactly, which only became possible when staleness
      // moved from a clock to a monotonic sequence: two timestamps can tie, and a tie had to be read as
      // "stale" to stay safe — which made a genuinely drained bucket indistinguishable from one that was not.
      expect(
        (await fixture.rollups.listStaleBuckets({ tenantId: T1, period: "hour", since: DAY, limit: 10 })).items,
      ).toEqual([]);
    });

    it("lists no stale bucket for another tenant", async () => {
      const { rollups } = await seeded([event({ n: 1 })]);
      expect(
        (await rollups.listStaleBuckets({ tenantId: T2, period: "hour", since: DAY, limit: 10 })).items,
      ).toEqual([]);
    });

    it("rolls up reasoning tokens the ledger recorded", async () => {
      // The ledger has the column, so a rollup that ignored it would drop a figure that is on the invoice.
      const { rollups } = await seeded([
        event({ n: 1, reasoningTokens: 40 }),
        event({ n: 2, reasoningTokens: 60 }),
      ]);
      const row = await rollups.rebuild({ tenantId: T1, period: "hour", bucketStart: HOUR });
      expect(row.reasoningTokens).toBe(100);
    });
  });
}
