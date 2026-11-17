/**
 * #628: a provider's refusal is stored and streamed in safe words; the raw text reaches the log only.
 */
import { describe, expect, it } from "vitest";

import {
  classifyProviderFailure,
  friendlyRunError,
  withFriendlyRunErrors,
  withFriendlyRunStoreErrors,
} from "../run-errors.js";
import { noteTurnModel } from "../turn-billing.js";
import { withTurnLogging } from "../turn-logging.js";

const GOOGLE_DEPLETED =
  "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.";

describe("classifyProviderFailure", () => {
  it.each([
    [GOOGLE_DEPLETED, "billing"],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", "billing"],
    ["You exceeded your current quota, please check your plan and billing details.", "quota"],
    ["insufficient_quota", "quota"],
    ["429 RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).", "quota"],
    ["Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM)", "rate_limit"],
    ["Too Many Requests", "rate_limit"],
    ["Overloaded", "overloaded"],
    ["{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}", "overloaded"],
    ["Incorrect API key provided: sk-abc***. You can find your API key at https://platform.openai.com/account/api-keys.", "auth"],
    ["invalid x-api-key", "auth"],
    ["API key not valid. Please pass a valid API key.", "auth"],
    ["Request failed with status code 401", "auth"],
  ] as const)("%s → %s", (message, reason) => {
    expect(classifyProviderFailure({ code: "internal", message })).toBe(reason);
  });

  it("leaves everything else alone", () => {
    expect(classifyProviderFailure({ code: "internal", message: "run failed: worker lost the lease" })).toBeUndefined();
    expect(classifyProviderFailure({ code: "internal", message: "The model returned no answer three times in a row." })).toBeUndefined();
    // A bare number is not evidence of anything.
    expect(classifyProviderFailure({ code: "internal", message: "Post 429 could not be found" })).toBeUndefined();
  });

  it("never re-describes a code that already means something to the app", () => {
    expect(classifyProviderFailure({ code: "budget_exceeded", message: "insufficient credits" })).toBeUndefined();
    expect(classifyProviderFailure({ code: "cancelled", message: "rate limit" })).toBeUndefined();
    expect(classifyProviderFailure({ code: "approval_denied", message: "Overloaded" })).toBeUndefined();
  });

  it("reads a bare rate_limited code as a rate limit", () => {
    expect(classifyProviderFailure({ code: "rate_limited", message: "" })).toBe("rate_limit");
  });
});

describe("friendlyRunError", () => {
  it("platform key: a stable code, the safe sentence, no provider text", () => {
    const friendly = friendlyRunError({ code: "internal", message: GOOGLE_DEPLETED, retryable: false }, "platform");
    expect(friendly).toEqual({
      code: "provider_unavailable",
      message: "The assistant is temporarily unavailable. Please try again later.",
      retryable: false,
      details: { reason: "billing", keySource: "platform" },
    });
    expect(JSON.stringify(friendly)).not.toMatch(/ai\.studio|prepayment/);
  });

  it("the workspace's own key says so and points at Settings", () => {
    const friendly = friendlyRunError({ code: "internal", message: "You exceeded your current quota" }, "workspace");
    expect(friendly.message).toMatch(/Your AI provider refused the request .*Settings → AI providers/);
    expect(friendly.details).toEqual({ reason: "quota", keySource: "workspace" });
  });

  it("uses codes from the platform's closed set", () => {
    expect(friendlyRunError({ code: "internal", message: "Too Many Requests" }, "platform").code).toBe("rate_limited");
    expect(friendlyRunError({ code: "internal", message: "invalid x-api-key" }, "workspace").code).toBe("unauthorized");
    expect(friendlyRunError({ code: "internal", message: "Too Many Requests" }, "platform").retryable).toBe(true);
  });

  it("returns an unrelated error unchanged, by identity", () => {
    const error = { code: "internal", message: "worker lost the lease", retryable: false };
    expect(friendlyRunError(error, "platform")).toBe(error);
  });
});

