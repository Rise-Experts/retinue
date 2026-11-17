/**
 * A provider's "slow down", made into an error the run retries — #651.
 *
 * agentkit retries a failed turn (`runWithRetry`: up to 5 attempts, honouring a retry delay of up to 60 s), but
 * only for an `AgentPlatformError` marked retryable. Anything else becomes `internal, retryable: false`
 * (`toPlatformError`). The AI SDK throws its own `APICallError` / `RetryError`, so every provider refusal failed
 * the run on the spot.
 *
 * Production, 2026-09-30: Google answers a **per-minute** limit with HTTP 429 `RESOURCE_EXHAUSTED` "You exceeded
 * your current quota". Parts 26, 78 and 79 of the evaluation failed that way in ~7 s with "temporarily
 * unavailable"; the same request a minute later worked every time.
 *
 * What is retryable here, and what is not:
 *
 * - **Per-minute limits and overload** (429, 503, 529): retryable, with the provider's own delay when it gives one
 *   (Google's `RetryInfo.retryDelay`, a `retry-after` header).
 * - **An empty balance** (prepayment depleted, `insufficient_quota`, credit balance) and **per-day limits**: not
 *   retryable, and left untouched — `run-errors.ts` words them for the person. Retrying those only makes them
 *   wait longer for the same answer.
 */
import { AgentPlatformError } from "@retinue/agentkit";

type ApiErrorLike = {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly statusCode?: unknown;
  readonly responseBody?: unknown;
  readonly responseHeaders?: unknown;
  readonly lastError?: unknown;
  readonly cause?: unknown;
};

/**
 * An empty balance, in every provider's words. Deliberately **not** "billing details": Google's per-minute 429 says
 * "please check your plan and billing details" too, and reading that as an empty balance is the bug this fixes.
 * OpenAI's real out-of-credit error carries `insufficient_quota`.
 */
const BALANCE = /prepayment credits? (?:are|is) depleted|credit balance is too low|insufficient[_ ](?:quota|credits?|balance|funds)|billing hard limit|payment required/i;
/** A daily cap: waiting a minute does not lift it. */
const PER_DAY = /per[ _-]?day|PerDay|daily limit/i;
const SLOW_DOWN = /RESOURCE_EXHAUSTED|rate[_ -]?limit|too many requests|exceeded your current quota|quota exceeded/i;
const OVERLOADED = /overloaded|UNAVAILABLE|model is currently unavailable|service unavailable/i;

/** How long to wait on a rate limit when the provider does not say: four retries then span about a minute. */
export const DEFAULT_RATE_LIMIT_DELAY_MS = 20_000;

/** The provider's error under the SDK's wrapping: a `RetryError` keeps the last attempt's error. */
const innermost = (thrown: unknown): ApiErrorLike | undefined => {
  let current = thrown as ApiErrorLike | undefined;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    if (typeof current.statusCode === "number") return current;
    const next = (current.lastError ?? current.cause) as ApiErrorLike | undefined;
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current !== null && typeof current === "object" ? current : undefined;
};

/** "37s", "1.5s" or a header's seconds, in milliseconds. */
const retryDelayMs = (error: ApiErrorLike): number | undefined => {
  const body = typeof error.responseBody === "string" ? error.responseBody : "";
  const fromBody = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (fromBody?.[1] !== undefined) return Math.round(Number(fromBody[1]) * 1000);
  const headers = (error.responseHeaders ?? {}) as Record<string, unknown>;
  const header = headers["retry-after"] ?? headers["Retry-After"];
  const seconds = typeof header === "string" || typeof header === "number" ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
};

/**
 * The retryable platform error for a provider's "slow down", or `undefined` when the failure is anything else
 * (left for the run to fail as it would have).
 */
