import { describe, expect, it } from "vitest";
import {
  ALL_SPAN_NAMES,
  BOUNDARY_SPANS,
  LOG_EVENTS,
  LOG_FIELD_ALLOWLIST,
  MAX_FIELD_LENGTH,
  METRIC_ATTRIBUTE_ALLOWLIST,
  NOOP_TELEMETRY,
  RUN_INSTRUMENTS,
  SPAN_FOR_RUN_EVENT,
  TRACE_FLAG_SAMPLED,
  boundMetricAttributes,
  createRecordingTelemetry,
  createRunMetrics,
  errorCodeOf,
  formatLogLine,
  formatTraceparent,
  instrumentConsumer,
  instrumentDispatcher,
  instrumentModelCall,
  instrumentToolCall,
  isSampled,
  parseTraceparent,
  recordApprovalWait,
  redactFields,
  spanForRunEvent,
  traceparentOf,
  withSpan,
} from "../telemetry/index.js";
import { RUN_EVENT_TYPES } from "../core/events.js";
import type { JobConsumer, RunJob } from "../worker/main.js";
import type { JobDispatcher } from "../runtime/index.js";
import type { RunId, TenantId } from "../core/ids.js";

const t1 = "t1" as TenantId;
const r1 = "r1" as RunId;

describe("W3C trace context", () => {
  it("round-trips a traceparent", () => {
    const parts = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: TRACE_FLAG_SAMPLED };
    expect(parseTraceparent(formatTraceparent(parts))).toEqual(parts);
  });

  it("returns null for anything malformed rather than throwing", () => {
    // Null, not a throw, and this is the decision that matters: a malformed header means *start a new trace*,
    // never fail the request. This function is on the hot path of every request and every job, and telemetry
    // that can break a run is worse than no telemetry.
    for (const bad of [
      undefined,
      null,
      "",
      "nonsense",
      "00-tooshort-b".repeat(1),
      `00-${"A".repeat(32)}-${"b".repeat(16)}-01`, // uppercase hex is not lower-hex
      `00-${"a".repeat(31)}-${"b".repeat(16)}-01`, // wrong trace id length
      `00-${"a".repeat(32)}-${"b".repeat(15)}-01`, // wrong span id length
      `00-${"a".repeat(32)}-${"b".repeat(16)}-zz`, // flags not hex
      `00-${"a".repeat(32)}-${"b".repeat(16)}`, // no flags
    ])
      expect(parseTraceparent(bad as string | undefined), String(bad)).toBeNull();
  });

  /**
   * The all-zero ids, which are the subtle ones.
   *
   * The spec forbids them, and accepting one is worse than rejecting: every caller that failed to propagate
   * lands in the same "trace 000…0", which looks like a working trace joining unrelated requests. A missing
   * trace is obvious; a merged one is not.
   */
  it("rejects the all-zero trace id and span id", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`)).toBeNull();
  });

  it("rejects version ff, which the spec forbids, but tolerates a future version", () => {
    expect(parseTraceparent(`ff-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    // Forward compatibility: a newer producer's context still joins our trace rather than being dropped, because
    // the first four fields keep their meaning. Dropping it would break interop with a collector that upgrades
    // before we do — which is the normal direction.
    expect(parseTraceparent(`01-${"a".repeat(32)}-${"b".repeat(16)}-01-extra`)).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    });
  });

  it("keeps unrecognised flag bits rather than flattening them to a boolean", () => {
    const parsed = parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-03`);
    // The field is a bitfield and only bit 0 is assigned. A boolean would discard bit 1 on every round trip.
    expect(parsed?.traceFlags).toBe(3);
    expect(isSampled(parsed?.traceFlags ?? 0)).toBe(true);
    expect(isSampled(0)).toBe(false);
  });
});

describe("redaction — AC-5", () => {
  /**
   * The test the criterion names, with seeded values.
   *
   * Every one of these is a thing someone would plausibly attach while debugging: the prompt, the answer, an API
   * key, a bearer token, a signed URL, a whole message object.
   */
  const SECRETS = {
    prompt: "Summarise the acquisition terms for Northwind before Friday",
    messages: [{ role: "user", content: "my password is hunter2" }],
    apiKey: "sk-unsloth-a9ab17cd37ce9f4c4163f298577a94de",
    authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    signedUrl: "https://storage.example/obj?token=abc123&sig=deadbeef",
    text: "the model's answer, verbatim",
    input: { query: "internal salary bands" },
    output: "revenue rose nine percent",
    serviceRoleKey: "service_role_abcdef",
    stack: "Error: boom\n    at query (/app/db.ts:12) with 'secret-arg'",
  } as const;

  it("drops every seeded sensitive field", () => {
    const { fields, dropped } = redactFields(SECRETS);
    expect(fields).toEqual({});
    expect([...dropped].sort()).toEqual([...Object.keys(SECRETS)].sort());
  });

  it("none of the seeded values appears anywhere in the emitted bytes", () => {
    const telemetry = createRecordingTelemetry({ tenantId: t1, runId: r1 });
    telemetry.logger.log("info", "model.called", { ...SECRETS, modelId: "gpt-4o" });
    const output = telemetry.lines.join("\n");
    // The *bytes a sink would write*, not the call arguments. A mock capturing the arguments would prove the
    // caller's intent and nothing about the output — and the output is what reaches a log aggregator.
    for (const value of Object.values(SECRETS)) {
      const needle = typeof value === "string" ? value : JSON.stringify(value);
      expect(output, `leaked: ${needle.slice(0, 40)}`).not.toContain(needle);
    }
    // And a distinctive substring, in case a value was mangled rather than dropped.
    for (const needle of ["hunter2", "Northwind", "sk-unsloth", "eyJhbGci", "deadbeef", "salary", "service_role"])
      expect(output, `leaked fragment: ${needle}`).not.toContain(needle);
    // The safe field survived, or this test would pass on a logger that emitted nothing at all.
    expect(output).toContain("gpt-4o");
  });

  /**
   * An allowlist, not a denylist — the whole design.
   *
   * A field nobody has heard of is dropped. A denylist would have to have named it in advance, which means
   * naming every field anyone will ever add.
   */
  it("drops an unknown field without having been told about it", () => {
    const { fields, dropped } = redactFields({ someFieldInventedTomorrow: "value", runId: "r1" });
    expect(fields).toEqual({ runId: "r1" });
    expect(dropped).toEqual(["someFieldInventedTomorrow"]);
  });

  it("drops an object even under an allowlisted key", () => {
    // `{ reason: {...} }` is one keystroke from being a whole tool input, and the key says nothing about what a
    // nested value holds.
    const { fields, dropped } = redactFields({ reason: { nested: "content" }, toolName: ["a"] });
    expect(fields).toEqual({});
    expect([...dropped].sort()).toEqual(["reason", "toolName"]);
  });

  it("bounds an allowlisted string, so a leak is a fragment and not a document", () => {
    const long = "x".repeat(MAX_FIELD_LENGTH + 500);
    const { fields } = redactFields({ reason: long });
    expect(String(fields.reason).length).toBeLessThan(MAX_FIELD_LENGTH + 20);
    // Visibly truncated, which is how someone notices the bug rather than trusting a value that looks whole.
    expect(String(fields.reason)).toContain("…[truncated]");
  });

  it("drops a non-finite number, which JSON would render as a missing value", () => {
    const { fields, dropped } = redactFields({ durationMs: Number.NaN, latencyMs: Number.POSITIVE_INFINITY, waitMs: 5 });
    expect(fields).toEqual({ waitMs: 5 });
    expect([...dropped].sort()).toEqual(["durationMs", "latencyMs"]);
  });

  it("reports what it dropped, as a separate line, naming keys and never values", () => {
    const telemetry = createRecordingTelemetry();
    telemetry.logger.log("info", "tool.called", { toolName: "publish", prompt: "secret text" });
    const notice = telemetry.logs.find((l) => l.event === "telemetry.fields-dropped");
    // A silent drop is invisible data loss: whoever needs the field finds it absent and goes looking in the
    // wrong place. Its own line rather than a field on the original, so a query for dropped fields finds them.
    expect(notice).toBeDefined();
    expect(String(notice?.fields.reason)).toContain("prompt");
    expect(telemetry.lines.join("\n")).not.toContain("secret text");
  });

  it("a field cannot overwrite the event, the level or the timestamp", () => {
    const line = formatLogLine({
      level: "info",
      event: "run.started",
      at: "2026-08-23T12:00:00.000Z",
      context: { tenantId: "t1" },
      // A field literally named `event`. This is the one lie a log must not be able to tell: a line claiming to
      // be a different event than the one that was logged makes every downstream count wrong, and no reader can
      // tell. Sabotage found this untested — I wrote the guard and asserted only the happy path.
      fields: { event: "run.completed", level: "debug", at: "1970-01-01T00:00:00.000Z", reason: "ok" } as never,
    });
    expect(JSON.parse(line)).toEqual({
      at: "2026-08-23T12:00:00.000Z",
      level: "info",
      event: "run.started",
      tenantId: "t1",
      reason: "ok",
    });
  });

  it("the allowlist itself holds no field whose name suggests content", () => {
    // A guard on the list, because the list is the mechanism. The next person to need "just one more field" adds
    // it here, and these are the names that would let content through.
    const forbidden = ["prompt", "message", "messages", "content", "text", "input", "output", "body", "token",
      "apiKey", "secret", "password", "authorization", "key", "url", "stack", "query", "answer", "excerpt"];
    for (const name of forbidden) expect(LOG_FIELD_ALLOWLIST, `allowlisted: ${name}`).not.toContain(name);
  });

  it("the log event names are a closed set, so a message cannot carry content", () => {
    // The structural half of AC-5: `log()` takes a `LogEvent`, not a string, so there is no parameter to put a
    // prompt in. Asserted on the *shape* of the names too — a name with a space or a colon is prose creeping in.
    expect(LOG_EVENTS.length).toBeGreaterThan(20);
    for (const event of LOG_EVENTS) expect(event, event).toMatch(/^[a-z]+\.[a-z-]+$/);
    expect(new Set(LOG_EVENTS).size).toBe(LOG_EVENTS.length);
  });
});

describe("correlation on every line — AC-4", () => {
  it("carries tenant, conversation, run and principal", () => {
    const telemetry = createRecordingTelemetry({
      tenantId: "t1",
      conversationId: "c1",
      runId: "r1",
      principalId: "u1",
      requestId: "req1",
    });
    telemetry.logger.log("info", "run.started");
    const line = JSON.parse(telemetry.lines[0] ?? "{}");
    // All four named by the criterion, at the top level rather than nested: a query for `runId:r1` in an
    // aggregator must not need to know the shape.
    expect(line).toMatchObject({ tenantId: "t1", conversationId: "c1", runId: "r1", principalId: "u1" });
  });

  it("a child logger inherits and extends, so ids are set once at a boundary", () => {
    const telemetry = createRecordingTelemetry({ tenantId: "t1" });
    telemetry.logger.child({ runId: "r9" }).child({ principalId: "u9" }).log("info", "run.claimed");
    expect(JSON.parse(telemetry.lines[0] ?? "{}")).toMatchObject({ tenantId: "t1", runId: "r9", principalId: "u9" });
  });

  it("omits an absent id rather than emitting an empty string", () => {
    const telemetry = createRecordingTelemetry({ tenantId: "t1" });
    telemetry.logger.log("info", "worker.started");
    // `runId: ""` reads as a run whose id is blank. Absence is the honest shape, and it is also what makes an
    // aggregator's "field exists" filter mean something.
    expect(Object.keys(JSON.parse(telemetry.lines[0] ?? "{}"))).not.toContain("runId");
  });
});

describe("spans align with run events — AC-2", () => {
  it("every run event type has a span, with no extras", () => {
    // A total map keyed by RunEventType, so a new event type without a span decision is a *compile* error. The
    // runtime assertion is the same statement in the other direction: nothing in the map that is not an event.
    expect([...Object.keys(SPAN_FOR_RUN_EVENT)].sort()).toEqual([...RUN_EVENT_TYPES].sort());
  });

  it("resolves an event type at runtime and refuses an unknown one", () => {
    expect(spanForRunEvent("tool.failed")).toBe("tool.call");
    // Null, not `undefined` indexed out of the map — that would produce a span literally named "undefined",
    // which is the kind of thing that survives for a year in a trace view.
    expect(spanForRunEvent("run.exploded")).toBeNull();
  });

  /**
   * Same word in both places, with the exceptions named.
   *
   * An operator holding a trace and an event history matches them by eye, so `agent.inference` next to a
   * `model.called` event costs a lookup every time. The exceptions are listed *here*, not excluded from the
   * loop, because a documented exception and an oversight look identical when both are simply absent — and this
   * assertion failed on `part.added` first time round for exactly that reason.
   */
  it("names a span the same word the event does, except where a span per event would bury the useful ones", () => {
    // Deliberately folded into `run.step`: a span per streamed part is thousands per run, and they hide the
    // model and tool spans that an operator is actually looking for.
    const FOLDED_INTO_RUN_STEP = ["part.added", "part.updated", "usage.updated"];
    for (const [event, span] of Object.entries(SPAN_FOR_RUN_EVENT)) {
      if (FOLDED_INTO_RUN_STEP.includes(event)) {
        expect(span, event).toBe("run.step");
        continue;
      }
      const domain = event.split(".")[0];
      // `question.*` and `approval.*` are the hitl domain; everything else shares its first word with its span.
      if (domain === "question" || domain === "approval") expect(span.startsWith("hitl."), event).toBe(true);
      else expect(span.startsWith(`${domain}.`), `${event} -> ${span}`).toBe(true);
    }
    // And the exception list is exhaustive: a *new* event folded into run.step without being listed here fails.
    for (const [event, span] of Object.entries(SPAN_FOR_RUN_EVENT))
      if (span === "run.step") expect(FOLDED_INTO_RUN_STEP, event).toContain(event);
  });

  it("declares every boundary span the criterion lists", () => {
    for (const name of ["http.request", "run.admit", "run.enqueue", "run.claim", "model.call", "tool.call", "hitl.approval"])
      expect(ALL_SPAN_NAMES).toContain(name);
  });
});

describe("one request is one trace — AC-1", () => {
  /**
   * The end-to-end property, across three processes.
   *
   * The API host's request span, the enqueue, and then a *separate* consumer that only ever sees the job payload
   * — which is exactly the real constraint: the worker cannot hold a live span object across a process boundary,
   * so the trace has to survive as a string.
   */
  it("the worker's span shares the request's trace id, through the job payload alone", async () => {
    const telemetry = createRecordingTelemetry();
    const enqueued: RunJob[] = [];
    const rawDispatcher: JobDispatcher = {
      async enqueueRun(input) {
        enqueued.push(input as RunJob);
      },
    };
    const dispatcher = instrumentDispatcher(rawDispatcher, { telemetry, now: () => 1_000 });

    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const rawConsumer: JobConsumer = { start(h) { deliver = h; }, stop: async () => {} };
    const consumer = instrumentConsumer(rawConsumer, { telemetry, workerId: "w1", now: () => 1_400 });
    consumer.start(async () => {});

    let requestTraceId = "";
    await withSpan(telemetry.tracer, BOUNDARY_SPANS.request, { kind: "server" }, async (request) => {
      requestTraceId = request.context.traceId;
      await dispatcher.enqueueRun({ tenantId: t1, runId: r1, traceparent: traceparentOf(request) });
    });

    const job = enqueued[0];
    expect(job?.traceparent, "the job must carry a traceparent or nothing can join the trace").toBeDefined();
    await deliver?.(job as RunJob);

    const claim = telemetry.spans.find((s) => s.name === BOUNDARY_SPANS.claim);
    expect(claim?.traceId).toBe(requestTraceId);
    // And it is a *child*, not merely in the same trace: the parent is the enqueue span, so the queue hop is
    // visible as a hop rather than the worker appearing to be called by the request directly.
    const enqueueSpan = telemetry.spans.find((s) => s.name === BOUNDARY_SPANS.enqueue);
    expect(claim?.parentSpanId).toBe(enqueueSpan?.spanId);
    expect(claim?.attributes["queue.trace_continued"]).toBe(true);
  });

  it("a job with no traceparent starts its own trace instead of failing", async () => {
    const telemetry = createRecordingTelemetry();
    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const consumer = instrumentConsumer({ start(h) { deliver = h; }, stop: async () => {} }, { telemetry });
    consumer.start(async () => {});
    // A job already on the queue from before propagation existed. It must run.
    await deliver?.({ tenantId: t1, runId: r1 });
    const claim = telemetry.spans.find((s) => s.name === BOUNDARY_SPANS.claim);
    expect(claim).toBeDefined();
    expect(claim?.parentSpanId).toBeNull();
    // Recorded as *not* continued, so a propagation bug is distinguishable from an old job. Without this both
    // look like a working trace.
    expect(claim?.attributes["queue.trace_continued"]).toBe(false);
  });

  it("a malformed traceparent is treated as absent, not as a failure", async () => {
    const telemetry = createRecordingTelemetry();
    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const consumer = instrumentConsumer({ start(h) { deliver = h; }, stop: async () => {} }, { telemetry });
    consumer.start(async () => {});
    await expect(deliver?.({ tenantId: t1, runId: r1, traceparent: "garbage" })).resolves.toBeUndefined();
    expect(telemetry.spans.find((s) => s.name === BOUNDARY_SPANS.claim)?.attributes["queue.trace_continued"]).toBe(false);
  });

  it("two overlapping enqueues do not cross their traces", async () => {
    // The bug my first version had: the wrapper remembered the span it had just opened and let the adapter read
    // it back. With two concurrent enqueues that attributes one tenant's run to another tenant's request, which
    // is worse than having no trace at all.
    const telemetry = createRecordingTelemetry();
    const enqueued: RunJob[] = [];
    const dispatcher = instrumentDispatcher(
      { async enqueueRun(i) { await Promise.resolve(); enqueued.push(i as RunJob); } },
      { telemetry },
    );
    await Promise.all([
      dispatcher.enqueueRun({ tenantId: t1, runId: "ra" as RunId }),
      dispatcher.enqueueRun({ tenantId: "t2" as TenantId, runId: "rb" as RunId }),
    ]);
    const parents = enqueued.map((j) => j.traceparent);
    expect(parents.filter(Boolean)).toHaveLength(2);
    expect(new Set(parents).size, "each enqueue must carry its own span").toBe(2);
  });

  it("the enqueue span is a producer and the claim span is a consumer", async () => {
    const telemetry = createRecordingTelemetry();
    const enqueued: RunJob[] = [];
    const dispatcher = instrumentDispatcher({ async enqueueRun(i) { enqueued.push(i as RunJob); } }, { telemetry });
    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const consumer = instrumentConsumer({ start(h) { deliver = h; }, stop: async () => {} }, { telemetry });
    consumer.start(async () => {});
    await dispatcher.enqueueRun({ tenantId: t1, runId: r1 });
    await deliver?.(enqueued[0] as RunJob);
    // The pair is how a collector draws a queue hop. Without the kinds it renders as a nested call, and a
    // producer span ending long before its child then looks like a broken trace.
    expect(telemetry.spans.find((s) => s.name === BOUNDARY_SPANS.enqueue)?.kind).toBe("producer");
    expect(telemetry.spans.find((s) => s.name === BOUNDARY_SPANS.claim)?.kind).toBe("consumer");
  });

  it("ends every span on the failure path and records only a code", async () => {
    const telemetry = createRecordingTelemetry();
    await expect(
      withSpan(telemetry.tracer, "x", {}, async () => {
        throw Object.assign(new Error("the prompt was: secret text"), { code: "forbidden" });
      }),
    ).rejects.toThrow();
    const span = telemetry.spans[0];
    expect(span?.ended, "a span left open leaks memory and never reaches a collector").toBe(true);
    expect(span?.status).toBe("error");
    expect(span?.errorCode).toBe("forbidden");
    // The message is *not* on the span. An error message is the most common accidental carrier of content — a
    // rejected prompt, a failing statement, a signed URL — and #131 found exactly that shape in this codebase.
    expect(JSON.stringify(telemetry.spans)).not.toContain("secret text");
  });

  it("errorCodeOf reports a code or a class name, never a message", () => {
    expect(errorCodeOf(Object.assign(new Error("m"), { code: "unavailable" }))).toBe("unavailable");
    expect(errorCodeOf(new TypeError("my secret"))).toBe("TypeError");
    expect(errorCodeOf("a string that is actually the prompt")).toBe("unknown");
    expect(errorCodeOf(undefined)).toBe("unknown");
    // A "code" that is really a paragraph is refused, or the escape hatch becomes the leak.
    expect(errorCodeOf({ code: "x".repeat(200) })).toBe("Object");
  });
});

describe("metrics answer the operational questions — AC-3", () => {
  it("declares an instrument for every question the criterion asks", () => {
    const names = Object.values(RUN_INSTRUMENTS).map((i) => i.name);
    for (const expected of [
      "agentkit_queue_depth",
      "agentkit_claim_latency_ms",
      "agentkit_run_duration_ms",
      "agentkit_model_latency_ms",
      "agentkit_model_calls_total",
      "agentkit_tool_calls_total",
      "agentkit_approval_wait_ms",
    ])
      expect(names).toContain(expected);
  });

  it("gives every instrument a unit, a description and the question it answers", () => {
    for (const spec of Object.values(RUN_INSTRUMENTS)) {
      expect(spec.unit.length, spec.name).toBeGreaterThan(0);
      // The question, because "enough to answer 'is it healthy'" is the criterion. A metric with no question
      // behind it is one nobody looks at.
      expect(spec.answers, spec.name).toMatch(/\?$/);
      // The unit in the name too: a graph legend shows the name, not the metadata.
      if (spec.unit === "ms") expect(spec.name.endsWith("_ms"), spec.name).toBe(true);
      if (spec.kind === "counter") expect(spec.name.endsWith("_total"), spec.name).toBe(true);
    }
  });

  it("records claim latency from the producer's stamp", async () => {
    const telemetry = createRecordingTelemetry();
    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const consumer = instrumentConsumer(
      { start(h) { deliver = h; }, stop: async () => {} },
      { telemetry, now: () => Date.parse("2026-08-23T12:00:03.000Z") },
    );
    consumer.start(async () => {});
    await deliver?.({ tenantId: t1, runId: r1, enqueuedAt: "2026-08-23T12:00:00.000Z" });
    const claim = telemetry.metrics.find((m) => m.instrument === RUN_INSTRUMENTS.claimLatencyMs.name);
    expect(claim?.value).toBe(3_000);
  });

  it("drops a negative claim latency rather than clamping it to zero", async () => {
    const telemetry = createRecordingTelemetry();
    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const consumer = instrumentConsumer(
      { start(h) { deliver = h; }, stop: async () => {} },
      { telemetry, now: () => Date.parse("2026-08-23T12:00:00.000Z") },
    );
    consumer.start(async () => {});
    // Clock skew between two hosts. A zero is indistinguishable from a genuinely instant claim, and a p99 built
    // from fabricated zeros reads healthy — the absence is the honest answer.
    await deliver?.({ tenantId: t1, runId: r1, enqueuedAt: "2026-08-23T12:00:05.000Z" });
    expect(telemetry.metrics.filter((m) => m.instrument === RUN_INSTRUMENTS.claimLatencyMs.name)).toEqual([]);
  });

  it("records claim latency even when the run then fails", async () => {
    const telemetry = createRecordingTelemetry();
    let deliver: ((job: RunJob) => Promise<void>) | null = null;
    const consumer = instrumentConsumer(
      { start(h) { deliver = h; }, stop: async () => {} },
      { telemetry, now: () => Date.parse("2026-08-23T12:00:02.000Z") },
    );
    consumer.start(async () => {
      throw new Error("boom");
    });
    await expect(deliver?.({ tenantId: t1, runId: r1, enqueuedAt: "2026-08-23T12:00:00.000Z" })).rejects.toThrow();
    // A queue backing up and a run failing are different incidents. A metric that only appeared on success would
    // hide the first behind the second.
    expect(telemetry.metrics.some((m) => m.instrument === RUN_INSTRUMENTS.claimLatencyMs.name)).toBe(true);
  });

  it("records run duration and outcome on both the success and the failure path", async () => {
    for (const shouldFail of [false, true]) {
      const telemetry = createRecordingTelemetry();
      let deliver: ((job: RunJob) => Promise<void>) | null = null;
      const consumer = instrumentConsumer({ start(h) { deliver = h; }, stop: async () => {} }, { telemetry });
      consumer.start(async () => {
        if (shouldFail) throw Object.assign(new Error("x"), { code: "unavailable" });
      });
      const call = deliver?.({ tenantId: t1, runId: r1 });
      if (shouldFail) await expect(call).rejects.toThrow();
      else await call;
      const total = telemetry.metrics.find((m) => m.instrument === RUN_INSTRUMENTS.runsTotal.name);
      // Duration on the failure path too: a dashboard built only on successes shows latency *improving* as
      // things break, because the slow runs are the ones that time out.
      expect(telemetry.metrics.some((m) => m.instrument === RUN_INSTRUMENTS.runDurationMs.name)).toBe(true);
      expect(total?.attributes.outcome).toBe(shouldFail ? "failed" : "completed");
      if (shouldFail) expect(total?.attributes.errorCode).toBe("unavailable");
    }
  });

  it("times a model call and counts its outcome, with no prompt on the span", async () => {
    const telemetry = createRecordingTelemetry();
    const metrics = createRunMetrics(telemetry.meter);
    let clock = 0;
    const now = () => (clock += 250);
    await instrumentModelCall({ telemetry, metrics, now }, { tenantId: t1, runId: r1, modelId: "gpt-4o" }, async () => "answer");
    expect(telemetry.metrics.find((m) => m.instrument === RUN_INSTRUMENTS.modelLatencyMs.name)?.value).toBeGreaterThan(0);
    expect(telemetry.metrics.find((m) => m.instrument === RUN_INSTRUMENTS.modelCallsTotal.name)?.attributes.outcome).toBe("ok");
    const span = telemetry.spans.find((s) => s.name === BOUNDARY_SPANS.model);
    expect(span?.attributes.modelId).toBe("gpt-4o");
    // The counts live on the usage ledger, which is tenant-scoped and designed to hold them. The span holds the
    // model id and the outcome and nothing a user or a model authored.
    expect(Object.keys(span?.attributes ?? {})).toEqual(expect.not.arrayContaining(["prompt", "input", "output"]));
  });

  it("counts a failed model call and a failed tool call by error code", async () => {
    const telemetry = createRecordingTelemetry();
    const metrics = createRunMetrics(telemetry.meter);
    await expect(
      instrumentModelCall({ telemetry, metrics }, { tenantId: t1, modelId: "m" }, async () => {
        throw Object.assign(new Error("rate limited: prompt was secret"), { code: "rate-limited" });
      }),
    ).rejects.toThrow();
    await expect(
      instrumentToolCall({ telemetry, metrics }, { tenantId: t1, toolName: "publish_post" }, async () => {
        throw Object.assign(new Error("nope"), { code: "forbidden" });
      }),
    ).rejects.toThrow();

    expect(
      telemetry.metrics.find((m) => m.instrument === RUN_INSTRUMENTS.modelCallsTotal.name)?.attributes.errorCode,
    ).toBe("rate-limited");
    expect(
      telemetry.metrics.find((m) => m.instrument === RUN_INSTRUMENTS.toolCallsTotal.name)?.attributes.errorCode,
    ).toBe("forbidden");
    // Latency recorded on failure too — an error rate without a latency next to it cannot distinguish "failing
    // fast" from "timing out", and those need different responses.
    expect(telemetry.metrics.some((m) => m.instrument === RUN_INSTRUMENTS.toolLatencyMs.name)).toBe(true);
    expect(telemetry.lines.join("\n")).not.toContain("prompt was secret");
  });

  it("records an approval wait spanning a process restart", () => {
    const telemetry = createRecordingTelemetry();
    const metrics = createRunMetrics(telemetry.meter);
    recordApprovalWait(
      { telemetry, metrics },
      {
        tenantId: t1,
        runId: r1,
        interactionId: "i1",
        requestedAt: "2026-08-23T12:00:00.000Z",
        decidedAt: "2026-08-23T12:04:00.000Z",
        decision: "approved",
      },
    );
    // Not a wrapper, because the wait is not a function call: the run is suspended, the process may have exited,
    // and the decision arrives in a different request. Two timestamps is the only shape that can measure it.
    expect(telemetry.metrics.find((m) => m.instrument === RUN_INSTRUMENTS.approvalWaitMs.name)?.value).toBe(240_000);
    expect(telemetry.logs.find((l) => l.event === "approval.decided")?.fields.waitMs).toBe(240_000);
  });

  /**
   * Cardinality, enforced in the implementation.
   *
   * `runId` on a latency histogram is one line of code and one time series per run. It looks like helpful detail
   * in review and is a cardinality incident in production, with the bill arriving a month later.
   */
  it("drops an unbounded metric attribute, in the implementation and not at the call site", () => {
    const telemetry = createRecordingTelemetry();
    const metrics = createRunMetrics(telemetry.meter);
    metrics.runDurationMs.record(10, { tenantId: t1, runId: r1, conversationId: "c1", outcome: "completed" } as never);
    const recorded = telemetry.metrics[0];
    expect(Object.keys(recorded?.attributes ?? {}).sort()).toEqual(["outcome", "tenantId"]);
    expect(boundMetricAttributes({ runId: "r1" })).toEqual({});
    for (const unbounded of ["runId", "conversationId", "principalId", "requestId", "interactionId"])
      expect(METRIC_ATTRIBUTE_ALLOWLIST, unbounded).not.toContain(unbounded);
  });
});

describe("absence is a no-op", () => {
  it("NOOP_TELEMETRY satisfies every call without a branch anywhere", async () => {
    // The reason no call site has `if (telemetry)`. Optional-and-checked would be checked in nineteen places and
    // forgotten in the twentieth, and the forgotten one is a crash rather than a missing span.
    const result = await withSpan(NOOP_TELEMETRY.tracer, "x", { kind: "server" }, async (span) => {
      span.setAttributes({ tenantId: "t1" });
      span.recordError({ code: "c" });
      return 42;
    });
    expect(result).toBe(42);
    createRunMetrics(NOOP_TELEMETRY.meter).runsTotal.record(1, { outcome: "ok" });
    NOOP_TELEMETRY.logger.child({ runId: "r1" }).log("info", "run.started", { reason: "x" });
  });

  it("an instrumented dispatcher still enqueues when telemetry is a no-op", async () => {
    const enqueued: unknown[] = [];
    const dispatcher = instrumentDispatcher(
      { async enqueueRun(i) { enqueued.push(i); } },
      { telemetry: NOOP_TELEMETRY },
    );
    await dispatcher.enqueueRun({ tenantId: t1, runId: r1 });
    expect(enqueued).toHaveLength(1);
  });

  it("an enqueue failure still propagates, and is logged as a code", async () => {
    const telemetry = createRecordingTelemetry();
    const dispatcher = instrumentDispatcher(
      { async enqueueRun() { throw Object.assign(new Error("redis down at redis://user:pw@host"), { code: "unavailable" }); } },
      { telemetry },
    );
    // Telemetry must never swallow a failure: the caller's error handling is the guarantee, and a wrapper that
    // absorbed it would turn a failed enqueue into a run that never happens and never reports.
    await expect(dispatcher.enqueueRun({ tenantId: t1, runId: r1 })).rejects.toThrow();
    expect(telemetry.logs.find((l) => l.event === "run.enqueue-failed")?.fields.errorCode).toBe("unavailable");
    expect(telemetry.lines.join("\n")).not.toContain("user:pw@host");
  });
});
