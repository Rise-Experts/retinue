/**
 * Telemetry that does nothing, and the in-memory telemetry the tests assert on.
 *
 * `NOOP_TELEMETRY` is why no call site has an `if (telemetry)`. Optional-and-checked would be checked in
 * nineteen places and forgotten in the twentieth, and the forgotten one is a crash rather than a missing span.
 *
 * `createRecordingTelemetry` is the same port over arrays. It is what makes AC-1, AC-2 and AC-5 assertable
 * without a collector: the redaction test needs to see the *actual bytes* a sink would write, and a mock that
 * captured the call arguments would prove the caller's intent rather than the output.
 */

import { boundMetricAttributes } from "./metrics.js";
import { formatLogLine, redactFields } from "./redaction.js";
import { formatTraceparent, parseTraceparent, TRACE_FLAG_SAMPLED } from "./trace-context.js";
import type {
  Attributes,
  LogLevel,
  LogRecord,
  Logger,
  Meter,
  MetricRecorder,
  Span,
  SpanOptions,
  SpanStatus,
  Telemetry,
  TelemetryContext,
  Tracer,
} from "./index.js";
import type { LogEvent } from "./log-events.js";

const NOOP_RECORDER: MetricRecorder = { record: () => {} };

const NOOP_SPAN: Span = {
  context: { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 },
  setAttributes: () => {},
  recordError: () => {},
  setStatus: () => {},
  end: () => {},
};

const NOOP_LOGGER: Logger = { log: () => {}, child: () => NOOP_LOGGER };

export const NOOP_TELEMETRY: Telemetry = {
  tracer: { startSpan: () => NOOP_SPAN },
  meter: { counter: () => NOOP_RECORDER, histogram: () => NOOP_RECORDER, gauge: () => NOOP_RECORDER },
  logger: NOOP_LOGGER,
};

export type RecordedSpan = {
  readonly name: string;
  readonly kind: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  attributes: Record<string, string | number | boolean>;
  status: SpanStatus;
  errorCode: string | null;
  ended: boolean;
};

export type RecordedMetric = {
  readonly instrument: string;
  readonly value: number;
  readonly attributes: Attributes;
};

export type RecordingTelemetry = Telemetry & {
  readonly spans: readonly RecordedSpan[];
  readonly metrics: readonly RecordedMetric[];
  readonly logs: readonly LogRecord[];
  /** The bytes a sink would write. The redaction test asserts on these, not on the records. */
  readonly lines: readonly string[];
};

/**
 * Deterministic ids.
 *
 * A counter, not randomness. The property worth asserting is "the worker's span carries the API host's trace
 * id", and that is untestable against a random source — you can only check the two happen to be equal, which is
 * also true of two random values one time in 2^128 and, more usefully, is what a bug producing a *constant* id
 * would also satisfy.
 */
const sequentialIds = () => {
  let trace = 0;
  let span = 0;
  return {
    traceId: () => (++trace).toString(16).padStart(32, "0"),
    spanId: () => (++span).toString(16).padStart(16, "0"),
  };
};

export const createRecordingTelemetry = (
  base: TelemetryContext = { tenantId: "t1" },
  now: () => string = () => "2026-08-23T12:00:00.000Z",
): RecordingTelemetry => {
  const spans: RecordedSpan[] = [];
  const metrics: RecordedMetric[] = [];
  const logs: LogRecord[] = [];
  const lines: string[] = [];
  const ids = sequentialIds();

  const tracer: Tracer = {
    startSpan(name: string, options: SpanOptions = {}): Span {
      const parent = parseTraceparent(options.parent);
      // The parent's trace id, or a new one. This single line is AC-1: the worker passes the job's traceparent
      // and lands in the API host's trace rather than starting its own.
      const traceId = parent?.traceId ?? ids.traceId();
      const spanId = ids.spanId();
      const record: RecordedSpan = {
        name,
        kind: options.kind ?? "internal",
        traceId,
        spanId,
        parentSpanId: parent?.spanId ?? null,
        attributes: { ...(options.attributes ?? {}) },
        status: "unset",
        errorCode: null,
        ended: false,
      };
      spans.push(record);
      return {
        context: { traceId, spanId, traceFlags: parent?.traceFlags ?? TRACE_FLAG_SAMPLED },
        setAttributes(attributes) {
          Object.assign(record.attributes, attributes);
        },
        recordError({ code }) {
          record.errorCode = code;
        },
        setStatus(status) {
          record.status = status;
        },
        end() {
          record.ended = true;
        },
      };
    },
  };

  const recorder = (instrument: string): MetricRecorder => ({
    record(value, attributes) {
      // Bounded here, in the *implementation*, so a call site that passes a run id cannot create a series. The
      // test that proves this passes an unbounded attribute deliberately.
      metrics.push({ instrument, value, attributes: boundMetricAttributes(attributes) });
    },
  });

  const meter: Meter = {
    counter: (name) => recorder(name),
    histogram: (name) => recorder(name),
    gauge: (name) => recorder(name),
  };

  const makeLogger = (context: TelemetryContext): Logger => ({
    log(level: LogLevel, event: LogEvent, raw?: Readonly<Record<string, unknown>>) {
      const { fields, dropped } = redactFields(raw);
      const record: LogRecord = { level, event, context, fields, at: now() };
      logs.push(record);
      lines.push(formatLogLine({ ...record, context: context as Record<string, string | undefined> }));
      if (dropped.length > 0) {
        // The *names* of what was dropped, never the values, and as its own line rather than a field on this
        // one: a redaction that quietly removed a field would look to whoever needs it like the field was never
        // set, and they would go looking in the wrong place.
        const notice: LogRecord = {
          level: "debug",
          event: "telemetry.fields-dropped",
          context,
          fields: { count: dropped.length, reason: dropped.slice(0, 8).join(",").slice(0, 120) },
          at: now(),
        };
        logs.push(notice);
        lines.push(formatLogLine({ ...notice, context: context as Record<string, string | undefined> }));
      }
    },
    child(extra) {
      return makeLogger({ ...context, ...extra });
    },
  });

  return {
    tracer,
    meter,
    logger: makeLogger(base),
    get spans() {
      return spans;
    },
    get metrics() {
      return metrics;
    },
    get logs() {
      return logs;
    },
    get lines() {
      return lines;
    },
  };
};

/** The traceparent for a span, for putting into a job payload or an outbound header. */
export const traceparentOf = (span: Span): string => formatTraceparent(span.context);
