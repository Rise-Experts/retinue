import { describe, expect, it } from "vitest";

import { DETAILED_REPLIES, SUMMARY_NOTE, TIER_BLOCK, TOOL_PREVIEW_CHARS, conversationHistory, isSummaryTurn, toolRecordOf } from "../history.js";
import { createThreadSummarizer } from "../thread-summary.js";

/**
 * #630 — history used to carry earlier tool results as ids only, so the model could not re-read what a search
 * found two turns ago. Recent replies now carry previews; older ones one line per call with a ref.
 */
const reply = (id: string, finding: string) => ({
  id,
  role: "assistant",
  parts: [
    { type: "tool-call", toolCallId: `${id}-call`, toolName: "search_web", input: { query: "q" } },
    { type: "tool-result", toolCallId: `${id}-call`, toolName: "search_web", output: { results: [{ title: finding, snippet: "s".repeat(5_000) }] } },
    { type: "text", text: `Found ${id}.` },
  ],
});
const user = (id: string) => ({ id, role: "user", parts: [{ type: "text", text: `ask ${id}` }] });

/** #650: a reply's tool record opens the next user turn; this is that turn's text. */
const noteAfter = (turns: readonly { role: string; content: unknown }[], replyStart: string): string | undefined => {
  const at = turns.findIndex((t) => String(t.content).startsWith(replyStart));
  const next = turns[at + 1];
  return at === -1 || next?.role !== "user" ? undefined : String(next.content);
};

const storeOf = (oldestFirst: readonly unknown[]) => ({
  messages: {
    async listByConversation() {
      return { items: [...oldestFirst].reverse(), nextCursor: null };
    },
  } as never,
});

describe("tool results in history", () => {
  it("lists every call with a ref, even one that produced no id", () => {
    const record = toolRecordOf(reply("m1", "Coffee prices") as never);
    expect(record).toContain("- search_web (ref m1#m1-call)");
    expect(record).not.toContain("Coffee prices");
  });

  it("carries every reply's tool inputs and results in full while the thread fits (#644)", async () => {
    const items = [user("u1"), reply("m1", "OLDEST"), user("u2"), reply("m2", "SECOND"), user("u3")];
    const turns = await conversationHistory({ ...storeOf(items), tenantId: "t", conversationId: "c", tokenBudget: 1_000_000 });
    const m1 = noteAfter(turns, "Found m1")!;
    expect(m1).toContain("OLDEST");
    expect(m1).toContain('input: {"query":"q"}');
    expect(m1).toContain("result: ");
  });

  it("shrinks the oldest replies first when the thread is long: full, then previews, then refs", async () => {
    // 12 replies: tiers are decided as of the 10th (#659), so the 11th and 12th stay full.
    const items = Array.from({ length: 12 }, (_, i) => [user(`u${i + 1}`), reply(`m${i + 1}`, `FINDING${i + 1}`)]).flat();
    items.push(user("u13"));
    // Each full reply is ~1.3k tokens; half of 6,000 fits the two newest anchored replies.
    const turns = await conversationHistory({ ...storeOf(items), tenantId: "t", conversationId: "c", tokenBudget: 6_000, onTrimmed: () => {} });
    const text = (id: string) => noteAfter(turns, `Found ${id}`)?.split("\n\nask ")[0];
    expect(text("m12")).toContain("result: ");
    expect(text("m11")).toContain("result: ");
    expect(DETAILED_REPLIES).toBe(3);
    for (const id of ["m8", "m7", "m6"]) {
      const t = text(id);
      if (t === undefined) continue; // trimmed to fit — fine, the point is the level of what is kept
      expect(t, id).toContain("recall_tool_result");
      expect(t, id).not.toContain("result: ");
      expect(t.length, id).toBeLessThan(TOOL_PREVIEW_CHARS + 900);
    }
  });

  /*
   * #659: one more reply must not rewrite the text of earlier ones — that is what broke the provider's prompt cache on
   * every turn. Tiers move only when a block of TIER_BLOCK replies completes.
   */
  it("leaves every earlier turn byte-identical when one reply is added, until a block completes", async () => {
    const thread = (replies: number) => {
      const items: unknown[] = Array.from({ length: replies }, (_, i) => [user(`u${i + 1}`), reply(`m${i + 1}`, `F${i + 1}`)]).flat();
      items.push(user(`u${replies + 1}`));
      return items;
    };
    const project = async (replies: number) => (await conversationHistory({ ...storeOf(thread(replies)), tenantId: "t", conversationId: "c", tokenBudget: 10_000, onTrimmed: () => {} })).map((t) => String(t.content));
    const at11 = await project(11);
    const at12 = await project(12);
    // Everything up to the turn that changed hands is the same text, so the cached prefix survives.
    const shared = at11.slice(0, at11.length - 1);
    expect(at12.slice(0, shared.length)).toEqual(shared);
    expect(TIER_BLOCK).toBe(10);
  });

  it("keeps a failure and its message in both forms", () => {
    const failed = {
      id: "m9",
      role: "assistant",
      parts: [{ type: "tool-result", toolCallId: "k", toolName: "create_post_draft", output: { ok: false, error: { message: "too many hashtags" } } }],
    };
    expect(toolRecordOf(failed as never)).toContain("create_post_draft (ref m9#k) failed: too many hashtags");
    expect(toolRecordOf(failed as never, { detail: true })).toContain("failed: too many hashtags");
  });
});

