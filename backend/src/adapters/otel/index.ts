/**
 * The OpenTelemetry adapter — AC-6: "instrumentation is vendor-neutral and can target a customer's own
 * collector".
 *
 * The only file in `src/` that knows OpenTelemetry exists, and a boundary rule (R11) keeps it that way. That is
 * what makes the claim true rather than aspirational: a single convenience import of `@opentelemetry/api` in a
 * hot path is how a platform acquires a vendor, and it is invisible in review.
 *
 * **Structural types, no runtime import.** The OTel API surface this needs is declared below as interfaces, and
 * a caller passes their own `TracerProvider` and `MeterProvider`. So `@retinue/agentkit` has no dependency on
 * any OTel package — a customer already running the OTel SDK hands us the objects they have, and a customer
 * running something else implements four small interfaces. `otel.test.ts` imports the *real*
 * `@opentelemetry/api` and passes real providers through, which is the only way to know the structural types are
 * right rather than plausible.
 *
 * That also means "target your own collector" needs nothing from us: exporters, samplers, resource attributes
 * and endpoints are all configured on the provider the caller constructs. We never see a URL.
 */

import { boundMetricAttributes } from "../../telemetry/metrics.js";
import { formatLogLine, redactFields } from "../../telemetry/redaction.js";
import { parseTraceparent, TRACE_FLAG_SAMPLED } from "../../telemetry/trace-context.js";
import type {
  Attributes,
  AttributeValue,
  LogLevel,
  Logger,
  Meter,
  MetricRecorder,
  Span,
  SpanKind,
  SpanOptions,
  Telemetry,
  TelemetryContext,
  Tracer,
} from "../../telemetry/index.js";
import type { LogEvent } from "../../telemetry/log-events.js";

/* ------------------------------------------------------------------------------------------------------------
 * The OTel API surface, structurally.
 *
 * Narrowed to what is used. A wider declaration would be a copy of someone else's types that drifts, and every
 * member here has to be satisfied by a real provider — which the adapter's test proves against the published
 * package rather than against this file.
 * ---------------------------------------------------------------------------------------------------------- */

/** OTel's numeric SpanKind enum. Values are fixed by the spec, so the mapping below is stable. */
export const OTEL_SPAN_KIND: Readonly<Record<SpanKind, number>> = {
  internal: 0,
  server: 1,
  client: 2,
  producer: 3,
  consumer: 4,
};

/** OTel's numeric SpanStatusCode. */
const OTEL_STATUS = { unset: 0, ok: 1, error: 2 } as const;

export interface OtelSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

export interface OtelSpan {
  spanContext(): OtelSpanContext;
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: { name?: string; message?: string }): unknown;
  end(): unknown;
}

export interface OtelTracer {
  startSpan(
    name: string,
    options?: { kind?: number; attributes?: Record<string, AttributeValue> },
    context?: unknown,
  ): OtelSpan;
}

export interface OtelTracerProvider {
  getTracer(name: string, version?: string): OtelTracer;
}

export interface OtelCounter {
  add(value: number, attributes?: Record<string, AttributeValue>): unknown;
}
export interface OtelHistogram {
  record(value: number, attributes?: Record<string, AttributeValue>): unknown;
}
export interface OtelGauge {
  record(value: number, attributes?: Record<string, AttributeValue>): unknown;
}

export interface OtelMeter {
  createCounter(name: string, options?: { unit?: string; description?: string }): OtelCounter;
  createHistogram(name: string, options?: { unit?: string; description?: string }): OtelHistogram;
  createGauge(name: string, options?: { unit?: string; description?: string }): OtelGauge;
}

export interface OtelMeterProvider {
  getMeter(name: string, version?: string): OtelMeter;
}

/**
 * How a serialized parent becomes an OTel context.
 *
 * Injected, and this is the one seam that genuinely needs it. Building a `Context` containing a remote span
 * requires `trace.setSpanContext(ROOT_CONTEXT, …)` from `@opentelemetry/api` — a *function* from the package we
 * are refusing to import. So the caller supplies it in three lines at wiring time, which is a fair trade for the
 * core staying dependency-free.
 *
 * Without it the adapter still works: spans are created without a remote parent, so a trace stops at the process
 * boundary. Degrading rather than throwing, because a missing three lines of wiring should cost a trace link and
 * not every request.
 */
export type RemoteContextFactory = (parent: {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}) => unknown;

