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

import type { ErrorPart, Message } from "../core/content-parts.js";
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
import type { CheckpointStore, MessageStore, RunStore } from "../persistence/index.js";
import type { UsageRecorder } from "../usage/index.js";
import type { RunCheckpoint } from "./checkpoint.js";
import { type DistributedLockStore, type Run } from "./index.js";
import { isTerminal } from "./index.js";
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
  /**
   * Records the assistant's turn when a run reaches a terminal state — #157.
   *
   * Optional, because a host that reads history from the event log instead does not need it. Supply it and the
   * next run's `loadHistory` sees what the assistant said; leave it out and the agent has amnesia between runs
   * unless the host reconstructs the turn itself. That reconstruction was the gap: `MessageStore` was
   * read-only, so the user's turn was persisted and the assistant's never was, and every host had to fold the
   * event log to paper over the asymmetry.
   *
   * Writes are idempotent on a message id derived from the run id, so a resumed run that completes after a
   * restart records one turn, not two.
   */
  readonly messages?: MessageStore;
};

export type ProcessOutcome = "completed" | "failed" | "cancelled" | "skipped" | "lost" | "paused";

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
    /**
     * A run whose context cannot be built is **failed**, not retried — #172.
     *
     * `buildContext` throwing escaped `drive` entirely: the try that marks a run failed starts after the engine
     * begins, so the run stayed `running`, its lease expired, the reaper re-claimed it, and it threw again.
     * Forever. Seen in the wild the moment `buildContext` started refusing runs with no recorded principal
     * (#164): every pre-#164 run became an unkillable reap loop, reported once per sweep and never resolved.
     *
     * Failed rather than retried because this class of error is **deterministic by construction**. The host is
     * saying it cannot construct an identity for this run; the next attempt has exactly the same run row and will
     * say the same thing. A transient failure fetching a checkpoint is different, and stays inside the retry
     * path below — this covers only the host's own refusal.
     *
     * A failed run is visible: it has a status, an error, and a place in the UI. An eternally-reaped one is a log
     * line nobody reads.
     */
    let context: ExecutionContext;
    try {
      context = await deps.buildContext(run);
    } catch (thrown) {
      const error = toPlatformError(thrown);
      const failed = await runs.transition({ tenantId, id: run.id, workerId, to: "failed", now: clock(), error });
      // The event too, so a client watching this run learns why rather than waiting on a stream that never ends.
      if (deps.eventLog) {
        await deps.eventLog
          .append({
            tenantId,
            event: { type: "run.failed", runId: run.id, sequence: 1, occurredAt: clock(), error },
          })
          .catch(() => undefined);
      }
      return { run: failed, outcome: "failed" };
    }
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

    /**
     * Record the assistant's turn — #157. Called on every terminal exit, and only there.
     *
     * `isTerminal` is the gate rather than a check for "completed", because a run that failed or was cancelled
     * still streamed text the user read; dropping it would show them a reply that vanishes on reload. The
     * paused states are excluded by construction: `waiting-for-approval` and `waiting-for-question` transition
     * back to `queued`, so they are not terminal, and writing there would be worse than not writing at all —
     * the id is derived from the run, so the partial turn would win and the completed one would be discarded
     * as a duplicate.
     */
    const persistAssistantTurn = async (status: Run["status"]): Promise<void> => {
      if (deps.messages === undefined || !isTerminal(status)) return;
      if (state.parts.length === 0) return;
      /**
       * No conversation, nothing to persist the turn to — #198.
       *
       * A no-op rather than a throw, and the distinction matters: one runtime serves both a chat assistant and a
       * headless automation, so a run without a conversation is a *fact about that run*, not a wiring mistake.
       * Throwing here would make an automation fail at the end of successful work.
       *
       * What must still fail loudly is a caller *asking* for conversation-scoped data on such a run — that is a
       * programming error, and `conversationScoped` below is where it is refused.
       */
      if (run.conversationId === undefined) return;
      const message: Message = {
        // The same id the client already saw on every `part.added`. A second convention here would mean the
        // streamed message and the persisted row disagreed about their own identity, so a client that kept the
        // streamed id could never match it to the row it later loads from history.
        id: deriveRunMessageId(run.id) as MessageId,
        conversationId: run.conversationId,
        runId: run.id,
        role: "assistant",
        parts: state.parts,
        createdAt: clock(),
      };
      await deps.messages.append({ tenantId, message });
    };

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

    /** True once a keepalive reported the claim gone; the loop below turns this into a ClaimLostError. */
    let claimLost = false;

    const beat = async (): Promise<void> => {
      lastKeepalive = now();
      const alive = await runs.keepalive({ tenantId, id: run.id, workerId, leaseMs, now: clock() });
      if (!alive) {
        claimLost = true;
        return;
      }
      const fresh = await runs.findById({ tenantId, id: run.id });
      if (fresh?.cancelRequestedAt !== undefined) cancelRequested = true;
    };

    const heartbeat = async (): Promise<void> => {
      if (claimLost) throw new ClaimLostError();
      if (now() - lastKeepalive < keepaliveEveryMs) return;
      await beat();
      if (claimLost) throw new ClaimLostError();
    };

    /**
     * A timer-based heartbeat for the duration of the run, independent of engine events (#107 AC-5).
     *
     * `heartbeat()` above runs after each event, which keeps a tool-*heavy* run alive — many short
     * tools, an event between each. It does nothing for a *single* long tool call: while the engine
     * awaits one tool it yields nothing, so nothing calls keepalive, and a tool slower than the lease
     * loses its claim. The run is then reaped and re-executed while the first call is still in flight,
     * which for a slow external write is exactly the duplicate the lease exists to prevent.
     *
     * This is the one place #107 adds behaviour rather than wiring what exists. AC-5 cannot be
     * satisfied by composition, because nothing outside the run's own loop knows the run is alive.
     *
     * A failed keepalive sets `claimLost` rather than throwing: an unhandled rejection from a timer
     * would take the process down, and the loop below is where losing a claim is already handled.
     */
    const startTimerHeartbeat = (): (() => void) => {
      const timer = setInterval(() => {
        if (claimLost) return;
        // Skipped when an event-driven beat happened recently, so a busy run does not double its
        // keepalive traffic.
        if (now() - lastKeepalive < keepaliveEveryMs) return;
        void beat().catch(() => {
          // A failed round trip is not proof the claim is gone, so it is not treated as loss here;
          // the next beat, or the event-driven one, will find out.
        });
      }, Math.max(1, keepaliveEveryMs));
      timer.unref?.();
      return () => clearInterval(timer);
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
    /**
     * Whether there is prior *work* to resume from — not merely a prior event (#170).
     *
     * This read `state.sequence > 0`, which was true exactly when the log held something. That worked while the
     * only things in the log were the worker's own events, and became wrong the moment admission started
     * emitting `run.queued`: every fresh run would arrive with sequence 1 and be handed a "resume checkpoint"
     * containing nothing but the fact that it was queued.
     *
     * Parts and pending tool calls are the honest predicate, because they are what a resume *uses*: the engine
     * replays from the checkpoint's parts and finalizes its dangling calls. A run that was claimed and died
     * before producing either has nothing to resume from, and passing null says so.
     */
    const recovered = state.parts.length > 0 || state.pendingToolCalls.length > 0;

    // A re-claimed run may carry dangling tool calls (from the checkpoint or the reconciled log).
    // Finalize them once, before the engine resumes, so it observes them as failed and never re-fires.
    if (state.pendingToolCalls.length > 0) await finalizePending();

    // Started before the engine runs and stopped in the `finally` below, so the lease is held for the
    // whole of the run rather than only across event boundaries.
    const stopTimerHeartbeat = startTimerHeartbeat();
    try {
      const started = await runs.transition({ tenantId, id: run.id, workerId, to: "running", now: clock() });
      await emit({ type: "run.started" });
      await persist();

      const signal: CancellationSignal = { isCancelled: () => cancelRequested };
      const iterable = engine.run({ run: started, context, resume: recovered ? toCheckpoint() : null, signal });

      // A run pauses (rather than completes) when the engine requests a question/approval and ends.
      let pause: "waiting-for-question" | "waiting-for-approval" | null = null;
      for await (const body of iterable) {
        await emit(body);
        await persist(); // durable before the engine proceeds (tool.started) / between retry attempts
        /**
         * `run.checkpointed`, at tool boundaries — #170.
         *
         * The event type was specified in `docs/04` and in `RUN_EVENT_TYPES`, and nothing emitted it. What
         * "checkpointed" should *mean* was the open question, since `persist()` runs on every engine event and an
         * event per text delta would double the stream to say nothing.
         *
         * Tool boundaries, because that is what the checkpoint above exists for — its own comment says
         * "durable before the engine proceeds (tool.started)". A crash mid-tool is the case where durability is
         * load-bearing, so "your progress through this tool is saved" is the signal a client can act on. The
         * cadence is a judgement; the alternatives were one per event (noise) or none (what we had).
         */
        if (body.type === "tool.started" || body.type === "tool.completed" || body.type === "tool.failed") {
          // The event carries its own sequence, stamped by `emit` — no payload needed.
          await emit({ type: "run.checkpointed" });
        }
        if (body.type === "question.requested") pause = "waiting-for-question";
        else if (body.type === "approval.requested") pause = "waiting-for-approval";
        else if (body.type === "question.answered" || body.type === "approval.decided") pause = null;
        await heartbeat(); // throttled; runs on every event so a tool-heavy run keeps its lease alive
        if (cancelRequested) break;
      }

      if (cancelRequested) {
        await finalizePending();
        const cancelled = await runs.transition({ tenantId, id: run.id, workerId, to: "cancelled", now: clock() });
        await emit({ type: "run.cancelled" });
        await persist();
        await persistAssistantTurn("cancelled");
        return { run: cancelled, outcome: "cancelled" };
      }

      if (pause) {
        // Paused for human input: persist and release the claim so a continuation can re-claim it.
        // Pending tool calls are NOT finalized — nothing was interrupted; the run is waiting.
        await persist();
        const paused = await runs.transition({ tenantId, id: run.id, workerId, to: pause, now: clock() });
        return { run: paused, outcome: "paused" };
      }

      await finalizePending();
      const completed = await runs.transition({ tenantId, id: run.id, workerId, to: "completed", now: clock() });
      await emit({ type: "run.completed" });
      await persist();
      await persistAssistantTurn("completed");
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
      await persistAssistantTurn("failed");
      return { run: failed, outcome: "failed" };
    } finally {
      // Every exit path: completed, paused, failed, claim lost, or a throw from the engine. A timer
      // left running would keep renewing the lease on a run this worker is no longer driving.
      stopTimerHeartbeat();
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