export const retryableProviderError = (thrown: unknown): AgentPlatformError | undefined => {
  if (thrown instanceof AgentPlatformError) return undefined;
  const error = innermost(thrown);
  if (error === undefined) return undefined;
  const status = typeof error.statusCode === "number" ? error.statusCode : undefined;
  const text = `${typeof error.message === "string" ? error.message : ""} ${typeof error.responseBody === "string" ? error.responseBody : ""}`;
  if (BALANCE.test(text) || PER_DAY.test(text)) return undefined;
  const retryAfterMs = retryDelayMs(error);
  if (status === 429 || (status === undefined && SLOW_DOWN.test(text))) {
    /*
     * No delay from the provider means the kit's own backoff: 0.5 s doubling to 8 s, five attempts spent in about
     * eight seconds. Production, 2026-10-01: Google's 429s came without RetryInfo, and every retry landed in the same
     * minute as the refusal. A per-minute limit needs the next minute, so wait long enough to reach it.
     */
    const delay = retryAfterMs ?? DEFAULT_RATE_LIMIT_DELAY_MS;
    return new AgentPlatformError({
      code: "rate_limited",
      message: `the model provider is rate-limiting requests (per-minute limit${status === undefined ? "" : `, HTTP ${status}`}); retrying`,
      retryable: true,
      retryAfterMs: delay,
    });
  }
  if (status === 503 || status === 529 || (status === undefined && OVERLOADED.test(text))) {
    return new AgentPlatformError({
      code: "provider_unavailable",
      message: `the model provider is overloaded${status === undefined ? "" : ` (HTTP ${status})`}; retrying`,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return undefined;
};

/** `thrown`, or its retryable form. For a `catch` that rethrows. */
export const asRetryable = (thrown: unknown): unknown => retryableProviderError(thrown) ?? thrown;

type StreamPart = { readonly type?: string; readonly error?: unknown } & Record<string, unknown>;

/** A LanguageModelV3 stream whose `error` parts carry the retryable form. */
export const withRetryableStreamErrors = (stream: unknown): unknown => {
  if (typeof TransformStream === "undefined" || stream === null || typeof stream !== "object" || typeof (stream as { pipeThrough?: unknown }).pipeThrough !== "function") {
    return stream;
  }
  return (stream as ReadableStream<StreamPart>).pipeThrough(
    new TransformStream<StreamPart, StreamPart>({
      transform(part, controller) {
        if (part.type !== "error") return controller.enqueue(part);
        const retryable = retryableProviderError(part.error);
        controller.enqueue(retryable === undefined ? part : { ...part, error: retryable });
      },
    }),
  );
};

/** How often one model call is retried here before the refusal goes up to the run. */
export const STEP_RETRIES = 2;
/** The longest one step waits here; the run's own retry takes over after that. */
export const STEP_RETRY_MAX_MS = 20_000;

const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

/**
 * One model call, retried when the provider refused it as busy — #651 follow-up.
 *
 * The engine retries a turn only while nothing has streamed (a retry after output would repeat it), so a refusal
 * on the **second** call of a turn — after a tool ran and its card was shown — failed the run. Production,
 * 2026-10-01: a deck was created, and the call that would have written the reply was refused. A refused call has
 * produced nothing, so retrying *that call* is safe at any step. Twice, waiting the provider's delay (at most 20 s);
 * after that the refusal goes up to the run as before.
 */
export const withStepRetry = async <T>(
  call: () => Promise<T>,
  options: { readonly signal?: AbortSignal | undefined; readonly runId?: unknown; readonly retries?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> => {
  const retries = options.retries ?? STEP_RETRIES;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (thrown) {
      const retryable = thrown instanceof AgentPlatformError && thrown.retryable && (thrown.code === "rate_limited" || thrown.code === "provider_unavailable");
      if (!retryable || attempt >= retries || options.signal?.aborted === true) throw thrown;
      const delay = Math.min((thrown as AgentPlatformError).retryAfterMs ?? DEFAULT_RATE_LIMIT_DELAY_MS, STEP_RETRY_MAX_MS);
      console.warn(`[shareflow] run ${String(options.runId ?? "?")}: the model call was refused as busy; retrying it in ${Math.round(delay / 1000)} s (${attempt + 1}/${retries}).`);
      await (options.sleep ?? ((ms: number) => pause(ms, options.signal)))(delay);
    }
  }
};
