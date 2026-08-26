import { describe, expect, it } from "vitest";
import type { Message, MessagePart, TextPart } from "../../core/content-parts.js";
import { asId } from "../../core/ids.js";
import type { ConversationId, MessageId, MessagePartId, TenantId } from "../../core/ids.js";
import { createMemoryThreadSummaryStore } from "../../adapters/memory/index.js";
import { compactThread } from "../index.js";
import { type ThreadSummarizer } from "../index.js";

const T = asId<TenantId>("t1");
const C = asId<ConversationId>("c1");

const text = (t: string): TextPart => ({ id: asId<MessagePartId>(`p-${t}`), type: "text", schemaVersion: 1, createdAt: "t", text: t });

const msg = (id: string, role: Message["role"], parts: MessagePart[] = [text(id)]): Message => ({
  id: asId<MessageId>(id),
  conversationId: C,
  role,
  parts,
  createdAt: "t",
});

const summarizer: ThreadSummarizer = {
  summarize: async ({ priorSummary, messages }) =>
    `${priorSummary ? priorSummary + " " : ""}[summary of ${messages.length} msgs]`,
};

const estimate = (messages: readonly Message[]) => messages.length * 100; // 100 tokens/message

describe("thread compaction", () => {
  it("keeps recent turns verbatim and summarizes the older prefix into a versioned summary", async () => {
    const summaries = createMemoryThreadSummaryStore(() => "t");
    const messages = ["m1", "m2", "m3", "m4", "m5"].map((id) => msg(id, "user"));
    const result = await compactThread({
      tenantId: T,
      conversationId: C,
      messages,
      keepRecent: 2,
      summaries,
      summarizer,
      estimateTokens: estimate,
    });
    expect(result).not.toBeNull();
    expect(result!.kept.map((m) => m.id)).toEqual(["m4", "m5"]);
    expect(result!.summary.version).toBe(1);
    expect(result!.summary.coversUpToMessageId).toBe("m3");
    expect(result!.event.type).toBe("context.compacted");
    expect(result!.event.droppedParts).toBe(3); // m1..m3, one part each
    expect(result!.event.tokensReclaimed).toBeGreaterThan(0);
  });

  it("returns null when there is nothing worth compacting", async () => {
    const summaries = createMemoryThreadSummaryStore();
    const result = await compactThread({
      tenantId: T,
      conversationId: C,
      messages: [msg("m1", "user"), msg("m2", "user")],
      keepRecent: 5,
      summaries,
      summarizer,
      estimateTokens: estimate,
    });
    expect(result).toBeNull();
  });

  it("does not split a tool-call from its tool-result (preserves tool continuity)", async () => {
    const summaries = createMemoryThreadSummaryStore(() => "t");
    // Boundary at keepRecent=2 would start 'recent' with the tool result m4 — move it earlier.
    const messages = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "assistant"), // tool-call turn
      msg("m4", "tool"), // its result
      msg("m5", "user"),
    ];
    const result = await compactThread({
      tenantId: T,
      conversationId: C,
      messages,
      keepRecent: 2,
      summaries,
      summarizer,
      estimateTokens: estimate,
    });
    // recent must not begin with the dangling tool result; boundary moved back to include m3.
    expect(result!.kept[0]!.role).not.toBe("tool");
    expect(result!.kept.map((m) => m.id)).toEqual(["m3", "m4", "m5"]);
  });

  it("layers on the prior summary across successive compactions", async () => {
    const summaries = createMemoryThreadSummaryStore(() => "t");
    const first = ["a", "b", "c"].map((id) => msg(id, "user"));
    await compactThread({ tenantId: T, conversationId: C, messages: first, keepRecent: 1, summaries, summarizer, estimateTokens: estimate });
    const second = ["d", "e", "f"].map((id) => msg(id, "user"));
    const result = await compactThread({ tenantId: T, conversationId: C, messages: second, keepRecent: 1, summaries, summarizer, estimateTokens: estimate });
    expect(result!.summary.version).toBe(2);
    expect(result!.summary.summary).toContain("[summary of"); // includes prior summary text
    expect(result!.summary.summary.indexOf("[summary of")).not.toBe(result!.summary.summary.lastIndexOf("[summary of"));
  });
});
