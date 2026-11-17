/**
 * Many workspaces on one platform key — #668.
 *
 * ## The limit this shares out
 *
 * Google rate-limits per **project**, not per key or per user: every Chorus workspace on the platform key draws on
 * one per-minute token budget (~1M on the current tier). At the production average of ~17k tokens a turn that is
 * ~60 turns a minute for everybody, and one 500k-token chat spends half of it per message. Past the limit Google
 * answers 429, and #651 turned that into a retry — which helps one turn and does nothing for the next twenty, all
 * of which hit the same wall in the same minute.
 *
 * So the budget is counted here, before the call, in Redis — one counter per workspace per minute and one for the
 * platform — and a turn that would go over it **waits in a queue the person can see** instead of being refused by
 * the provider.
 *
 * ## Per call, not per turn
 *
 * The provider counts every request. A tool-calling turn is a loop, and each pass resends the whole context: seven
 * calls over an 11k prompt are 77k tokens to Google, not 11k. So every model call is estimated from what it will
 * send (`estimateCallTokens`, chars/4) and reserved, and reconciled with the provider's own usage when it finishes.
 *
 * Only the turn's **first** call can wait. Once a turn has streamed anything the engine no longer retries it (a
 * retry would repeat the output), so stopping it mid-loop would lose a turn that has already shown its work; its
 * later calls are counted without being held, and it is the next turn that queues for them.
 *
 * ## How the wait is shown
 *
 * The worker stamps each event's sequence itself, so this cannot append an event of its own — a second writer
 * would collide on `(tenant_id, run_id, sequence)` and one of the two would be dropped. What the run *does* emit
 * on its own is `run.retry-pending`, with `nextAttemptAt`, whenever the first call throws a retryable error before
 * anything streamed — the event the chat already renders as "Busy right now — trying again…". So a queued turn
 * throws `rate_limited` with `details.reason: "queued"` and the wait as `retryAfterMs`; the engine sleeps it out
 * and tries again, and `run-errors.ts` keeps the reason so the app can say "queued, about N s".
 *
 * The engine allows five attempts, and a real provider refusal must still have some left. So at most
 * `VISIBLE_QUEUE_RETRIES` waits go through the engine; after that the gate waits in place. Either way the whole
 * wait is bounded by `maxQueueMs`, and past it the turn fails with a clear error rather than hanging.
 *
 * ## Fixed windows
 *
 * The window is the minute the call starts in, truncated — the same decision agentkit's rate limiter makes, for
 * the same reason: every process derives the same key for the same moment, and an old window expires on its own.
 * The cost is the boundary burst (a full window at :59 and another at :00); Google's own limit is not finer than
 * that either.
 *
 * ## Exempt, and failing open
 *
 * A workspace's own key (BYO) is the workspace's limit, not ours: those turns are never counted or held. And when
 * Redis cannot be reached the budget **admits**, and says so in the log — a counter that is down must not take the
 * assistant down with it. The provider's own 429 and #651's retry are still behind it.
 */

import { AgentPlatformError } from "@retinue/agentkit";

import { estimateCallTokens } from "./context-management.js";
import { optionalNumberEnv } from "./env.js";
import type { ModelCallUsage } from "./workspace-turn-model.js";

/** One workspace's share of the platform per minute, unless `SHAREFLOW_TPM_PER_WORKSPACE` says otherwise. */
export const DEFAULT_WORKSPACE_TPM = 250_000;
/** The platform key's per-minute limit (Google's current tier), unless `SHAREFLOW_TPM_PLATFORM` says otherwise. */
export const DEFAULT_PLATFORM_TPM = 1_000_000;
/** The longest a turn waits for the budget before it fails, unless `SHAREFLOW_TPM_MAX_QUEUE_MS` says otherwise. */
export const DEFAULT_MAX_QUEUE_MS = 120_000;
/** The share of the platform limit at which ops is told, unless `SHAREFLOW_TPM_ALERT_RATIO` says otherwise. */
export const DEFAULT_ALERT_RATIO = 0.7;
/** The budget's window. A provider's per-minute limit, so a minute. */
export const BUDGET_WINDOW_MS = 60_000;
/**
 * How many waits go through the engine's retry (and are therefore shown). The engine allows five attempts; three
 * here leaves one for a real provider refusal after the queue.
 */
