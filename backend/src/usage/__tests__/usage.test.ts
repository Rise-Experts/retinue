import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { createMemoryUsageStore } from "../../adapters/memory/index.js";
import { createUsageRecorder, type PricingResolver } from "../index.js";

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
