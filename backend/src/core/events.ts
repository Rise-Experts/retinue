/**
 * Transport events — `docs/04-durable-runtime-and-hitl.md`.
 *
 * Transports map these to GraphQL subscriptions, SSE or another channel without
 * changing runtime semantics. Events carry a monotonic sequence per run so a client
 * can resume from a cursor after reconnecting.
 */

import type { MessagePart } from "./content-parts.js";
import type { PlatformError } from "./errors.js";
import type { InteractionId, MessageId, RunId, TenantId, ToolCallId } from "./ids.js";

export const RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.checkpointed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.retry-pending",
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

/**
 * Emitted when a transient failure triggers a retry (see docs/04 → Retry policy).
 * Carries enough for a client to render "attempt 2 of 5, retrying in ~3s (rate limited)"
 * rather than only showing the `retry-pending` status.
 */
export type RunRetryPendingEvent = EventBase<"run.retry-pending"> & {
  readonly attempt: number;
  readonly maxAttempts: number;
  /** When the next attempt is scheduled, honoring any `retry-after` the provider returned. */
  readonly nextAttemptAt: string;
  /** The transient error that triggered the retry. */
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
  /** When present, the worker records a durable `UsageEvent` for this realized step. */
  readonly modelId?: string;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  /**
   * Non-text input this step carried — #185 AC-4.
   *
   * On the event, not only in the cost, so the ledger can say *why* a step cost what it did. A multimodal turn
   * and a text turn that happened to price the same are otherwise indistinguishable after the fact, which makes
   * a pricing mistake invisible.
   */
  readonly imageCount?: number;
  readonly audioSeconds?: number;
  readonly currency?: string;
  /** Stable per-step id so recording is idempotent across a recovery. */
  readonly stepId?: string;
};

export type ContextCompactedEvent = EventBase<"context.compacted"> & {
  readonly droppedParts: number;
  readonly tokensReclaimed: number;
};

export type RunEvent =
  | RunLifecycleEvent
  | RunFailedEvent
  | RunRetryPendingEvent
  | PartEvent
  | ToolEvent
  | InteractionEvent
  | UsageUpdatedEvent
  | ContextCompactedEvent;

/** Fan-out port. Adapters: Supabase Realtime, Redis pub/sub, in-memory for tests. */
export interface RealtimePublisher {
  publish(channel: string, event: RunEvent): Promise<void>;
}

/**
 * Durable, append-only per-run event log — the catch-up half of reconnect. Every event the worker
 * publishes is also appended here; a reconnecting client reads everything after its cursor. Ordering
 * is by the monotonic `sequence`, so replay is deterministic and gap-free. Adapters: Postgres,
 * Redis list (Twenty's pattern), in-memory for tests.
 */
export interface RunEventLog {
  append(input: { readonly tenantId: TenantId; readonly event: RunEvent }): Promise<void>;
  /** Events with `sequence > after`, ascending. `after: 0` returns the whole run. */
  listAfter(input: {
    readonly tenantId: TenantId;
    readonly runId: RunId;
    readonly after: number;
    readonly limit?: number;
  }): Promise<readonly RunEvent[]>;
  latestSequence(input: { readonly tenantId: TenantId; readonly runId: RunId }): Promise<number>;
}

/** A tool call started but not yet resolved, tracked while projecting a run's event stream. */
export type StreamPendingToolCall = {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly startedAt: string;
};

/**
 * The deterministic projection of a run's event stream: the assistant message parts plus the
 * accounting/interaction state a client needs to render. It is a pure fold over `RunEvent`s, so the
 * server (worker checkpoint) and any client rebuild identical state from the same events — the
 * single source of truth that makes reconnect produce no missing or duplicated parts.
 */
export type RunStreamState = {
  readonly parts: readonly MessagePart[];
  readonly pendingToolCalls: readonly StreamPendingToolCall[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costMinorUnits: number };
  /** Highest sequence folded in. Use as the reconnect cursor. */
  readonly sequence: number;
  readonly lastEventType?: RunEventType;
  /** Present between retry attempts, cleared as soon as the run makes progress again. */
  readonly retry?: { readonly attempt: number; readonly maxAttempts: number; readonly nextAttemptAt: string };
  readonly error?: PlatformError;
  readonly terminal: boolean;
};

export const EMPTY_RUN_STREAM_STATE: RunStreamState = {
  parts: [],
  pendingToolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0, costMinorUnits: 0 },
  sequence: 0,
  terminal: false,
};

/** Fold one event into the projection. Pure; ignores events with a sequence already folded. */
export const reduceRunEvent = (state: RunStreamState, event: RunEvent): RunStreamState => {
  if (event.sequence <= state.sequence && state.sequence > 0) return state; // idempotent replay
  const base: RunStreamState = {
    ...state,
    sequence: event.sequence,
    lastEventType: event.type,
    // Any forward progress clears a pending retry banner.
    ...(event.type === "run.retry-pending" ? {} : { retry: undefined }),
  };
  switch (event.type) {
    case "part.added":
      return { ...base, parts: [...state.parts, event.part] };
    case "part.updated": {
      const exists = state.parts.some((p) => p.id === event.part.id);
      return {
        ...base,
        parts: exists
          ? state.parts.map((p) => (p.id === event.part.id ? event.part : p))
          : [...state.parts, event.part],
      };
    }
    case "tool.started":
      return {
        ...base,
        pendingToolCalls: [
          ...state.pendingToolCalls,
          { toolCallId: event.toolCallId, toolName: event.toolName, startedAt: event.occurredAt },
        ],
      };
    case "tool.completed":
    case "tool.failed":
      return { ...base, pendingToolCalls: state.pendingToolCalls.filter((t) => t.toolCallId !== event.toolCallId) };
    case "usage.updated":
      return {
        ...base,
        usage: {
          inputTokens: state.usage.inputTokens + event.inputTokens,
          outputTokens: state.usage.outputTokens + event.outputTokens,
          costMinorUnits: state.usage.costMinorUnits + (event.costMinorUnits ?? 0),
        },
      };
    case "run.retry-pending":
      return {
        ...base,
        retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, nextAttemptAt: event.nextAttemptAt },
      };
    case "run.failed":
      return { ...base, error: event.error, terminal: true };
    case "run.completed":
    case "run.cancelled":
      return { ...base, terminal: true };
    default:
      return base;
  }
};

/** Project a full (or partial) event sequence into `RunStreamState`. */
export const reduceRunEvents = (
  events: Iterable<RunEvent>,
  initial: RunStreamState = EMPTY_RUN_STREAM_STATE,
): RunStreamState => {
  let state = initial;
  for (const event of events) state = reduceRunEvent(state, event);
  return state;
};