export const VISIBLE_QUEUE_RETRIES = 3;
/** A Redis call that takes longer than this counts as unavailable: the budget must not slow every turn down. */
export const STORE_TIMEOUT_MS = 500;

export type TokenBudgetConfig = {
  /** Tokens per minute per workspace; `0` means no per-workspace limit. */
  readonly workspaceTpm: number;
  /** Tokens per minute for the whole platform key; `0` means no platform limit. */
  readonly platformTpm: number;
  readonly maxQueueMs: number;
  /** Of `platformTpm`; `0` turns the alert off. */
  readonly alertRatio: number;
};

/** The budget, from the environment, with the defaults above. Both limits `0` turns the budget off. */
export const tokenBudgetConfigFrom = (env: Readonly<Record<string, string | undefined>> = process.env): TokenBudgetConfig => ({
  workspaceTpm: Math.max(0, optionalNumberEnv("SHAREFLOW_TPM_PER_WORKSPACE", DEFAULT_WORKSPACE_TPM, env)),
  platformTpm: Math.max(0, optionalNumberEnv("SHAREFLOW_TPM_PLATFORM", DEFAULT_PLATFORM_TPM, env)),
  maxQueueMs: Math.max(0, optionalNumberEnv("SHAREFLOW_TPM_MAX_QUEUE_MS", DEFAULT_MAX_QUEUE_MS, env)),
  alertRatio: Math.max(0, optionalNumberEnv("SHAREFLOW_TPM_ALERT_RATIO", DEFAULT_ALERT_RATIO, env)),
});

/** The window a moment belongs to. Pure, so every process agrees without coordinating. */
export const budgetWindowStart = (atMs: number): number => atMs - (atMs % BUDGET_WINDOW_MS);

export type ReserveInput = {
  readonly workspaceId: string;
  readonly windowStartMs: number;
  readonly tokens: number;
  readonly workspaceLimit: number;
  readonly platformLimit: number;
  /** Platform usage at which the window's alert fires; `0` for none. */
  readonly alertAt: number;
  /** Count it whatever the counters say: a later call of a turn that has already started. */
  readonly force: boolean;
  readonly ttlSeconds: number;
};

export type ReserveResult = {
  readonly admitted: boolean;
  /** The counters after this reservation, or as they stood when it was refused. */
  readonly workspaceUsed: number;
  readonly platformUsed: number;
  /** True exactly once per window: the reservation that took the platform past `alertAt`. */
  readonly alert: boolean;
};

export type AdjustInput = {
  readonly workspaceId: string;
  readonly windowStartMs: number;
  readonly delta: number;
  readonly alertAt: number;
  readonly ttlSeconds: number;
};

/**
 * The counters, as a port. `reserve` must check and increment **atomically** — two workers reading "there is room"
 * and both incrementing is the budget overrun this exists to prevent — and must set the expiry in the same step.
 */
export interface TokenBudgetStore {
  reserve(input: ReserveInput): Promise<ReserveResult>;
  adjust(input: AdjustInput): Promise<{ readonly platformUsed: number; readonly alert: boolean }>;
}

/** Namespaced, so a counter cannot collide with BullMQ's keys or agentkit's rate limiter. */
export const tokenBudgetKeys = (workspaceId: string, windowStartMs: number) => ({
  workspace: `shareflow:tpm:ws:${workspaceId}:${windowStartMs}`,
  platform: `shareflow:tpm:platform:${windowStartMs}`,
  alert: `shareflow:tpm:alert:${windowStartMs}`,
});

