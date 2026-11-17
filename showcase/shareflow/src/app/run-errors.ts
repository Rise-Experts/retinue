/**
 * A model provider's refusal, said in words a customer can act on — #628.
 *
 * ## The defect
 *
 * A production turn on 2026-09-29 failed because the platform's Gemini balance ran out, and the chat
 * showed the provider's own sentence: *"Your prepayment credits are depleted. Please go to AI Studio at
 * https://ai.studio/projects to manage your project and billing…"*. The engine turns a thrown provider
 * error into `{ code: "internal", message: <the provider's text> }` (`toPlatformError`), and that event
 * is what the app renders. So the customer was told to top up *our* Google account.
 *
 * ## What this does
 *
 * Classifies the failure from its message, and rewrites the **persisted** `run.failed` (and
 * `run.retry-pending`) event to a stable code, a safe English sentence and `details` the app localizes:
 *
 * - `details.reason` — `billing` | `quota` | `rate_limit` | `overloaded` | `auth`
 * - `details.keySource` — `workspace` when the workspace's own key (BYO) served the run, else `platform`
 *
 * The code stays inside the platform's closed `ERROR_CODES` set (`parseRunEvent` validates it on read, so a
 * new code would make the event unreadable): `rate_limited` for a rate limit, `unauthorized` for a bad key,
 * `provider_unavailable` for the rest.
 *
 * The raw message is **not lost**: the decorator sits inside `withTurnLogging`, which logs the event it
 * was handed — the original — after persistence. So `docker logs` keeps the provider's text; `run_events`
 * and the SSE stream carry only the safe one.
 *
 * ## BYO versus platform
 *
 * The two are different problems with different owners. A workspace whose own key ran out has to fix it
 * in Settings → AI providers; a platform key that ran out is ours, and the customer can only wait (or, as
 * an admin, connect their own key). `peekTurnModel` answers which served the run.
 */

import { peekTurnModel } from "./turn-billing.js";

export type ProviderFailureReason = "billing" | "quota" | "rate_limit" | "overloaded" | "auth";
export type KeySource = "workspace" | "platform";

/**
 * Patterns, most specific first — the first match wins: OpenAI's quota sentence also says "billing
 * details", and a quota error also carries the generic 429.
 *
 * Bare status numbers are only matched with a status word next to them: a run can fail for a reason that
 * merely *mentions* a number, and "429" alone is not evidence of a rate limit.
 */
const PATTERNS: readonly (readonly [ProviderFailureReason, RegExp])[] = [
  // OpenAI `insufficient_quota` / "You exceeded your current quota"; Google RESOURCE_EXHAUSTED quota.
  ["quota", /insufficient_quota|exceeded your current quota|quota (?:exceeded|has been exceeded)|resource[_ ]exhausted|check quota/i],
  // Google AI Studio (the production case), Anthropic, generic billing.
  [
    "billing",
    /prepayment credits? (?:are|is) depleted|credit balance is too low|insufficient[_ ](?:credits?|balance|funds)|billing (?:details|account|hard limit|issue)|payment required|\b402\b|plans? (?:and|&) billing/i,
  ],
  // Every provider's bad-key sentence, and the HTTP status only when named as one.
  [
    "auth",
    /invalid[_ ]?(?:x-)?api[_ -]?key|incorrect api key|api key not valid|api_key_invalid|authentication_error|invalid authentication|permission[_ ]denied|(?:status(?: code)?|http)[: ]*(?:401|403)\b|\b401 unauthorized/i,
  ],
  ["rate_limit", /rate[_ -]?limit|too many requests|(?:status(?: code)?|http)[: ]*429\b|\b429 too many/i],
  // Anthropic 529 `overloaded_error`, Google 503 UNAVAILABLE, OpenAI "server is overloaded".
  ["overloaded", /overloaded|(?:status(?: code)?|http)[: ]*(?:503|529)\b|\b529\b|service unavailable|model is currently unavailable/i],
];

/**
 * Codes that already mean something specific to the app — a budget, an approval, a cancelled run — and
 * must never be re-described as a provider problem even when their message happens to match a pattern.
 */
const CLASSIFIABLE_CODES: ReadonlySet<string> = new Set([
  "internal",
  "provider_error",
  "provider_unavailable",
  "rate_limited",
  "unauthorized",
  "forbidden",
  "timeout",
]);

/** The reason a provider refused, or `undefined` when the message is not recognisably a provider refusal. */
export const classifyProviderFailure = (error: {
  readonly code?: unknown;
  readonly message?: unknown;
}): ProviderFailureReason | undefined => {
  const code = typeof error.code === "string" ? error.code : "internal";
  if (!CLASSIFIABLE_CODES.has(code)) return undefined;
  const message = typeof error.message === "string" ? error.message : "";
  if (message === "") return code === "rate_limited" ? "rate_limit" : undefined;
  /*
   * #651: `rate_limited` is a decision already made (`provider-errors.ts`) — a per-minute limit. Google words those
   * "You exceeded your current quota", which the patterns below would read as an empty balance. Only a real
   * balance message overrides it.
   */
  if (code === "rate_limited") return PATTERNS.find(([reason]) => reason === "billing")?.[1].test(message) === true ? "billing" : "rate_limit";
  for (const [reason, pattern] of PATTERNS) if (pattern.test(message)) return reason;
  return code === "rate_limited" ? "rate_limit" : undefined;
};

