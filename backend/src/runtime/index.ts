/**
 * Run lifecycle and execution limits — `docs/04-durable-runtime-and-hitl.md`.
 */

import type { PlatformError } from "../core/errors.js";
import type { AgentId, ConversationId, PrincipalId, RunId, TenantId } from "../core/ids.js";

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting-for-question",
  "waiting-for-approval",
  "retry-pending",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The state machine from the specification. A transition absent from this map is a
 * bug, not an undefined behaviour — the worker rejects it rather than guessing.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: [
    "waiting-for-question",
    "waiting-for-approval",
    "retry-pending",
    "completed",
    "failed",
    "cancelled",
  ],
  "waiting-for-question": ["queued", "cancelled"],
  "waiting-for-approval": ["queued", "cancelled"],
  "retry-pending": ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const canTransition = (from: RunStatus, to: RunStatus): boolean =>
  RUN_TRANSITIONS[from].includes(to);

export const isTerminal = (status: RunStatus): boolean =>
  RUN_TRANSITIONS[status].length === 0;

export type ExecutionLimits = {
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly wallClockTimeoutMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly costCeilingMinorUnits: number;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  /** Beyond this, a tool result is spilled to blob storage and referenced. */
  readonly maxInlineToolOutputBytes: number;
  /**
   * Sampling temperature, when the agent wants to pin it (#160).
   *
   * Optional, because "leave the provider's default alone" is a real and common choice, and a required field
   * would force every agent to invent a number. `0` is meaningful and distinct from absent — a graded run needs
   * to be able to ask for it, which is what the evaluation harness's reproducibility argument rests on.
   */
  readonly temperature?: number;
};

export type Run = {
  readonly id: RunId;
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly agentVersion: number;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: PlatformError;
  /** Identifies the worker holding the claim; used to reap stale streams. */
  readonly claimedBy?: string;
  readonly keepaliveAt?: string;
  /** When the current claim's lease expires. A past value marks the run reclaimable. */
  readonly leaseExpiresAt?: string;
  /** Set when a cancel was requested; the owning worker observes it and stops. Durable so a
   * cancel issued to one process is honored by whichever worker holds the run. */
  readonly cancelRequestedAt?: string;
  /**
   * The caller this run was admitted for — #164.
   *
   * Absent for runs created before this was recorded, and for a caller that did not supply it. That absence is
   * deliberately visible rather than defaulted: `buildContext` substituting an identity is the bug this exists
   * to end, and a default here would move the substitution one layer down where it is harder to see.
   */
  readonly principalId?: PrincipalId;
  readonly roleIds?: readonly string[];
};

/** Durable job enqueue. Adapters: BullMQ, in-memory for tests. */
export interface JobDispatcher {
  /**
   * `traceparent` and `enqueuedAt` are the trace hop (#143).
   *
   * On the port rather than smuggled through a side channel on the adapter, because the alternative was an
   * instrumented wrapper remembering the last span it opened — which is wrong the moment two enqueues overlap,
   * and overlapping enqueues are the normal case. Optional so every existing caller is unaffected and a job
   * already sitting on the queue still runs; a job with no traceparent starts its own trace, which loses a link
   * rather than a run.
   */
  enqueueRun(input: {
    tenantId: TenantId;
    runId: RunId;
    readonly traceparent?: string;
    readonly enqueuedAt?: string;
  }): Promise<void>;
}

/** Atomic claim so two workers never process one run. Adapters: Redis, Postgres. */
export interface DistributedLockStore {
  acquire(key: string, ttlMs: number): Promise<{ released: () => Promise<void> } | null>;
}

export * from "./retry.js";
export * from "./checkpoint.js";
export * from "./worker.js";
export * from "./streaming.js";
export * from "./serialization.js";
