/**
 * The telemetry port — REQ-033 (#143).
 *
 * A run crosses the API host, the queue and a worker. Without a correlated view, diagnosing a production issue
 * means guessing, so this exists to make one user request one trace.
 *
 * **Ours, not a vendor's.** The port is our own types; `adapters/otel` binds them to OpenTelemetry. Nothing in
 * `src/` outside that adapter imports an OTel package, and a boundary rule (R11) makes that a build failure
 * rather than a convention — the same treatment R3 gives the AI SDK. "Vendor-neutral" is only true if it is
 * enforced: a single convenience import of `@opentelemetry/api` in a hot path is how a platform acquires a
 * vendor, and it is invisible in review.
 *
 * **Shaped for W3C trace context, because that is the interop surface.** The port's identifiers are trace ids,
 * span ids and a `traceparent` string, which is what any collector understands. A bespoke correlation id would
 * work exactly as well until a customer wanted their own tooling to see it.
 *
 * **Absence is a no-op, not a branch.** `NOOP_TELEMETRY` means no call site needs `if (telemetry)`, so an
 * unconfigured deployment loses observability and nothing else. Optional-and-checked would eventually be
 * checked in nineteen places and forgotten in the twentieth.
 */

export * from "./trace-context.js";
export * from "./log-events.js";
export * from "./redaction.js";
export * from "./spans.js";
export * from "./metrics.js";
export * from "./noop.js";
export * from "./instrument.js";

import type { LogEvent } from "./log-events.js";
import type { TraceFlags } from "./trace-context.js";

/**
 * The identifiers on every log line and every span — AC-4.
 *
 * Every field is an id. That is the point: this type is what a caller is *allowed* to correlate on, and it
 * contains no room for content. A telemetry context that carried a `message` or a `prompt` would be the
 * redaction hole, and it would be added by someone who needed one line of context in one incident.
 */
export type TelemetryContext = {
  readonly tenantId: string;
  readonly conversationId?: string;
  readonly runId?: string;
  readonly principalId?: string;
  /** The inbound request, so a trace can be tied back to an access log entry. */
  readonly requestId?: string;
};

export const SPAN_KINDS = ["server", "client", "producer", "consumer", "internal"] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

/**
 * A span attribute value.
 *
 * Primitives only, and deliberately not `unknown`. A nested object is where content hides: `{ input: {...} }`
 * on a tool span is one keystroke from being the whole tool input, and no reviewer would notice. A caller that
 * genuinely needs structure has to name each field, which is exactly the friction that keeps prompts out.
 */
export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export type SpanStatus = "unset" | "ok" | "error";

export interface Span {
  /** The span's own context, for propagation into a job payload or an outbound header. */
  readonly context: SpanContext;
  setAttributes(attributes: Attributes): void;
  /**
   * Record a failure on the span.
   *
   * Takes a **code and message**, not an error object. An error's `stack` and `cause` chain routinely carry a
   * URL with a token in it or the argument that caused the throw — #131 found exactly that, a service-role key
   * echoed into an error message and therefore into logs. So the span gets the classified code and a message
   * the caller has taken responsibility for, and the object stays out.
   */
  recordError(input: { readonly code: string; readonly message?: string }): void;
  setStatus(status: SpanStatus): void;
  end(): void;
}

export type SpanContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: TraceFlags;
};

export type SpanOptions = {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  /**
   * The parent, as a `traceparent` string.
   *
   * A string rather than a span object, because the parent usually arrives *serialized* — out of a job payload
   * or an HTTP header — and a port that took a live span would force every producer to keep one alive across a
   * process boundary, which is the one thing it cannot do.
   */
  readonly parent?: string;
};

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

/**
 * Run `fn` inside a span, ending it on both paths and recording a failure.
 *
 * A helper rather than a method on the port, so an adapter cannot get the error path wrong. Every adapter
 * getting `try/finally` right independently is a guarantee that holds until the second adapter.
 */
export const withSpan = async <T>(
  tracer: Tracer,
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> => {
  const span = tracer.startSpan(name, options);
  try {
    const result = await fn(span);
    span.setStatus("ok");
    return result;
  } catch (error) {
    // The code only. `String(error)` here would put the message on the span, and an error message is the most
    // common accidental carrier of content — a rejected prompt, a failing SQL statement, a signed URL.
    span.recordError({ code: errorCodeOf(error) });
    span.setStatus("error");
    throw error;
  } finally {
    span.end();
  }
};

/**
 * A classified code for a thrown value, and nothing else.
 *
 * Reads `code` when the platform's own error carries one, and otherwise reports the constructor name. Never the
 * message: this function's whole job is to be the place that refuses to pass one through.
 */
export const errorCodeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) return code;
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "unknown";
};

export type MetricRecorder = {
  record(value: number, attributes?: Attributes): void;
};

export interface Meter {
  /** Monotonic count — requests, errors, runs. */
  counter(name: string, options?: { readonly unit?: string; readonly description?: string }): MetricRecorder;
  /** A distribution — latency, duration, wait time. Percentiles are the only useful form of these. */
  histogram(name: string, options?: { readonly unit?: string; readonly description?: string }): MetricRecorder;
  /** A point-in-time value — queue depth. Recorded, not accumulated. */
  gauge(name: string, options?: { readonly unit?: string; readonly description?: string }): MetricRecorder;
}

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A structured log line.
 *
 * `event` is a **closed union of literals**, not free text — see `log-events.ts`. That is the structural half
 * of AC-5: a caller physically cannot put a prompt in the message, because the message is not a string it
 * controls. The redaction allowlist then handles the fields. A denylist over free-text messages would be
 * checking every line forever and losing the one added on a Friday.
 */
export type LogRecord = {
  readonly level: LogLevel;
  readonly event: LogEvent;
  readonly context: TelemetryContext;
  readonly fields: Readonly<Record<string, AttributeValue>>;
  readonly at: string;
};

export interface Logger {
  log(level: LogLevel, event: LogEvent, fields?: Readonly<Record<string, unknown>>): void;
  /** A logger bound to more context. Correlation ids are set once at a boundary, not repeated per line. */
  child(context: Partial<TelemetryContext>): Logger;
}

export type Telemetry = {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly logger: Logger;
};
