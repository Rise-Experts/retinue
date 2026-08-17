/**
 * In-memory thread summary store — `docs/13` → Long-thread compaction. Versioned, append-only
 * compacted history; `latest` returns the newest summary. Tenant/conversation-partitioned.
 */

import type { ThreadSummary, ThreadSummaryStore } from "../../persistence/index.js";

export const createMemoryThreadSummaryStore = (
  clock: () => string = () => new Date().toISOString(),
): ThreadSummaryStore => {
  const byKey = new Map<string, ThreadSummary[]>();
  const key = (tenantId: string, conversationId: string) => `${tenantId} ${conversationId}`;

  return {
    async latest({ tenantId, conversationId }) {
      const list = byKey.get(key(tenantId, conversationId));
      return list && list.length > 0 ? list[list.length - 1]! : null;
    },
    async append({ tenantId, conversationId, summary, coversUpToMessageId }) {
      const k = key(tenantId, conversationId);
      const list = byKey.get(k) ?? [];
      const next: ThreadSummary = {
        conversationId,
        version: list.length + 1,
        summary,
        coversUpToMessageId,
        createdAt: clock(),
      };
      list.push(next);
      byKey.set(k, list);
      return next;
    },
  };
};
