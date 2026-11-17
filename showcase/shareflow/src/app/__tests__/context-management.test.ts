import { describe, expect, it } from "vitest";

import { CLEARED_PREVIEW_CHARS, clearOldToolResults, estimateCallTokens, manageCallContext, withPromptCaching } from "../context-management.js";

/** A V3 prompt: a system message, then `n` call/result pairs whose outputs are `size` characters each. */
const promptWith = (n: number, size: number) => {
  const prompt: unknown[] = [{ role: "system", content: "You are the assistant." }, { role: "user", content: [{ type: "text", text: "go" }] }];
  for (let i = 0; i < n; i += 1) {
    prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read_source", input: { url: `https://e.com/${i}` } }] });
    prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_source", output: { type: "json", value: { text: `${i}:` + "x".repeat(size) } } }] });
  }
  return { prompt } as never;
};

const results = (params: { prompt: { content: unknown }[] }) =>
  params.prompt.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; toolCallId?: string; output?: { value: unknown } }[]) : [])).filter((p) => p.type === "tool-result");

describe("clearOldToolResults", () => {
  it("does nothing while the call is under the threshold", () => {
    const params = promptWith(3, 1_000);
    const result = clearOldToolResults(params, { working: 200_000 });
    expect(result.cleared).toBe(0);
    expect(result.params).toBe(params);
  });

  it("clears the oldest outputs, keeps the newest, and stops once under the target", () => {
    // 10 results of ~10k tokens each ≈ 100k, against a 120k working window: over 60%, target 45%.
    const params = promptWith(10, 40_000);
    const before = estimateCallTokens(params);
    const result = clearOldToolResults(params, { working: 120_000 });
    expect(before).toBeGreaterThan(120_000 * 0.6);
    expect(result.cleared).toBeGreaterThan(0);
    expect(result.after).toBeLessThanOrEqual(120_000 * 0.45);
    const out = results(result.params as never);
    // Oldest cleared, newest four untouched.
    expect(String(out[0]?.output?.value)).toContain("Earlier tool output cleared");
    for (const kept of out.slice(-4)) expect(JSON.stringify(kept.output)).toContain("x".repeat(1_000));
    // The stub carries a bounded preview.
    expect(String(out[0]?.output?.value).length).toBeLessThan(CLEARED_PREVIEW_CHARS + 300);
  });

  it("never splits a call from its result: every result keeps its call id and name", () => {
    const params = promptWith(10, 40_000);
    const result = clearOldToolResults(params, { working: 120_000 });
    const out = results(result.params as never);
    expect(out.map((p) => p.toolCallId)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i}`));
    expect((result.params as { prompt: unknown[] }).prompt).toHaveLength((params as { prompt: unknown[] }).prompt.length);
  });

  it("does not mutate the SDK's params", () => {
    const params = promptWith(10, 40_000);
    const snapshot = JSON.stringify(params);
    clearOldToolResults(params, { working: 120_000 });
    expect(JSON.stringify(params)).toBe(snapshot);
  });

  it("leaves the newest results alone even when that is not enough", () => {
    const params = promptWith(4, 100_000);
    expect(clearOldToolResults(params, { working: 100_000 }).cleared).toBe(0);
  });
});

describe("withPromptCaching", () => {
  it("puts Anthropic breakpoints on the system prompt and the newest message", () => {
    const params = withPromptCaching(promptWith(2, 10), { provider: "anthropic" }) as { prompt: { role: string; providerOptions?: unknown }[] };
    const marked = params.prompt.map((m, i) => (m.providerOptions === undefined ? null : i)).filter((i) => i !== null);
    expect(marked).toEqual([0, params.prompt.length - 1]);
    expect(params.prompt[0]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("gives OpenAI a per-conversation cache key and keeps options already there", () => {
    const params = withPromptCaching({ prompt: [], providerOptions: { openai: { reasoningEffort: "high" } } } as never, { provider: "openai", cacheKey: "conv-1" }) as {
      providerOptions: Record<string, unknown>;
    };
    expect(params.providerOptions["openai"]).toEqual({ reasoningEffort: "high", promptCacheKey: "conv-1" });
  });

  it("leaves Gemini alone — it caches implicitly", () => {
    const params = promptWith(2, 10);
    expect(withPromptCaching(params, { provider: "google", cacheKey: "c" })).toBe(params);
  });
});

describe("manageCallContext", () => {
  it("sizes the clearing against the target model's working window", () => {
    const logs: string[] = [];
    const params = promptWith(10, 40_000); // ~100k tokens
    // gpt-4o: 128k working window → over 60%, cleared.
    const small = manageCallContext(params, { provider: "openai", modelId: "gpt-4o" }, { log: (l) => logs.push(l) });
    expect(results(small as never).some((p) => String(p.output?.value).includes("cleared"))).toBe(true);
    expect(logs[0]).toContain("gpt-4o");
    // Gemini: 200k working window → ~50%, untouched.
    const big = manageCallContext(params, { provider: "google", modelId: "gemini-2.5-flash" });
    expect(results(big as never).some((p) => String(p.output?.value).includes("cleared"))).toBe(false);
  });
});
