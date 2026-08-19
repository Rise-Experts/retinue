import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId } from "../../core/ids.js";
import type { NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import { reduceRunEvents, type RunEvent } from "../../core/events.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import { createDefaultEngine } from "../engine.js";
import { defineAgent } from "../agent.js";

const RUN = asId<RunId>("r1");
const run: Run = {
  id: RUN,
  tenantId: asId("t1"),
  conversationId: asId("c1"),
  agentId: asId("a1"),
  agentVersion: 1,
  status: "running",
  createdAt: "t",
};
const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
  runId: RUN,
};
const manifest = defineAgent({ id: "a1", name: "A", instructions: "be helpful", modelPolicy: { role: "smart" } });
const model = {} as ResolvedModel;
const signal = { isCancelled: () => false };

/** Stamp engine events into full RunEvents so we can reduce them like the worker would. */
const stamp = (events: EngineEvent[]): RunEvent[] =>
  events.map((e, i) => ({ ...e, runId: RUN, sequence: i + 1, occurredAt: `t${i + 1}` }) as RunEvent);

const baseDeps = (streamTurn: () => AsyncIterable<NeutralStreamChunk>, over = {}) => ({
  loadManifest: async () => manifest,
  resolveModel: () => ({ model, modelId: "claude-sonnet-5", currency: "USD", price: () => 42 }),
  loadHistory: async () => [{ role: "user" as const, text: "hi" }],
  streamTurn,
  ...over,
});

const collect = async (engine: ReturnType<typeof createDefaultEngine>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context, resume: null, signal })) out.push(e);
  return out;
};

describe("default engine — chunk → event mapping", () => {
  it("maps text deltas, tool call/result, and usage to typed events", async () => {
    async function* chunks(): AsyncIterable<NeutralStreamChunk> {
      yield { type: "text-delta", id: "t", text: "Hel" };
      yield { type: "text-delta", id: "t", text: "lo" };
      yield { type: "tool-call", toolCallId: "tc1", toolName: "search", input: { q: "x" } };
      yield { type: "tool-result", toolCallId: "tc1", toolName: "search", output: { hits: 1 } };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } };
    }
    const engine = createDefaultEngine(baseDeps(chunks));
    const events = collect(engine);
    const state = reduceRunEvents(stamp(await events));

    expect(state.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)).toEqual(["Hello"]);
    expect(state.parts.some((p) => p.type === "tool-call")).toBe(true);
    expect(state.parts.some((p) => p.type === "tool-result")).toBe(true);
    expect(state.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costMinorUnits: 42 });
  });

  it("throws when the stream emits an error after output (no silent swallow)", async () => {
    async function* chunks(): AsyncIterable<NeutralStreamChunk> {
      yield { type: "text-delta", id: "t", text: "partial" };
      yield { type: "error", error: new Error("provider blew up") };
    }
    const engine = createDefaultEngine(baseDeps(chunks));
    await expect(collect(engine)).rejects.toThrow("provider blew up");
  });
});

describe("default engine — retry before first output", () => {
  it("retries a transient failure that happens before any output, then succeeds", async () => {
    const { AgentPlatformError } = await import("../../core/errors.js");
    let attempts = 0;
    function makeStream(): () => AsyncIterable<NeutralStreamChunk> {
      return async function* () {
        attempts += 1;
        if (attempts === 1) throw new AgentPlatformError({ code: "rate_limited", message: "429", retryable: true });
        yield { type: "text-delta", id: "t", text: "recovered" };
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      };
    }
    const sleep = vi.fn(async () => {});
    const engine = createDefaultEngine(baseDeps(makeStream(), { sleep, now: () => 0 }));
    const events = await collect(engine);
    expect(attempts).toBe(2);
    expect(events.some((e) => e.type === "run.retry-pending")).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
    const state = reduceRunEvents(stamp(events));
    expect(state.parts.some((p) => p.type === "text")).toBe(true);
  });

  it("does NOT retry once output has already streamed", async () => {
    const { AgentPlatformError } = await import("../../core/errors.js");
    let attempts = 0;
    function makeStream(): () => AsyncIterable<NeutralStreamChunk> {
      return async function* () {
        attempts += 1;
        yield { type: "text-delta", id: "t", text: "some output" };
        throw new AgentPlatformError({ code: "rate_limited", message: "429", retryable: true });
      };
    }
    const engine = createDefaultEngine(baseDeps(makeStream(), { sleep: async () => {}, now: () => 0 }));
    await expect(collect(engine)).rejects.toMatchObject({ code: "rate_limited" });
    expect(attempts).toBe(1); // not retried — would have duplicated the partial answer
  });
});
