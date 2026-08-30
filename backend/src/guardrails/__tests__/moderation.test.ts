/**
 * The moderation adapter — REQ-046 (#205), task #212, AC-4.
 *
 * The properties worth pinning are about *cost* and *failure*, not about classification: the classifier is the
 * host's and its accuracy is not ours to test. What is ours is that we never call it when we said we would not,
 * and that a classifier outage stops turns rather than silently stopping moderation.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { ConversationId, RunId } from "../../core/ids.js";
import { applyInputGuardrails, applyOutputGuardrails } from "../index.js";
import { createModerationGuardrail } from "../moderation.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
  runId: asId<RunId>("r1"),
};

const clean = () => ({ flagged: false });

describe("cost is the host's to control — AC-4", () => {
  it("spends two calls per turn by default: input and message", async () => {
    const classify = vi.fn(clean);
    const guardrail = createModerationGuardrail({ classify });
    await applyInputGuardrails([guardrail], { text: "hello" }, context);
    await applyOutputGuardrails([guardrail], { kind: "message", text: "hi back" }, context);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("inspecting only the input halves the cost, and leaves output unchecked", async () => {
    const classify = vi.fn(clean);
    const guardrail = createModerationGuardrail({ classify, subjects: ["input"] });
    // No `inspectOutput` at all, so the composer skips it rather than calling a hook that returns pass — the
    // difference is a classifier call that never happens.
    expect(guardrail.inspectOutput).toBeUndefined();
    await applyOutputGuardrails([guardrail], { kind: "message", text: "anything" }, context);
    expect(classify).not.toHaveBeenCalled();
  });

  it("never classifies a tool call's arguments", async () => {
    const classify = vi.fn(clean);
    const guardrail = createModerationGuardrail({ classify, subjects: ["input", "message", "tool-result"] });
    await applyOutputGuardrails([guardrail], { kind: "tool-call", toolName: "x", input: { a: 1 } }, context);
    // Classifying a JSON object produces confident nonsense; the PII guardrail is the one that reads arguments.
    expect(classify).not.toHaveBeenCalled();
  });

  it("skips a tool result that is not text, and classifies one that is", async () => {
    const classify = vi.fn(clean);
    const guardrail = createModerationGuardrail({ classify, subjects: ["tool-result"] });
    await applyOutputGuardrails([guardrail], { kind: "tool-result", toolName: "x", output: { rows: 3 } }, context);
    expect(classify).not.toHaveBeenCalled();
    await applyOutputGuardrails([guardrail], { kind: "tool-result", toolName: "x", output: "some prose" }, context);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("does not spend a call on an empty string", async () => {
    const classify = vi.fn(clean);
    await applyInputGuardrails([createModerationGuardrail({ classify })], { text: "   " }, context);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("verdicts", () => {
  it("refuses when flagged, naming categories and not content", async () => {
    const guardrail = createModerationGuardrail({ classify: () => ({ flagged: true, categories: ["violence"] }) });
    const decision = await applyInputGuardrails([guardrail], { text: "something awful and specific" }, context);
    if (decision.outcome !== "refused") throw new Error("expected a refusal");
    expect(decision.message).toContain("violence");
    expect(decision.message).not.toContain("something awful and specific");
  });

  it("a classifier outage stops the turn rather than stopping moderation", async () => {
    const guardrail = createModerationGuardrail({ classify: () => { throw new Error("503 from the classifier"); } });
    const decision = await applyInputGuardrails([guardrail], { text: "hello" }, context);
    // The expensive-looking choice, deliberately: the alternative is an outage nobody notices, during which
    // everything passes.
    expect(decision.outcome).toBe("refused");
    if (decision.outcome === "refused") expect(decision.code).toBe("guardrail_failed");
  });

  it("passes clean content without a verdict beyond the record", async () => {
    const decision = await applyInputGuardrails([createModerationGuardrail({ classify: clean })], { text: "hi" }, context);
    expect(decision.outcome).toBe("allowed");
    expect(decision.records[0]).toMatchObject({ guardrail: "moderation", outcome: "pass" });
  });

  it("can be named, so two classifiers are distinguishable in the log", async () => {
    const decision = await applyInputGuardrails(
      [createModerationGuardrail({ classify: clean, name: "openai-moderation" })],
      { text: "hi" },
      context,
    );
    expect(decision.records[0]?.guardrail).toBe("openai-moderation");
  });
});
