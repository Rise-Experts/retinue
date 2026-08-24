/**
 * Usage recording port — `docs/12-usage-and-accounting.md`. **Frozen v1.**
 *
 * The runtime records usage from the day it exists (REQ-005); rollups, quotas and reporting are
 * built on top in REQ-013 without reopening the runtime. Shape only here.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ConversationId, PrincipalId, RunId } from "../core/ids.js";
import type { ModelPricing } from "../models/index.js";

export type UsageEvent = {
  readonly id: string;
  readonly tenantId: string;
  /**
   * Who consumed it — #175.
   *
   * A usage record carried a tenant and no principal, so "what has this person spent" was unanswerable: the data
   * was never recorded. Per-user metrics and per-user limits both start here.
   *
   * Stamped by the recorder from the **trusted context**, never from the event payload — the same rule `tenantId`
   * follows, and for the same reason: a caller that could name the principal on a usage event could bill someone
   * else's budget.
   *
   * Optional on the type, because rows written before this exist and a record with an unknown principal is a
   * fact rather than a thing to invent. It is nullable in storage for that reason too.
   */
  readonly principalId?: PrincipalId;
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

/**
 * The key an append is idempotent on: `(runId, stepId)` when a step is known, else the event id.
 *
 * Lives here rather than in an adapter so every adapter dedupes identically **by construction**. The
 * reference adapter owned a private copy of this, which meant "both adapters agree" was a
 * coincidence — the same situation `DEFAULT_SESSION_STATE_MAX_BYTES` was in before #97 moved it to
 * the port. A recovered run re-recording a step it already logged must be a no-op in every adapter,
 * because the alternative is double-counting real money.
 */
export const usageDedupeKey = (
  event: Pick<UsageEvent, "id" | "runId"> & { readonly stepId?: string },
): string => (event.stepId === undefined ? event.id : `${event.runId}:${event.stepId}`);

/** What a caller supplies; the recorder stamps `id`, `tenantId` and `occurredAt`. */
/**
 * What a caller supplies. `id`, `tenantId`, `principalId` and `occurredAt` are the recorder's to stamp.
 *
 * `principalId` moved into that set by #175: identity comes from the execution context, so accepting it here
 * would be accepting a claim about whose budget to charge.
 */
export type UsageEventInput = Omit<UsageEvent, "id" | "tenantId" | "principalId" | "occurredAt">;

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
export * from "./quota.js";
export * from "./rollups.js";
