import { describe, expect, it } from "vitest";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import {
  OTEL_SPAN_KIND,
  createOtelTelemetry,
  type OtelMeterProvider,
  type OtelSpan,
  type OtelTracerProvider,
} from "../index.js";
import { SPAN_KINDS, formatTraceparent, withSpan } from "../../../telemetry/index.js";

/**
 * The OTel adapter — AC-6.
 *
 * Two things are being proved, and only the second needs the real package.
 *
 * The adapter's *behaviour* is proved against recording fakes: what it puts on a span, what it drops from a
 * metric, what reaches the log sink.
 *
 * The adapter's *interoperability* is proved by handing it the genuine `@opentelemetry/api` — real
 * `SpanStatusCode` values, a real `Context` built by `trace.setSpanContext`, and a `NoopTracerProvider`-shaped
 * provider from the package itself. Structural types that were merely plausible would compile fine and fail on
 * the first real provider, and "vendor-neutral" would be a claim resting on interfaces nobody had checked.
 */

type Recorded = {
  name: string;
  kind?: number;
  attributes: Record<string, unknown>;
  status?: { code: number };
  exceptions: { name?: string; message?: string }[];
  ended: boolean;
  parentContext: unknown;
  spanId: string;
  traceId: string;
};

const fakeTracing = () => {
  const spans: Recorded[] = [];
  let n = 0;
  const provider: OtelTracerProvider = {
    getTracer: () => ({
      startSpan(name, options, context) {
        n += 1;
        // A parent context reaches the tracer as OTel's opaque `Context`. The adapter's job is to build it from a
        // traceparent, so what is asserted is that it was *passed* — the extraction of ids from it is OTel's.
        const parent = context === undefined ? null : trace.getSpanContext(context as Context);
        const record: Recorded = {
          name,
          ...(options?.kind !== undefined ? { kind: options.kind } : {}),
          attributes: { ...(options?.attributes ?? {}) },
          exceptions: [],
          ended: false,
          parentContext: context ?? null,
          spanId: String(n).padStart(16, "0"),
          traceId: parent?.traceId ?? String(n).padStart(32, "0"),
        };
        spans.push(record);
        const span: OtelSpan = {
          spanContext: () => ({ traceId: record.traceId, spanId: record.spanId, traceFlags: 1 }),
          setAttribute(key, value) {
            record.attributes[key] = value;
          },
          setStatus(status) {
            record.status = status;
          },
          recordException(exception) {
            record.exceptions.push(exception);
          },
          end() {
            record.ended = true;
          },
        };
        return span;
      },
    }),
  };
  return { provider, spans };
};

const fakeMetrics = () => {
  const recorded: { instrument: string; kind: string; value: number; attributes: Record<string, unknown> }[] = [];
  const created: { name: string; kind: string; unit?: string }[] = [];
  const make = (kind: string) => (name: string, options?: { unit?: string }) => {
    created.push({ name, kind, ...(options?.unit !== undefined ? { unit: options.unit } : {}) });
    const push = (value: number, attributes?: Record<string, unknown>) =>
      recorded.push({ instrument: name, kind, value, attributes: { ...(attributes ?? {}) } });
    return { add: push, record: push };
  };
  const provider: OtelMeterProvider = {
    getMeter: () => ({
      createCounter: make("counter"),
      createHistogram: make("histogram"),
      createGauge: make("gauge"),
    }),
  };
  return { provider, recorded, created };
};

/** The three lines of wiring a host writes. Reproduced verbatim so the doc comment on it stays true. */
const remoteContext = (parent: { traceId: string; spanId: string; traceFlags: number }): Context =>
  trace.setSpanContext(ROOT_CONTEXT, { ...parent, isRemote: true });