/**
 * Check both counters and increment both, in one script.
 *
 * A counter that is still at zero admits whatever is asked: a single turn larger than the whole limit (a 500k chat
 * against a 250k share) would otherwise never fit and wait for ever. It runs alone in a fresh window instead.
 */
export const RESERVE_SCRIPT = `
local ws = tonumber(redis.call('GET', KEYS[1]) or '0')
local pf = tonumber(redis.call('GET', KEYS[2]) or '0')
local tokens = tonumber(ARGV[1])
local wsLimit = tonumber(ARGV[2])
local pfLimit = tonumber(ARGV[3])
local force = ARGV[4] == '1'
local ttl = tonumber(ARGV[5])
local alertAt = tonumber(ARGV[6])
if not force then
  if wsLimit > 0 and ws > 0 and ws + tokens > wsLimit then return {0, ws, pf, 0} end
  if pfLimit > 0 and pf > 0 and pf + tokens > pfLimit then return {0, ws, pf, 0} end
end
ws = redis.call('INCRBY', KEYS[1], tokens)
redis.call('EXPIRE', KEYS[1], ttl)
pf = redis.call('INCRBY', KEYS[2], tokens)
redis.call('EXPIRE', KEYS[2], ttl)
local alert = 0
if alertAt > 0 and pf >= alertAt and redis.call('SET', KEYS[3], '1', 'NX', 'EX', ttl) then alert = 1 end
return {1, ws, pf, alert}
`;

/** A reservation's estimate corrected by the real usage. Clamped at zero, so a correction cannot make room that never existed. */
export const ADJUST_SCRIPT = `
local delta = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local alertAt = tonumber(ARGV[3])
local ws = redis.call('INCRBY', KEYS[1], delta)
if ws < 0 then redis.call('SET', KEYS[1], '0') end
redis.call('EXPIRE', KEYS[1], ttl)
local pf = redis.call('INCRBY', KEYS[2], delta)
if pf < 0 then redis.call('SET', KEYS[2], '0'); pf = 0 end
redis.call('EXPIRE', KEYS[2], ttl)
local alert = 0
if alertAt > 0 and pf >= alertAt and redis.call('SET', KEYS[3], '1', 'NX', 'EX', ttl) then alert = 1 end
return {pf, alert}
`;

/** The one Redis method this needs. Structural, so `ioredis` is not imported for a type. */
export type EvalClient = { eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> };

const numbers = (reply: unknown, length: number): number[] => {
  const values = Array.isArray(reply) ? reply.map((value) => Number(value)) : [];
  // A reply that is not the script's shape is a failure, not an empty counter: reading it as zero would admit everything silently.
  if (values.length !== length || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`token budget: Redis returned ${JSON.stringify(reply)}, which is not the script's reply`);
  }
  return values;
};

export const createRedisTokenBudgetStore = (client: EvalClient): TokenBudgetStore => ({
  async reserve(input) {
    const keys = tokenBudgetKeys(input.workspaceId, input.windowStartMs);
    const reply = await client.eval(
      RESERVE_SCRIPT,
      3,
      keys.workspace,
      keys.platform,
      keys.alert,
      Math.round(input.tokens),
      input.workspaceLimit,
      input.platformLimit,
      input.force ? "1" : "0",
      input.ttlSeconds,
      input.alertAt,
    );
    const [admitted, workspaceUsed, platformUsed, alert] = numbers(reply, 4) as [number, number, number, number];
    return { admitted: admitted === 1, workspaceUsed, platformUsed, alert: alert === 1 };
  },
  async adjust(input) {
    const keys = tokenBudgetKeys(input.workspaceId, input.windowStartMs);
    const reply = await client.eval(ADJUST_SCRIPT, 3, keys.workspace, keys.platform, keys.alert, Math.round(input.delta), input.ttlSeconds, input.alertAt);
    const [platformUsed, alert] = numbers(reply, 2) as [number, number];
    return { platformUsed, alert: alert === 1 };
  },
});

