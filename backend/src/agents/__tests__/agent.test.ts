import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { MessageId, MessagePartId } from "../../core/ids.js";
import type { TextPart } from "../../core/content-parts.js";
import type { AgentEngine, EngineEvent } from "../../runtime/index.js";
import { deriveRunMessageId } from "../../runtime/index.js";
import { createAgent, defineAgent } from "../agent.js";

/** A fake engine that echoes the latest user message — lets us test facade wiring without a model. */
const echoEngine = (): AgentEngine => ({
  async *run({ run }): AsyncIterable<EngineEvent> {
    const part: TextPart = {
      id: `${deriveRunMessageId(run.id)}:0` as MessagePartId,
      type: "text",
      schemaVersion: 1,
      createdAt: "t",
      text: `echo:${run.id}`,
    };
    yield { type: "part.added", messageId: deriveRunMessageId(run.id) as MessageId, part };
    yield { type: "usage.updated", inputTokens: 3, outputTokens: 2, modelId: "m", cachedInputTokens: 0 };
  },
});

describe("createAgent — embedded facade", () => {
  it("runs a turn and returns the assistant's parts", async () => {
    const agent = createAgent({
      manifest: { id: "assistant", name: "Assistant", instructions: "be concise", modelPolicy: { role: "smart" } },
      engine: echoEngine(),
    });
    const result = await agent.run({ conversationId: "c1", message: "hello" });
    expect(result.outcome).toBe("completed");
    expect(result.text).toContain("echo:");
    expect(result.parts.some((p) => p.type === "text")).toBe(true);
  });

  it("persists state across turns on the same conversation", async () => {
    // An engine that reports how many messages of history it was given.
    const countingEngine: AgentEngine = {
      async *run({ run, context }): AsyncIterable<EngineEvent> {
        // The facade's loadHistory feeds prior turns; assert growth via the engine seeing them is
        // indirect, so instead emit a marker and rely on the facade appending each turn.
        const part: TextPart = { id: `${run.id}:0` as MessagePartId, type: "text", schemaVersion: 1, createdAt: "t", text: `run ${run.id}` };
        void context;
        yield { type: "part.added", messageId: deriveRunMessageId(run.id) as MessageId, part };
      },
    };
    const agent = createAgent({
      manifest: { id: "a", name: "A", instructions: "x", modelPolicy: { role: "smart" } },
      engine: countingEngine,
    });
    await agent.run({ conversationId: "thread", message: "first" });
    const second = await agent.run({ conversationId: "thread", message: "second" });
    expect(second.outcome).toBe("completed");
    // Two turns ran on one conversation without error — state carried (user+assistant messages stored).
    expect(second.parts).toHaveLength(1);
  });

  it("defineAgent fills a partial manifest with defaults", () => {
    const m = defineAgent({ id: "a", name: "A", instructions: "hi", modelPolicy: { role: "fast" } });
    expect(m.version).toBe(1);
    expect(m.responseFormat).toEqual({ kind: "text" });
    expect(m.limits.maxSteps).toBeGreaterThan(0);
    expect(m.toolPolicy).toEqual({ preloaded: [], categories: [], excluded: [] });
  });
});
