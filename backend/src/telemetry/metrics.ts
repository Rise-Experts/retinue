/**
 * The metric set — AC-3: "metrics answer queue health, latency and error rate without reading logs".
 *
 * That criterion is a test of *completeness*, so the instruments are declared as data and `createRunMetrics`
 * builds a typed recorder for each. A metric name at a call site is a string nothing checks, and the failure is
 * a dashboard panel that is empty because a name was misspelled once.
 *
 * Units are in the names (`_ms`, `_total`) as well as in the metadata, because a graph legend shows the name
 * and not the unit, and "is 4000 seconds or milliseconds" is the wrong question to be asking during an incident.
 */

import type { Attributes, Meter, MetricRecorder } from "./index.js";

export type InstrumentKind = "counter" | "histogram" | "gauge";

export type InstrumentSpec = {
  readonly name: string;
  readonly kind: InstrumentKind;
  readonly unit: string;
  readonly description: string;
  /**
   * The operational question this exists to answer.
   *
   * Recorded per instrument because "enough to answer 'is it healthy'" is the acceptance criterion, and a metric
   * with no question behind it is one nobody looks at — while a question with no metric is the gap this field
   * makes visible.
   */
  readonly answers: string;
};

export const RUN_INSTRUMENTS = {
  queueDepth: {
    name: "agentkit_queue_depth",
    kind: "gauge",
    unit: "{job}",
    description: "Jobs waiting on the run queue.",
    answers: "Is work arriving faster than it is being processed?",
  },
  claimLatencyMs: {
    name: "agentkit_claim_latency_ms",
    kind: "histogram",
    unit: "ms",
    description: "Time from enqueue to a worker claiming the run.",
    answers: "How long does a user wait before anything starts happening?",
  },
  runDurationMs: {
    name: "agentkit_run_duration_ms",
    kind: "histogram",
    unit: "ms",
    description: "Wall-clock time from claim to a terminal run state.",
    answers: "Are runs getting slower?",
  },
  runsTotal: {
    name: "agentkit_runs_total",
    kind: "counter",
    unit: "{run}",
    description: "Runs reaching a terminal state, by outcome.",
    answers: "What fraction of runs fail, and is that changing?",
  },
  modelLatencyMs: {
    name: "agentkit_model_latency_ms",
    kind: "histogram",
    unit: "ms",
    description: "Duration of one model call.",
    answers: "Is a slow run the provider's fault or ours?",
  },
  modelCallsTotal: {
    name: "agentkit_model_calls_total",
    kind: "counter",
    unit: "{call}",
    description: "Model calls, by outcome and model.",
    answers: "What is the model error rate, per model?",
  },
  toolCallsTotal: {
    name: "agentkit_tool_calls_total",
    kind: "counter",
    unit: "{call}",
    description: "Tool calls, by outcome and tool.",
    answers: "Which tool is failing, and how often?",
  },
  toolLatencyMs: {
    name: "agentkit_tool_latency_ms",
    kind: "histogram",
    unit: "ms",
    description: "Duration of one tool call.",
    answers: "Is a tool the reason runs are slow?",
  },
  approvalWaitMs: {
    name: "agentkit_approval_wait_ms",
    kind: "histogram",
    unit: "ms",
    description: "Time a run spent waiting for a human decision.",
    answers: "Are approvals the bottleneck rather than the platform?",
  },
  retriesTotal: {
    name: "agentkit_retries_total",
    kind: "counter",
    unit: "{retry}",
    description: "Retry attempts, by reason.",
    answers: "Is a provider degrading before it starts failing outright?",
  },
} as const satisfies Readonly<Record<string, InstrumentSpec>>;

export type RunInstrumentKey = keyof typeof RUN_INSTRUMENTS;

export type RunMetrics = Readonly<Record<RunInstrumentKey, MetricRecorder>>;

/**
 * Build every instrument once.
 *
 * Once, at wiring time, rather than per call: an OTel meter deduplicates by name, but a port implementation need
 * not, and creating an instrument inside a hot path is how a metrics backend acquires a million series.
 */
export const createRunMetrics = (meter: Meter): RunMetrics => {
  const build = (spec: InstrumentSpec): MetricRecorder => {
    const options = { unit: spec.unit, description: spec.description };
    if (spec.kind === "counter") return meter.counter(spec.name, options);
    if (spec.kind === "histogram") return meter.histogram(spec.name, options);
    return meter.gauge(spec.name, options);
  };
  const out: Partial<Record<RunInstrumentKey, MetricRecorder>> = {};
  for (const [key, spec] of Object.entries(RUN_INSTRUMENTS))
    out[key as RunInstrumentKey] = build(spec);
  return out as RunMetrics;
};

/**
 * The attribute set a metric may carry.
 *
 * Bounded on purpose, and this is the important part: every metric attribute multiplies the series count, and
 * an unbounded one — a run id, a conversation id, a user id — is how a metrics bill becomes the largest line in
 * an infrastructure budget. Ids belong on **spans and logs**, which are sampled and indexed, never on metrics.
 */
export const METRIC_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  "tenantId",
  "outcome",
  "errorCode",
  "toolName",
  "modelId",
  "providerId",
  "reason",
] as const;

const METRIC_ALLOWED = new Set(METRIC_ATTRIBUTE_ALLOWLIST);

/**
 * Drop unbounded attributes before recording.
 *
 * Applied by the adapter, not trusted to call sites. `runId` on a latency histogram is one line of code and one
 * series per run — it looks like helpful detail in review and is a cardinality incident in production.
 */
export const boundMetricAttributes = (attributes: Attributes | undefined): Attributes => {
  if (attributes === undefined) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) if (METRIC_ALLOWED.has(key)) out[key] = value;
  return out;
};
