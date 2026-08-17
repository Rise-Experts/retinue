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

/**
 * Start `runId` now if the conversation is free, else enqueue it FIFO. Returns whether it started.
 * The claim-or-enqueue is atomic, so two runs racing to start the same conversation cannot both win,
 * and a run can never slip into an idle-but-unclaimed slot and strand itself.
 */
export const startOrEnqueueRun = async (
  coordinator: ConversationRunCoordinator,
  input: { tenantId: TenantId; conversationId: ConversationId; runId: RunId },
): Promise<"started" | "queued"> => {
  return (await coordinator.claimOrEnqueue(input)).status;
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
