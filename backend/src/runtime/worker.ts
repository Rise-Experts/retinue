/**
 * Durable run worker — `docs/04-durable-runtime-and-hitl.md` → Durable execution.
 *
 * The worker owns a run's lifecycle: claim it under a lease, drive the injected `AgentEngine`,
 * checkpoint every streamed event, keep the lease alive, and finish inside a terminal transition.
 * It is provider-neutral — the engine produces the events; the worker makes them durable and
 * recoverable. The guarantees it enforces (per the acceptance criteria):
 *
 * - **Atomic claim** — a lease-based `RunStore.claim` means two workers never process one run.
 * - **Refresh loses nothing** — parts are checkpointed and appended to the durable `RunEventLog`
 *   as they stream, so a reconnecting client catches up from its cursor with no gap.
 * - **Safe crash recovery** — a re-claim reloads the checkpoint and *finalizes* (never re-runs)
 *   tool calls that were mid-flight, so no external action fires twice.
 * - **Cooperative cancellation** — a durable cancel request stops the engine and finalizes cleanly.
 *
 * Streaming state is projected through the one canonical reducer (`reduceRunEvent`), the same fold a
 * client uses, so the checkpoint and any client rebuild identical state. Retrying transient provider
 * failures is the engine's job (`runWithRetry`); the worker just relays the `run.retry-pending`
 * notifications it emits. Retried *external* writes are made safe by idempotency keys.
 */

import type { ErrorPart } from "../core/content-parts.js";
import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError, type PlatformError } from "../core/errors.js";
import {
  EMPTY_RUN_STREAM_STATE,
  reduceRunEvent,
  type RealtimePublisher,
  type RunEvent,
  type RunEventLog,
  type RunStreamState,
} from "../core/events.js";
import type { MessageId, MessagePartId, RunId } from "../core/ids.js";
import type { CheckpointStore, RunStore } from "../persistence/index.js";
import type { UsageRecorder } from "../usage/index.js";
import type { RunCheckpoint } from "./checkpoint.js";
import { type DistributedLockStore, type Run } from "./index.js";
import { toPlatformError } from "./retry.js";

/** Stable assistant-message id for a run, so a resumed/recovered run upserts one row, not many. */
export const deriveRunMessageId = (runId: RunId): string => `run:${runId}:assistant`;

/** Cooperative cancellation the engine polls between steps and tool calls. */
export interface CancellationSignal {
  readonly isCancelled: () => boolean;
}

/** Distributive `Omit` — plain `Omit` over a union keeps only common keys, collapsing the union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An event the engine yields. The worker stamps `runId`, a monotonic `sequence` and `occurredAt`,
 * so engines never have to track sequencing. Distributes over the union, keeping `type` discriminating.
 */
export type EngineEvent = DistributiveOmit<RunEvent, "sequence" | "occurredAt" | "runId">;

export type EngineRunInput = {
  readonly run: Run;
  readonly context: ExecutionContext;
  /** Non-null on recovery: parts already persisted, step reached, dangling calls already finalized. */
  readonly resume: RunCheckpoint | null;
  readonly signal: CancellationSignal;
};

/**
 * The pluggable agent loop (model + tools). Yields typed events; MUST be resumable from `resume`
 * (never re-run a tool already present in the checkpoint), MUST wrap provider calls in
 * `runWithRetry` and yield `run.retry-pending`, and SHOULD abort provider/tools when the async
 * iterator is `return()`-ed or `signal.isCancelled()` flips.
 */
export interface AgentEngine {
  run(input: EngineRunInput): AsyncIterable<EngineEvent>;
}

export type DurableWorkerDeps = {
  readonly runs: RunStore;
  readonly checkpoints: CheckpointStore;
  readonly publisher: RealtimePublisher;
  readonly engine: AgentEngine;
  /** Durable per-run event log for reconnect catch-up. Optional but required for gap-free reconnect. */
  readonly eventLog?: RunEventLog;
  /** Records durable usage per realized step (doc 12). Recorded as usage is realized, so a later
   * failure never loses the usage already consumed — and idempotently, so recovery never double-counts. */
  readonly usage?: UsageRecorder;
  /** Host builds the execution context; identity never comes from model output. */
  readonly buildContext: (run: Run) => ExecutionContext | Promise<ExecutionContext>;
  readonly workerId: string;
  /** Optional belt-and-suspenders mutual exclusion around the atomic claim. */
  readonly locks?: DistributedLockStore;
  readonly clock?: () => string;
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly keepaliveEveryMs?: number;
  /** Realtime channel for a run's events. Defaults to `conversation:<id>`. */
  readonly channelFor?: (run: Run) => string;
};

