/**
 * Wiring telemetry to the boundaries — AC-1, AC-2, AC-3.
 *
 * The port is inert on its own. These are the wrappers that put it on the path a run actually takes, and they
 * are **decorators over the existing seams** rather than edits inside them: `instrumentDispatcher` wraps a
 * `JobDispatcher`, `instrumentConsumer` wraps a `JobConsumer`. Two reasons, and the second is the real one.
 *
 * The first is that a deployment without telemetry runs the undecorated object, so telemetry cannot be the
 * reason a run fails.
 *
 * The second is that instrumentation *inside* the dispatcher would put a span around the enqueue and nothing
 * around the wait between enqueue and claim — which is the number a user actually experiences. Wrapping both
 * sides is what makes claim latency measurable at all.
 */

import type { JobDispatcher } from "../runtime/index.js";
import type { JobConsumer, RunJob } from "../worker/main.js";
import type { RunId, TenantId } from "../core/ids.js";
import { BOUNDARY_SPANS } from "./spans.js";
import { createRunMetrics, type RunMetrics } from "./metrics.js";
import { formatTraceparent, parseTraceparent } from "./trace-context.js";
import { errorCodeOf, withSpan, type Telemetry } from "./index.js";

/**
 * What a job carries so the worker can continue the trace — AC-1.
 *
 * `traceparent` is **optional**, and that is a compatibility decision rather than laziness: jobs enqueued before
 * this landed are already on the queue, and a worker that required the field would fail every one of them. A job
 * without it starts a new trace, which is a missing link in one trace rather than a lost run.
 *
 * `enqueuedAt` rides along for the same reason claim latency cannot be measured on one side: the worker needs to
 * know when the producer let go. Taken from the producer's clock, so the number is only as good as clock skew
 * between the two hosts — stated because a negative claim latency in a dashboard is otherwise a mystery.
 */
export type TracedJob = {
  readonly traceparent?: string;
  readonly enqueuedAt?: string;
};

export type InstrumentedDispatcherDeps = {
  readonly telemetry: Telemetry;
  readonly metrics?: RunMetrics;
  /** Injected so a test can pin it; also what makes claim latency assertable without waiting. */
  readonly now?: () => number;
};

/**
 * Wrap a dispatcher so the enqueue is a span and the job carries the trace forward.
 *
 * The traceparent goes down through `enqueueRun`, which #143 widened to accept it. The first version of this
 * remembered the span it had just opened and let the adapter read it back — which is wrong the moment two
 * enqueues overlap, and overlapping enqueues are the normal case, not the edge one. A racy trace link is worse
 * than none: it attributes one tenant's run to another tenant's request.
 */
export const instrumentDispatcher = (inner: JobDispatcher, deps: InstrumentedDispatcherDeps): JobDispatcher => {
  const clock = deps.now ?? (() => Date.now());
  return {
    async enqueueRun(input: { tenantId: TenantId; runId: RunId; traceparent?: string; enqueuedAt?: string }): Promise<void> {
      await withSpan(
        deps.telemetry.tracer,
        BOUNDARY_SPANS.enqueue,
        {
          // `producer`, so a collector renders the queue hop as a queue hop rather than as a nested call. The
          // distinction matters in a trace view: a producer span is expected to end long before its consumer.
          kind: "producer",
          // The *caller's* traceparent is this span's parent — the request that is enqueueing. Missing in the
          // first version, and the end-to-end test caught it immediately: the enqueue span opened its own trace,
          // so the worker faithfully continued a trace containing nothing but the queue hop. Every span existed,
          // every parent link was present, and the trace was still useless.
          ...(input.traceparent !== undefined ? { parent: input.traceparent } : {}),
          attributes: { tenantId: input.tenantId, runId: input.runId },
        },
        async (span) => {
          try {
            await inner.enqueueRun({
              ...input,
              // The *enqueue span's* context, not the request's: the consumer's span is a child of this hop, and
              // parenting it to the request instead would flatten the queue out of the trace entirely.
              traceparent: formatTraceparent(span.context),
              enqueuedAt: input.enqueuedAt ?? new Date(clock()).toISOString(),
            });
          } catch (error) {
            deps.telemetry.logger.log("error", "run.enqueue-failed", {
              tenantId: input.tenantId,
              runId: input.runId,
              errorCode: errorCodeOf(error),
            });
            throw error;
          }
          deps.telemetry.logger.log("info", "run.enqueued", { tenantId: input.tenantId, runId: input.runId });
        },
      );
    },
  };
};