/**
 * The same counters in a `Map`, for tests. **Not** for a deployment: two workers each holding their own would each
 * allow the full budget, which is the overrun the Redis store exists to prevent.
 */
export const createMemoryTokenBudgetStore = (): TokenBudgetStore & { readonly counters: ReadonlyMap<string, number> } => {
  const counters = new Map<string, number>();
  const alerted = new Set<string>();
  /** Windows older than the newest two are dropped, the way a TTL would. */
  const prune = (windowStartMs: number) => {
    for (const key of counters.keys()) {
      const start = Number(key.slice(key.lastIndexOf(":") + 1));
      if (start < windowStartMs - BUDGET_WINDOW_MS) counters.delete(key);
    }
  };
  const alertOnce = (key: string, used: number, alertAt: number): boolean => {
    if (alertAt <= 0 || used < alertAt || alerted.has(key)) return false;
    alerted.add(key);
    return true;
  };
  return {
    counters,
    async reserve(input) {
      prune(input.windowStartMs);
      const keys = tokenBudgetKeys(input.workspaceId, input.windowStartMs);
      const ws = counters.get(keys.workspace) ?? 0;
      const pf = counters.get(keys.platform) ?? 0;
      if (!input.force) {
        const overWorkspace = input.workspaceLimit > 0 && ws > 0 && ws + input.tokens > input.workspaceLimit;
        const overPlatform = input.platformLimit > 0 && pf > 0 && pf + input.tokens > input.platformLimit;
        if (overWorkspace || overPlatform) return { admitted: false, workspaceUsed: ws, platformUsed: pf, alert: false };
      }
      const tokens = Math.round(input.tokens);
      counters.set(keys.workspace, ws + tokens);
      counters.set(keys.platform, pf + tokens);
      return { admitted: true, workspaceUsed: ws + tokens, platformUsed: pf + tokens, alert: alertOnce(keys.alert, pf + tokens, input.alertAt) };
    },
    async adjust(input) {
      const keys = tokenBudgetKeys(input.workspaceId, input.windowStartMs);
      const delta = Math.round(input.delta);
      counters.set(keys.workspace, Math.max(0, (counters.get(keys.workspace) ?? 0) + delta));
      const pf = Math.max(0, (counters.get(keys.platform) ?? 0) + delta);
      counters.set(keys.platform, pf);
      return { platformUsed: pf, alert: alertOnce(keys.alert, pf, input.alertAt) };
    },
  };
};

/** A reservation, kept by the call that made it so the real usage can correct it. */
export type Reservation = {
  readonly workspaceId: string;
  readonly windowStartMs: number;
  readonly tokens: number;
};

export type Admission =
  | { readonly admitted: true; readonly reservation?: Reservation }
  | { readonly admitted: false; readonly waitMs: number; readonly scope: "workspace" | "platform" };

