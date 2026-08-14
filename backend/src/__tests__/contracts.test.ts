import { describe, expect, it } from "vitest";

import { canTransition, isTerminal, RUN_STATUSES } from "../runtime/index.js";
import { classifyMcpTool, mcpToolName } from "../mcp/index.js";
import { AgentPlatformError } from "../core/errors.js";
import { SKILL_LIMITS } from "../skills/index.js";

describe("run lifecycle", () => {
  it("matches the state machine in docs/04", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "waiting-for-approval")).toBe(true);
    expect(canTransition("waiting-for-approval", "queued")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false);
  });

  it("treats only completed, failed and cancelled as terminal", () => {
    const terminal = RUN_STATUSES.filter(isTerminal);
    expect(terminal).toEqual(["completed", "failed", "cancelled"]);
  });
});

describe("mcp tool classification", () => {
  it("defaults an unclassified tool to external-write, not read", () => {
    expect(classifyMcpTool({})).toEqual({ effect: "external-write", source: "default" });
  });

  it("does not let a remote readOnlyHint downgrade the effect on its own", () => {
    expect(classifyMcpTool({ readOnlyHint: true }).effect).toBe("external-write");
  });

  it("honours an administrator classification", () => {
    expect(classifyMcpTool({}, "read")).toEqual({ effect: "read", source: "administrator" });
  });

  it("escalates on a destructive hint", () => {
    expect(classifyMcpTool({ destructiveHint: true }).effect).toBe("destructive");
  });

  it("namespaces tool names per server", () => {
    expect(mcpToolName("acme", "search")).toBe("mcp__acme__search");
  });
});

describe("skill limits", () => {
  it("accepts slug names and rejects the rest", () => {
    expect(SKILL_LIMITS.namePattern.test("post-composition")).toBe(true);
    expect(SKILL_LIMITS.namePattern.test("Post Composition")).toBe(false);
  });
});

describe("platform errors", () => {
  it("drops the cause and stack on the wire form", () => {
    const error = new AgentPlatformError(
      { code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 1_000 },
      { cause: new Error("upstream detail") },
    );

    expect(error.toPlatformError()).toEqual({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
      retryAfterMs: 1_000,
    });
  });
});
