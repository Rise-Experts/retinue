/**
 * #668: the platform key's per-minute token budget — a turn over it waits, visibly and for a bounded time,
 * instead of failing on the provider's 429.
 */
import { AgentPlatformError } from "@retinue/agentkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUDGET_WINDOW_MS,
  budgetWindowStart,
  createMemoryTokenBudgetStore,
  createRedisTokenBudgetStore,
  createTokenBudget,
  createTurnBudgetGate,
  tokenBudgetConfigFrom,
  type TokenBudgetConfig,
  type TokenBudgetStore,
} from "../token-budget.js";
import { withWorkspaceModel } from "../workspace-turn-model.js";

/** One second into a window, so "the rest of this window" is 59 s. */
const T0 = budgetWindowStart(1_800_000_000_000) + 1_000;

const CONFIG: TokenBudgetConfig = { workspaceTpm: 100_000, platformTpm: 300_000, maxQueueMs: 120_000, alertRatio: 0.7 };

/** A prompt the estimator (chars / 4) reads as about `tokens` tokens. */
const promptOf = (tokens: number) => ({ prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(tokens * 4) }] }] });

const quiet = { warn: () => {}, alert: () => {} };

afterEach(() => {
  vi.useRealTimers();
});

describe("tokenBudgetConfigFrom", () => {
  it("defaults to a 1M platform limit and a 70% alert", () => {
    expect(tokenBudgetConfigFrom({})).toEqual({ workspaceTpm: 250_000, platformTpm: 1_000_000, maxQueueMs: 120_000, alertRatio: 0.7 });
  });

  it("reads each limit from the environment", () => {
    const config = tokenBudgetConfigFrom({
      SHAREFLOW_TPM_PER_WORKSPACE: "5000",
      SHAREFLOW_TPM_PLATFORM: "0",
      SHAREFLOW_TPM_MAX_QUEUE_MS: "30000",
      SHAREFLOW_TPM_ALERT_RATIO: "0.5",
    });
    expect(config).toEqual({ workspaceTpm: 5_000, platformTpm: 0, maxQueueMs: 30_000, alertRatio: 0.5 });
  });
});

