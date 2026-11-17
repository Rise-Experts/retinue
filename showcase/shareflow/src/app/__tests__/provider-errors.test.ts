/**
 * #651 — a provider's "slow down" becomes an error the run retries.
 *
 * agentkit retries only a retryable `AgentPlatformError`; the AI SDK's own errors became `internal, retryable:false`
 * and failed the turn in ~7 s. Google words a per-minute limit "You exceeded your current quota" (production,
 * 2026-09-30, parts 26, 78, 79 — each worked a minute later).
 */
import { describe, expect, it } from "vitest";

import { AgentPlatformError } from "@retinue/agentkit";

import { DEFAULT_RATE_LIMIT_DELAY_MS, STEP_RETRY_MAX_MS, asRetryable, retryableProviderError, withRetryableStreamErrors, withStepRetry } from "../provider-errors.js";
import { classifyProviderFailure, friendlyRunError } from "../run-errors.js";

/** The AI SDK's APICallError, as far as this code reads it. */
const apiError = (statusCode: number, responseBody: string, message = "Resource has been exhausted (e.g. check quota).") =>
  Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody, responseHeaders: {} });

const GOOGLE_PER_MINUTE = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count", quotaId: "GenerateContentPaidTierInputTokensPerModelPerMinute" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" },
    ],
  },
});
const GOOGLE_PER_DAY = GOOGLE_PER_MINUTE.replace("PerModelPerMinute", "PerModelPerDay");
const GOOGLE_PREPAY = JSON.stringify({ error: { code: 429, message: "Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.", status: "RESOURCE_EXHAUSTED" } });

describe("retryableProviderError", () => {
  it("makes Google's per-minute 429 retryable, with Google's own delay", () => {
    const error = retryableProviderError(apiError(429, GOOGLE_PER_MINUTE));
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error?.toPlatformError()).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 37_000 });
  });

  it("finds the provider's error under the SDK's RetryError", () => {
    const retryError = Object.assign(new Error("Failed after 3 attempts. Last error: Resource has been exhausted"), { name: "AI_RetryError", reason: "maxRetriesExceeded", lastError: apiError(429, GOOGLE_PER_MINUTE) });
    expect(retryableProviderError(retryError)?.toPlatformError().code).toBe("rate_limited");
  });

  it("waits long enough to reach the next minute when the provider gives no delay (production, 2026-10-01)", () => {
    const error = retryableProviderError(apiError(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'));
    expect(error?.toPlatformError().retryAfterMs).toBe(DEFAULT_RATE_LIMIT_DELAY_MS);
    expect(DEFAULT_RATE_LIMIT_DELAY_MS * 4).toBeGreaterThanOrEqual(60_000);
  });

  it("uses a retry-after header when the body has no delay", () => {
    const error = Object.assign(apiError(429, "{}", "Too Many Requests"), { responseHeaders: { "retry-after": "12" } });
    expect(retryableProviderError(error)?.toPlatformError().retryAfterMs).toBe(12_000);
  });

  it("makes overload retryable (Anthropic 529, Google 503)", () => {
    expect(retryableProviderError(apiError(529, '{"type":"overloaded_error"}', "Overloaded"))?.toPlatformError()).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(retryableProviderError(apiError(503, '{"status":"UNAVAILABLE"}', "The model is overloaded"))?.toPlatformError().retryable).toBe(true);
  });

  it("leaves an empty balance and a per-day limit alone: waiting does not fix them", () => {
    expect(retryableProviderError(apiError(429, GOOGLE_PREPAY))).toBeUndefined();
    expect(retryableProviderError(apiError(429, GOOGLE_PER_DAY))).toBeUndefined();
    expect(retryableProviderError(apiError(429, "{}", "You exceeded your current quota: insufficient_quota"))).toBeUndefined();
  });

  it("leaves other failures and platform errors alone", () => {
    expect(retryableProviderError(apiError(400, "{}", "Invalid argument"))).toBeUndefined();
    const own = new AgentPlatformError({ code: "timeout", message: "t", retryable: true });
    expect(asRetryable(own)).toBe(own);
    expect(asRetryable("boom")).toBe("boom");
  });
});

describe("withRetryableStreamErrors", () => {
  it("rewrites an error part and passes everything else through", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", id: "t", delta: "hi" });
        controller.enqueue({ type: "error", error: apiError(429, GOOGLE_PER_MINUTE) });
        controller.close();
      },
    });
    const reader = (withRetryableStreamErrors(source) as ReadableStream<{ type: string; error?: unknown }>).getReader();
    const parts: { type: string; error?: unknown }[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    expect(parts[0]).toEqual({ type: "text-delta", id: "t", delta: "hi" });
    expect(parts[1]?.error).toBeInstanceOf(AgentPlatformError);
  });
});

describe("the person's wording for a retried limit", () => {
  it("says busy, not unavailable, for rate_limited — even in Google's quota words", () => {
    expect(classifyProviderFailure({ code: "rate_limited", message: "You exceeded your current quota (per minute)" })).toBe("rate_limit");
    expect(friendlyRunError({ code: "rate_limited", message: "the model provider is rate-limiting requests (per-minute limit, HTTP 429); retrying" }, "platform")).toMatchObject({
      code: "rate_limited",
      retryable: true,
      message: "The assistant is busy right now. Please try again in a minute.",
    });
  });

  it("still names an empty balance as billing", () => {
    expect(classifyProviderFailure({ code: "rate_limited", message: "Your prepayment credits are depleted" })).toBe("billing");
  });
});

/**
 * A refused model call is retried where it failed — production, 2026-10-01: the call after a tool (the deck was made)
 * was refused as busy, and the engine does not retry once output has streamed.
 */
describe("withStepRetry", () => {
  const busy = () => new AgentPlatformError({ code: "rate_limited", message: "busy", retryable: true, retryAfterMs: 37_000 });

  it("retries a busy refusal, waiting the provider's delay capped at 20 s", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withStepRetry(async () => {
      calls += 1;
      if (calls < 3) throw busy();
      return "ok";
    }, { sleep: async (ms) => { waits.push(ms); } });
    expect(result).toBe("ok");
    expect(waits).toEqual([STEP_RETRY_MAX_MS, STEP_RETRY_MAX_MS]);
  });

  it("gives up after two retries and passes the refusal up to the run", async () => {
    let calls = 0;
    await expect(withStepRetry(async () => { calls += 1; throw busy(); }, { sleep: async () => {} })).rejects.toBeInstanceOf(AgentPlatformError);
    expect(calls).toBe(3);
  });

  it("does not retry anything else, or once cancelled", async () => {
    let calls = 0;
    await expect(withStepRetry(async () => { calls += 1; throw new Error("bad request"); }, { sleep: async () => {} })).rejects.toThrow("bad request");
    expect(calls).toBe(1);
    const controller = new AbortController();
    controller.abort();
    calls = 0;
    await expect(withStepRetry(async () => { calls += 1; throw busy(); }, { signal: controller.signal, sleep: async () => {} })).rejects.toBeInstanceOf(AgentPlatformError);
    expect(calls).toBe(1);
  });
});
