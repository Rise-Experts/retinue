/**
 * Usage recording port — `docs/12-usage-and-accounting.md`. **Frozen v1.**
 *
 * The runtime records usage from the day it exists (REQ-005); rollups, quotas and reporting are
 * built on top in REQ-013 without reopening the runtime. Shape only here.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ConversationId, RunId } from "../core/ids.js";
import type { ModelPricing } from "../models/index.js";

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
  /** Append a usage event for a realized step. Append-only and idempotent on `(runId, stepId)`. */
  record(context: ExecutionContext, event: UsageEventInput): Promise<void>;
  /** Pre-flight ceiling check before a provider call, against the run's remaining budget. */
  reserve(context: ExecutionContext, estimate: CostEstimate): Promise<Reservation>;
}

/** Per-run cost/token ceiling (from `ExecutionLimits`, doc 04). Any field omitted is unbounded. */
export type UsageCeiling = {
  readonly costMinorUnits?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
};

/**
 * Provider-aware token estimate used for budgeting and pre-flight ceiling checks (doc 03/12).
 * Actuals from the provider response are authoritative and reconcile these estimates afterwards.
 */
export interface TokenCounter {
  estimate(text: string): number;
}

/** Resolves a model's pricing at execution time so cost is computed from live rates, not guesses. */
export interface PricingResolver {
  resolve(modelId: string): ModelPricing | null;
}

export * from "./recorder.js";