describe("the budget", () => {
  it("admits up to the workspace's share, then names the wait to the end of the window", async () => {
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: CONFIG, now: () => T0, ...quiet });
    expect((await budget.admit({ workspaceId: "a", tokens: 60_000 })).admitted).toBe(true);
    const refused = await budget.admit({ workspaceId: "a", tokens: 60_000 });
    expect(refused).toEqual({ admitted: false, waitMs: BUDGET_WINDOW_MS - 1_000, scope: "workspace" });
    // Another workspace still has its own share.
    expect((await budget.admit({ workspaceId: "b", tokens: 60_000 })).admitted).toBe(true);
  });

  it("refuses at the platform limit even when each workspace has room", async () => {
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: CONFIG, now: () => T0, ...quiet });
    for (const id of ["a", "b", "c"]) expect((await budget.admit({ workspaceId: id, tokens: 100_000 })).admitted).toBe(true);
    const refused = await budget.admit({ workspaceId: "d", tokens: 1_000 });
    expect(refused).toMatchObject({ admitted: false, scope: "platform" });
  });

  it("admits a turn larger than the whole limit into an empty window, so it runs alone instead of never", async () => {
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: CONFIG, now: () => T0, ...quiet });
    expect((await budget.admit({ workspaceId: "a", tokens: 500_000 })).admitted).toBe(true);
    expect((await budget.admit({ workspaceId: "b", tokens: 10 })).admitted).toBe(false);
  });

  it("starts over in the next window", async () => {
    let now = T0;
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: CONFIG, now: () => now, ...quiet });
    await budget.admit({ workspaceId: "a", tokens: 100_000 });
    expect((await budget.admit({ workspaceId: "a", tokens: 1 })).admitted).toBe(false);
    now += BUDGET_WINDOW_MS;
    expect((await budget.admit({ workspaceId: "a", tokens: 100_000 })).admitted).toBe(true);
  });

  it("counts a forced call whatever the counters say — a turn already running is never cut off", async () => {
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: CONFIG, now: () => T0, ...quiet });
    await budget.admit({ workspaceId: "a", tokens: 100_000 });
    expect((await budget.admit({ workspaceId: "a", tokens: 50_000, force: true })).admitted).toBe(true);
  });

  it("corrects the estimate with the real usage", async () => {
    const store = createMemoryTokenBudgetStore();
    const budget = createTokenBudget({ store, config: CONFIG, now: () => T0, ...quiet });
    const admission = await budget.admit({ workspaceId: "a", tokens: 90_000 });
    if (!admission.admitted) throw new Error("expected an admission");
    await budget.reconcile(admission.reservation, 20_000);
    expect((await budget.admit({ workspaceId: "a", tokens: 70_000 })).admitted).toBe(true);
    // A refused call gives everything back.
    const second = await budget.admit({ workspaceId: "b", tokens: 50_000 });
    if (!second.admitted) throw new Error("expected an admission");
    await budget.reconcile(second.reservation, 0);
    expect(store.counters.get(`shareflow:tpm:ws:b:${budgetWindowStart(T0)}`)).toBe(0);
  });

  it("is off when both limits are 0", async () => {
    const reserve = vi.fn();
    const budget = createTokenBudget({
      store: { reserve, adjust: vi.fn() } as never,
      config: { ...CONFIG, workspaceTpm: 0, platformTpm: 0 },
      ...quiet,
    });
    expect(await budget.admit({ workspaceId: "a", tokens: 10_000_000 })).toEqual({ admitted: true });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("fails open when Redis throws, and says so once per window", async () => {
    const warn = vi.fn();
    let now = T0;
    const store: TokenBudgetStore = {
      reserve: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
      adjust: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const budget = createTokenBudget({ store, config: CONFIG, now: () => now, warn, alert: () => {} });
    for (let i = 0; i < 5; i += 1) expect((await budget.admit({ workspaceId: "a", tokens: 1_000_000 })).admitted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("ECONNREFUSED");
    now += BUDGET_WINDOW_MS;
    await budget.admit({ workspaceId: "a", tokens: 1 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain("4 more like this");
  });

  it("fails open when Redis does not answer in time", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const store: TokenBudgetStore = { reserve: () => new Promise(() => {}), adjust: () => new Promise(() => {}) };
    const budget = createTokenBudget({ store, config: CONFIG, warn, alert: () => {}, storeTimeoutMs: 500 });
    const admission = budget.admit({ workspaceId: "a", tokens: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await admission).toEqual({ admitted: true });
    expect(warn.mock.calls[0]?.[0]).toContain("no reply in 500 ms");
  });

  it("raises the 70% alert once per window, as one structured line", async () => {
    const alert = vi.fn();
    let now = T0;
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: CONFIG, now: () => now, warn: () => {}, alert });
    await budget.admit({ workspaceId: "a", tokens: 100_000 });
    await budget.admit({ workspaceId: "b", tokens: 100_000 });
    expect(alert).not.toHaveBeenCalled();
    await budget.admit({ workspaceId: "c", tokens: 10_000 }); // 210k of 300k: 70%
    await budget.admit({ workspaceId: "c", tokens: 10_000 });
    expect(alert).toHaveBeenCalledTimes(1);
    const line = String(alert.mock.calls[0]?.[0]);
    expect(line.startsWith("[shareflow] ops-alert ")).toBe(true);
    expect(JSON.parse(line.slice("[shareflow] ops-alert ".length))).toMatchObject({
      alert: "platform_tpm_high",
      level: "warn",
      usedTokens: 210_000,
      limitTokens: 300_000,
      ratio: 0.7,
    });
    now += BUDGET_WINDOW_MS;
    for (const id of ["a", "b", "c"]) await budget.admit({ workspaceId: id, tokens: 80_000 });
    expect(alert).toHaveBeenCalledTimes(2);
  });
});

describe("the Redis store", () => {
  it("sends the window's three keys and reads the script's reply", async () => {
    const evalCall = vi.fn(async () => [1, 500, 900, 0]);
    const store = createRedisTokenBudgetStore({ eval: evalCall });
    const result = await store.reserve({
      workspaceId: "ws1",
      windowStartMs: 60_000,
      tokens: 500,
      workspaceLimit: 1_000,
      platformLimit: 2_000,
      alertAt: 1_400,
      force: false,
      ttlSeconds: 65,
    });
    expect(result).toEqual({ admitted: true, workspaceUsed: 500, platformUsed: 900, alert: false });
    expect(evalCall.mock.calls[0]?.slice(1)).toEqual([
      3,
      "shareflow:tpm:ws:ws1:60000",
      "shareflow:tpm:platform:60000",
      "shareflow:tpm:alert:60000",
      500,
      1_000,
      2_000,
      "0",
      65,
      1_400,
    ]);
  });

  it("treats a reply of the wrong shape as a failure, not as an empty counter", async () => {
    const store = createRedisTokenBudgetStore({ eval: async () => null });
    await expect(store.adjust({ workspaceId: "a", windowStartMs: 0, delta: 1, alertAt: 0, ttlSeconds: 65 })).rejects.toThrow(/not the script's reply/);
  });
});

describe("the turn's gate", () => {
  const gateFor = (budget: ReturnType<typeof createTokenBudget>, now: () => number, sleep: (ms: number) => Promise<void>) =>
    createTurnBudgetGate({ budget, workspaceId: "a", now, sleep, log: () => {} });

  it("never counts a call on the workspace's own key", async () => {
    const admit = vi.fn();
    const gate = createTurnBudgetGate({ budget: { config: CONFIG, admit, reconcile: vi.fn() } as never, workspaceId: "a", log: () => {} });
    expect(await gate({ params: promptOf(1_000_000), source: "workspace" })).toBeUndefined();
    expect(admit).not.toHaveBeenCalled();
  });

  it("queues visibly three times, then waits inline, then gives up with a clear error past the bound", async () => {
    let now = T0;
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: { ...CONFIG, maxQueueMs: 300_000 }, now: () => now, ...quiet });
    await budget.admit({ workspaceId: "a", tokens: 100_000 });
    // Every sleep lands in a window another turn has already filled.
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      await budget.admit({ workspaceId: "a", tokens: 100_000 });
    });
    const gate = gateFor(budget, () => now, sleep);
    const call = { params: promptOf(10_000), source: "deployment" as const };

    for (let shown = 1; shown <= 3; shown += 1) {
      const queued = await gate(call).catch((thrown: unknown) => thrown);
      expect(queued).toBeInstanceOf(AgentPlatformError);
      expect(queued).toMatchObject({ code: "rate_limited", retryable: true, details: { reason: "queued", scope: "workspace" } });
      // The engine waits `retryAfterMs`, then asks again.
      now += (queued as AgentPlatformError).retryAfterMs ?? 0;
      await budget.admit({ workspaceId: "a", tokens: 100_000 });
    }
    // Queued 179 s so far: two more inline waits fit the 300 s bound, the third would not.
    const final = await gate(call).catch((thrown: unknown) => thrown);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(final).toMatchObject({ code: "rate_limited", retryable: false, details: { reason: "queue_timeout" } });
  });

  it("admits after the wait, tells how long it waited, and forces the turn's later calls", async () => {
    let now = T0;
    const budget = createTokenBudget({ store: createMemoryTokenBudgetStore(), config: CONFIG, now: () => now, ...quiet });
    await budget.admit({ workspaceId: "a", tokens: 100_000 });
    const waits: number[] = [];
    const gate = createTurnBudgetGate({ budget, workspaceId: "a", now: () => now, onWaited: (ms) => waits.push(ms), log: () => {} });
    const call = { params: promptOf(60_000), source: "deployment" as const };

    const queued = (await gate(call).catch((thrown: unknown) => thrown)) as AgentPlatformError;
    now += queued.retryAfterMs ?? 0;
    const ticket = await gate(call);
    expect(ticket).toBeDefined();
    expect(waits).toEqual([BUDGET_WINDOW_MS - 1_000]);
    // A second step of the same turn goes even though it passes the workspace's share.
    expect(await gate(call)).toBeDefined();
  });
});

