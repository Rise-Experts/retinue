import { describe, expect, it } from "vitest";
import { ROOT_CONTEXT, trace, type Context } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { createOtelTelemetry, type OtelMeterProvider, type OtelTracerProvider } from "../index.js";
import {
  BOUNDARY_SPANS,
  RUN_INSTRUMENTS,
  createRunMetrics,
  instrumentConsumer,
  instrumentDispatcher,
  traceparentOf,
  withSpan,
} from "../../../telemetry/index.js";
import type { JobConsumer, RunJob } from "../../../worker/main.js";
import type { RunId, TenantId } from "../../../core/ids.js";

/**
 * The real OpenTelemetry pipeline — the issue's test step 4, "point instrumentation at a local collector and
 * assert metrics arrive".
 *
 * A running collector is not something a unit test should require, so this uses the layer *immediately* before
 * one: the genuine OTel SDK, a genuine span processor and metric reader, and an in-memory exporter in the place
 * an OTLP exporter goes. Everything between our port and the wire is real — provider, tracer, sampler, span
 * processor, meter, aggregation, reader. Swapping `InMemorySpanExporter` for `OTLPTraceExporter` is a
 * one-line change in the *host's* wiring, which is where a collector endpoint belongs and why we never see a URL.
 *
 * The previous file proves the adapter drives real OTel objects. This one proves data comes out the other end,
 * which is a different claim and the one the criterion actually makes.
 */

const remoteContext = (parent: { traceId: string; spanId: string; traceFlags: number }): Context =>
  trace.setSpanContext(ROOT_CONTEXT, { ...parent, isRemote: true });

const realTracing = () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { provider: provider as unknown as OtelTracerProvider, exporter, shutdown: () => provider.shutdown() };
};

const realMetrics = () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // A long interval, because the assertion forces a collection rather than waiting on a timer. A test that slept
  // for an export interval would be slow and, worse, intermittently green.
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    provider: provider as unknown as OtelMeterProvider,
    async collect() {
      await provider.forceFlush();
      return exporter.getMetrics();
    },
    shutdown: () => provider.shutdown(),
  };
};