export type ProcessOutcome = "completed" | "failed" | "cancelled" | "skipped" | "lost";

export type ProcessResult = {
  readonly run: Run | null;
  readonly outcome: ProcessOutcome;
};

/** Thrown internally when a keepalive reveals the lease was lost; never marks the run failed. */
class ClaimLostError extends Error {
  constructor() {
    super("run claim lost");
    this.name = "ClaimLostError";
  }
}

export const createDurableWorker = (deps: DurableWorkerDeps) => {
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? (() => new Date(now()).toISOString());
  const leaseMs = deps.leaseMs ?? 30_000;
  const keepaliveEveryMs = deps.keepaliveEveryMs ?? Math.max(1, Math.floor(leaseMs / 3));
  const channelFor = deps.channelFor ?? ((r: Run) => `conversation:${r.conversationId}`);
  const { runs, checkpoints, publisher, engine, workerId } = deps;

  /** Drive one already-claimed run to a terminal state. */
  const drive = async (run: Run): Promise<ProcessResult> => {
    const tenantId = run.tenantId;
    const context = await deps.buildContext(run);
    const channel = channelFor(run);
    const initial = await checkpoints.latest({ tenantId, runId: run.id });
    let state: RunStreamState = initial
      ? {
          ...EMPTY_RUN_STREAM_STATE,
          parts: initial.parts,
          pendingToolCalls: initial.pendingToolCalls,
          usage: initial.usage,
          sequence: initial.sequence,
        }
      : EMPTY_RUN_STREAM_STATE;
    let cancelRequested = run.cancelRequestedAt !== undefined;
    let lastKeepalive = now();

    const toCheckpoint = (): RunCheckpoint => ({
      runId: run.id,
      sequence: state.sequence,
      parts: state.parts,
      // Step = tool-call rounds reached, so a resumed engine trusting `resume.step` never re-drives.
      step: state.parts.filter((p) => p.type === "tool-call").length,
      pendingToolCalls: state.pendingToolCalls,
      usage: state.usage,
      updatedAt: clock(),
    });

    const emit = async (body: EngineEvent): Promise<void> => {
      const event = { ...body, runId: run.id, sequence: state.sequence + 1, occurredAt: clock() } as RunEvent;
      state = reduceRunEvent(state, event);
      await publisher.publish(channel, event);
      if (deps.eventLog) await deps.eventLog.append({ tenantId, event });
      // Record durable usage for a realized step. Keyed by sequence so recovery never double-counts.
      if (deps.usage && event.type === "usage.updated" && event.modelId !== undefined) {
        await deps.usage.record(context, {
          runId: run.id,
          conversationId: run.conversationId,
          modelId: event.modelId,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedInputTokens: event.cachedInputTokens ?? 0,
          ...(event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens }),
          costMinorUnits: event.costMinorUnits ?? 0,
          currency: event.currency ?? "USD",
          stepId: event.stepId ?? String(event.sequence),
        });
      }
    };
    const persist = () => checkpoints.save({ tenantId, checkpoint: toCheckpoint() });

    /** Finalize any tool calls started but never completed — as interrupted errors, never re-run. */
    const finalizePending = async (): Promise<void> => {
      for (const pending of state.pendingToolCalls) {
        const error: PlatformError = {
          code: "cancelled",
          message: `Tool call '${pending.toolName}' was interrupted before it completed`,
          retryable: false,
        };
        const part: ErrorPart = {
          id: `${pending.toolCallId}:interrupted` as MessagePartId,
          type: "error",
          schemaVersion: 1,
          createdAt: clock(),
          error,
        };
        await emit({ type: "tool.failed", toolCallId: pending.toolCallId, toolName: pending.toolName });
        await emit({ type: "part.added", messageId: deriveRunMessageId(run.id) as MessageId, part });
      }
      await persist();
    };

    const heartbeat = async (): Promise<void> => {
      if (now() - lastKeepalive < keepaliveEveryMs) return;
      lastKeepalive = now();
      const alive = await runs.keepalive({ tenantId, id: run.id, workerId, leaseMs, now: clock() });
      if (!alive) throw new ClaimLostError();
      const fresh = await runs.findById({ tenantId, id: run.id });
      if (fresh?.cancelRequestedAt !== undefined) cancelRequested = true;
    };

    // Recovery reconciliation (C1). `emit` makes an event durable in the log *before* the checkpoint
    // is written, so after a crash the log can lead the checkpoint. Fold the events the log has beyond
    // the checkpoint back into state, so: (a) new sequences continue past the true durable max instead
    // of colliding, and (b) a tool.started that was logged but not yet checkpointed is still seen as
    // pending — and therefore finalized below — so it is never silently re-run.
    if (deps.eventLog) {
      const missed = await deps.eventLog.listAfter({ tenantId, runId: run.id, after: state.sequence });
      for (const event of missed) state = reduceRunEvent(state, event);
      if (missed.length > 0) await persist();
    }
    const recovered = state.sequence > 0;

    // A re-claimed run may carry dangling tool calls (from the checkpoint or the reconciled log).
    // Finalize them once, before the engine resumes, so it observes them as failed and never re-fires.
    if (state.pendingToolCalls.length > 0) await finalizePending();

    try {
      const started = await runs.transition({ tenantId, id: run.id, workerId, to: "running", now: clock() });
      await emit({ type: "run.started" });
      await persist();

      const signal: CancellationSignal = { isCancelled: () => cancelRequested };
      const iterable = engine.run({ run: started, context, resume: recovered ? toCheckpoint() : null, signal });

      for await (const body of iterable) {
        await emit(body);
        await persist(); // durable before the engine proceeds (tool.started) / between retry attempts
        await heartbeat(); // throttled; runs on every event so a tool-heavy run keeps its lease alive
        if (cancelRequested) break;
      }

      if (cancelRequested) {
        await finalizePending();
        const cancelled = await runs.transition({ tenantId, id: run.id, workerId, to: "cancelled", now: clock() });
        await emit({ type: "run.cancelled" });
        await persist();
        return { run: cancelled, outcome: "cancelled" };
      }

      await finalizePending();
      const completed = await runs.transition({ tenantId, id: run.id, workerId, to: "completed", now: clock() });
      await emit({ type: "run.completed" });
      await persist();
      return { run: completed, outcome: "completed" };
    } catch (thrown) {
      if (thrown instanceof ClaimLostError) {
        return { run: await runs.findById({ tenantId, id: run.id }), outcome: "lost" };
      }
      const error = toPlatformError(thrown);
      await finalizePending();
      const failed = await runs.transition({ tenantId, id: run.id, workerId, to: "failed", now: clock(), error });
      await emit({ type: "run.failed", error });
      await persist();
      return { run: failed, outcome: "failed" };
    }
  };

  return {
    /** Claim (under an optional lock) and drive a run. Idempotent: a claimed/terminal run is skipped. */
    async process(input: { tenantId: Run["tenantId"]; runId: RunId }): Promise<ProcessResult> {
      const { tenantId, runId } = input;
      // Best-effort mutual exclusion. The authoritative guard is the RunStore lease (kept alive by
      // heartbeat); this lock is not renewed, so on a run longer than leaseMs it simply expires —
      // a harmless degradation, since claim/keepalive still prevent two workers driving one run.
      const lock = deps.locks ? await deps.locks.acquire(`run:${runId}`, leaseMs) : { released: async () => {} };
      if (!lock) return { run: await runs.findById({ tenantId, id: runId }), outcome: "skipped" };
      try {
        const claimed = await runs.claim({ tenantId, id: runId, workerId, leaseMs, now: clock() });
        if (!claimed) return { run: await runs.findById({ tenantId, id: runId }), outcome: "skipped" };
        return await drive(claimed);
      } finally {
        await lock.released();
      }
    },

    /**
     * Recover runs whose lease expired (crashed workers). Returns the reclaimed candidates; a caller
     * re-enqueues each via its `JobDispatcher`. Kept separate so recovery cadence is the host's call.
     */
    async reapExpired(limit = 20): Promise<readonly Run[]> {
      return runs.reapExpired({ now: clock(), limit });
    },
  };
};

export type DurableWorker = ReturnType<typeof createDurableWorker>;

/** Re-export for adapters that construct terminal errors from thrown values. */
export { AgentPlatformError };
