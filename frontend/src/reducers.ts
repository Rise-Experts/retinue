/**
 * Typed-part reducers — `docs/06-graphql-and-frontend.md` → Headless React package.
 *
 * The framework-free core the hooks are built on (and that React Native reuses): fold a run's
 * events into the render state — accumulated parts, status, retry indicator, error. Pair with the
 * `EventBuffer` so out-of-order or replayed events are ordered and de-duplicated first; then this
 * reducer assumes in-order events and never double-applies. Keeping the logic pure is what makes
 * reconnect provably lossless and the hooks trivially testable.
 */

import { createEventBuffer } from "./event-buffer.js";
import type { RetryState } from "./hooks/index.js";
import type { MessagePart, PlatformError, RunEvent, RunEventType, RunStatus } from "./types/index.js";

export type RunView = {
  readonly status: RunStatus | undefined;
  readonly parts: readonly MessagePart[];
  /** Present only between retry attempts; drives the "attempt 2 of 5" indicator. */
  readonly retry: RetryState | undefined;
  readonly error: PlatformError | undefined;
  readonly lastSequence: number;
  readonly done: boolean;
};

export const EMPTY_RUN_VIEW: RunView = {
  status: undefined,
  parts: [],
  retry: undefined,
  error: undefined,
  lastSequence: 0,
  done: false,
};

const STATUS_BY_EVENT: Partial<Record<RunEventType, RunStatus>> = {
  "run.queued": "queued",
  "run.started": "running",
  "run.retry-pending": "retry-pending",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "question.requested": "waiting-for-question",
  "approval.requested": "waiting-for-approval",
  "question.answered": "running",
  "approval.decided": "running",
  // Any forward progress means the run is actively running again (clears retry-pending/waiting).
  "part.added": "running",
  "part.updated": "running",
  "tool.started": "running",
  "tool.completed": "running",
  "tool.failed": "running",
  "usage.updated": "running",
};

const TERMINAL: ReadonlySet<RunEventType> = new Set(["run.completed", "run.failed", "run.cancelled"]);

/** Fold one in-order event into the view. Pure. */
export const applyRunEvent = (view: RunView, event: RunEvent): RunView => {
  const base: RunView = {
    ...view,
    lastSequence: event.sequence,
    status: STATUS_BY_EVENT[event.type] ?? view.status ?? "running",
    // Any event other than a retry-pending clears a stale retry banner.
    retry: event.type === "run.retry-pending" ? view.retry : undefined,
    done: view.done || TERMINAL.has(event.type),
  };
  switch (event.type) {
    case "part.added":
      return { ...base, parts: [...view.parts, event.part] };
    case "part.updated": {
      const exists = view.parts.some((p) => p.id === event.part.id);
      return {
        ...base,
        parts: exists ? view.parts.map((p) => (p.id === event.part.id ? event.part : p)) : [...view.parts, event.part],
      };
    }
    case "run.retry-pending":
      return {
        ...base,
        retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, nextAttemptAt: event.nextAttemptAt, reason: event.error },
      };
    case "run.failed":
      return { ...base, error: event.error };
    default:
      return base;
  }
};

/**
 * Stateful projector combining the ordering buffer with the reducer: push raw (possibly out-of-order
 * or duplicated) events, read the current view. This is exactly what `useRunSubscription` drives.
 */
export const createRunProjector = (fromSequence = 0) => {
  const buffer = createEventBuffer(fromSequence);
  let view: RunView = { ...EMPTY_RUN_VIEW, lastSequence: fromSequence };
  return {
    push(event: RunEvent): RunView {
      for (const ordered of buffer.push(event)) view = applyRunEvent(view, ordered);
      return view;
    },
    view: () => view,
    cursor: () => buffer.lastSequence(),
    pending: () => buffer.pendingCount(),
  };
};

/** Project a whole event list (test/catch-up convenience). */
export const projectRunEvents = (events: Iterable<RunEvent>, fromSequence = 0): RunView => {
  const projector = createRunProjector(fromSequence);
  let view = projector.view();
  for (const event of events) view = projector.push(event);
  return view;
};