describe("the real OTel pipeline", () => {
  /**
   * AC-1, end to end, through the actual SDK.
   *
   * Three processes' worth of spans, joined only by a string in a job payload, and read back out of an exporter
   * — not out of our own recorder. This is the strongest form of the claim available without a collector: the
   * trace id is assigned by OTel's own id generator and the parent link is resolved by OTel's own context API.
   */
  it("exports one trace spanning request, enqueue and claim", async () => {
    const tracing = realTracing();
    const metrics = realMetrics();
    const telemetry = createOtelTelemetry({
      tracerProvider: tracing.provider,
      meterProvider: metrics.provider,
      remoteContext,
    });

    const enqueued: RunJob[] = [];
    const dispatcher = instrumentDispatcher({ async enqueueRun(i) { enqueued.push(i as RunJob); } }, { telemetry });
    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const consumer: JobConsumer = instrumentConsumer(
      { start(h) { deliver = h; }, stop: async () => {} },
      { telemetry, workerId: "w1" },
    );
    consumer.start(async () => {});

    await withSpan(telemetry.tracer, BOUNDARY_SPANS.request, { kind: "server" }, async (request) => {
      await dispatcher.enqueueRun({
        tenantId: "t1" as TenantId,
        runId: "r1" as RunId,
        traceparent: traceparentOf(request),
      });
    });
    await deliver?.(enqueued[0] as RunJob);

    const exported = tracing.exporter.getFinishedSpans();
    const byName = new Map(exported.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual([BOUNDARY_SPANS.claim, BOUNDARY_SPANS.enqueue, BOUNDARY_SPANS.request].sort());

    const request = byName.get(BOUNDARY_SPANS.request);
    const enqueue = byName.get(BOUNDARY_SPANS.enqueue);
    const claim = byName.get(BOUNDARY_SPANS.claim);

    // One trace id across all three, assigned by OTel and not by us.
    expect(new Set(exported.map((s) => s.spanContext().traceId)).size).toBe(1);
    // And the chain is request → enqueue → claim, so the queue hop is visible as a hop.
    expect(enqueue?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(claim?.parentSpanContext?.spanId).toBe(enqueue?.spanContext().spanId);
    expect(claim?.attributes["queue.trace_continued"]).toBe(true);

    await tracing.shutdown();
    await metrics.shutdown();
  });

  it("exports the run metrics with their declared units, through a real reader", async () => {
    const tracing = realTracing();
    const metrics = realMetrics();
    const telemetry = createOtelTelemetry({ tracerProvider: tracing.provider, meterProvider: metrics.provider });
    const run = createRunMetrics(telemetry.meter);

    run.runsTotal.record(1, { tenantId: "t1", outcome: "completed" });
    run.claimLatencyMs.record(1_200, { tenantId: "t1" });
    run.queueDepth.record(7, { tenantId: "t1" });

    const collected = await metrics.collect();
    const emitted = collected.flatMap((batch) =>
      batch.scopeMetrics.flatMap((scope) => scope.metrics.map((m) => ({ name: m.descriptor.name, unit: m.descriptor.unit }))),
    );
    // Names *and* units out of the exporter. A misspelled name is an empty dashboard panel rather than a wrong
    // one, which is the failure nobody investigates — so it is asserted where the data actually leaves.
    expect(emitted).toContainEqual({ name: RUN_INSTRUMENTS.runsTotal.name, unit: RUN_INSTRUMENTS.runsTotal.unit });
    expect(emitted).toContainEqual({ name: RUN_INSTRUMENTS.claimLatencyMs.name, unit: RUN_INSTRUMENTS.claimLatencyMs.unit });
    expect(emitted).toContainEqual({ name: RUN_INSTRUMENTS.queueDepth.name, unit: RUN_INSTRUMENTS.queueDepth.unit });

    await tracing.shutdown();
    await metrics.shutdown();
  });

  it("a counter arrives as a monotonic sum and a histogram as a distribution", async () => {
    const tracing = realTracing();
    const metrics = realMetrics();
    const telemetry = createOtelTelemetry({ tracerProvider: tracing.provider, meterProvider: metrics.provider });
    const run = createRunMetrics(telemetry.meter);

    run.runsTotal.record(1, { tenantId: "t1", outcome: "completed" });
    run.runsTotal.record(1, { tenantId: "t1", outcome: "completed" });
    run.modelLatencyMs.record(100, { tenantId: "t1" });
    run.modelLatencyMs.record(300, { tenantId: "t1" });

    const collected = await metrics.collect();
    const all = collected.flatMap((b) => b.scopeMetrics.flatMap((s) => s.metrics));
    const counter = all.find((m) => m.descriptor.name === RUN_INSTRUMENTS.runsTotal.name);
    const histogram = all.find((m) => m.descriptor.name === RUN_INSTRUMENTS.modelLatencyMs.name);

    // The counter accumulated rather than replaced — which is the difference between `add` and `record`, and the
    // reason the adapter must route a counter through `add`. Getting it wrong yields a metric stuck at 1.
    expect(counter?.dataPoints[0]?.value).toBe(2);
    const point = histogram?.dataPoints[0]?.value as { count: number; sum?: number } | undefined;
    // A distribution, not a last-value gauge. Percentiles are the only useful form of a latency, and a gauge
    // would silently report only the most recent call.
    expect(point?.count).toBe(2);
    expect(point?.sum).toBe(400);

    await tracing.shutdown();
    await metrics.shutdown();
  });

  it("carries the instrumentation scope, so a collector can attribute the data to us", async () => {
    const tracing = realTracing();
    const metrics = realMetrics();
    const telemetry = createOtelTelemetry({
      tracerProvider: tracing.provider,
      meterProvider: metrics.provider,
      scopeName: "@retinue/agentkit",
      scopeVersion: "0.0.0",
    });
    telemetry.tracer.startSpan("x").end();
    createRunMetrics(telemetry.meter).runsTotal.record(1, { outcome: "completed" });

    expect(tracing.exporter.getFinishedSpans()[0]?.instrumentationScope.name).toBe("@retinue/agentkit");
    const collected = await metrics.collect();
    // Without a scope, a customer's collector cannot tell our metrics from their application's, and neither can
    // a bill.
    expect(collected.flatMap((b) => b.scopeMetrics.map((s) => s.scope.name))).toContain("@retinue/agentkit");

    await tracing.shutdown();
    await metrics.shutdown();
  });

  it("keeps an unbounded attribute out of the exported series", async () => {
    const tracing = realTracing();
    const metrics = realMetrics();
    const telemetry = createOtelTelemetry({ tracerProvider: tracing.provider, meterProvider: metrics.provider });
    const run = createRunMetrics(telemetry.meter);
    for (const runId of ["r1", "r2", "r3"])
      run.runDurationMs.record(10, { tenantId: "t1", runId, outcome: "completed" } as never);

    const collected = await metrics.collect();
    const points = collected
      .flatMap((b) => b.scopeMetrics.flatMap((s) => s.metrics))
      .filter((m) => m.descriptor.name === RUN_INSTRUMENTS.runDurationMs.name)
      .flatMap((m) => m.dataPoints);
    // Three runs, **one** series. Read out of the exporter, because this is the assertion that would otherwise
    // be about our own bookkeeping rather than about what a metrics backend is billed for.
    expect(points).toHaveLength(1);
    expect(Object.keys(points[0]?.attributes ?? {}).sort()).toEqual(["outcome", "tenantId"]);

    await tracing.shutdown();
    await metrics.shutdown();
  });
});
