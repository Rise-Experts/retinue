/**
 * Run checkpoints — `docs/04-durable-runtime-and-hitl.md` → Durable execution.
 *
 * A checkpoint is the durable snapshot the worker writes as a run streams. It is what lets a page
 * refresh lose no output and a crashed worker recover: a new claim reloads the latest checkpoint,
 * finalizes any tool calls that were mid-flight, and continues from there.
 */

import type { MessagePart } from "../core/content-parts.js";
import type { RunId, ToolCallId } from "../core/ids.js";

/** A tool call the runtime started but has not yet seen complete — reconciled on recovery. */
export type PendingToolCall = {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly startedAt: string;
};

/** Running token/cost totals, checkpointed so a recovered run keeps accounting continuity. */
export type RunUsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMinorUnits: number;
};

export const EMPTY_USAGE_TOTALS: RunUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  costMinorUnits: 0,
};

export type RunCheckpoint = {
  readonly runId: RunId;
  /** Highest event sequence durably persisted. A reconnecting client resumes with `after: sequence`. */
  readonly sequence: number;
  /** Accumulated parts of the assistant message being produced, in order. */
  readonly parts: readonly MessagePart[];
  /** Step index reached in the agent loop, bounded by `ExecutionLimits.maxSteps`. */
  readonly step: number;
  /** Tool calls started but not yet completed. Non-empty after a crash → finalized on recovery. */
  readonly pendingToolCalls: readonly PendingToolCall[];
  readonly usage: RunUsageTotals;
  readonly updatedAt: string;
};

export const emptyCheckpoint = (runId: RunId, updatedAt: string): RunCheckpoint => ({
  runId,
  sequence: 0,
  parts: [],
  step: 0,
  pendingToolCalls: [],
  usage: EMPTY_USAGE_TOTALS,
  updatedAt,
});