describe("compaction keeps well under the budget afterwards", () => {
  it("keeps only ~40% of the budget verbatim, so the next turn does not condense again", async () => {
    const turn = (role: string, label: string) => ({ id: label, role, parts: [{ type: "text", text: label.padEnd(400, ".") }] }); // 100 tokens
    const items = Array.from({ length: 300 }, (_, i) => turn(i % 2 === 0 ? "user" : "assistant", `t${i}`));
    let latest: { summary: string; coversUpToMessageId: string; version: number; createdAt: string } | null = null;
    const summaries = {
      async latest() { return latest; },
      async append(input: { summary: string; coversUpToMessageId: string }) {
        latest = { ...input, version: 1, createdAt: "2026-09-29T00:00:00.000Z" };
        return latest;
      },
    };
    const calls: unknown[] = [];
    const summarizer = { async summarize(input: unknown) { calls.push(input); return "short summary"; } };
    // ~30,000 tokens of thread against a 20,000 budget. Keeping "whatever fits" would keep ~18,000 and cross
    // again within a few turns; 40% less the summary allowance keeps ~6,000.
    const history = await conversationHistory({
      ...storeOf(items),
      tenantId: "t",
      conversationId: "c",
      tokenBudget: 20_000,
      onTrimmed: () => {},
      compaction: { summaries: summaries as never, summarizer: summarizer as never },
    });
    expect(calls).toHaveLength(1);
    expect(isSummaryTurn(history[0])).toBe(true);
    // Everything except the summary note itself, which opens the first turn.
    const summaryChars = SUMMARY_NOTE.length + 2 + "short summary".length;
    const verbatim = (history.reduce((sum, t) => sum + String(t.content).length, 0) - summaryChars) / 4;
    expect(verbatim).toBeLessThanOrEqual(20_000 * 0.4);
    expect(verbatim).toBeGreaterThan(20_000 * 0.2);
    expect(String(history.at(-1)?.content)).toContain("t299");
  });
});

describe("the summarizer sees what tools returned", () => {
  it("passes a clipped tool output, not just '(called X)'", async () => {
    const prompts: string[] = [];
    const summarizer = createThreadSummarizer({
      context: {} as never,
      generate: (async (input: { prompt: string }) => {
        prompts.push(input.prompt);
        return { summary: "## Things made and their ids\n- draft d-42" };
      }) as never,
    });
    await summarizer.summarize({
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "tool-call", toolName: "create_post_draft", input: { caption: "hi" } },
            { type: "tool-result", toolName: "create_post_draft", output: { postDraftId: "d-42", huge: "z".repeat(10_000) } },
          ],
        },
      ] as never,
    });
    expect(prompts[0]).toContain("create_post_draft returned");
    expect(prompts[0]).toContain("d-42");
    expect(prompts[0]!.length).toBeLessThan(2_000);
  });
});

describe("the deck the agent wrote reaches later turns (#644, chat d756738b)", () => {
  it("carries create_artifact's input — the full deck — not only its receipt", async () => {
    const deck = "<!-- format: 16:9 -->\n---\n# Retinue Agent Kit\n---\n## 1️⃣ AgentKit: Basic Agent Setup\n```ts\nconst agent = createAgent({})\n```";
    const made = {
      id: "m7",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "c7", toolName: "create_artifact", input: { kind: "slides", title: "Quick Intro", content: deck } },
        { type: "tool-result", toolCallId: "c7", toolName: "create_artifact", output: { artifactId: "a4e8619c", version: 1, kind: "slides" } },
        { type: "text", text: "Your slide post is ready." },
      ],
    };
    const turns = await conversationHistory({ ...storeOf([user("u1"), made, user("u2")]), tenantId: "t", conversationId: "c", tokenBudget: 1_000_000 });
    const text = noteAfter(turns, "Your slide post")!;
    expect(text).toContain("artifactId a4e8619c");
    expect(text).toContain("## 1️⃣ AgentKit: Basic Agent Setup");
    expect(text).toContain("const agent = createAgent({})");
  });

  it("names the tool an execute_tool call actually ran", async () => {
    const ran = {
      id: "m8",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "c8", toolName: "execute_tool", input: { name: "update_brand_profile", input: { tone: ["warm"] } } },
        { type: "tool-result", toolCallId: "c8", toolName: "execute_tool", output: { changed: ["tone"] } },
        { type: "text", text: "Tone updated." },
      ],
    };
    const turns = await conversationHistory({ ...storeOf([user("u1"), ran, user("u2")]), tenantId: "t", conversationId: "c", tokenBudget: 1_000_000 });
    const text = noteAfter(turns, "Tone updated")!;
    expect(text).toContain("- update_brand_profile (ref m8#c8)");
    expect(text).toContain('input: {"tone":["warm"]}');
  });
});
