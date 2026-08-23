/**
 * In-memory usage ledger — `docs/12-usage-and-accounting.md`.
 *
 * Append-only reference `UsageStore`: events are only ever added, never edited or deleted. Appends
 * are idempotent on `(runId, stepId)` (falling back to `id`), so a recovered run that re-records a
 * step it already logged does not double-count. `totals` derives rollups from the events — never a
 * separate source of truth.
 */

import type { Page } from "../../core/context.js";
import { bucketStartFor, nextBucket } from "../../usage/quota.js";
import type {
  RollupPeriod,
  UsageRollup,
  UsageRollupStore,
  UsageStore,
  UsageTotals,
} from "../../persistence/index.js";
import { usageDedupeKey } from "../../usage/index.js";
import type { UsageEvent } from "../../usage/index.js";

const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costMinorUnits: 0,
  eventCount: 0,
};

// Imported from the port (#100) rather than defined here, so the Postgres adapter cannot drift.
/**
 * The ledger and its rollups over one set of rows (#139).
 *
 * One backend, because a rollup is *derived* from the ledger and nothing else — deriving it from a second copy
 * of the events would make the two able to disagree, which is the one thing a spend figure must not do.
 */
export const createMemoryUsageBackend = (options: { readonly clock?: () => string } = {}) => {
  const clock = options.clock ?? (() => new Date().toISOString());
  // tenantId → (dedupeKey → event). Partitioning by tenant makes cross-tenant reads impossible.
  const byTenant = new Map<string, Map<string, UsageEvent>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };

  /**
   * When we learned about each event, keyed the same way as the event.
   *
   * Distinct from `occurredAt`: an event can be recorded late — a delayed provider report, a recovered run
   * replaying its steps — with an `occurredAt` in the past. Staleness judged by `occurredAt` would see its
   * bucket as already computed and never roll it up, which is a silent undercount.
   *
   * A monotonic counter rather than a clock, so two events recorded in the same millisecond still order — and
   * so a test needs no injected clock to observe the property.
   */
  const recordedAt = new Map<string, number>();
  let recordSequence = 0;

  const usage: UsageStore = {
    async append({ tenantId, event }) {
      const rows = tenant(tenantId);
      const key = usageDedupeKey(event);
      if (rows.has(key)) return; // idempotent: a re-recorded step is a no-op
      rows.set(key, event);
      recordedAt.set(`${tenantId} ${key}`, (recordSequence += 1));
    },

    async listByRun({ tenantId, runId, limit, cursor }) {
      const all = [...tenant(tenantId).values()]
        .filter((e) => e.runId === runId)
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1));
      const start = cursor ? all.findIndex((e) => e.id === cursor) + 1 : 0;
      const items = all.slice(start, start + limit);
      const nextCursor = start + limit < all.length ? items[items.length - 1]?.id : undefined;
      const page: Page<UsageEvent> = nextCursor === undefined ? { items } : { items, nextCursor };
      return page;
    },

    async breakdown({ tenantId, from, to, by, limit }) {
      const scoped = [...tenant(tenantId).values()].filter(
        // Half-open, like every other range in this codebase, so adjacent periods tile without a boundary
        // event appearing in both.
        (e) => e.occurredAt >= from && e.occurredAt < to,
      );
      const groups = new Map<string, UsageTotals>();
      for (const e of scoped) {
        // A conversation is optional on a usage event — a background extraction has none — so those group under
        // an explicit key rather than being silently dropped, which would make the breakdown not add up.
        const key = by === "model" ? e.modelId : (e.conversationId ?? "");
        const current = groups.get(key) ?? ZERO_TOTALS;
        groups.set(key, {
          inputTokens: current.inputTokens + e.inputTokens,
          outputTokens: current.outputTokens + e.outputTokens,
          cachedInputTokens: current.cachedInputTokens + e.cachedInputTokens,
          reasoningTokens: current.reasoningTokens + (e.reasoningTokens ?? 0),
          costMinorUnits: current.costMinorUnits + e.costMinorUnits,
          eventCount: current.eventCount + 1,
        });
      }
      return [...groups.entries()]
        .map(([key, totals]) => ({ key, totals }))
        // Largest cost first, so a `limit` drops what matters least; ties by key so the order is stable and a
        // rendered breakdown does not reshuffle between refreshes.
        .sort((a, b) =>
          b.totals.costMinorUnits !== a.totals.costMinorUnits
            ? b.totals.costMinorUnits - a.totals.costMinorUnits
            : a.key.localeCompare(b.key),
        )
        .slice(0, limit);
    },

    async totals({ tenantId, runId, conversationId }) {
      const scoped = [...tenant(tenantId).values()].filter(
        (e) =>
          (runId === undefined || e.runId === runId) &&
          (conversationId === undefined || e.conversationId === conversationId),
      );
      return scoped.reduce<UsageTotals>(
        (acc, e) => ({
          inputTokens: acc.inputTokens + e.inputTokens,
          outputTokens: acc.outputTokens + e.outputTokens,
          cachedInputTokens: acc.cachedInputTokens + e.cachedInputTokens,
          reasoningTokens: acc.reasoningTokens + (e.reasoningTokens ?? 0),
          costMinorUnits: acc.costMinorUnits + e.costMinorUnits,
          eventCount: acc.eventCount + 1,
        }),
        ZERO_TOTALS,
      );
    },
  };

  /** Buckets already computed, so `listStaleBuckets` can tell "never computed" from "computed and current". */
  const computed = new Map<string, Map<string, UsageRollup>>();
  /** The record sequence a bucket was last computed at, paired with its row. */
  const computedAtSequence = new Map<string, number>();
  const rollupsFor = (t: string) => {
    let m = computed.get(t);
    if (!m) computed.set(t, (m = new Map()));
    return m;
  };

  /** Events in a bucket, by their `occurredAt`. The only input a rebuild has. */
  const eventsIn = (tenantId: string, period: RollupPeriod, bucketStart: string): readonly UsageEvent[] => {
    const end = nextBucket(period, bucketStart);
    return [...tenant(tenantId).values()].filter((e) => e.occurredAt >= bucketStart && e.occurredAt < end);
  };

  const sumOf = (events: readonly UsageEvent[]): UsageTotals =>
    events.reduce<UsageTotals>(
      (acc, e) => ({
        inputTokens: acc.inputTokens + e.inputTokens,
        outputTokens: acc.outputTokens + e.outputTokens,
        cachedInputTokens: acc.cachedInputTokens + e.cachedInputTokens,
        reasoningTokens: acc.reasoningTokens + (e.reasoningTokens ?? 0),
        costMinorUnits: acc.costMinorUnits + e.costMinorUnits,
        eventCount: acc.eventCount + 1,
      }),
      ZERO_TOTALS,
    );

  const rollups: UsageRollupStore = {
    async rebuild({ tenantId, period, bucketStart }) {
      const computedAt = clock();
      // A **recomputation**, not an accumulation. Re-running writes the same numbers and two writers racing
      // one bucket write the same value, which is what makes idempotency structural rather than bookkept.
      const events = eventsIn(tenantId, period, bucketStart);
      const totals = sumOf(events);
      const row: UsageRollup = {
        ...totals,
        period,
        bucketStart,
        // The currency of the events in the bucket. Empty when there are none — a bucket with no spend has no
        // currency, and claiming one would be inventing a fact.
        currency: events[0]?.currency ?? "",
        computedAt,
      };
      rollupsFor(tenantId).set(`${period} ${bucketStart}`, row);
      // The sequence at the moment of computation, so a *later* append marks the bucket stale again regardless
      // of when the event claims to have occurred.
      computedAtSequence.set(`${tenantId} ${period} ${bucketStart}`, recordSequence);
      return row;
    },

    async get({ tenantId, period, bucketStart }) {
      // Absent from *this tenant's* map, so a foreign bucket is null without a comparison anyone could get
      // wrong — and no aggregate can span tenants.
      return rollupsFor(tenantId).get(`${period} ${bucketStart}`) ?? null;
    },

    async list({ tenantId, period, from, to, limit, cursor }) {
      const rows = [...rollupsFor(tenantId).values()]
        .filter((r) => r.period === period && r.bucketStart >= from && r.bucketStart < to)
        .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
      const start = cursor === undefined ? 0 : rows.findIndex((r) => r.bucketStart > cursor);
      const at = start < 0 ? rows.length : start;
      const items = rows.slice(at, at + limit);
      const last = items[items.length - 1];
      return at + limit < rows.length && last !== undefined
        ? { items, nextCursor: last.bucketStart }
        : { items };
    },

    async sum({ tenantId, period, from, to }) {
      // Over the *rollups*, not the ledger: the whole point of AC-1 is that a read never scans raw records.
      return [...rollupsFor(tenantId).values()]
        .filter((r) => r.period === period && r.bucketStart >= from && r.bucketStart < to)
        .reduce<UsageTotals>(
          (acc, r) => ({
            inputTokens: acc.inputTokens + r.inputTokens,
            outputTokens: acc.outputTokens + r.outputTokens,
            cachedInputTokens: acc.cachedInputTokens + r.cachedInputTokens,
            reasoningTokens: acc.reasoningTokens + r.reasoningTokens,
            costMinorUnits: acc.costMinorUnits + r.costMinorUnits,
            eventCount: acc.eventCount + r.eventCount,
          }),
          ZERO_TOTALS,
        );
    },

    async listStaleBuckets({ tenantId, period, since, limit, cursor }) {
      // Derived from the ledger: a bucket is stale when it holds an event newer than its last computation, or
      // has never been computed. So an interrupted job resumes by asking again -- there is no cursor to lose.
      const rows = rollupsFor(tenantId);
      // Keyed on the newest *record* sequence in each bucket, not the newest `occurredAt`.
      const buckets = new Map<string, number>();
      for (const [key, event] of tenant(tenantId)) {
        if (event.occurredAt < since) continue;
        const bucketStart = bucketStartFor(period, event.occurredAt);
        const seq = recordedAt.get(`${tenantId} ${key}`) ?? 0;
        const newest = buckets.get(bucketStart);
        if (newest === undefined || seq > newest) buckets.set(bucketStart, seq);
      }
      const stale = [...buckets.entries()]
        .filter(([bucketStart, newestRecord]) => {
          const existing = rows.get(`${period} ${bucketStart}`);
          if (existing === undefined) return true;
          const computedSeq = computedAtSequence.get(`${tenantId} ${period} ${bucketStart}`) ?? 0;
          return newestRecord > computedSeq;
        })
        .map(([bucketStart]) => ({ period, bucketStart }))
        .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
      const start = cursor === undefined ? 0 : stale.findIndex((b) => b.bucketStart > cursor);
      const at = start < 0 ? stale.length : start;
      const items = stale.slice(at, at + limit);
      const last = items[items.length - 1];
      return at + limit < stale.length && last !== undefined
        ? { items, nextCursor: last.bucketStart }
        : { items };
    },
  };

  return { usage, rollups };
};

export const createMemoryUsageStore = (): UsageStore => createMemoryUsageBackend().usage;
export const createMemoryUsageRollupStore = (): UsageRollupStore => createMemoryUsageBackend().rollups;