describe("withFriendlyRunErrors", () => {
  const harness = () => {
    const persisted: { type?: string; error?: { message?: string; details?: unknown } }[] = [];
    const lines: string[] = [];
    const errors: string[] = [];
    const original = console.error;
    const log = withTurnLogging(
      withFriendlyRunErrors({ append: async (input: { tenantId: unknown; event: unknown }) => void persisted.push(input.event as never) }),
      (line) => lines.push(line),
    );
    return {
      log,
      persisted,
      errors,
      capture: async (fn: () => Promise<void>) => {
        console.error = (message: string) => void errors.push(message);
        try {
          await fn();
        } finally {
          console.error = original;
        }
      },
    };
  };

  it("persists the safe error while the log line keeps the provider's words", async () => {
    const { log, persisted, errors, capture } = harness();
    await capture(async () => {
      await log.append({ tenantId: "ws-1", event: { type: "run.started", runId: "run-a" } });
      await log.append({ tenantId: "ws-1", event: { type: "run.failed", runId: "run-a", error: { code: "internal", message: GOOGLE_DEPLETED, retryable: false } } });
    });
    expect(persisted[1]?.error?.message).toBe("The assistant is temporarily unavailable. Please try again later.");
    expect(persisted[1]?.error?.details).toEqual({ reason: "billing", keySource: "platform" });
    expect(errors.join("\n")).toContain("prepayment credits are depleted");
  });

  it("knows a BYO run from the model the engine noted for it", async () => {
    const { log, persisted } = harness();
    noteTurnModel("run-byo", () => true);
    await log.append({ tenantId: "ws-1", event: { type: "run.failed", runId: "run-byo", error: { code: "internal", message: "insufficient_quota" } } });
    expect(persisted[0]?.error?.details).toEqual({ reason: "quota", keySource: "workspace" });
  });

  it("passes every other event through untouched", async () => {
    const { log, persisted } = harness();
    const event = { type: "run.failed", runId: "run-b", error: { code: "internal", message: "worker lost the lease" } };
    await log.append({ tenantId: "ws-1", event });
    await log.append({ tenantId: "ws-1", event: { type: "part.added", runId: "run-b" } });
    expect(persisted[0]).toBe(event);
    expect(persisted).toHaveLength(2);
  });

  it("rewrites a retry-pending event's error too", async () => {
    const { log, persisted } = harness();
    await log.append({ tenantId: "ws-1", event: { type: "run.retry-pending", runId: "run-c", error: { code: "rate_limited", message: "Rate limit reached for gpt-4o" } } });
    expect(persisted[0]?.error?.message).toMatch(/busy/);
  });
});

describe("withFriendlyRunStoreErrors", () => {
  it("rewrites the error a failed run is stored with", async () => {
    const seen: unknown[] = [];
    const runs = withFriendlyRunStoreErrors({ transition: async (input: Record<string, unknown>) => void seen.push(input), other: 1 });
    await runs.transition({ id: "run-d", to: "failed", error: { code: "internal", message: GOOGLE_DEPLETED } });
    await runs.transition({ id: "run-d", to: "running" });
    expect((seen[0] as { error: { message: string } }).error.message).not.toMatch(/prepayment/);
    expect(seen[1]).toEqual({ id: "run-d", to: "running" });
    expect(runs.other).toBe(1);
  });
});

/** #668: the platform's own queue keeps its reason; it is not re-described as a provider rate limit. */
describe("the token-budget queue", () => {
  it("says the turn is queued, with the wait", () => {
    const error = {
      code: "rate_limited",
      message: "the platform's per-minute token budget is in use; the turn is queued for about 42 s",
      retryable: true,
      retryAfterMs: 41_500,
      details: { reason: "queued", scope: "platform", waitMs: 41_500, queuedMs: 0 },
    };
    expect(friendlyRunError(error, "platform")).toEqual({
      code: "rate_limited",
      message: "The assistant is busy; your message is queued and starts in about 42 s.",
      retryable: true,
      details: { reason: "queued", keySource: "platform", waitMs: 41_500 },
      retryAfterMs: 41_500,
    });
  });

  it("says plainly that a turn queued past the bound did not start", () => {
    const friendly = friendlyRunError(
      { code: "rate_limited", message: "the platform's per-minute token budget stayed full", retryable: false, details: { reason: "queue_timeout" } },
      "platform",
    );
    expect(friendly).toMatchObject({ code: "rate_limited", retryable: false, details: { reason: "queue_timeout", keySource: "platform" } });
    expect(String(friendly.message)).toContain("send it again");
  });
});