/** The safe sentence per reason and key source. The app localizes from `details`; this is the fallback. */
const MESSAGES: Record<KeySource, Record<ProviderFailureReason, string>> = {
  platform: {
    billing: "The assistant is temporarily unavailable. Please try again later.",
    quota: "The assistant is temporarily unavailable. Please try again later.",
    auth: "The assistant is temporarily unavailable. Please try again later.",
    rate_limit: "The assistant is busy right now. Please try again in a minute.",
    overloaded: "The assistant is busy right now. Please try again in a minute.",
  },
  workspace: {
    billing: "Your AI provider refused the request (billing or quota). Check Settings → AI providers.",
    quota: "Your AI provider refused the request (billing or quota). Check Settings → AI providers.",
    auth: "Your AI provider rejected the API key. Check Settings → AI providers.",
    rate_limit: "Your AI provider is rate-limiting requests. Try again in a minute, or check Settings → AI providers.",
    overloaded: "Your AI provider is overloaded right now. Please try again shortly.",
  },
};

const CODES: Record<ProviderFailureReason, "provider_unavailable" | "rate_limited" | "unauthorized"> = {
  billing: "provider_unavailable",
  quota: "provider_unavailable",
  auth: "unauthorized",
  rate_limit: "rate_limited",
  overloaded: "provider_unavailable",
};

export type ErrorLike = {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly retryable?: unknown;
  readonly details?: unknown;
  readonly retryAfterMs?: unknown;
};

/**
 * #668: the platform's own per-minute budget queued the turn (`token-budget.ts`) — ours, not the provider's, so
 * it keeps its own reason instead of being re-described as a provider rate limit. The app falls back to its
 * "busy" text for a reason it does not know.
 */
const queueReasonOf = (error: ErrorLike): "queued" | "queue_timeout" | undefined => {
  if (error.code !== "rate_limited" || error.details === null || typeof error.details !== "object") return undefined;
  const reason = (error.details as { reason?: unknown }).reason;
  return reason === "queued" || reason === "queue_timeout" ? reason : undefined;
};

const queueError = (error: ErrorLike, reason: "queued" | "queue_timeout", keySource: KeySource): ErrorLike => {
  const waitMs = (error.details as { waitMs?: unknown }).waitMs;
  if (reason === "queued") {
    const seconds = typeof waitMs === "number" ? Math.max(1, Math.ceil(waitMs / 1000)) : undefined;
    return {
      code: "rate_limited",
      message: seconds === undefined ? "The assistant is busy; your message is queued." : `The assistant is busy; your message is queued and starts in about ${seconds} s.`,
      retryable: true,
      details: { reason, keySource, ...(typeof waitMs === "number" ? { waitMs } : {}) },
      ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  return {
    code: "rate_limited",
    message: "The assistant is too busy right now and your message could not start. Please send it again in a minute.",
    retryable: false,
    details: { reason, keySource },
  };
};

/**
 * The error as the customer should see it: unchanged when it is not a provider refusal, otherwise a stable
 * code, a safe message and the classification. `retryAfterMs` is kept — it is a number, not provider text.
 */
export const friendlyRunError = (error: ErrorLike, keySource: KeySource): ErrorLike => {
  const queue = queueReasonOf(error);
  if (queue !== undefined) return queueError(error, queue, keySource);
  const reason = classifyProviderFailure(error);
  if (reason === undefined) return error;
  return {
    code: CODES[reason],
    message: MESSAGES[keySource][reason],
    retryable: reason === "rate_limit" || reason === "overloaded",
    details: { reason, keySource },
    ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
  };
};

/** The minimum an event log must do. Matches `RunEventLog` without importing it. */
type EventLogLike = {
  append(input: { readonly tenantId: unknown; readonly event: unknown }): Promise<void>;
};

const REWRITTEN: ReadonlySet<string> = new Set(["run.failed", "run.retry-pending"]);

/**
 * Wrap the persisting event log so a provider refusal is stored — and therefore streamed — in safe words.
 *
 * Wrap the **innermost** log (the Postgres one), so `withTurnLogging` outside it still sees and prints the
 * original error, and `withTurnCharging` outside that has not yet forgotten which model served the run.
 */
export const withFriendlyRunErrors = <T extends EventLogLike>(
  eventLog: T,
  keySourceFor: (runId: unknown) => KeySource = (runId) => (peekTurnModel(runId) === true ? "workspace" : "platform"),
): T => {
  const append: EventLogLike["append"] = async (input) => {
    const event = input.event as { readonly type?: string; readonly runId?: unknown; readonly error?: ErrorLike };
    if (event.type === undefined || !REWRITTEN.has(event.type) || event.error === undefined) {
      return eventLog.append(input);
    }
    const friendly = friendlyRunError(event.error, keySourceFor(event.runId));
    if (friendly === event.error) return eventLog.append(input);
    return eventLog.append({ ...input, event: { ...event, error: friendly } });
  };
  return { ...eventLog, append } as T;
};

/** The minimum a run store must do for the rewrite. Structural, like the event log's. */
type RunStoreLike = {
  transition(input: { readonly error?: unknown; readonly id?: unknown } & Record<string, unknown>): Promise<unknown>;
};

/**
 * The run row's error, rewritten the same way — the worker stores the failure on the run as well as in the
 * event, and a client that reads a run (rather than its events) must not get the provider's text either.
 */
export const withFriendlyRunStoreErrors = <T extends RunStoreLike>(
  runs: T,
  keySourceFor: (runId: unknown) => KeySource = (runId) => (peekTurnModel(runId) === true ? "workspace" : "platform"),
): T => {
  const transition: RunStoreLike["transition"] = (input) => {
    const error = input.error as ErrorLike | undefined;
    if (error === undefined || error === null || typeof error !== "object") return runs.transition(input);
    const friendly = friendlyRunError(error, keySourceFor(input.id));
    return runs.transition(friendly === error ? input : { ...input, error: friendly });
  };
  return { ...runs, transition } as T;
};
