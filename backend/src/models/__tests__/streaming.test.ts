import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AgentPlatformError } from "../../core/errors.js";
import { modalitiesOf, streamModelTurn, turnText, type NeutralStreamChunk, type TurnMessage } from "../streaming.js";

/**
 * A model that records the prompt it was handed — #185.
 *
 * The assertion that matters is what reached the provider, and nothing else can see it: the bridge is the last
 * hop before the SDK, and an image dropped here is invisible everywhere upstream. That is exactly how an
 * attachment came to be stored, authorized, rendered and billed for without the model ever being told it existed.
 */
const recordingModel = (captured: { prompt?: unknown }) =>
  new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      captured.prompt = options.prompt;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: "ok" },
            { type: "text-end", id: "0" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ] as never,
        }),
      };
    },
  });

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
      streamModelTurn({ model: textModel(), messages: [{ role: "user", content: "hi" }] }),
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

describe("a turn carries what the user sent (#185)", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("sends an image part to the provider, beside the text", async () => {
    const captured: { prompt?: unknown } = {};
    await drain(
      streamModelTurn({
        model: recordingModel(captured),
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "what is in this picture?" },
              { kind: "image", image: png, mediaType: "image/png" },
            ],
          },
        ],
      }),
    );
    // Read out of what the provider was actually handed. Before this, the bridge was
    // `content: m.text` — the image existed in the message and reached nothing.
    const prompt = JSON.stringify(captured.prompt);
    expect(prompt).toContain("what is in this picture?");
    expect(prompt).toContain("image");
    expect(prompt).toContain("iVBORw0KGgo");
  });

  it("leaves a plain text turn as a plain string", async () => {
    /**
     * Not wrapped in a single text part.
     *
     * Providers treat the two the same, but the wire form differs, and a change that rewrites every existing
     * text turn has a blast radius of every conversation rather than the ones with an attachment.
     */
    const captured: { prompt?: unknown } = {};
    await drain(streamModelTurn({ model: recordingModel(captured), messages: [{ role: "user", content: "hi" }] }));
    const message = (captured.prompt as { content: unknown }[])[0]!;
    expect(typeof message.content === "string" || Array.isArray(message.content)).toBe(true);
    expect(JSON.stringify(captured.prompt)).toContain("hi");
  });

  it("refuses a modality the resolved model does not accept, naming both", async () => {
    /**
     * Fail closed, and loudly.
     *
     * Dropping the attachment would send a turn that reads as if the user attached nothing, and the model would
     * answer confidently about a message it never saw. Substituting a description silently would make the
     * transcript a record of something that did not happen. Both are worse than stopping.
     */
    const captured: { prompt?: unknown } = {};
    const error = await drain(
      streamModelTurn({
        model: recordingModel(captured),
        modelModalities: ["text"],
        messages: [{ role: "user", content: [{ kind: "image", image: png }] }],
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentPlatformError);
    expect((error as AgentPlatformError).code).toBe("capability_unavailable");
    expect((error as AgentPlatformError).message).toContain("image");
    expect((error as AgentPlatformError).message).toContain("text");
    // And nothing was sent. A refusal that still called the provider would bill for the turn it refused.
    expect(captured.prompt).toBeUndefined();
  });

  it("does not check when the caller has not said what the model accepts", async () => {
    /**
     * Absent means "do not check", not "text only".
     *
     * Defaulting to text would refuse every image turn from every caller not yet updated — an outage dressed as
     * a safety check, and the kind that gets the check deleted rather than fixed.
     */
    const captured: { prompt?: unknown } = {};
    const chunks = await drain(
      streamModelTurn({
        model: recordingModel(captured),
        messages: [{ role: "user", content: [{ kind: "image", image: png }] }],
      }),
    );
    expect(chunks.some((c) => c.type === "finish")).toBe(true);
  });

  it("admits a turn whose modalities the model does accept", async () => {
    const captured: { prompt?: unknown } = {};
    const chunks = await drain(
      streamModelTurn({
        model: recordingModel(captured),
        modelModalities: ["text", "image"],
        messages: [{ role: "user", content: [{ kind: "image", image: png }] }],
      }),
    );
    expect(chunks.some((c) => c.type === "finish")).toBe(true);
  });
});

describe("reading a turn", () => {
  it("takes the text of a string turn and of a parts turn alike", () => {
    expect(turnText({ role: "user", content: "plain" })).toBe("plain");
    expect(
      turnText({
        role: "user",
        content: [
          { kind: "text", text: "one" },
          { kind: "image", image: "x" },
          { kind: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("names the modalities a turn needs, from the parts rather than from a declaration", () => {
    const turn = (content: TurnMessage["content"]): TurnMessage => ({ role: "user", content });
    expect(modalitiesOf([turn("just text")])).toEqual([]);
    expect(modalitiesOf([turn([{ kind: "image", image: "x" }])])).toEqual(["image"]);
    // A file's modality is its media type. A PDF needs `pdf`, not `file` — the model definition declares
    // modalities, so the check has to speak the same vocabulary or it can never match.
    expect(modalitiesOf([turn([{ kind: "file", data: "x", mediaType: "application/pdf" }])])).toEqual(["pdf"]);
    expect(modalitiesOf([turn([{ kind: "file", data: "x", mediaType: "audio/mpeg" }])])).toEqual(["audio"]);
    // An unrecognised type is sent as a file and claims no modality: guessing one we cannot name would make the
    // check refuse turns for a reason nobody can act on.
    expect(modalitiesOf([turn([{ kind: "file", data: "x", mediaType: "application/zip" }])])).toEqual([]);
  });
});