export type InstrumentedConsumerDeps = InstrumentedDispatcherDeps & {
  /** Which worker process this is. On a log line, so a stuck instance is identifiable. */
  readonly workerId?: string;
};

/**
 * Wrap a consumer so each job continues its producer's trace and claim latency is recorded.
 *
 * The handler runs *inside* the claim span, so everything the run does — model calls, tool calls, an approval
 * wait — is a descendant of it and of the original request. That is AC-1: one user request, one trace, across
 * three processes.
 */
export const instrumentConsumer = (
  inner: JobConsumer,
  deps: InstrumentedConsumerDeps,
): JobConsumer => {
  const metrics = deps.metrics ?? createRunMetrics(deps.telemetry.meter);
  const now = deps.now ?? (() => Date.now());
  const workerId = deps.workerId;

  return {
    start(handler: (job: RunJob) => Promise<void>) {
      return inner.start(async (job: RunJob & TracedJob) => {
        const parent = parseTraceparent(job.traceparent);
        const claimedAt = now();

        // Claim latency, from the producer's stamp. Recorded before the handler runs, so it is reported even if
        // the run then fails -- a queue backing up and a run failing are different incidents and a metric that
        // only appeared on success would hide the first behind the second.
        if (job.enqueuedAt !== undefined) {
          const enqueued = Date.parse(job.enqueuedAt);
          // Skew between two hosts can make this negative. Dropped rather than clamped to zero: a zero is
          // indistinguishable from a genuinely instant claim, and a p99 built from fabricated zeros reads
          // healthy. The absence is the honest answer.
          if (Number.isFinite(enqueued) && claimedAt >= enqueued)
            metrics.claimLatencyMs.record(claimedAt - enqueued, { tenantId: job.tenantId });
        }

        await withSpan(
          deps.telemetry.tracer,
          BOUNDARY_SPANS.claim,
          {
            // `consumer`, the other half of the producer span. A collector uses the pair to draw the queue hop.
            kind: "consumer",
            ...(parent !== null ? { parent: job.traceparent } : {}),
            attributes: {
              tenantId: job.tenantId,
              runId: job.runId,
              // Whether the trace was actually continued. Without this, a propagation bug looks identical to a
              // job that was enqueued before propagation existed, and both look like a working trace.
              "queue.trace_continued": parent !== null,
              ...(workerId !== undefined ? { workerId } : {}),
            },
          },
          async () => {
            const logger = deps.telemetry.logger.child({ tenantId: job.tenantId, runId: job.runId });
            logger.log("info", "run.claimed", { ...(workerId !== undefined ? { workerId } : {}) });
            const startedAt = now();
            try {
              await handler(job);
              metrics.runDurationMs.record(now() - startedAt, { tenantId: job.tenantId, outcome: "completed" });
              metrics.runsTotal.record(1, { tenantId: job.tenantId, outcome: "completed" });
            } catch (error) {
              const errorCode = errorCodeOf(error);
              // Duration on the failure path too. A dashboard built only on successes shows latency improving
              // as things break, because the slow runs are the ones that time out.
              metrics.runDurationMs.record(now() - startedAt, { tenantId: job.tenantId, outcome: "failed" });
              metrics.runsTotal.record(1, { tenantId: job.tenantId, outcome: "failed", errorCode });
              logger.log("error", "run.failed", { errorCode });
              throw error;
            }
          },
        );
      });
    },
    stop: (graceMs: number) => inner.stop(graceMs),
  };
};

/**
 * Time a model call — latency, outcome and the model, with no prompt anywhere near it.
 *
 * The attributes are the model id and the outcome. Not the prompt, not the response, not the token *contents* —
 * the counts are on the usage ledger, which is the place designed to hold them and which is tenant-scoped.
 */
