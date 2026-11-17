/**
 * #658 — count tokens the way the provider does.
 *
 * Production, 2026-09-30 (one chat on gemini-2.5-flash): 29k characters billed as 4.85k tokens, ~6 characters a
 * token. At a flat chars ÷ 4 the history estimate read 1.5x the real size, so a history budget planned at 85% of
 * the window condensed at ~53% of it. These tests pin the ratio that replaces the 4, and AC-1's property — after
 * three turns the history estimate is within 10% of the provider's count — on recorded and simulated numbers.
 * The live check against the three providers is separate and recorded in the PR.
 */
import { describe, expect, it } from "vitest";

import { conversationHistory } from "../history.js";
import { clearOldToolResults, manageCallContext } from "../context-management.js";
import { HISTORY_FLOOR_TOKENS, historyBudgetFitsASummary } from "../prompt-budget.js";
import { promptFingerprint } from "../prompt-fingerprint.js";
import { SUMMARY_MAX_CHARS } from "../thread-summary.js";
import {
  DEFAULT_CHARS_PER_TOKEN,
  MAX_CHARS_PER_TOKEN,
  MIN_CHARS_PER_TOKEN,
  charsPerTokenFor,
  defaultCharsPerToken,
  estimateTokensAt,
  measuredCharsPerToken,
  measuredPromptOf,
  rescaleContextSections,
  tokenizerFamily,
} from "../token-ratio.js";

/** The production reading the issue cites: 29k characters, 4.85k tokens, gemini-2.5-flash. */
const RECORDED_GEMINI = { modelId: "gemini-2.5-flash", promptChars: 29_000, inputTokens: 4_850 } as const;

describe("per-model defaults", () => {
  it("is ~6 for Gemini and 4 for Claude and OpenAI, ignoring provider prefixes and case", () => {
    expect(defaultCharsPerToken("gemini-2.5-flash")).toBe(6);
    expect(defaultCharsPerToken("models/Gemini-3-pro")).toBe(6);
    expect(defaultCharsPerToken("claude-sonnet-4-5")).toBe(4);
    expect(defaultCharsPerToken("openai/gpt-4.1")).toBe(4);
    expect(defaultCharsPerToken("o3-mini")).toBe(4);
  });

  it("falls back to the old chars ÷ 4 for a model it does not know", () => {
    expect(defaultCharsPerToken("mistral-large-latest")).toBe(DEFAULT_CHARS_PER_TOKEN);
    expect(tokenizerFamily("mistral-large-latest")).toBe("other");
  });
});

describe("the learned ratio", () => {
  it("reads ~6 off the recorded Gemini turn", () => {
    expect(measuredCharsPerToken(RECORDED_GEMINI)).toBeCloseTo(29_000 / 4_850, 5);
  });

  it("plans the next turn with the previous turn's ratio when the tokeniser is the same", () => {
    const previous = { ...RECORDED_GEMINI, promptChars: 30_000, inputTokens: 5_500 };
    expect(charsPerTokenFor({ modelId: "gemini-2.5-pro", previous })).toBeCloseTo(30_000 / 5_500, 5);
  });

  it("ignores a measurement from a model with another tokeniser — a chat switched mid-way", () => {
    expect(charsPerTokenFor({ modelId: "claude-sonnet-4-5", previous: RECORDED_GEMINI })).toBe(4);
    expect(charsPerTokenFor({ modelId: "gpt-4.1", previous: { ...RECORDED_GEMINI, modelId: "claude-sonnet-4-5" } })).toBe(4);
  });

  it("uses the default when nothing usable was measured", () => {
    expect(charsPerTokenFor({ modelId: "gemini-2.5-flash" })).toBe(6);
    expect(charsPerTokenFor({ modelId: "gemini-2.5-flash", previous: undefined })).toBe(6);
    // Recorded before promptChars existed.
    expect(charsPerTokenFor({ modelId: "gemini-2.5-flash", previous: { inputTokens: 4_850 } })).toBe(6);
    // An image is tokens with no characters behind it.
    expect(charsPerTokenFor({ modelId: "gemini-2.5-flash", previous: { ...RECORDED_GEMINI, hasMedia: true } })).toBe(6);
    expect(charsPerTokenFor({ modelId: "gemini-2.5-flash", previous: { ...RECORDED_GEMINI, inputTokens: 0 } })).toBe(6);
  });

  it("clamps a reading that cannot be prose", () => {
    expect(measuredCharsPerToken({ promptChars: 100_000, inputTokens: 1_000 })).toBe(MAX_CHARS_PER_TOKEN);
    expect(measuredCharsPerToken({ promptChars: 1_000, inputTokens: 1_000 })).toBe(MIN_CHARS_PER_TOKEN);
  });

  it("reads the measurement off the conversation's latest assistant_turn_steps row", () => {
    const row = {
      lastInputTokens: 4_850,
      promptFingerprint: { tools: "x", promptChars: 29_000, hasMedia: false },
      model: { modelId: "gemini-2.5-flash" },
    };
    expect(measuredPromptOf(row)).toEqual({ ...RECORDED_GEMINI, hasMedia: false });
    expect(measuredPromptOf({ lastInputTokens: 4_850, promptFingerprint: { tools: "x" } })).toBeUndefined();
    expect(measuredPromptOf(null)).toBeUndefined();
  });

  it("estimates at the ratio, rounding up, and treats a nonsense ratio as 4", () => {
    expect(estimateTokensAt("x".repeat(29_000), 6)).toBe(4_834);
    expect(estimateTokensAt("abcde", 4)).toBe(2);
    expect(estimateTokensAt("abcdefgh", 0)).toBe(2);
    expect(estimateTokensAt("abcdefgh", Number.NaN)).toBe(2);
  });
});

