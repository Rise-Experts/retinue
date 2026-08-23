/**
 * Every log line's name — the structural half of AC-5.
 *
 * A logger whose message is a `string` can be handed a prompt. Not by anyone careless: by someone debugging an
 * incident at midnight who needs to see what the model was asked, ships it, and never removes it. A redaction
 * denylist does not help, because the content is in the *message*, which a denylist cannot inspect without
 * pattern-matching prose.
 *
 * So the message is a closed union of literals. A caller **cannot** put content in it — there is no string
 * parameter to put it in. Adding a log line means adding a name here, which is a reviewed act in a file whose
 * whole purpose is visible from its first line. That is the difference between a rule and a mechanism.
 *
 * Named after what happened, in past tense, so a log is readable as a sequence of facts.
 */
export const LOG_EVENTS = [
  // Request and admission
  "request.received",
  "request.completed",
  "request.rejected",
  "run.admitted",
  "run.refused-quota",
  "run.refused-authorization",

  // Queue
  "run.enqueued",
  "run.enqueue-failed",
  "run.claimed",
  "run.claim-contended",
  "run.lease-expired",
  "run.reaped",
  "run.reap-failed",

  // Execution
  "run.started",
  "run.checkpointed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.retry-scheduled",
  "run.handler-threw",

  // Model and tools
  "model.called",
  "model.failed",
  "tool.called",
  "tool.failed",
  "tool.denied",

  // Human in the loop
  "approval.requested",
  "approval.decided",
  "question.requested",
  "question.answered",

  // Process lifecycle
  "worker.started",
  "worker.draining",
  "worker.stopped",

  // Telemetry's own faults. A dropped field must be visible, or redaction becomes a silent data loss that
  // nobody notices until an incident needs the field that was being dropped.
  "telemetry.fields-dropped",
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];
