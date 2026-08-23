/**
 * The redaction boundary — AC-5.
 *
 * "No prompt content, message content or credential ever appears in logs" is the failure mode discovered too
 * late: it is found by someone reading a log aggregator, months after the line was added, and by then the data
 * is in a third-party index and a backup.
 *
 * **An allowlist, not a denylist.** This is the whole design. A denylist has to name every field that must not
 * be logged, forever, including the one a colleague adds next month. An allowlist names the fields that may be,
 * and anything else is dropped without being asked about. The failure direction is "an incident is missing a
 * field", not "a prompt is in Datadog".
 *
 * Three properties beyond the list:
 *
 * **Primitives only.** A nested object is where content hides — `{ input: {...} }` on a tool log line is one
 * keystroke from being the whole tool input. An object value is dropped even if its key is allowlisted.
 *
 * **Strings are bounded.** An allowlisted key can still be *handed* content: nothing stops a caller passing
 * prose as `toolName`. A short cap means the leak is a truncated fragment rather than a document, and a value
 * that hits the cap is visibly truncated, which is how someone notices the bug.
 *
 * **A dropped field is reported, not silent.** `redactFields` returns what it removed so the logger can emit
 * `telemetry.fields-dropped`. Silent dropping turns redaction into invisible data loss, and the person
 * debugging finds an empty field rather than an explanation.
 */

import type { AttributeValue } from "./index.js";

/**
 * The fields any log line or span may carry.
 *
 * Ids, names from closed sets, counts, durations, and classified codes. Nothing whose value is authored by a
 * user or a model. Read the list as the answer to "what can this platform tell you about a failure?" — if it is
 * not here, the answer is a metric or a trace, not a log field.
 */
export const LOG_FIELD_ALLOWLIST: readonly string[] = [
  // Correlation. Also present on the record's `context`; allowed here so a line about a *different* run than
  // the bound one can name it.
  "tenantId",
  "conversationId",
  "runId",
  "principalId",
  "requestId",
  "traceId",
  "spanId",
  "interactionId",
  "jobId",
  "workerId",

  // What happened, from closed sets
  "status",
  "outcome",
  "decision",
  "reason",
  "eventType",
  "partType",
  "riskCategory",
  "toolName",
  "modelId",
  "providerId",
  "agentId",
  "skillId",
  "graderId",
  "sourceType",
  "period",

  // Classified failures. A *code*, never a message.
  "errorCode",
  "retryable",
  "attempt",
  "maxAttempts",

  // Numbers
  "durationMs",
  "waitMs",
  "latencyMs",
  "queueDepth",
  "count",
  "sequence",
  "stepCount",
  "toolCallCount",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "costMinorUnits",
  "currency",
  "byteSize",
  "version",
  "expectedVersion",
  "limit",
  "chunkCount",
  "resultCount",
  "score",
] as const;

const ALLOWED = new Set(LOG_FIELD_ALLOWLIST);

/**
 * The cap on a string field.
 *
 * 120 characters: comfortably longer than every id, model name and error code in the list, and far shorter than
 * a prompt, a message or a signed URL. Deliberately not generous — the cap is a *bound on a leak*, and a
 * generous bound is a leak.
 */
export const MAX_FIELD_LENGTH = 120;
export const TRUNCATION_MARKER = "…[truncated]";

export type Redacted = {
  readonly fields: Readonly<Record<string, AttributeValue>>;
  /** The keys that were removed, so the caller can say so. Names only — never the values. */
  readonly dropped: readonly string[];
};

export const redactFields = (input: Readonly<Record<string, unknown>> | undefined): Redacted => {
  if (input === undefined) return { fields: {}, dropped: [] };
  const fields: Record<string, AttributeValue> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key)) {
      dropped.push(key);
      continue;
    }
    if (typeof value === "number") {
      // NaN and Infinity serialize as `null` in JSON, which reads as "no value" rather than "a bad value".
      if (!Number.isFinite(value)) {
        dropped.push(key);
        continue;
      }
      fields[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      fields[key] = value;
      continue;
    }
    if (typeof value === "string") {
      fields[key] =
        value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}${TRUNCATION_MARKER}` : value;
      continue;
    }
    // Everything else — objects, arrays, functions, null, undefined, symbols, bigint. An object is dropped even
    // under an allowlisted key, because the key says nothing about what a nested value contains.
    dropped.push(key);
  }

  return { fields, dropped };
};

/**
 * A log record as a single line of JSON.
 *
 * Serialized here rather than by the sink, so every sink emits the same shape and the redaction cannot be
 * bypassed by a sink that formats the record itself. The context is spread at the top level, because a query
 * for `runId:...` in a log aggregator should not need to know it is nested.
 */
export const formatLogLine = (record: {
  readonly level: string;
  readonly event: string;
  readonly at: string;
  readonly context: Readonly<Record<string, string | undefined>>;
  readonly fields: Readonly<Record<string, AttributeValue>>;
}): string => {
  const flat: Record<string, AttributeValue> = { at: record.at, level: record.level, event: record.event };
  for (const [key, value] of Object.entries(record.context)) if (value !== undefined) flat[key] = value;
  // Fields last, but they cannot overwrite `event` or `level`: a field named `event` would make a line claim to
  // be a different event than the one that was logged, which is the one lie a log must not be able to tell.
  for (const [key, value] of Object.entries(record.fields))
    if (key !== "at" && key !== "level" && key !== "event") flat[key] = value;
  return JSON.stringify(flat);
};
