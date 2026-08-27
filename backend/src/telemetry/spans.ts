/**
 * Span names — AC-2: "spans align with the existing run event types, so traces and event history correspond".
 *
 * The alignment is a **total map keyed by `RunEventType`**, so adding an event type without deciding on its span
 * is a compile error. A `Record<string, string>` here would let a new event type land with no span and the
 * mismatch would only be found by someone comparing a trace against an event log during an incident — which is
 * exactly when they can least afford to.
 *
 * Names follow the event names, which is not laziness: an operator holding a trace and an event history is
 * matching them by eye, and a span called `agent.inference` next to a `model.called` event costs a lookup every
 * time. The same word means the same thing in both places.
 */

import { RUN_EVENT_TYPES, type RunEventType } from "../core/events.js";

/**
 * Every run event's span name.
 *
 * Several events map to the *same* span deliberately — `part.added` and `part.updated` are both activity within
 * a run, not boundaries worth their own span, and a span per streamed part would produce thousands per run and
 * bury the ones that matter. They still get a span *name* rather than being excluded, because "this event has
 * no span" is a decision that must be visible, and an omission looks identical to an oversight.
 */
export const SPAN_FOR_RUN_EVENT: Readonly<Record<RunEventType, string>> = {
  "run.queued": "run.enqueue",
  "run.started": "run.execute",
  "run.checkpointed": "run.checkpoint",
  "run.completed": "run.execute",
  "run.failed": "run.execute",
  "run.cancelled": "run.execute",
  "run.retry-pending": "run.retry",
  "part.added": "run.step",
  "part.updated": "run.step",
  "tool.started": "tool.call",
  "tool.completed": "tool.call",
  "tool.failed": "tool.call",
  "question.requested": "hitl.question",
  "question.answered": "hitl.question",
  "approval.requested": "hitl.approval",
  "approval.decided": "hitl.approval",
  "usage.updated": "run.step",
  "context.compacted": "context.compact",
  // Its own span, not `run.step`: a guardrail verdict is the boundary of a decision somebody will need to find
  // later — "what stopped this turn" is the question a trace gets opened to answer.
  "guardrail.verdict": "guardrail.inspect",
};

/**
 * The spans that are *not* run events.
 *
 * The request and the claim have no event type — a run event exists once there is a run, and these happen
 * before or around that. Listed here so the full set of span names has one home; a name invented at a call site
 * is a name nothing can check.
 */
export const BOUNDARY_SPANS = {
  /** The inbound GraphQL operation. `server` kind — the root of the trace. */
  request: "http.request",
  /** Quota and authorization, before anything is claimed or enqueued. */
  admission: "run.admit",
  /** The producer side of the queue. Where the `traceparent` is written into the job. */
  enqueue: "run.enqueue",
  /** The consumer side. Where the `traceparent` is read back and the trace continues. */
  claim: "run.claim",
  /** One model call. */
  model: "model.call",
  /** One tool call. */
  tool: "tool.call",
  /** Waiting for a human. Often the longest span in a trace, and the one an operator most wants to see. */
  approvalWait: "hitl.approval",
} as const;

export type BoundarySpan = (typeof BOUNDARY_SPANS)[keyof typeof BOUNDARY_SPANS];

/** Every span name the platform emits. Used by the test that asserts the two sets agree. */
export const ALL_SPAN_NAMES: readonly string[] = [
  ...new Set([...Object.values(SPAN_FOR_RUN_EVENT), ...Object.values(BOUNDARY_SPANS)]),
];

/**
 * The span a run event belongs to.
 *
 * A function rather than direct map access, so a caller holding a `RunEventType` from a store — where the type
 * is a string at runtime — cannot index into `undefined` and produce a span named "undefined".
 */
export const spanForRunEvent = (type: string): string | null =>
  (RUN_EVENT_TYPES as readonly string[]).includes(type)
    ? SPAN_FOR_RUN_EVENT[type as RunEventType]
    : null;
