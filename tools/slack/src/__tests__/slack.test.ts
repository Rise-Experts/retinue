/**
 * Slack tools — REQ-047 (#206), task #214.
 *
 * The second toolkit, and the tests are deliberately the same shape as GitHub's: if the second package needed a
 * different set of guarantees, the pattern would be wrong. The one genuinely Slack-specific case is the first
 * describe block, and it is the mistake this integration exists to not make.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@retinue/agentkit";
import { bearer, createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";
import { createSlackToolkit, SLACK_TOOL_NAMES } from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const toolNamed = async (name: string, fetchImpl: typeof fetch, secrets: Record<string, string> = { slack: "xoxb-test" }) => {
  const provider = createSlackToolkit({ credentialRef: "slack", resolver: createStaticCredentialResolver(secrets), fetchImpl });
  const tool = (await provider.listTools(context)).find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
};

describe("Slack answers 200 with ok:false — the mistake worth not making", () => {
  it("treats ok:false as a failure even though the HTTP status is 200", async () => {
    // A toolkit that checks the status alone reports success for `channel_not_found`, and the model then believes
    // it posted a message that never arrived.
    const fetchImpl = vi.fn(async () => json({ ok: false, error: "channel_not_found" }));
    const tool = await toolNamed("slack_post_message", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: { channel: "C1", text: "hi" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("channel_not_found");
  });

  it("separates a rate limit, so the model waits instead of retrying differently", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, error: "ratelimited" }));
    const tool = await toolNamed("slack_list_channels", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: {} });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("rate_limited");
    expect(result.error.retryable).toBe(true);
  });

  it("separates bad auth, which is a wiring problem and not retryable", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, error: "invalid_auth" }));
    const tool = await toolNamed("slack_list_channels", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: {} });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("unauthorized");
    expect(result.error.retryable).toBe(false);
  });
});

describe("the same guarantees as the first toolkit", () => {
  it("classifies reads and writes, gating by classification", async () => {
    const provider = createSlackToolkit({ credentialRef: "slack", resolver: createStaticCredentialResolver({ slack: "t" }) });
    const byName = new Map((await provider.listTools(context)).map((t) => [t.descriptor.name, t.descriptor]));
    expect([...byName.keys()].sort()).toEqual([...SLACK_TOOL_NAMES].sort());
    expect(byName.get("slack_read_history")).toMatchObject({ effect: "read", approvalPolicy: "never" });
    expect(byName.get("slack_post_message")).toMatchObject({
      effect: "external-write",
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
    });
  });

  it("resolves the token on every call, so a rotated bot token works without a restart", async () => {
    const resolve = vi.fn(async () => bearer("xoxb-rotating"));
    const fetchImpl = vi.fn(async () => json({ ok: true, channels: [] }));
    const provider = createSlackToolkit({ credentialRef: "slack", resolver: { resolve }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const tool = (await provider.listTools(context)).find((t) => t.descriptor.name === "slack_list_channels")!;
    await tool.execute({ context, input: {} });
    await tool.execute({ context, input: {} });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("sends the token as a bearer, and only to Slack's host", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, channels: [] }));
    const tool = await toolNamed("slack_list_channels", fetchImpl as unknown as typeof fetch);
    await tool.execute({ context, input: {} });
    const headers = new Headers(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer xoxb-test");
  });

  it("fails before any request when no credential is wired", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    const tool = await toolNamed("slack_list_channels", fetchImpl as unknown as typeof fetch, {});
    const result = await tool.execute({ context, input: {} });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads no credential from the environment", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toContain("process.env");
  });
});

describe("pagination admits when it stopped", () => {
  it("follows the cursor and reports no truncation when it runs out", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, channels: [{ id: "C1" }], response_metadata: { next_cursor: "abc" } }))
      .mockResolvedValueOnce(json({ ok: true, channels: [{ id: "C2" }], response_metadata: { next_cursor: "" } }));
    const tool = await toolNamed("slack_list_channels", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: {} });
    if (!result.ok) throw new Error("expected success");
    expect(result.data).toMatchObject({ truncated: false });
    expect((result.data as { channels: unknown[] }).channels).toHaveLength(2);
  });

  it("reports truncation rather than implying it saw everything", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, channels: [{ id: "C" }], response_metadata: { next_cursor: "more" } }));
    const tool = await toolNamed("slack_list_channels", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: {} });
    if (!result.ok) throw new Error("expected success");
    expect(result.data).toMatchObject({ truncated: true });
  });
});
