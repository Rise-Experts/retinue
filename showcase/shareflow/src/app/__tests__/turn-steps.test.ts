import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";
import { modelCallUsage, withWorkspaceModel } from "../workspace-turn-model.js";
import { readTurnSteps, turnModelRecorder, turnStepsRecorder } from "../turn-steps.js";

/**
 * #518 — measured on production: "Context 80k" for a ~2k-token chat, because the ledger's one row per
 * turn is the sum over 7 model calls. Each call is now measured on its own.
 */
const context = { tenantId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", principalId: "u-1", runId: "run-1", conversationId: "conv-1" } as unknown as ExecutionContext;

describe("modelCallUsage", () => {
  it("reads numbers and the newer { total } objects, and ignores an empty report", () => {
    expect(modelCallUsage({ inputTokens: 11_400, outputTokens: 120, cachedInputTokens: 9_000 })).toEqual({ inputTokens: 11_400, outputTokens: 120, cachedInputTokens: 9_000 });
    expect(modelCallUsage({ inputTokens: { total: 50 }, outputTokens: { total: 5 } })).toEqual({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 });
    // #630: the middleware's V3 shape carries the cache read inside inputTokens.
    expect(modelCallUsage({ inputTokens: { total: 20_000, noCache: 4_000, cacheRead: 16_000 }, outputTokens: { total: 10 } })).toEqual({ inputTokens: 20_000, outputTokens: 10, cachedInputTokens: 16_000 });
    expect(modelCallUsage({})).toBeUndefined();
    expect(modelCallUsage(null)).toBeUndefined();
  });
});

describe("withWorkspaceModel reports every call", () => {
  const streamOf = (parts: unknown[]) =>
    new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });

  it("reports a streamed call's finish usage and passes the stream through unchanged", async () => {
    const calls: unknown[] = [];
    let middleware: { wrapStream: (o: { doStream: () => Promise<unknown>; params: unknown }) => Promise<unknown> } | undefined;
    withWorkspaceModel({
      model: {},
      context,
      resolve: async () => undefined,
      languageModelFor: async () => ({}),
      wrap: ({ middleware: m }) => { middleware = m as never; return {}; },
      onCall: (u) => calls.push(u),
    });
    const parts = [{ type: "text-delta", delta: "hi" }, { type: "finish", usage: { inputTokens: 11_000, outputTokens: 40 } }];
    const result = (await middleware!.wrapStream({ doStream: async () => ({ stream: streamOf(parts) }), params: {} })) as { stream: ReadableStream };
    const seen: unknown[] = [];
    const reader = result.stream.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; seen.push(value); }
    expect(seen).toEqual(parts);
    expect(calls).toEqual([{ inputTokens: 11_000, outputTokens: 40, cachedInputTokens: 0 }]);
  });
});