export const instrumentModelCall = async <T>(
  deps: { readonly telemetry: Telemetry; readonly metrics: RunMetrics; readonly now?: () => number },
  input: { readonly tenantId: string; readonly runId?: string; readonly modelId: string; readonly providerId?: string },
  call: () => Promise<T>,
): Promise<T> => {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  return withSpan(
    deps.telemetry.tracer,
    BOUNDARY_SPANS.model,
    {
      kind: "client",
      attributes: {
        tenantId: input.tenantId,
        modelId: input.modelId,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      },
    },
    async () => {
      const attrs = { tenantId: input.tenantId, modelId: input.modelId };
      try {
        const result = await call();
        deps.metrics.modelLatencyMs.record(now() - startedAt, attrs);
        deps.metrics.modelCallsTotal.record(1, { ...attrs, outcome: "ok" });
        return result;
      } catch (error) {
        deps.metrics.modelLatencyMs.record(now() - startedAt, attrs);
        deps.metrics.modelCallsTotal.record(1, { ...attrs, outcome: "error", errorCode: errorCodeOf(error) });
        deps.telemetry.logger.log("warn", "model.failed", {
          tenantId: input.tenantId,
          modelId: input.modelId,
          errorCode: errorCodeOf(error),
        });
        throw error;
      }
    },
  );
};

/** Time a tool call. Same shape, and the same deliberate absence of arguments and results. */
export const instrumentToolCall = async <T>(
  deps: { readonly telemetry: Telemetry; readonly metrics: RunMetrics; readonly now?: () => number },
  input: { readonly tenantId: string; readonly runId?: string; readonly toolName: string },
  call: () => Promise<T>,
): Promise<T> => {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  return withSpan(
    deps.telemetry.tracer,
    BOUNDARY_SPANS.tool,
    {
      kind: "internal",
      attributes: {
        tenantId: input.tenantId,
        toolName: input.toolName,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
      },
    },
    async () => {
      const attrs = { tenantId: input.tenantId, toolName: input.toolName };
      try {
        const result = await call();
        deps.metrics.toolLatencyMs.record(now() - startedAt, attrs);
        deps.metrics.toolCallsTotal.record(1, { ...attrs, outcome: "ok" });
        return result;
      } catch (error) {
        deps.metrics.toolLatencyMs.record(now() - startedAt, attrs);
        deps.metrics.toolCallsTotal.record(1, { ...attrs, outcome: "error", errorCode: errorCodeOf(error) });
        deps.telemetry.logger.log("warn", "tool.failed", {
          tenantId: input.tenantId,
          toolName: input.toolName,
          errorCode: errorCodeOf(error),
        });
        throw error;
      }
    },
  );
};

/**
 * Record how long a run waited for a human.
 *
 * Not a wrapper, because the wait is not a function call: the run is *suspended*, the process may have exited,
 * and the decision arrives in a different request entirely. So this is called when the decision lands, with both
 * timestamps — the only shape that can measure a wait spanning a deploy.
 *
 * Often the longest span in a trace, and the one that most needs to be visibly *not* the platform's latency.
 */
export const recordApprovalWait = (
  deps: { readonly telemetry: Telemetry; readonly metrics: RunMetrics },
  input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly interactionId: string;
    readonly requestedAt: string;
    readonly decidedAt: string;
    readonly decision: string;
    readonly traceparent?: string;
  },
): void => {
  const requested = Date.parse(input.requestedAt);
  const decided = Date.parse(input.decidedAt);
  if (Number.isFinite(requested) && Number.isFinite(decided) && decided >= requested)
    deps.metrics.approvalWaitMs.record(decided - requested, { tenantId: input.tenantId });

  const span = deps.telemetry.tracer.startSpan(BOUNDARY_SPANS.approvalWait, {
    kind: "internal",
    ...(input.traceparent !== undefined ? { parent: input.traceparent } : {}),
    attributes: {
      tenantId: input.tenantId,
      runId: input.runId,
      interactionId: input.interactionId,
      decision: input.decision,
    },
  });
  span.setStatus("ok");
  span.end();

  deps.telemetry.logger.log("info", "approval.decided", {
    tenantId: input.tenantId,
    runId: input.runId,
    interactionId: input.interactionId,
    decision: input.decision,
    ...(Number.isFinite(requested) && Number.isFinite(decided) && decided >= requested
      ? { waitMs: decided - requested }
      : {}),
  });
};
