/**
 * In-memory usage ledger — `docs/12-usage-and-accounting.md`.
 *
 * Append-only reference `UsageStore`: events are only ever added, never edited or deleted. Appends
 * are idempotent on `(runId, stepId)` (falling back to `id`), so a recovered run that re-records a
 * step it already logged does not double-count. `totals` derives rollups from the events — never a
 * separate source of truth.
 */

import type { Page } from "../../core/context.js";
import type { UsageStore, UsageTotals } from "../../persistence/index.js";
import type { UsageEvent } from "../../usage/index.js";

const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costMinorUnits: 0,
  eventCount: 0,
};

const dedupeKey = (event: UsageEvent): string =>
  event.stepId !== undefined ? `${event.runId}:${event.stepId}` : event.id;

export const createMemoryUsageStore = (): UsageStore => {
  // tenantId → (dedupeKey → event). Partitioning by tenant makes cross-tenant reads impossible.
  const byTenant = new Map<string, Map<string, UsageEvent>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };

  return {
    async append({ tenantId, event }) {
      const rows = tenant(tenantId);
      const key = dedupeKey(event);
      if (rows.has(key)) return; // idempotent: a re-recorded step is a no-op
      rows.set(key, event);
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
};
