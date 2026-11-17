import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";

import { RECALL_PAGE_CHARS, createToolResultRecallService, parseToolResultRef, toolResultRef } from "../tool-results.js";

const stored = {
  id: "msg-1",
  conversationId: "conv-1",
  role: "assistant",
  parts: [
    { type: "tool-call", toolCallId: "call-1", toolName: "search_web", input: { query: "q" } },
    { type: "tool-result", toolCallId: "call-1", toolName: "search_web", output: { results: [{ title: "A", url: "https://a.example" }] } },
    { type: "tool-result", toolCallId: "call-2", toolName: "read_source", output: { text: "y".repeat(RECALL_PAGE_CHARS + 500) } },
  ],
};

const service = () =>
  createToolResultRecallService({
    messages: {
      async findById({ tenantId, id }: { tenantId: string; id: string }) {
        return tenantId === "t1" && id === "msg-1" ? (stored as never) : null;
      },
    } as never,
  });

const context = (conversationId = "conv-1") => ({ tenantId: "t1", conversationId } as unknown as ExecutionContext);

describe("tool result refs", () => {
  it("round-trips, splitting at the last #", () => {
    expect(parseToolResultRef(toolResultRef("msg-1", "call-1"))).toEqual({ messageId: "msg-1", toolCallId: "call-1" });
    expect(parseToolResultRef("a#b#c")).toEqual({ messageId: "a#b", toolCallId: "c" });
    expect(parseToolResultRef("nohash")).toBeUndefined();
    expect(parseToolResultRef("#x")).toBeUndefined();
    expect(parseToolResultRef("x#")).toBeUndefined();
  });
});

describe("recall", () => {
  it("returns a stored result in full", async () => {
    const result = await service().recall(context(), { ref: "msg-1#call-1" });
    expect(result.toolName).toBe("search_web");
    expect(JSON.parse(result.content)).toEqual({ results: [{ title: "A", url: "https://a.example" }] });
    expect(result.nextOffset).toBeUndefined();
  });

  it("pages a long result", async () => {
    const first = await service().recall(context(), { ref: "msg-1#call-2" });
    expect(first.content).toHaveLength(RECALL_PAGE_CHARS);
    expect(first.nextOffset).toBe(RECALL_PAGE_CHARS);
    const second = await service().recall(context(), { ref: "msg-1#call-2", offset: first.nextOffset! });
    expect(second.offset).toBe(RECALL_PAGE_CHARS);
    expect(second.nextOffset).toBeUndefined();
    expect(first.content.length + second.content.length).toBe(first.totalChars);
  });

  it("refuses a ref from another conversation — a model cannot read another chat through it", async () => {
    await expect(service().recall(context("conv-2"), { ref: "msg-1#call-1" })).rejects.toThrow(/No tool result/);
  });

  it("refuses an unknown message, an unknown call, and a malformed ref", async () => {
    await expect(service().recall(context(), { ref: "msg-9#call-1" })).rejects.toThrow(/No tool result/);
    await expect(service().recall(context(), { ref: "msg-1#call-9" })).rejects.toThrow(/No tool result/);
    await expect(service().recall(context(), { ref: "garbage" })).rejects.toThrow(/No tool result/);
  });
});
