/**
 * Error contract — `docs/03-intelligence-runtime.md`.
 *
 * Errors carry a stable code, retryability and safe details. "Safe" means the payload
 * is shown to a model and a user: no credentials, no connection strings, no internal
 * hostnames, no raw provider stack traces.
 */

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_input",
  "conflict",
  "rate_limited",
  "provider_unavailable",
  "provider_error",
  "timeout",
  "cancelled",
  "budget_exceeded",
  "context_overflow",
  "approval_required",
  "approval_denied",
  "approval_expired",
  /**
   * A tool put a question to a person and the run must park until they answer — #163.
   *
   * Not an error the model should work around, and deliberately not `approval_required`: an approval asks *may
   * I do this* about a call the platform already holds, and this asks *which of these* about a call that has
   * not been decided yet. The engine reads this code to emit `question.requested`, which is what suspends the
   * run — before this, `question.requested` was in the event union and handled by the worker, and nothing in
   * the platform could produce it.
   *
   * Carries `details.interactionId`.
   */
  "question_pending",
  "idempotency_conflict",
  "capability_unavailable",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type PlatformError = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Redacted, model- and user-safe context. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterMs?: number;
};

export class AgentPlatformError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(error: PlatformError, options?: { cause?: unknown }) {
    super(error.message, options);
    this.name = "AgentPlatformError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
    this.retryAfterMs = error.retryAfterMs;
  }

  /** The wire form. Deliberately drops `cause` and the stack. */
  toPlatformError(): PlatformError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

export const isAgentPlatformError = (value: unknown): value is AgentPlatformError =>
  value instanceof AgentPlatformError;
