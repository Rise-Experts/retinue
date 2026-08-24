/**
 * Usage recorder — `docs/12-usage-and-accounting.md`.
 *
 * `record` appends a durable `UsageEvent` for each realized step (append-only; corrections are new
 * compensating events, never edits). `reserve` is the pre-flight ceiling check: it computes the
 * estimated cost from live pricing and refuses a call that would push the run past its cost or token
 * ceiling, so a run fails clearly rather than overspending. Cost is always integer minor units with
 * an explicit currency.
 */

import type { ExecutionContext } from "../core/context.js";
import { estimateTokens } from "../core/tokens.js";
import { AgentPlatformError } from "../core/errors.js";
import type { RunId } from "../core/ids.js";
import { computeModelCostMinorUnits, type ModelRegistry } from "../models/index.js";
import type { UsageStore } from "../persistence/index.js";
import type {
  CostEstimate,
  PricingResolver,
  Reservation,
  TokenCounter,
  UsageCeiling,
  UsageEventInput,
  UsageRecorder,
} from "./index.js";

/** A crude but provider-agnostic default: ~4 characters per token. Replace with a real tokenizer. */
export const heuristicTokenCounter: TokenCounter = {
  estimate: (text) => estimateTokens(text),
};

/** Pricing resolver backed by the model registry — resolves rates from the catalog at call time. */
export const createRegistryPricingResolver = (registry: ModelRegistry): PricingResolver => ({
  resolve: (modelId) => registry.list().find((m) => m.modelId === modelId)?.pricing ?? null,
});

/**
 * A usage record id that survives a restart — #174.
 *
 * This was `usage-${counter += 1}` over a **module-level** counter, which is per-process. `usage_records` has
 * `PRIMARY KEY (tenant_id, id)`, so restarting a worker reset the counter to 1 and the next record collided with
 * the `usage-1` already in the table: `duplicate key value violates unique constraint "usage_records_pkey"`, and
 * the run failed. Two workers in one deployment collided the same way without restarting at all.
 *
 * Invisible to every test, because a test starts with a fresh schema *and* a fresh module — the counter and the
 * table are always in step. It only breaks against a database that outlives the process, which is the only kind
 * a deployment has.
 *
 * The dedupe index on `(tenant_id, dedupe_key)` is the *intended* idempotency mechanism and it works: a recovered
 * run re-recording a step it already logged is a no-op. That is a different thing from two distinct events
 * colliding on a surrogate id, which is why this is fixed by making the id unique rather than by adding another
 * `ON CONFLICT` — swallowing a PK collision would silently drop a real record, and the dropped one would be
 * revenue.
 */
const defaultIdFactory = (): string => `usage-${crypto.randomUUID()}`;

export const createUsageRecorder = (config: {
  readonly store: UsageStore;
  readonly pricing: PricingResolver;
  /** Per-run ceiling from the agent's `ExecutionLimits`. Undefined ⇒ the run is unbounded. */
  readonly resolveCeiling?: (context: ExecutionContext) => Promise<UsageCeiling | undefined> | UsageCeiling | undefined;
  readonly clock?: () => string;
  readonly idFactory?: () => string;
}): UsageRecorder => {
  const clock = config.clock ?? (() => new Date().toISOString());
  const idFactory = config.idFactory ?? defaultIdFactory;

  const estimatedCost = (estimate: CostEstimate): number => {
    const pricing = config.pricing.resolve(estimate.modelId);
    if (!pricing) return 0; // unknown model → cannot price; ceiling check falls back to token limits
    return computeModelCostMinorUnits(pricing, {
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.maxOutputTokens,
    });
  };

  return {
    async record(context, event: UsageEventInput) {
      // Identity comes from the trusted context, never from the event payload — tenant *and* principal (#175).
      // A caller able to name either could bill someone else's budget.
      await config.store.append({
        tenantId: context.tenantId,
        event: {
          ...event,
          id: idFactory(),
          tenantId: context.tenantId as unknown as string,
          principalId: context.principalId,
          occurredAt: clock(),
        },
      });
    },

    async reserve(context, estimate): Promise<Reservation> {
      // Best-effort pre-flight: a read-then-decide, so two concurrent reserves can both pass and then
      // both spend — the authoritative bound is the append-only ledger checked here plus the run's
      // limits. If a model has no pricing, its estimated cost is 0; pair a cost ceiling with a token
      // ceiling to bound unknown-priced models.
      const id = idFactory();
      const ceiling = await config.resolveCeiling?.(context);
      if (!ceiling) return { id, withinCeiling: true };

      const runId = context.runId as RunId | undefined;
      const spent = runId
        ? await config.store.totals({ tenantId: context.tenantId, runId })
        : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costMinorUnits: 0, eventCount: 0 };

      const overCost =
        ceiling.costMinorUnits !== undefined &&
        spent.costMinorUnits + estimatedCost(estimate) > ceiling.costMinorUnits;
      const overInput =
        ceiling.inputTokens !== undefined && spent.inputTokens + estimate.inputTokens > ceiling.inputTokens;
      const overOutput =
        ceiling.outputTokens !== undefined && spent.outputTokens + estimate.maxOutputTokens > ceiling.outputTokens;

      return { id, withinCeiling: !(overCost || overInput || overOutput) };
    },
  };
};

/** Thrown by callers when `reserve()` denies a call, so the run fails with a clear budget error. */
export const budgetExceeded = (detail: string): AgentPlatformError =>
  new AgentPlatformError({
    code: "budget_exceeded",
    message: `Run would exceed its usage ceiling: ${detail}`,
    retryable: false,
  });
