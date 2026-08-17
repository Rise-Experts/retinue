/**
 * Usage recording port — `docs/12-usage-and-accounting.md`. **Frozen v1.**
 *
 * The runtime records usage from the day it exists (REQ-005); rollups, quotas and reporting are
 * built on top in REQ-013 without reopening the runtime. Shape only here.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ConversationId, RunId } from "../core/ids.js";

export type UsageEvent = {
  readonly id: string;
  readonly tenantId: string;
  readonly conversationId?: ConversationId;
  readonly runId: RunId;
  readonly stepId?: string;
  readonly toolCallId?: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens?: number;
  /** Integer minor units in the tenant's accounting currency. */
  readonly costMinorUnits: number;
  readonly currency: string;
  readonly occurredAt: string;
};

/** What a caller supplies; the recorder stamps `id`, `tenantId` and `occurredAt`. */
export type UsageEventInput = Omit<UsageEvent, "id" | "tenantId" | "occurredAt">;

export type CostEstimate = {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
};

export type Reservation = {
  readonly id: string;
  /** False when the estimate would exceed a run or tenant ceiling. */
  readonly withinCeiling: boolean;
};

export interface UsageRecorder {
  /** Append a usage event, written in the run's completion transaction. */
  record(context: ExecutionContext, event: UsageEventInput): Promise<void>;
  /** Pre-flight ceiling check before a provider call. */
  reserve(context: ExecutionContext, estimate: CostEstimate): Promise<Reservation>;
}