describe("the per-turn row", () => {
  it("counts the calls, keeps the last call's input as the context, and sums the rest", async () => {
    const rows = new Map<string, { steps: number; last: number; total: number; out: number; cached: number }>();
    const sql = {
      async query<Row>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
        if (text.includes("insert into public.assistant_turn_steps")) {
          const [run, , , input, output, cached] = params as [string, string, string, number, number, number];
          const r = rows.get(run);
          rows.set(run, r === undefined
            ? { steps: 1, last: input, total: input, out: output, cached }
            : { steps: r.steps + 1, last: input, total: r.total + input, out: r.out + output, cached: r.cached + cached });
          return [];
        }
        const r = rows.get(String(params[1]));
        return (r === undefined ? [] : [{ r: { steps: r.steps, last_input_tokens: r.last, total_input_tokens: r.total, total_output_tokens: r.out, cached_input_tokens: r.cached } }]) as Row[];
      },
    };
    const record = turnStepsRecorder(sql as never);
    for (const input of [11_000, 11_300, 11_600, 11_900]) await record(context, { inputTokens: input, outputTokens: 30, cachedInputTokens: 0 });
    expect(await readTurnSteps(sql as never, String(context.tenantId), { runId: "run-1" })).toEqual({
      steps: 4,
      lastInputTokens: 11_900, // the context — not 45,800
      totalInputTokens: 45_800,
      totalOutputTokens: 120,
      cachedInputTokens: 0,
    });
  });

  it("records nothing outside a run", async () => {
    const seen: unknown[] = [];
    await turnStepsRecorder({ async query(t: string) { seen.push(t); return []; } } as never)(
      { tenantId: "t" } as unknown as ExecutionContext,
      { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    );
    expect(seen).toEqual([]);
  });

  /*
   * #630: the model's window is read as `to_jsonb(row)`, so a database that has not applied the migration
   * still measures turns — the model is simply absent and the meter falls back to the deployment's.
   */
  it("reads the answering model's window when recorded, and nothing breaks when the columns are missing", async () => {
    const withColumns = { async query() { return [{ r: { steps: 2, last_input_tokens: 9_000, total_input_tokens: 17_000, total_output_tokens: 80, cached_input_tokens: 4_000, model_id: "claude-sonnet-4-5", context_window: 200_000, working_window: 200_000, history_condensed: true } }]; } };
    expect((await readTurnSteps(withColumns as never, "t", { runId: "r" }))?.model).toEqual({ modelId: "claude-sonnet-4-5", contextWindow: 200_000, workingWindow: 200_000, historyCondensed: true });
    const without = { async query() { return [{ r: { steps: 2, last_input_tokens: 9_000, total_input_tokens: 17_000, total_output_tokens: 80, cached_input_tokens: 0 } }]; } };
    const read = await readTurnSteps(without as never, "t", { conversationId: "c" });
    expect(read?.lastInputTokens).toBe(9_000);
    expect(read?.model).toBeUndefined();
  });

  /*
   * #651: a run that failed before its first model call has a row with no steps. The meter read it, found nothing,
   * and went blank; it now shows the conversation's last measured turn.
   */
  it("shows the conversation's last measured turn when the asked-for run measured nothing", async () => {
    const queries: string[] = [];
    const sql = {
      async query(text: string, params: unknown[]) {
        queries.push(text);
        if (text.includes("s.run_id = $2")) return [{ r: { steps: 0, conversation_id: "conv-1" } }];
        expect(params).toEqual(["t", "conv-1"]);
        return [{ r: { steps: 3, last_input_tokens: 42_000, total_input_tokens: 120_000, total_output_tokens: 90, cached_input_tokens: 30_000 } }];
      },
    };
    const read = await readTurnSteps(sql as never, "t", { runId: "failed-run" });
    expect(read?.lastInputTokens).toBe(42_000);
    expect(queries[1]).toContain("coalesce(s.steps, 0) > 0");
  });

  it("reads the prompt fingerprint when recorded", async () => {
    const sql = { async query() { return [{ r: { steps: 1, last_input_tokens: 10, total_input_tokens: 10, total_output_tokens: 1, cached_input_tokens: 0, prompt_fingerprint: { tools: "abc", messages: ["user:1"] } } }]; } };
    expect((await readTurnSteps(sql as never, "t", { runId: "r" }))?.promptFingerprint).toEqual({ tools: "abc", messages: ["user:1"] });
  });

  it("skips unmeasured turns when reading by conversation", async () => {
    const seen: string[] = [];
    await readTurnSteps({ async query(text: string) { seen.push(text); return []; } } as never, "t", { conversationId: "c" });
    expect(seen[0]).toContain("coalesce(s.steps, 0) > 0");
  });

  it("records the model in its own statement, so a missing column costs only this", async () => {
    const seen: { text: string; params: readonly unknown[] }[] = [];
    await turnModelRecorder({ async query(text: string, params: readonly unknown[]) { seen.push({ text, params }); return []; } } as never)(context, {
      modelId: "gemini-2.5-flash",
      contextWindow: 1_048_576,
      workingWindow: 200_000,
      historyCondensed: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toContain("working_window = excluded.working_window");
    expect(seen[0]?.text).not.toContain("steps = public.assistant_turn_steps.steps + 1");
    expect(seen[0]?.params.slice(3)).toEqual(["gemini-2.5-flash", 1_048_576, 200_000, false]);
  });
});
