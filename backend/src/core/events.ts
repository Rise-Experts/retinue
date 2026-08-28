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
  /**
   * The run needs a connection, and here is where to go and get one — task #264.
   *
   * Carries the provider, the scopes being asked for and a login URL. It carries **no secret**: not the client
   * secret, not a token, not the PKCE verifier. This is an event a client renders and a person clicks.
   */
  "connection.requested",
  "connection.completed",
  "usage.updated",
  "context.compacted",
  "guardrail.verdict",
  "catalog.truncated",
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
  /**
   * The tool that actually ran, when the model called `execute_tool` — task #210.
   *
   * Absent on `tool.started`, because at that point nothing has resolved the target yet. Present on completion
   * and failure, where it is the difference between an audit trail that names an action and one that names a
   * mechanism.
   */
  readonly ranToolName?: string;
};

export type InteractionEvent = EventBase<
  "question.requested" | "question.answered" | "approval.requested" | "approval.decided"
> & {
  readonly interactionId: InteractionId;
};

/**
 * The run needs a connection, and here is where to get one — task #264.
 *
 * Its own event rather than an `InteractionEvent`, because it carries different things: an interaction id names
 * a stored question or approval, and this names a *provider*, the scopes being asked for, and a URL. Folding it
 * in would mean an `interactionId` for something that is not one.
 *
 * **It carries no secret.** Not the client secret, not a token, not the PKCE verifier. This is rendered in a UI
 * and clicked by a person, so it goes wherever a screenshot goes.
 */
export type ConnectionRequestedEvent = EventBase<"connection.requested"> & {
  readonly provider: string;
  /** Where to send the person. Single-use and TTL-bounded — see the OAuth flow's `state`. */
  readonly loginUrl: string;
  /** What the consent will ask for, so a UI can say what is being granted. */
  readonly scopes: readonly string[];
  /** Which tool stalled, so a transcript reads coherently. */
  readonly toolName?: string;
  /** When the login URL stops working, so a client can offer a fresh one rather than a dead link. */
  readonly expiresAt: string;
};

export type ConnectionCompletedEvent = EventBase<"connection.completed"> & {
  readonly provider: string;
  readonly connectionId: string;
};

export type UsageUpdatedEvent = EventBase<"usage.updated"> & {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMinorUnits?: number;
  /** When present, the worker records a durable `UsageEvent` for this realized step. */
  readonly modelId?: string;
  readonly cachedInputTokens?: number;
  /** Tokens written into a prompt cache — task #247. Absent means the provider reported no breakdown. */
  readonly cacheWriteTokens?: number;
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

/**
 * What a guardrail concluded — REQ-046 (#205).
 *
 * Emitted for every verdict, including a pass, because "no guardrail ran" and "a guardrail ran and allowed it"
 * are different facts and an incident review needs to tell them apart.
 *
 * **Carries no inspected value, ever.** `what` names fields or entity types; the content that was redacted is
 * precisely what must not travel into an event log, a trace, or a support ticket — otherwise the audit trail
 * becomes the leak it exists to record.
 */
export type GuardrailVerdictEvent = EventBase<"guardrail.verdict"> & {
  readonly guardrail: string;
  readonly subject: "input" | "message" | "tool-call" | "tool-result";
  readonly outcome: "pass" | "redacted" | "refused";
  /** For a redaction: the fields or entity types touched. Never their contents. */
  readonly what?: readonly string[];
  /** For a refusal. */
  readonly code?: string;
  /** True when the guardrail threw and was therefore treated as a refusal. */
  readonly threw?: boolean;
};

/**
 * A catalogue did not fit its budget, and what was left out — REQ-045 (#204), task #210, AC-3 and AC-5.
 *
 * This event *is* the guarantee. A truncated tool list is invisible from inside a run: the model is not told a
 * tool was withheld, so it never calls it, and the transcript reads exactly like a run where the model chose
 * not to. Every other failure at least looks like a failure; this one looks like a decision. So the names go in
 * the log, in full, and #210's AC-7 is a test that deleting this event fails the build.
 *
 * Names, not a count. "14 tools were dropped" tells a reader that something happened and nothing about whether
 * it mattered; `github_merge_pull_request` tells them immediately.
 */
export type CatalogTruncatedEvent = EventBase<"catalog.truncated"> & {
  /**
   * Which catalogue. One event rather than two, because the fact is the same fact and a reader asking "what was
   * withheld from this turn" should not have to know there are two mechanisms.
   */
  readonly catalog: "tools" | "skills";
  readonly budgetTokens: number;
  readonly residentTokens: number;
  /** Every dropped tool, by name. */
  readonly dropped: readonly string[];
  /**
   * Whether the model can still get to what was dropped.
   *
   * `find_tools` makes a truncated tool catalogue a *deferral*; without it the same event describes a permanent
   * removal, and a reader cannot tell which from the names alone. There is no `find_skills`, so a truncated
   * skill catalogue is always `false` today — which is a fact worth having in the log rather than a field to
   * leave off.
   */
  readonly findable: boolean;
  /**
   * Set when the protected set alone exceeds the budget — a misconfiguration, not the mechanism working.
   *
   * A deployment in this state believes it capped its context and has not.
   */
  readonly overBudget?: boolean;
};

export type RunEvent =
  | RunLifecycleEvent
  | RunFailedEvent
  | RunRetryPendingEvent
  | PartEvent
  | ToolEvent
  | InteractionEvent
  | ConnectionRequestedEvent
  | ConnectionCompletedEvent
  | UsageUpdatedEvent
  | ContextCompactedEvent
  | GuardrailVerdictEvent
  | CatalogTruncatedEvent;

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
  /**
   * Present while the run is waiting for somebody to connect a provider — task #264.
   *
   * On the stream state rather than as a message part, because it is not a thing the model said: it is the
   * platform telling a client *this run is stopped and here is the way to unstick it*. Cleared by
   * `connection.completed`, so a client that reconnects mid-consent still sees the button and one that
   * reconnects after it does not.
   */
  readonly connectionRequest?: {
    readonly provider: string;
    readonly loginUrl: string;
    readonly scopes: readonly string[];
    readonly toolName?: string;
    readonly expiresAt: string;
  };
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
    /**
     * The connection request, held until consent completes — task #264.
     *
     * Set and cleared here rather than derived by each client, so a reconnecting client sees the button exactly
     * when the run is actually waiting: the durable log replays both events in order, and the fold gives the
     * same answer as if it had been watching live.
     */
    case "connection.requested":
      return {
        ...base,
        connectionRequest: {
          provider: event.provider,
          loginUrl: event.loginUrl,
          scopes: event.scopes,
          ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
          expiresAt: event.expiresAt,
        },
      };
    case "connection.completed":
      return { ...base, connectionRequest: undefined };
    case "run.failed":
      // Cleared: a failed run's login URL is a button that leads nowhere.
      return { ...base, connectionRequest: undefined, error: event.error, terminal: true };
    case "run.completed":
    case "run.cancelled":
      return { ...base, connectionRequest: undefined, terminal: true };
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
