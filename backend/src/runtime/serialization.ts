/**
 * Per-conversation run serialization + turn commit — `docs/13-sessions-and-threads.md`.
 *
 * Runs within one conversation are serialized: at most one is `Running`, the rest queue FIFO, so
 * session-state and message order stay deterministic. A turn reads session state at claim time and
 * commits its state write in the same unit of work that finalizes the run, so state and messages
 * never diverge. The agent binding makes resumption deterministic — a resumed thread runs the same
 * agent, and the same version when pinned.
 */

import type { ConversationId, RunId, TenantId } from "../core/ids.js";
import { AgentPlatformError } from "../core/errors.js";
import type {
  ConversationBinding,
  ConversationRunCoordinator,
  UnitOfWork,
} from "../persistence/index.js";
import type { JobDispatcher } from "./index.js";
import type { RunEventLog } from "../core/events.js";

/**
 * Start `runId` now if the conversation is free, else enqueue it FIFO. Returns whether it started.
 * The claim-or-enqueue is atomic, so two runs racing to start the same conversation cannot both win,
 * and a run can never slip into an idle-but-unclaimed slot and strand itself.
 */
export const startOrEnqueueRun = async (
  coordinator: ConversationRunCoordinator,
  input: {
    tenantId: TenantId;
    /**
     * Absent for a run that belongs to no conversation — #198.
     *
     * Then **no slot is claimed at all**, and the run is admitted directly. The SPEC first proposed a
     * *tenant-level* slot for these; that was wrong and is corrected here. A tenant-level slot would serialise
     * every automation a tenant owns — two unrelated webhooks would queue behind each other for no reason —
     * and the reason there is a conversation slot in the first place is that turns in one conversation have an
     * order a person can see. An automation has no such ordering requirement.
     *
     * Concurrency for these runs is bounded where it should be: the worker's own limits, and quotas.
     */
    conversationId?: ConversationId;
    runId: RunId;
    /**
     * The durable log, so admission is *observable* — #170.
     *
     * `run.queued` was in `RUN_EVENT_TYPES`, mapped to a telemetry span, and mapped by the frontend reducer to
     * the status `queued` — and **nothing emitted it**. So a client subscribing to a run saw nothing at all
     * between sending a message and a worker picking it up: the one moment where "queued" is the only true
     * thing to say, and the state the reducer had a case for could never be reached.
     *
     * Emitted here rather than by each caller because admission is the event. Two hosts emitting their own
     * would be two answers to "when was this queued", and the one that forgot would look like a hang.
     *
     * Optional: a caller with no log still admits runs. Sequence 1 by definition — admission is the first thing
     * that happens to a run, and the worker reconciles from the log before emitting, so its own first event
     * continues from here rather than colliding.
     */
    eventLog?: RunEventLog;
    now?: () => string;
  },
): Promise<"started" | "queued"> => {
  /**
   * A conversation-less run skips the coordinator entirely, and is `started` by definition — there is nothing
   * for it to be queued *behind*. Calling `claimOrEnqueue` with no conversation would mean inventing a slot key,
   * which is the fabricated-identity failure this whole change exists to remove.
   */
  const status =
    input.conversationId === undefined
      ? ("started" as const)
      : (await coordinator.claimOrEnqueue({ ...input, conversationId: input.conversationId })).status;
  if (input.eventLog !== undefined) {
    /**
     * Best-effort, and deliberately so.
     *
     * The run is already admitted by the time this runs; failing the request now would report an error for work
     * that is going to happen anyway, and the caller would retry an admission that cannot be repeated. A missing
     * `run.queued` costs a client one status label. Losing the run costs the answer.
     */
    try {
      await input.eventLog.append({
        tenantId: input.tenantId,
        event: {
          type: "run.queued",
          runId: input.runId,
          sequence: 1,
          occurredAt: (input.now ?? (() => new Date().toISOString()))(),
        },
      });
    } catch {
      // A duplicate sequence means this run was already admitted and logged — a retried request, which is not
      // an error. Any other failure is a lost status label, which is not worth failing admission over.
    }
  }
  return status;
};

/**
 * On a run reaching a terminal state, atomically release the conversation and promote the next queued
 * run, then hand it to the dispatcher. Returns the promoted run, or null when the backlog is empty.
 * Because release+promote is atomic, two runs can never both become active. This is the per-thread
 * mailbox drain that guarantees FIFO execution.
 */
export const advanceConversation = async (
  coordinator: ConversationRunCoordinator,
  dispatcher: JobDispatcher,
  input: { tenantId: TenantId; conversationId: ConversationId; runId: RunId },
): Promise<RunId | null> => {
  const next = await coordinator.releaseAndPromote(input);
  if (next === null) return null;
  await dispatcher.enqueueRun({ tenantId: input.tenantId, runId: next });
  return next;
};

/**
 * The agent version a resumed thread must run. `pinned` keeps the recorded version even when a newer
 * one exists (deterministic continuation); `latest` tracks the newest. Throws if a pinned binding is
 * missing its version — a data error, not a silent fallback.
 */
export const resolveAgentVersionForResume = (
  binding: ConversationBinding,
  latestVersion: number,
): number => {
  if (binding.agentVersionPolicy === "latest") return latestVersion;
  if (binding.agentVersion === undefined)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `Pinned conversation binding for ${binding.conversationId} has no agentVersion`,
      retryable: false,
    });
  return binding.agentVersion;
};

/** One write in a turn commit: `do` performs it, `undo` compensates it if a later step fails. */
export type CommitStep<T> = {
  readonly do: () => Promise<T>;
  readonly undo?: (result: T) => void | Promise<void>;
};

/**
 * Commit a turn's writes together. Every step runs inside the unit of work; if any step throws, the
 * already-applied steps are compensated in reverse — so session state and messages commit
 * all-or-nothing. The Postgres `UnitOfWork` makes this a real transaction; the memory one compensates
 * explicitly. Pass a `UnitOfWork` exposing `runTx` (the memory/Postgres adapters do) to get rollback.
 */
export const commitTurn = async (
  uow: UnitOfWork & { runTx<T>(fn: (tx: { onRollback(c: () => void | Promise<void>): void }) => Promise<T>): Promise<T> },
  steps: ReadonlyArray<CommitStep<unknown>>,
): Promise<void> => {
  await uow.runTx(async (tx) => {
    for (const step of steps) {
      const result = await step.do();
      if (step.undo) tx.onRollback(() => step.undo!(result));
    }
  });
};