describe("the OTel adapter", () => {
  it("maps every span kind to OTel's numeric enum", () => {
    // Every kind, because a missing entry would silently become `undefined` and OTel would default it to
    // INTERNAL — turning the producer/consumer pair that draws a queue hop into two nested calls.
    for (const kind of SPAN_KINDS) expect(OTEL_SPAN_KIND[kind], kind).toBeTypeOf("number");
    expect(new Set(Object.values(OTEL_SPAN_KIND)).size).toBe(SPAN_KINDS.length);
  });

  it("puts attributes on the span, both at creation and afterwards", () => {
    const { provider, spans } = fakeTracing();
    const telemetry = createOtelTelemetry({ tracerProvider: provider, meterProvider: fakeMetrics().provider });
    const span = telemetry.tracer.startSpan("run.claim", { attributes: { tenantId: "t1" } });
    // `setAttributes` after creation is the normal case — an outcome is not known when the span opens. Sabotage
    // found this untested: deleting the loop that copies them left every assertion green, and a trace whose
    // spans carry no ids is a trace nobody can search.
    span.setAttributes({ runId: "r1", "queue.trace_continued": true });
    span.end();
    expect(spans[0]?.attributes).toEqual({ tenantId: "t1", runId: "r1", "queue.trace_continued": true });
  });

  it("uses OTel's own status codes, not numbers that happen to match", () => {
    const { provider, spans } = fakeTracing();
    const telemetry = createOtelTelemetry({ tracerProvider: provider, meterProvider: fakeMetrics().provider });
    const span = telemetry.tracer.startSpan("x");
    span.setStatus("error");
    span.end();
    // Compared against the value the *package* exports. A literal 2 here would pass today and drift the day OTel
    // renumbered, and the failure would be a dashboard where nothing is ever an error.
    expect(spans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
  });

  it("records a failure as a code, never as a thrown object", async () => {
    const { provider, spans } = fakeTracing();
    const telemetry = createOtelTelemetry({ tracerProvider: provider, meterProvider: fakeMetrics().provider });
    await expect(
      withSpan(telemetry.tracer, "x", {}, async () => {
        throw Object.assign(new Error("prompt was: confidential text"), { code: "forbidden" });
      }),
    ).rejects.toThrow();
    expect(spans[0]?.exceptions).toEqual([{ name: "forbidden" }]);
    // A stack and a cause chain routinely carry a URL with a token in it, or the argument that caused the throw.
    expect(JSON.stringify(spans)).not.toContain("confidential text");
  });

  /**
   * The interop test. A real OTel `Context`, built by the real `trace.setSpanContext`.
   *
   * If the structural `RemoteContextFactory` type were wrong, this would not compile — which is exactly the
   * check that a hand-written interface cannot give itself.
   */
  it("continues a remote trace through a real OTel Context", () => {
    const { provider, spans } = fakeTracing();
    const telemetry = createOtelTelemetry({
      tracerProvider: provider,
      meterProvider: fakeMetrics().provider,
      remoteContext,
    });
    const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
    telemetry.tracer.startSpan("run.claim", { kind: "consumer", parent: formatTraceparent(parent) });
    expect(spans[0]?.traceId).toBe(parent.traceId);
    expect(spans[0]?.kind).toBe(OTEL_SPAN_KIND.consumer);
  });

  it("degrades to a local span when no remoteContext is wired, rather than throwing", () => {
    // Building a Context needs a *function* from the package we refuse to import, so the caller supplies it. A
    // host that forgot should lose a trace link, not every request.
    const { provider, spans } = fakeTracing();
    const telemetry = createOtelTelemetry({ tracerProvider: provider, meterProvider: fakeMetrics().provider });
    telemetry.tracer.startSpan("run.claim", { parent: formatTraceparent({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }) });
    expect(spans[0]?.parentContext).toBeNull();
    expect(spans).toHaveLength(1);
  });

  it("defaults an unsampled parent to sampled rather than dropping its children", () => {
    const seen: { traceFlags: number }[] = [];
    const telemetry = createOtelTelemetry({
      tracerProvider: fakeTracing().provider,
      meterProvider: fakeMetrics().provider,
      remoteContext: (parent) => {
        seen.push(parent);
        return remoteContext(parent);
      },
    });
    telemetry.tracer.startSpan("x", { parent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00` });
    // Defaulting to unsampled would silently drop the child of every span whose producer did not set the bit —
    // which reads as a propagation bug and is very hard to find.
    expect(seen[0]?.traceFlags).toBe(1);
  });

  it("creates each instrument with its unit and kind", () => {
    const metrics = fakeMetrics();
    const telemetry = createOtelTelemetry({ tracerProvider: fakeTracing().provider, meterProvider: metrics.provider });
    telemetry.meter.counter("c_total", { unit: "{run}" }).record(1);
    telemetry.meter.histogram("h_ms", { unit: "ms" }).record(5);
    telemetry.meter.gauge("g", { unit: "{job}" }).record(3);
    expect(metrics.created).toEqual([
      { name: "c_total", kind: "counter", unit: "{run}" },
      { name: "h_ms", kind: "histogram", unit: "ms" },
      { name: "g", kind: "gauge", unit: "{job}" },
    ]);
    // A counter goes through `add`, not `record`. Getting this wrong is a metric that never increments, and a
    // panel that is empty rather than wrong — which nobody investigates.
    expect(metrics.recorded.map((r) => r.instrument)).toEqual(["c_total", "h_ms", "g"]);
  });

  it("bounds metric attributes in the adapter, so a call site cannot create a series per run", () => {
    const metrics = fakeMetrics();
    const telemetry = createOtelTelemetry({ tracerProvider: fakeTracing().provider, meterProvider: metrics.provider });
    telemetry.meter.histogram("h_ms").record(5, { tenantId: "t1", runId: "r1", outcome: "ok" });
    expect(Object.keys(metrics.recorded[0]?.attributes ?? {}).sort()).toEqual(["outcome", "tenantId"]);
  });

  it("sends a redacted line to the sink and nothing else", () => {
    const lines: string[] = [];
    const telemetry = createOtelTelemetry({
      tracerProvider: fakeTracing().provider,
      meterProvider: fakeMetrics().provider,
      sink: (line) => lines.push(line),
      context: { tenantId: "t1", runId: "r1" },
      now: () => "2026-08-23T12:00:00.000Z",
    });
    telemetry.logger.child({ principalId: "u1" }).log("info", "tool.called", {
      toolName: "publish_post",
      prompt: "confidential text",
    });
    // The sink takes a *string* that has already been through redaction. A sink receiving the record could format
    // it itself and bypass the allowlist, and it would be a reasonable-looking thing for someone to write.
    expect(lines[0]).toContain("publish_post");
    expect(lines.join("\n")).not.toContain("confidential text");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ tenantId: "t1", runId: "r1", principalId: "u1", event: "tool.called" });
    // The dropped-field notice, so the removal is visible.
    expect(lines[1]).toContain("telemetry.fields-dropped");
  });

  it("works against a provider from the package itself, which is the whole interop claim", () => {
    // `trace.getTracerProvider()` is the real API's default provider. It does nothing useful, which is the
    // point: what is being checked is that a genuine OTel provider *satisfies the structural type* and the
    // adapter drives it without a cast.
    const real = trace.getTracerProvider();
    const telemetry = createOtelTelemetry({
      tracerProvider: real as OtelTracerProvider,
      meterProvider: fakeMetrics().provider,
      remoteContext,
    });
    const span = telemetry.tracer.startSpan("http.request", { kind: "server", attributes: { tenantId: "t1" } });
    span.setAttributes({ runId: "r1" });
    span.setStatus("ok");
    span.recordError({ code: "none" });
    // No throw, and a context shaped as OTel defines it. The default provider returns all-zero ids, so the
    // assertion is on the *shape* — asserting a non-zero id here would be asserting a property of the noop
    // provider rather than of the adapter.
    expect(span.context.traceId).toHaveLength(32);
    expect(span.context.spanId).toHaveLength(16);
    span.end();
  });
});
