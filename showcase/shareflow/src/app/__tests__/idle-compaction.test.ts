/**
 * #657 — long chats condensed in pieces, on a small model, while nobody is waiting.
 */
import { describe, expect, it } from "vitest";

import { SUMMARY_CHUNK_TOKENS, SUMMARY_NOTE, conversationHistory, isSummaryTurn } from "../history.js";
import { IDLE_COMPACT_AFTER_MS, IDLE_KEEP_TOKENS, createIdleCompactor } from "../idle-compaction.js";
import { summaryModelFor } from "../thread-summary.js";

/** `count` messages of ~`tokens` tokens each, alternating user/assistant. */
const thread = (count: number, tokens: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", parts: [{ type: "text", text: `t${i} `.padEnd(tokens * 4, ".") }] }));

const store = (oldestFirst: readonly unknown[]) => ({
  async listByConversation() {
    return { items: [...oldestFirst].reverse(), nextCursor: null };
  },
});

const summaryStore = () => {
  let latest: { summary: string; coversUpToMessageId: string; version: number; createdAt: string } | null = null;
  const appended: string[] = [];
  return {
    appended,
    store: {
      async latest() { return latest; },
      async append(input: { summary: string; coversUpToMessageId: string }) {
        appended.push(input.coversUpToMessageId);
        latest = { ...input, version: appended.length, createdAt: "2026-10-01T00:00:00.000Z" };
        return latest;
      },
    },
  };
};

describe("condensing in pieces (#657)", () => {
  it("never hands one summary call more than SUMMARY_CHUNK_TOKENS, and layers each on the last", async () => {
    // 300 messages × 2,000 tokens = 600k: three-plus pieces of ≤100k each before the kept tail.
    const items = thread(300, 2_000);
    const summaries = summaryStore();
    const sizes: number[] = [];
    const priors: (string | undefined)[] = [];
    const summarizer = {
      async summarize(input: { priorSummary?: string; messages: readonly unknown[] }) {
        sizes.push(input.messages.length * 2_000);
        priors.push(input.priorSummary);
        return `summary ${sizes.length}`;
      },
    };
    const history = await conversationHistory({ messages: store(items) as never, tenantId: "t", conversationId: "c", tokenBudget: 200_000, onTrimmed: () => {}, compaction: { summaries: summaries.store as never, summarizer: summarizer as never } });
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(SUMMARY_CHUNK_TOKENS);
    expect(priors[0]).toBeUndefined();
    expect(priors[1]).toBe("summary 1");
    expect(isSummaryTurn(history[0])).toBe(true);
    expect(String(history[0]?.content)).toContain(`summary ${sizes.length}`);
  });

  it("keeps the pieces already condensed when a later one fails", async () => {
    const items = thread(300, 2_000);
    const summaries = summaryStore();
    let calls = 0;
    const summarizer = {
      async summarize() {
        calls += 1;
        if (calls === 2) throw new Error("busy");
        return "first piece";
      },
    };
    const history = await conversationHistory({ messages: store(items) as never, tenantId: "t", conversationId: "c", tokenBudget: 200_000, onTrimmed: () => {}, compaction: { summaries: summaries.store as never, summarizer: summarizer as never } });
    expect(summaries.appended).toHaveLength(1);
    expect(String(history[0]?.content)).toContain("first piece");
  });

  it("condenses a quiet chat at the idle threshold, keeping IDLE_KEEP_TOKENS verbatim", async () => {
    // 75 × 2,000 = 150k: under the 200k budget (no condense on a turn), over a 120k idle threshold.
    const items = thread(75, 2_000);
    const summaries = summaryStore();
    const summarizer = { async summarize() { return "idle summary"; } };
    const onTurn = await conversationHistory({ messages: store(items) as never, tenantId: "t", conversationId: "c", tokenBudget: 200_000, onTrimmed: () => {}, compaction: { summaries: summaries.store as never, summarizer: summarizer as never } });
    expect(isSummaryTurn(onTurn[0])).toBe(false);
    const idle = await conversationHistory({ messages: store(items) as never, tenantId: "t", conversationId: "c", tokenBudget: 200_000, compactAt: 120_000, keepTokens: IDLE_KEEP_TOKENS, onTrimmed: () => {}, compaction: { summaries: summaries.store as never, summarizer: summarizer as never } });
    expect(isSummaryTurn(idle[0])).toBe(true);
    const verbatim = (idle.reduce((sum, t) => sum + String(t.content).length, 0) - (SUMMARY_NOTE.length + 2 + "idle summary".length)) / 4;
    expect(verbatim).toBeLessThanOrEqual(IDLE_KEEP_TOKENS);
  });
});

describe("createIdleCompactor", () => {
  const fakeTimers = () => {
    const pending = new Map<number, { run: () => void; ms: number }>();
    let next = 0;
    return {
      pending,
      setTimer: (run: () => void, ms: number) => { next += 1; pending.set(next, { run, ms }); return next; },
      clearTimer: (handle: unknown) => { pending.delete(handle as number); },
      fire: () => { for (const [id, t] of [...pending]) { pending.delete(id); t.run(); } },
    };
  };

  it("runs the job once the chat has been quiet, and a new turn restarts the wait", async () => {
    const timers = fakeTimers();
    const ran: string[] = [];
    const idle = createIdleCompactor({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    idle.touch("c1", async () => { ran.push("first"); });
    idle.touch("c1", async () => { ran.push("second"); });
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending.values()][0]?.ms).toBe(IDLE_COMPACT_AFTER_MS);
    timers.fire();
    await Promise.resolve();
    expect(ran).toEqual(["second"]);
    expect(idle.pending()).toBe(0);
  });

  it("reports a failed job instead of throwing", async () => {
    const timers = fakeTimers();
    const lines: string[] = [];
    const idle = createIdleCompactor({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: (line) => lines.push(line) });
    idle.touch("c1", async () => { throw new Error("busy"); });
    timers.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines[0]).toContain("idle compaction of conversation c1 failed: busy");
  });
});

describe("summaryModelFor", () => {
  it("picks the provider's small model, and honours an override", () => {
    expect(summaryModelFor("google")).toBe("gemini-2.5-flash-lite");
    expect(summaryModelFor("openai")).toBe("gpt-4.1-mini");
    expect(summaryModelFor("anthropic")).toBe("claude-haiku-4-5");
    expect(summaryModelFor("google", "gemini-2.0-flash-lite")).toBe("gemini-2.0-flash-lite");
    expect(summaryModelFor("mistral")).toBeUndefined();
  });
});