export type OtelTelemetryOptions = {
  readonly tracerProvider: OtelTracerProvider;
  readonly meterProvider: OtelMeterProvider;
  /** Instrumentation scope. Appears on every span and metric, so a collector can attribute them to us. */
  readonly scopeName?: string;
  readonly scopeVersion?: string;
  readonly remoteContext?: RemoteContextFactory;
  /**
   * Where a log line goes.
   *
   * A sink taking a **string**, not a record — the string has already been through `formatLogLine`, which has
   * already been through `redactFields`. A sink that received the record could format it itself and bypass the
   * redaction, and it would be a reasonable-looking thing for someone to write.
   */
  readonly sink?: (line: string) => void;
  readonly context?: TelemetryContext;
  readonly now?: () => string;
};

const toOtelSpan = (span: OtelSpan): Span => ({
  get context() {
    const ctx = span.spanContext();
    return { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags };
  },
  setAttributes(attributes: Attributes) {
    // One at a time: `setAttributes` is on OTel's Span but not on every implementation of it, and `setAttribute`
    // is. Fewer members in the structural type means fewer things a customer's shim has to provide.
    for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
  },
  recordError({ code, message }) {
    // `name` carries the code. OTel's exception convention wants an Error-ish shape, and this is the honest one:
    // a classified code and an optional message the caller took responsibility for -- never a thrown object,
    // whose stack and cause routinely carry a token or the argument that caused the throw.
    span.recordException({ name: code, ...(message !== undefined ? { message } : {}) });
  },
  setStatus(status) {
    span.setStatus({ code: OTEL_STATUS[status] });
  },
  end() {
    span.end();
  },
});

export const createOtelTelemetry = (options: OtelTelemetryOptions): Telemetry => {
  const scope = options.scopeName ?? "@retinue/agentkit";
  const otelTracer = options.tracerProvider.getTracer(scope, options.scopeVersion);
  const otelMeter = options.meterProvider.getMeter(scope, options.scopeVersion);
  const sink = options.sink ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());

  const tracer: Tracer = {
    startSpan(name, spanOptions: SpanOptions = {}) {
      const parent = parseTraceparent(spanOptions.parent);
      const remote =
        parent !== null && options.remoteContext !== undefined
          ? options.remoteContext({
              traceId: parent.traceId,
              spanId: parent.spanId,
              // Default to sampled when the parent's flags say nothing. The alternative -- defaulting to
              // unsampled -- silently drops the child of every span whose producer did not set the bit, which
              // reads as a propagation bug and is very hard to find.
              traceFlags: parent.traceFlags === 0 ? TRACE_FLAG_SAMPLED : parent.traceFlags,
            })
          : undefined;
      return toOtelSpan(
        otelTracer.startSpan(
          name,
          {
            kind: OTEL_SPAN_KIND[spanOptions.kind ?? "internal"],
            ...(spanOptions.attributes !== undefined ? { attributes: { ...spanOptions.attributes } } : {}),
          },
          remote,
        ),
      );
    },
  };

  /**
   * Metric attributes are bounded here, in the adapter.
   *
   * Not trusted to call sites: `runId` on a latency histogram is one line of code and one time series per run.
   * It looks like helpful detail in review and is a cardinality incident in production, and the bill arrives a
   * month later.
   */
  const bounded = (attributes: Attributes | undefined): Record<string, AttributeValue> => ({
    ...boundMetricAttributes(attributes),
  });

  const meter: Meter = {
    counter(name, opts) {
      const counter = otelMeter.createCounter(name, opts as { unit?: string; description?: string } | undefined);
      return { record: (value, attributes) => void counter.add(value, bounded(attributes)) };
    },
    histogram(name, opts) {
      const histogram = otelMeter.createHistogram(name, opts as { unit?: string; description?: string } | undefined);
      return { record: (value, attributes) => void histogram.record(value, bounded(attributes)) } satisfies MetricRecorder;
    },
    gauge(name, opts) {
      const gauge = otelMeter.createGauge(name, opts as { unit?: string; description?: string } | undefined);
      return { record: (value, attributes) => void gauge.record(value, bounded(attributes)) };
    },
  };

  const makeLogger = (context: TelemetryContext): Logger => ({
    log(level: LogLevel, event: LogEvent, raw?: Readonly<Record<string, unknown>>) {
      const { fields, dropped } = redactFields(raw);
      sink(formatLogLine({ level, event, at: now(), context: context as Record<string, string | undefined>, fields }));
      if (dropped.length > 0)
        sink(
          formatLogLine({
            level: "debug",
            event: "telemetry.fields-dropped",
            at: now(),
            context: context as Record<string, string | undefined>,
            // Names, never values, and capped -- a dropped field's *name* is safe, and eight of them is enough
            // to identify the call site without the notice itself becoming a long line.
            fields: { count: dropped.length, reason: dropped.slice(0, 8).join(",").slice(0, 120) },
          }),
        );
    },
    child(extra) {
      return makeLogger({ ...context, ...extra });
    },
  });

  return { tracer, meter, logger: makeLogger(options.context ?? { tenantId: "" }) };
};
