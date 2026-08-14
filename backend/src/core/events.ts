/**
 * Transport events — `docs/04-durable-runtime-and-hitl.md`.
 *
 * Transports map these to GraphQL subscriptions, SSE or another channel without
 * changing runtime semantics. Events carry a monotonic sequence per run so a client
 * can resume from a cursor after reconnecting.
 */

import type { MessagePart } from "./content-parts.js";
import type { PlatformError } from "./errors.js";
import type { InteractionId, MessageId, RunId, ToolCallId } from "./ids.js";

export const RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.checkpointed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "part.added",
  "part.updated",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "question.requested",
  "question.answered",
  "approval.requested",
  "approval.decided",
  "usage.updated",
  "context.compacted",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

type EventBase<T extends RunEventType> = {
  readonly type: T;
  readonly runId: RunId;
  /** Monotonic per run. Clients resume with `after: sequence`. */
  readonly sequence: number;
  readonly occurredAt: string;
};

export type RunLifecycleEvent = EventBase<
  "run.queued" | "run.started" | "run.checkpointed" | "run.completed" | "run.cancelled"
>;

export type RunFailedEvent = EventBase<"run.failed"> & {
  readonly error: PlatformError;
};

export type PartEvent = EventBase<"part.added" | "part.updated"> & {
  readonly messageId: MessageId;
  readonly part: MessagePart;
};

export type ToolEvent = EventBase<"tool.started" | "tool.completed" | "tool.failed"> & {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
};

export type InteractionEvent = EventBase<
  "question.requested" | "question.answered" | "approval.requested" | "approval.decided"
> & {
  readonly interactionId: InteractionId;
};

export type UsageUpdatedEvent = EventBase<"usage.updated"> & {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMinorUnits?: number;
};

export type ContextCompactedEvent = EventBase<"context.compacted"> & {
  readonly droppedParts: number;
  readonly tokensReclaimed: number;
};

export type RunEvent =
  | RunLifecycleEvent
  | RunFailedEvent
  | PartEvent
  | ToolEvent
  | InteractionEvent
  | UsageUpdatedEvent
  | ContextCompactedEvent;

/** Fan-out port. Adapters: Supabase Realtime, Redis pub/sub, in-memory for tests. */
export interface RealtimePublisher {
  publish(channel: string, event: RunEvent): Promise<void>;
}
