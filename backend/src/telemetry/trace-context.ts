/**
 * W3C trace context — the wire format that makes AC-1 possible.
 *
 * A run is enqueued by the API host and executed by a worker in a different process, possibly minutes later.
 * The only thing that can join them into one trace is a `traceparent` travelling in the job payload, so this is
 * the parsing and formatting of that string and nothing else.
 *
 * Chosen over a bespoke correlation id because the format is what every collector already understands. A
 * home-grown id would work exactly as well right up to the point a customer pointed their own tooling at it,
 * which is AC-6.
 */

/** Only version 00 exists. A future version must be *ignored*, not guessed at — see `parseTraceparent`. */
export const TRACEPARENT_VERSION = "00";

export const TRACE_ID_LENGTH = 32;
export const SPAN_ID_LENGTH = 16;

/**
 * The sampled bit, as W3C defines it.
 *
 * A number rather than a boolean because the field is a bitfield and only bit 0 is assigned; keeping it numeric
 * means an unrecognised flag survives a round trip instead of being flattened to false by us.
 */
export type TraceFlags = number;
export const TRACE_FLAG_SAMPLED = 0x01;

const INVALID_TRACE_ID = "0".repeat(TRACE_ID_LENGTH);
const INVALID_SPAN_ID = "0".repeat(SPAN_ID_LENGTH);

const isLowerHex = (value: string, length: number): boolean =>
  value.length === length && /^[0-9a-f]+$/.test(value);

export type TraceparentParts = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: TraceFlags;
};

export const formatTraceparent = (parts: TraceparentParts): string =>
  `${TRACEPARENT_VERSION}-${parts.traceId}-${parts.spanId}-${(parts.traceFlags & 0xff).toString(16).padStart(2, "0")}`;

/**
 * Parse a `traceparent`, or return `null`.
 *
 * `null` rather than a throw, and this is the important decision: a malformed or absent header means *start a
 * new trace*, never fail the request. Telemetry that can break a run is worse than no telemetry, and this
 * function sits on the hot path of every request and every job.
 *
 * Strict about what it accepts, though. An all-zero trace id or span id is invalid per the spec, and accepting
 * one produces a trace that silently merges unrelated requests — every caller that failed to propagate lands in
 * the same "trace 000…0", which looks like a working trace and is worse than a missing one.
 */
export const parseTraceparent = (value: string | undefined | null): TraceparentParts | null => {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("-");
  // A version above 00 may carry *extra* fields, which the spec says to tolerate; fewer than four is malformed
  // whatever the version.
  if (parts.length < 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (version === undefined || traceId === undefined || spanId === undefined || flags === undefined) return null;
  // Version ff is explicitly forbidden. Any other unknown version is *forward* compatible: the first four
  // fields keep their meaning, so a newer producer's context still joins our trace rather than being dropped.
  if (!isLowerHex(version, 2) || version === "ff") return null;
  if (!isLowerHex(traceId, TRACE_ID_LENGTH) || traceId === INVALID_TRACE_ID) return null;
  if (!isLowerHex(spanId, SPAN_ID_LENGTH) || spanId === INVALID_SPAN_ID) return null;
  if (!isLowerHex(flags, 2)) return null;
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16) };
};

export const isSampled = (flags: TraceFlags): boolean => (flags & TRACE_FLAG_SAMPLED) !== 0;

/**
 * Fresh ids.
 *
 * `randomHex` is injected rather than reaching for `crypto` here, so a test can pin ids and assert that a
 * child span really carries its parent's trace id — which is the one property of propagation that matters and
 * the one that is untestable against a random source.
 */
export type IdGenerator = {
  readonly traceId: () => string;
  readonly spanId: () => string;
};

export const createIdGenerator = (randomHex: (bytes: number) => string): IdGenerator => ({
  traceId: () => randomHex(TRACE_ID_LENGTH / 2),
  spanId: () => randomHex(SPAN_ID_LENGTH / 2),
});
