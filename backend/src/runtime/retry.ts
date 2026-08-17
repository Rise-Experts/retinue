/**
 * Claude/Anthropic-SDK-style retry policy — `docs/04-durable-runtime-and-hitl.md` → Retry policy.
 *
 * A single provider call is retried on transient failures with exponential backoff plus jitter,
 * honoring any server-supplied `retry-after`, and only for the transient HTTP classes the spec
 * enumerates (408/409/429/5xx/529). Deterministic 4xx validation errors fail fast.
 *
 * This layer retries *provider calls*, which are side-effect-free to repeat. External/destructive
 * tool writes are made safe to retry separately, via idempotency keys (see `../idempotency`), so
 * nothing here fires a side effect twice.
 */

import { AgentPlatformError, type PlatformError } from "../core/errors.js";

export type RetryPolicy = {
  /** Total attempts including the first. `maxAttempts: 1` disables retrying. */
  readonly maxAttempts: number;
  /** Backoff for the first retry, before jitter. */
  readonly baseDelayMs: number;
  /** Upper bound on the computed (pre-`retry-after`) backoff. */
  readonly maxDelayMs: number;
  /** Geometric growth per attempt. */
  readonly backoffFactor: number;
  /** Fraction of the backoff shaved off by jitter, in `[0, 1]`. 0.25 mirrors the Anthropic SDK. */
  readonly jitter: number;
  /** A server `retry-after` is honored up to this ceiling, so a hostile value cannot stall a run. */
  readonly retryAfterCapMs: number;
};

/** Mirrors the Anthropic TS SDK defaults: 0.5s base, 8s cap, x2, -25% jitter. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  backoffFactor: 2,
  jitter: 0.25,
  retryAfterCapMs: 60_000,
};

/**
 * The transient HTTP status classes, matching the spec and the Anthropic SDK's `shouldRetry`:
 * `408` request timeout, `409` conflict, `429` rate limited, any `5xx`, and `529` overloaded.
 */
export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

/** Map a raw provider HTTP status to the platform error code the runtime reasons about. */
export const statusToErrorCode = (status: number): PlatformError["code"] => {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 529 || status === 503) return "provider_unavailable";
  if (status >= 500) return "provider_error";
  if (status === 409) return "conflict";
  return "provider_error";
};

/**
 * Parse a `Retry-After` / `retry-after-ms` header into milliseconds. Accepts a delta-seconds
 * integer, a millisecond value, or an HTTP-date (resolved against `now`). Returns `undefined`
 * when absent or unparseable so the caller falls back to computed backoff.
 */
export const parseRetryAfterMs = (
  headers: { retryAfter?: string | number | null; retryAfterMs?: string | number | null },
  now: number,
): number | undefined => {
  const ms = headers.retryAfterMs;
  if (ms !== undefined && ms !== null && ms !== "") {
    const n = typeof ms === "number" ? ms : Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const ra = headers.retryAfter;
  if (ra === undefined || ra === null || ra === "") return undefined;
  const n = typeof ra === "number" ? ra : Number(ra);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const dateMs = Date.parse(String(ra));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return undefined;
};

export type RetryDecision =
  | { readonly retry: true; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number }
  | { readonly retry: false; readonly reason: "non-retryable" | "exhausted" };

/**
 * Compute the pre-jitter backoff for the retry that follows `attempt` (1-based). Exposed for tests
 * and so a transport can preview the schedule.
 */
export const backoffMs = (policy: RetryPolicy, attempt: number): number =>
  Math.min(policy.baseDelayMs * policy.backoffFactor ** (attempt - 1), policy.maxDelayMs);

/**
 * Decide whether the failed `attempt` should be retried and, if so, how long to wait. `random`
 * defaults to `Math.random`; inject a fixed value for deterministic tests. When the error carries
 * `retryAfterMs`, the wait is at least that long (capped by `retryAfterCapMs`) — honoring the
 * server without letting it stall the run indefinitely.
 */
export const decideRetry = (input: {
  readonly error: PlatformError;
  readonly attempt: number;
  readonly policy: RetryPolicy;
  readonly random?: () => number;
}): RetryDecision => {
  const { error, attempt, policy } = input;
  if (!error.retryable) return { retry: false, reason: "non-retryable" };
  if (attempt >= policy.maxAttempts) return { retry: false, reason: "exhausted" };

  const random = input.random ?? Math.random;
  const jittered = backoffMs(policy, attempt) * (1 - random() * policy.jitter);
  const honored =
    error.retryAfterMs !== undefined
      ? Math.max(jittered, Math.min(error.retryAfterMs, policy.retryAfterCapMs))
      : jittered;
  return { retry: true, attempt, maxAttempts: policy.maxAttempts, delayMs: Math.round(honored) };
};

/** Normalize a thrown value to a `PlatformError`. Unclassified throws fail fast (non-retryable). */
export const toPlatformError = (value: unknown): PlatformError => {
  if (value instanceof AgentPlatformError) return value.toPlatformError();
  const message = value instanceof Error ? value.message : String(value);
  return { code: "internal", message, retryable: false };
};

export type RetryPendingInfo = {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly nextAttemptAt: string;
  readonly error: PlatformError;
};

/**
 * Run `operation` with the retry policy. `operation` receives the 1-based attempt number and MUST
 * be safe to repeat (provider call, or an idempotent tool). Between attempts `onRetryPending` fires
 * so the worker can persist a `retry-pending` status and publish a `run.retry-pending` event, then
 * `sleep` waits out the backoff. Exhausting the budget rethrows the last error unchanged.
 */
export const runWithRetry = async <T>(input: {
  readonly operation: (attempt: number) => Promise<T>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly policy?: RetryPolicy;
  readonly random?: () => number;
  readonly startAttempt?: number;
  readonly onRetryPending?: (info: RetryPendingInfo) => void | Promise<void>;
}): Promise<T> => {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  let attempt = input.startAttempt ?? 1;
  for (;;) {
    try {
      return await input.operation(attempt);
    } catch (thrown) {
      const error = toPlatformError(thrown);
      const decision = decideRetry({ error, attempt, policy, random: input.random });
      if (!decision.retry) throw new AgentPlatformError(error, { cause: thrown });
      const nextAttemptAt = new Date(input.now() + decision.delayMs).toISOString();
      await input.onRetryPending?.({
        attempt,
        maxAttempts: policy.maxAttempts,
        delayMs: decision.delayMs,
        nextAttemptAt,
        error,
      });
      await input.sleep(decision.delayMs);
      attempt += 1;
    }
  }
};