export type TokenBudget = {
  readonly config: TokenBudgetConfig;
  admit(input: { readonly workspaceId: string; readonly tokens: number; readonly force?: boolean }): Promise<Admission>;
  /** Correct a reservation with what the call really used; `0` for a call that was refused and used nothing. */
  reconcile(reservation: Reservation | undefined, actualTokens: number): Promise<void>;
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply in ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

export const createTokenBudget = (deps: {
  readonly store: TokenBudgetStore;
  readonly config: TokenBudgetConfig;
  readonly now?: () => number;
  /** Where "Redis is unavailable" goes. At most one line per window, with the count of the ones held back. */
  readonly warn?: (line: string) => void;
  /** Where the 70% alert goes: one structured line per window. */
  readonly alert?: (line: string) => void;
  readonly storeTimeoutMs?: number;
}): TokenBudget => {
  const { store, config } = deps;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const alert = deps.alert ?? ((line: string) => console.warn(line));
  const timeoutMs = deps.storeTimeoutMs ?? STORE_TIMEOUT_MS;
  const enabled = config.workspaceTpm > 0 || config.platformTpm > 0;
  const alertAt = config.platformTpm > 0 && config.alertRatio > 0 ? Math.ceil(config.platformTpm * config.alertRatio) : 0;
  // The window plus slack, so a key outlives a caller whose clock is a little behind Redis's.
  const ttlSeconds = Math.ceil(BUDGET_WINDOW_MS / 1000) + 5;

  let failWindow = -Infinity;
  let failSuppressed = 0;
  const failOpen = (error: unknown) => {
    const at = now();
    if (at - failWindow < BUDGET_WINDOW_MS) {
      failSuppressed += 1;
      return;
    }
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
    warn(
      `[shareflow] the token budget could not reach Redis (${message}); turns run without a budget until it can` +
        (failSuppressed > 0 ? ` (${failSuppressed} more like this in the last minute)` : "") +
        ".",
    );
    failWindow = at;
    failSuppressed = 0;
  };

  const raise = (windowStartMs: number, platformUsed: number) => {
    alert(
      `[shareflow] ops-alert ${JSON.stringify({
        alert: "platform_tpm_high",
        level: "warn",
        message: `platform-key usage passed ${Math.round(config.alertRatio * 100)}% of the per-minute token limit`,
        windowStart: new Date(windowStartMs).toISOString(),
        usedTokens: platformUsed,
        limitTokens: config.platformTpm,
        ratio: Math.round((platformUsed / config.platformTpm) * 1000) / 1000,
      })}`,
    );
  };

  return {
    config,
    async admit({ workspaceId, tokens, force = false }) {
      if (!enabled) return { admitted: true };
      const at = now();
      const windowStartMs = budgetWindowStart(at);
      const asked = Math.max(1, Math.round(tokens));
      let result: ReserveResult;
      try {
        result = await withTimeout(
          store.reserve({
            workspaceId,
            windowStartMs,
            tokens: asked,
            workspaceLimit: config.workspaceTpm,
            platformLimit: config.platformTpm,
            alertAt,
            force,
            ttlSeconds,
          }),
          timeoutMs,
        );
      } catch (error) {
        failOpen(error);
        return { admitted: true };
      }
      if (result.alert) raise(windowStartMs, result.platformUsed);
      if (result.admitted) return { admitted: true, reservation: { workspaceId, windowStartMs, tokens: asked } };
      const overWorkspace = config.workspaceTpm > 0 && result.workspaceUsed > 0 && result.workspaceUsed + asked > config.workspaceTpm;
      return { admitted: false, waitMs: Math.max(1, windowStartMs + BUDGET_WINDOW_MS - at), scope: overWorkspace ? "workspace" : "platform" };
    },
    async reconcile(reservation, actualTokens) {
      if (reservation === undefined) return;
      const delta = Math.round(actualTokens) - reservation.tokens;
      // A window that has ended no longer holds anybody back, so correcting it changes nothing.
      if (delta === 0 || budgetWindowStart(now()) !== reservation.windowStartMs) return;
      try {
        const result = await withTimeout(
          store.adjust({ workspaceId: reservation.workspaceId, windowStartMs: reservation.windowStartMs, delta, alertAt, ttlSeconds }),
          timeoutMs,
        );
        if (result.alert) raise(reservation.windowStartMs, result.platformUsed);
      } catch (error) {
        failOpen(error);
      }
    },
  };
};

/** One model call's place in the budget, settled when the call finishes. */
export type CallTicket = {
  /** The call's real usage, or `undefined` when it was refused (a refused call used nothing). */
  readonly settle: (usage: ModelCallUsage | undefined) => void;
};

/**
 * Asked before every model call of a turn: resolves with a ticket when the call may go, throws a retryable
 * `queued` error to wait where the person can see it, or a final error once the wait would pass its bound.
 */
export type CallGate = (call: {
  readonly params: unknown;
  /** Whose key the call runs on. A workspace's own key is never counted. */
  readonly source: "deployment" | "workspace";
  readonly signal?: AbortSignal | undefined;
}) => Promise<CallTicket | undefined>;

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

/** The error that makes the engine show the wait and try again after it. */
export const queuedError = (waitMs: number, queuedMs: number, scope: "workspace" | "platform"): AgentPlatformError =>
  new AgentPlatformError({
    code: "rate_limited",
    message: `${scope === "workspace" ? "this workspace's share of the platform's" : "the platform's"} per-minute token budget is in use; the turn is queued for about ${Math.ceil(waitMs / 1000)} s`,
    retryable: true,
    retryAfterMs: waitMs,
    details: { reason: "queued", scope, waitMs, queuedMs },
  });

/** The error past the bound: not retryable, so the run fails with it instead of waiting on. */
export const queueTimeoutError = (queuedMs: number, maxQueueMs: number): AgentPlatformError =>
  new AgentPlatformError({
    code: "rate_limited",
    message: `the platform's per-minute token budget stayed full for ${Math.round(queuedMs / 1000)} s (the most a turn waits is ${Math.round(maxQueueMs / 1000)} s); the turn was not sent to the model`,
    retryable: false,
    details: { reason: "queue_timeout", queuedMs, maxQueueMs },
  });

/**
 * One turn's gate. Built per turn, because what it remembers — whether the turn has started, how long it has been
 * queued, how many waits the engine has shown — describes that turn alone.
 */
export const createTurnBudgetGate = (input: {
  readonly budget: TokenBudget;
  readonly workspaceId: string;
  readonly runId?: unknown;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly visibleRetries?: number;
  /** Told once the turn is admitted after waiting: how long it waited. For the log and the load test. */
  readonly onWaited?: (waitedMs: number) => void;
  readonly log?: (line: string) => void;
}): CallGate => {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? pause;
  const visibleRetries = input.visibleRetries ?? VISIBLE_QUEUE_RETRIES;
  const log = input.log ?? ((line: string) => console.info(line));
  const run = String(input.runId ?? "?").slice(0, 8);
  let started = false;
  let queuedSince: number | undefined;
  let shown = 0;

  return async ({ params, source, signal }) => {
    if (source === "workspace") return undefined;
    const tokens = estimateCallTokens(params as never);
    for (;;) {
      const admission = await input.budget.admit({ workspaceId: input.workspaceId, tokens, force: started });
      if (admission.admitted) {
        if (!started && queuedSince !== undefined) {
          const waited = now() - queuedSince;
          log(`[shareflow] run ${run}: admitted after ${Math.round(waited / 1000)} s in the token-budget queue.`);
          input.onWaited?.(waited);
        }
        started = true;
        const reservation = admission.reservation;
        return {
          settle: (usage) => {
            const actual = usage === undefined ? 0 : usage.inputTokens + usage.outputTokens;
            input.budget.reconcile(reservation, actual).catch(() => {});
          },
        };
      }
      const at = now();
      queuedSince ??= at;
      const queued = at - queuedSince;
      if (queued + admission.waitMs > input.budget.config.maxQueueMs) {
        log(`[shareflow] run ${run}: the token budget stayed full; giving up after ${Math.round(queued / 1000)} s queued.`);
        throw queueTimeoutError(queued, input.budget.config.maxQueueMs);
      }
      log(`[shareflow] run ${run}: ~${tokens} tokens would pass the ${admission.scope} per-minute budget; queued for ${Math.ceil(admission.waitMs / 1000)} s.`);
      if (shown < visibleRetries) {
        shown += 1;
        throw queuedError(admission.waitMs, queued, admission.scope);
      }
      await sleep(admission.waitMs, signal);
    }
  };
};