describe("promptFingerprint's character count", () => {
  it("counts system, text, tool inputs, tool outputs and declarations, and flags media", () => {
    const fp = promptFingerprint({
      prompt: [
        { role: "system", content: "12345" },
        { role: "user", content: [{ type: "text", text: "abc" }] },
        { role: "assistant", content: [{ type: "tool-call", toolName: "t", input: { a: 1 } }] },
        { role: "tool", content: [{ type: "tool-result", toolName: "t", output: { type: "text", value: "hello" } }] },
      ],
      tools: [{ name: "t" }],
    });
    expect(fp.promptChars).toBe(5 + 3 + (1 + JSON.stringify({ a: 1 }).length) + (1 + 5) + JSON.stringify([{ name: "t" }]).length);
    expect(fp.hasMedia).toBe(false);
    expect(promptFingerprint({ prompt: [{ role: "user", content: [{ type: "file", data: "…", mediaType: "image/png" }] }] }).hasMedia).toBe(true);
  });
});

/**
 * AC-1 on simulated providers. Each provider tokenises at its own true ratio plus a fixed overhead per call; a
 * turn's history estimate is compared with what the provider would count for the same history text. Turn one
 * runs on the default; every later turn on what the previous one measured.
 */
describe("AC-1: within 10% of the provider after three turns", () => {
  const providers = [
    { modelId: "gemini-2.5-flash", trueRatio: 29_000 / 4_850 },
    { modelId: "claude-sonnet-4-5", trueRatio: 3.7 },
    { modelId: "gpt-4.1", trueRatio: 4.3 },
  ] as const;

  for (const provider of providers) {
    it(`converges on ${provider.modelId}`, () => {
      const system = "You are the assistant. ".repeat(200);
      const tools = Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: "Does a thing. ".repeat(10) }));
      const history: string[] = [];
      let previous: { modelId: string; promptChars: number; inputTokens: number } | undefined;
      let error = Number.POSITIVE_INFINITY;
      for (let turn = 1; turn <= 3; turn += 1) {
        history.push(`Message ${turn}: ${"a long paragraph about the launch plan. ".repeat(150 * turn)}`);
        history.push(`Reply ${turn}: ${"the draft, revised as asked. ".repeat(120 * turn)}`);
        const charsPerToken = charsPerTokenFor({ modelId: provider.modelId, previous });
        const historyText = history.join("\n\n");
        const estimate = estimateTokensAt(historyText, charsPerToken);
        const providerCount = Math.ceil(historyText.length / provider.trueRatio);
        error = Math.abs(estimate - providerCount) / providerCount;
        // The provider measures the whole call, not just the history.
        const params = {
          prompt: [{ role: "system", content: system }, ...history.map((text, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] }))],
          tools,
        };
        const promptChars = promptFingerprint(params).promptChars;
        previous = { modelId: provider.modelId, promptChars, inputTokens: Math.ceil(promptChars / provider.trueRatio) };
      }
      expect(error).toBeLessThan(0.1);
    });
  }

  it("is what chars ÷ 4 got wrong on Gemini: 50% over on the recorded turn", () => {
    const providerCount = RECORDED_GEMINI.inputTokens;
    expect(estimateTokensAt("x".repeat(RECORDED_GEMINI.promptChars), 4) / providerCount).toBeGreaterThan(1.45);
    expect(Math.abs(estimateTokensAt("x".repeat(RECORDED_GEMINI.promptChars), measuredCharsPerToken(RECORDED_GEMINI)!) - providerCount) / providerCount).toBeLessThan(0.01);
  });
});