/**
 * AC-1: twenty workspaces send a 50k-token turn each, at once, against a model that enforces the provider's
 * per-minute limit. Without the budget about half would hit the 429; with it every turn completes, and the ones
 * that waited did so in the queue.
 */
describe("AC-1: twenty workspaces at 50k tokens each", () => {
  const PROVIDER_TPM = 500_000;
  const TURN_TOKENS = 50_000;
  const WORKSPACES = 20;

  it("loses no turn, and records how long each queued", async () => {
    vi.useFakeTimers({ now: T0 });
    const budget = createTokenBudget({
      store: createMemoryTokenBudgetStore(),
      config: { workspaceTpm: 250_000, platformTpm: PROVIDER_TPM, maxQueueMs: 120_000, alertRatio: 0.7 },
      ...quiet,
    });

    /** The provider: input tokens per minute, refused with a 429 past the limit. */
    const served = new Map<number, number>();
    const providerRefusals: number[] = [];
    const provider = {
      doGenerate: async (params: { prompt: { content: { text: string }[] }[] }) => {
        const window = budgetWindowStart(Date.now());
        const input = Math.ceil(params.prompt[0]!.content[0]!.text.length / 4);
        const used = served.get(window) ?? 0;
        if (used + input > PROVIDER_TPM) {
          providerRefusals.push(Date.now());
          throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
        }
        served.set(window, used + input);
        return { content: [], usage: { inputTokens: input, outputTokens: 400 } };
      },
    };

    const waits: number[] = [];
    const retryPending: { workspace: string; reason: unknown; afterMs: number }[] = [];

    /** One turn, as the engine runs it: `resolveModel` once, then up to five attempts on a retryable error. */
    const runTurn = async (workspace: string): Promise<"completed" | "failed"> => {
      const turn = withWorkspaceModel({
        model: provider,
        context: { tenantId: workspace, runId: `run-${workspace}` } as never,
        resolve: async () => undefined,
        languageModelFor: async () => provider,
        wrap: ({ middleware }) => middleware,
        deployment: { provider: "google", modelId: "gemini-test" },
        gate: createTurnBudgetGate({ budget, workspaceId: workspace, onWaited: (ms) => waits.push(ms), log: () => {} }),
      });
      const middleware = turn.model as { wrapGenerate: (o: { doGenerate: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown> };
      const params = promptOf(TURN_TOKENS);
      for (let attempt = 1; ; attempt += 1) {
        try {
          await middleware.wrapGenerate({ doGenerate: () => provider.doGenerate(params as never), params });
          return "completed";
        } catch (thrown) {
          if (!(thrown instanceof AgentPlatformError) || !thrown.retryable || attempt >= 5) return "failed";
          const afterMs = Math.min(thrown.retryAfterMs ?? 500, 60_000);
          retryPending.push({ workspace, reason: (thrown.details as { reason?: unknown } | undefined)?.reason, afterMs });
          await new Promise((resolve) => setTimeout(resolve, afterMs));
        }
      }
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcomes = Promise.all(Array.from({ length: WORKSPACES }, (_, i) => runTurn(`ws-${String(i).padStart(2, "0")}`)));
    await vi.advanceTimersByTimeAsync(4 * BUDGET_WINDOW_MS);
    const results = await outcomes;
    warn.mockRestore();

    expect(results.filter((result) => result === "failed"), "a turn failed").toEqual([]);
    expect(providerRefusals, "the provider refused a call the budget let through").toEqual([]);
    for (const used of served.values()) expect(used).toBeLessThanOrEqual(PROVIDER_TPM);
    /*
     * About half fit the first minute (fewer than ten when an early call's real usage is reconciled before a later
     * call asks); the rest queued — visibly, through the engine's retry — and none waited past the bound.
     */
    expect(waits.length).toBeGreaterThanOrEqual(WORKSPACES / 2);
    for (const waited of waits) expect(waited).toBeLessThanOrEqual(120_000);
    expect(retryPending.length).toBeGreaterThanOrEqual(waits.length);
    expect(new Set(retryPending.map((entry) => entry.reason))).toEqual(new Set(["queued"]));
    const seconds = waits.map((ms) => Math.round(ms / 1000)).sort((a, b) => a - b);
    console.info(`[AC-1] ${WORKSPACES} turns, 0 failed; ${waits.length} queued, waits (s): ${seconds.join(", ")}`);
  });
});
