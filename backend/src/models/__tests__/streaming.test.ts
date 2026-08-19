import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { streamModelTurn, type NeutralStreamChunk } from "../streaming.js";

/** A mock model whose stream emits a text block then finishes with usage. */
const textModel = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "Hello " },
          { type: "text-delta", id: "0", delta: "world" },
          { type: "text-end", id: "0" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
          },
        ] as never,
      }),
    }),
  });

const drain = async (it: AsyncIterable<NeutralStreamChunk>) => {
  const out: NeutralStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};

describe("streamModelTurn — real AI SDK chunk mapping", () => {
  it("maps text deltas and final usage from the SDK fullStream to neutral chunks", async () => {
    const chunks = await drain(
      streamModelTurn({ model: textModel(), messages: [{ role: "user", text: "hi" }] }),
    );
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => (c as { text: string }).text).join("");
    expect(text).toBe("Hello world");
    // A finish chunk is emitted with a normalized usage object (token *values* come from the real
    // provider; the engine test covers usage-number mapping via an explicit stream).
    const finish = chunks.find((c) => c.type === "finish");
    expect(finish?.type).toBe("finish");
    expect((finish as { usage: { inputTokens: number } }).usage).toHaveProperty("inputTokens");
  });
});