describe("the budget and the compaction threshold use the ratio", () => {
  const message = (role: string, chars: number, id: string) => ({ id, role, parts: [{ id: `${id}p`, type: "text", text: id.padEnd(chars, ".") }] });
  const items = () => [message("assistant", 6_000, "d"), message("user", 6_000, "c"), message("assistant", 6_000, "b"), message("user", 6_000, "a")];
  const store = () => ({
    messages: {
      async listByConversation() {
        return { items: items(), nextCursor: null };
      },
    } as never,
  });

  it("keeps the turns Gemini's real count fits, that chars ÷ 4 would drop", async () => {
    // 24k characters: 6,000 tokens at chars ÷ 4, 4,000 at Gemini's 6. Budget 5,000.
    const at4 = await conversationHistory({ ...store(), tenantId: "t", conversationId: "c", tokenBudget: 5_000, onTrimmed: () => {} });
    const at6 = await conversationHistory({ ...store(), tenantId: "t", conversationId: "c", tokenBudget: 5_000, charsPerToken: 6, onTrimmed: () => {} });
    expect(at4.length).toBeLessThan(4);
    expect(at6).toHaveLength(4);
  });

  it("condenses at the threshold in the provider's tokens, not at chars ÷ 4", async () => {
    const calls: unknown[] = [];
    const compaction = () => ({
      summaries: {
        async latest() {
          return null;
        },
        async append(input: { summary: string; coversUpToMessageId: string }) {
          return { ...input, version: 1, createdAt: "2026-10-10T00:00:00.000Z" };
        },
      } as never,
      summarizer: {
        async summarize(input: unknown) {
          calls.push(input);
          return "Earlier: the launch plan.";
        },
      } as never,
    });
    // 24k characters against compactAt 5,000: over it at chars ÷ 4 (6,000), under it at 6 (4,000).
    await conversationHistory({ ...store(), tenantId: "t", conversationId: "c", tokenBudget: 50_000, compactAt: 5_000, charsPerToken: 6, compaction: compaction() });
    expect(calls).toHaveLength(0);
    await conversationHistory({ ...store(), tenantId: "t", conversationId: "c", tokenBudget: 50_000, compactAt: 5_000, compaction: compaction() });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("sizes the history floor so a protected summary fits at the densest ratio a chat can learn", () => {
    expect(Math.ceil(SUMMARY_MAX_CHARS / MIN_CHARS_PER_TOKEN)).toBeLessThanOrEqual(HISTORY_FLOOR_TOKENS);
    expect(historyBudgetFitsASummary(HISTORY_FLOOR_TOKENS)).toBe(true);
  });
});

describe("in-run tool-output clearing uses the ratio", () => {
  const params = () => ({
    prompt: [
      { role: "system", content: "s" },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_source", output: { type: "text", value: "x".repeat(10_000) } }],
      })),
    ],
  });

  it("clears at chars ÷ 4 what a 6-characters-a-token provider still has room for", () => {
    // ~80k characters against a 30k window at 60%: 20k tokens at 4 (over 18k), ~13.4k at 6 (under).
    expect(clearOldToolResults(params(), { working: 30_000 }).cleared).toBeGreaterThan(0);
    expect(clearOldToolResults(params(), { working: 30_000, charsPerToken: 6 }).cleared).toBe(0);
  });

  it("takes the run's measured ratio when given, and the target model's default otherwise", () => {
    // gpt-4o: 128k working window, clears past 76.8k. 400k characters: 100k tokens at its default 4, ~66.7k at 6.
    const big = () => ({
      prompt: Array.from({ length: 10 }, (_, i) => ({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_source", output: { type: "text", value: "x".repeat(40_000) } }],
      })),
    });
    const target = { provider: "openai", modelId: "gpt-4o" };
    const cleared = (p: unknown) => JSON.stringify(p).includes("Earlier tool output cleared");
    expect(cleared(manageCallContext(big(), target, { log: () => {} }))).toBe(true);
    expect(cleared(manageCallContext(big(), target, { charsPerToken: 6, log: () => {} }))).toBe(false);
  });
});

describe("the meter's breakdown, restated at the turn's ratio", () => {
  it("rescales sections sized at chars ÷ 4 to the provider's tokens", () => {
    const summary = { instructionsTokens: 1_200, sections: [{ providerId: "shareflow.project", tokens: 600 }] };
    expect(rescaleContextSections(summary, 6)).toEqual({ instructionsTokens: 800, sections: [{ providerId: "shareflow.project", tokens: 400 }] });
    expect(rescaleContextSections(summary, undefined)).toBe(summary);
    expect(rescaleContextSections(summary, 4)).toBe(summary);
    expect(rescaleContextSections("odd", 6)).toBe("odd");
  });
});
