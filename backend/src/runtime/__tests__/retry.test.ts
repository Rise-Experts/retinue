import { describe, expect, it, vi } from "vitest";
import { AgentPlatformError, type PlatformError } from "../../core/errors.js";
import {
  backoffMs,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  isRetryableStatus,
  parseRetryAfterMs,
  runWithRetry,
  statusToErrorCode,
} from "../retry.js";

const transient = (over: Partial<PlatformError> = {}): PlatformError => ({
  code: "rate_limited",
  message: "slow down",
  retryable: true,
  ...over,
});

describe("transient classification", () => {
  it("retries only 408/409/429/5xx/529, never deterministic 4xx", () => {
    for (const s of [408, 409, 429, 500, 502, 503, 529]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false);
  });

  it("maps statuses to platform error codes", () => {
    expect(statusToErrorCode(429)).toBe("rate_limited");
    expect(statusToErrorCode(408)).toBe("timeout");
    expect(statusToErrorCode(529)).toBe("provider_unavailable");
    expect(statusToErrorCode(500)).toBe("provider_error");
  });
});

describe("parseRetryAfterMs", () => {
  const now = Date.UTC(2020, 0, 1);
  it("prefers retry-after-ms", () => {
    expect(parseRetryAfterMs({ retryAfterMs: 1500 }, now)).toBe(1500);
  });
  it("reads delta-seconds", () => {
    expect(parseRetryAfterMs({ retryAfter: "3" }, now)).toBe(3000);
  });
  it("reads an HTTP-date relative to now", () => {
    const when = new Date(now + 5000).toUTCString();
    expect(parseRetryAfterMs({ retryAfter: when }, now)).toBe(5000);
  });
  it("returns undefined when absent or garbage", () => {
    expect(parseRetryAfterMs({}, now)).toBeUndefined();
    expect(parseRetryAfterMs({ retryAfter: "soon" }, now)).toBeUndefined();
  });
});

describe("backoff", () => {
  it("grows geometrically and caps at maxDelayMs", () => {
    const p = DEFAULT_RETRY_POLICY;
    expect(backoffMs(p, 1)).toBe(500);
    expect(backoffMs(p, 2)).toBe(1000);
    expect(backoffMs(p, 3)).toBe(2000);
    expect(backoffMs(p, 99)).toBe(p.maxDelayMs);
  });
});

describe("decideRetry", () => {
  it("does not retry a non-retryable error", () => {
    expect(decideRetry({ error: transient({ retryable: false }), attempt: 1, policy: DEFAULT_RETRY_POLICY })).toEqual({
      retry: false,
      reason: "non-retryable",
    });
  });

  it("stops once the attempt budget is exhausted", () => {
    expect(decideRetry({ error: transient(), attempt: 5, policy: DEFAULT_RETRY_POLICY })).toEqual({
      retry: false,
      reason: "exhausted",
    });
  });

  it("applies negative jitter within [1-jitter, 1] of the backoff", () => {
    const full = decideRetry({ error: transient(), attempt: 2, policy: DEFAULT_RETRY_POLICY, random: () => 0 });
    const shaved = decideRetry({ error: transient(), attempt: 2, policy: DEFAULT_RETRY_POLICY, random: () => 1 });
    expect(full).toMatchObject({ retry: true, delayMs: 1000 }); // 1000 * (1 - 0)
    expect(shaved).toMatchObject({ retry: true, delayMs: 750 }); // 1000 * (1 - 0.25)
  });

  it("honors retry-after as a floor, capped so a hostile value cannot stall", () => {
    const honored = decideRetry({
      error: transient({ retryAfterMs: 4000 }),
      attempt: 1,
      policy: DEFAULT_RETRY_POLICY,
      random: () => 0,
    });
    expect(honored).toMatchObject({ retry: true, delayMs: 4000 }); // max(500, 4000)
    const capped = decideRetry({
      error: transient({ retryAfterMs: 10 * 60_000 }),
      attempt: 1,
      policy: DEFAULT_RETRY_POLICY,
      random: () => 0,
    });
    expect(capped).toMatchObject({ delayMs: DEFAULT_RETRY_POLICY.retryAfterCapMs });
  });
});

describe("runWithRetry", () => {
  it("retries transient failures then returns, emitting retry-pending each time", async () => {
    const sleep = vi.fn(async () => {});
    const pending: number[] = [];
    let calls = 0;
    const result = await runWithRetry({
      now: () => Date.UTC(2020, 0, 1),
      random: () => 0,
      sleep,
      onRetryPending: (info) => {
        pending.push(info.attempt);
      },
      operation: async (attempt) => {
        calls = attempt;
        if (attempt < 3) throw new AgentPlatformError(transient());
        return "ok";
      },
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(pending).toEqual([1, 2]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last error unchanged once the budget is exhausted", async () => {
    let calls = 0;
    await expect(
      runWithRetry({
        now: () => 0,
        random: () => 0,
        sleep: async () => {},
        policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
        operation: async () => {
          calls += 1;
          throw new AgentPlatformError(transient({ code: "provider_unavailable", message: "boom" }));
        },
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable", message: "boom" });
    expect(calls).toBe(3);
  });

  it("fails fast on a non-retryable error without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      runWithRetry({
        now: () => 0,
        sleep,
        operation: async () => {
          calls += 1;
          throw new AgentPlatformError({ code: "invalid_input", message: "bad", retryable: false });
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
