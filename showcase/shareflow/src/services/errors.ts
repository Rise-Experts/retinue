/**
 * How a ShareFlow service reports failure across the seam.
 *
 * **This file is load-bearing, and the reason is not obvious.** The delegating envelope (#113) stores
 * the delegate's return value under the idempotency key and returns it on every later call with that
 * key. So a service that reported failure *as a value* — `{ success: false, error }`, which is exactly
 * the shape `PublishResult` uses inside ShareFlow today — would have that failure written into the
 * idempotency store as the permanent, final answer for that call. The retry would then "succeed",
 * returning the cached failure, and never reach the provider again.
 *
 * A thrown error cannot do that: the envelope stores only after the delegate returns.
 *
 * So the seam's contract is: **return data, or throw `AgentPlatformError`.** `serviceFailure` exists so
 * an adapter translating ShareFlow's boolean envelope has one obvious thing to call, rather than each
 * adapter author deciding independently whether to throw.
 */
import { AgentPlatformError, type ErrorCode } from "@retinue/agentkit";

/**
 * Codes a ShareFlow service is expected to produce. A subset of the platform's `ErrorCode`, listed so
 * an adapter maps a provider failure onto a code the runtime already knows how to retry, surface and
 * localize — rather than inventing a string the frontend has no message for.
 */
export const SERVICE_ERROR_CODES = [
  "not_found",
  "forbidden",
  "invalid_input",
  "conflict",
  "rate_limited",
  "provider_unavailable",
  "provider_error",
  "timeout",
  "capability_unavailable",
] as const satisfies readonly ErrorCode[];

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

/**
 * Codes worth retrying. Retryability is a property of the failure, not of the caller's patience, so it
 * is decided here once instead of at each call site.
 */
const RETRYABLE: ReadonlySet<ServiceErrorCode> = new Set([
  "rate_limited",
  "provider_unavailable",
  "timeout",
]);

/**
 * Build the error a ShareFlow service throws.
 *
 * `details` is optional and **must already be safe to show a model and a user** — the platform's error
 * contract is explicit that a `PlatformError` payload carries "no credentials … no raw provider stack
 * traces". This matters concretely here: ShareFlow's `PublishResult.error` carries a `rawResponse`
 * holding the provider's unmodified body, which can contain access tokens and third-party personal
 * data and is of unbounded size. **It must not be passed through.** Map it to a code and a sentence,
 * and log the body on ShareFlow's side where it is already subject to that app's retention rules.
 */
export const serviceFailure = (
  code: ServiceErrorCode,
  message: string,
  options?: {
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  },
): AgentPlatformError =>
  new AgentPlatformError(
    {
      code,
      message,
      retryable: options?.retryable ?? RETRYABLE.has(code),
      ...(options?.details === undefined ? {} : { details: options.details }),
      ...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    },
    options?.cause === undefined ? undefined : { cause: options.cause },
  );

/**
 * Translate a boolean-envelope result into the seam's contract.
 *
 * ShareFlow's publish path returns `{ success: boolean }`. An adapter wrapping it has to decide what to
 * do with `success: false`, and the wrong answer — returning it — is also the easiest one to write.
 * This makes the right answer a single call.
 */
export const unwrapServiceResult = <T>(
  result: { readonly ok: boolean; readonly value?: T; readonly code?: ServiceErrorCode; readonly message?: string },
): T => {
  if (result.ok) return result.value as T;
  throw serviceFailure(result.code ?? "provider_error", result.message ?? "the operation failed");
};
