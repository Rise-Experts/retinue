/**
 * Long-thread compaction — `docs/13-sessions-and-threads.md` → Long-thread compaction.
 *
 * When a thread's history outgrows the context budget, older turns are compacted into a durable,
 * versioned thread summary rather than dropped. Recent turns and open tool continuity are preserved
 * verbatim; only the older prefix is summarized. Compaction emits the `context.compacted` transport
 * event so a client can show that history was condensed. The summarizer itself is injected, so this
 * stays provider-neutral.
 */

import type { Message } from "../core/content-parts.js";
import { estimateTokens } from "../core/tokens.js";
import type { ConversationId, TenantId } from "../core/ids.js";
import type { ThreadSummary, ThreadSummaryStore } from "../persistence/index.js";
import type { ContextCompactedEvent } from "../core/events.js";

/** Produces the condensed text for a batch of older messages, layering on any prior summary. */
export interface ThreadSummarizer {
  summarize(input: { priorSummary?: string; messages: readonly Message[] }): Promise<string>;
}

const partCount = (messages: readonly Message[]): number =>
  messages.reduce((sum, m) => sum + m.parts.length, 0);

/**
 * Choose the split so the kept (recent) side never *starts* with a dangling tool result whose
 * tool-call would be summarized away. Walk the boundary earlier while the first kept message is a
 * tool message, preserving tool-call ↔ tool-result continuity.
 */
const splitPreservingToolContinuity = (
  messages: readonly Message[],
  keepRecent: number,
): { older: readonly Message[]; recent: readonly Message[] } => {
  let boundary = Math.max(0, messages.length - keepRecent);
  while (boundary > 0 && messages[boundary]?.role === "tool") boundary -= 1;
  return { older: messages.slice(0, boundary), recent: messages.slice(boundary) };
};

export type CompactionResult = {
  readonly summary: ThreadSummary;
  /** Recent turns kept verbatim — these plus the summary feed the next prompt. */
  readonly kept: readonly Message[];
  /** The transport event to publish (worker stamps runId/sequence/occurredAt). */
  readonly event: Omit<ContextCompactedEvent, "runId" | "sequence" | "occurredAt">;
};

/**
 * Compact a thread's history. Returns null when there is nothing worth compacting (history at or
 * under `keepRecent`, or no older messages survive the tool-continuity split). Otherwise summarizes
 * the older prefix, appends a versioned `ThreadSummary`, and reports what was reclaimed.
 */
export const compactThread = async (input: {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  /** Full history, oldest first. */
  readonly messages: readonly Message[];
  /** How many trailing messages to keep verbatim. */
  readonly keepRecent: number;
  readonly summaries: ThreadSummaryStore;
  readonly summarizer: ThreadSummarizer;
  /** Token estimate for a set of messages, used to report tokensReclaimed. */
  readonly estimateTokens: (messages: readonly Message[]) => number;
}): Promise<CompactionResult | null> => {
  if (input.messages.length <= input.keepRecent) return null;
  const { older, recent } = splitPreservingToolContinuity(input.messages, input.keepRecent);
  if (older.length === 0) return null;

  const prior = await input.summaries.latest({ tenantId: input.tenantId, conversationId: input.conversationId });
  const text = await input.summarizer.summarize({
    ...(prior ? { priorSummary: prior.summary } : {}),
    messages: older,
  });

  const coversUpToMessageId = older[older.length - 1]!.id;
  const summary = await input.summaries.append({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    summary: text,
    coversUpToMessageId,
  });

  // Tokens saved by replacing the older messages with the (smaller) summary text.
  const summaryTokens = estimateTokens(text);
  const tokensReclaimed = Math.max(0, input.estimateTokens(older) - summaryTokens);

  return {
    summary,
    kept: recent,
    event: { type: "context.compacted", droppedParts: partCount(older), tokensReclaimed },
  };
};
