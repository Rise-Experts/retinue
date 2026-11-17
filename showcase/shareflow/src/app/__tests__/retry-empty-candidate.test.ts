/**
 * The retry for a model call that came back with nothing in it.
 *
 * The stream shapes here are the real ones, taken from recorded Gemini traffic. The empty case is a
 * `text-start`/`text-end` pair with no delta between them and a `finish` carrying `finishReason: "stop"`
 * and no output tokens — which the platform reports as a completed run with zero parts, and which from
 * the app is a message sent and no reply at all.
 *
 * Every assertion is a way this could go wrong: not retrying, retrying something that did answer,
 * retrying forever, losing the chunks read while deciding, or waiting for the whole answer before
 * passing any of it on.
 */
import { describe, expect, it } from "vitest";

import { EMPTY_CANDIDATE_MESSAGE, withEmptyCandidateRetry } from "../retry-empty-candidate.js";

type Part = Record<string, unknown>;

const streamOf = (parts: readonly Part[]): ReadableStream<Part> =>
  new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

/** What the provider sends when it produces nothing: a bracketed empty text block. */
const EMPTY: readonly Part[] = [
  { type: "stream-start", warnings: [] },
  { type: "response-metadata", id: "r1", modelId: "gemini-2.5-flash" },
  { type: "text-start", id: "0" },
  { type: "text-end", id: "0" },
  { type: "finish", finishReason: "stop", usage: { inputTokens: 5046, outputTokens: 0 } },
];

const ANSWER: readonly Part[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: "You have three accounts" },
  { type: "text-delta", id: "0", delta: " connected." },
  { type: "text-end", id: "0" },
  { type: "finish", finishReason: "stop", usage: { inputTokens: 5046, outputTokens: 12 } },
];

const TOOL_CALL: readonly Part[] = [
  { type: "stream-start", warnings: [] },
  { type: "tool-input-start", id: "c1", toolName: "list_accounts" },
  { type: "tool-input-end", id: "c1" },
  { type: "tool-call", toolCallId: "c1", toolName: "list_accounts", input: "{}" },
  { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5046, outputTokens: 9 } },
];

/** A model whose successive calls return the given streams. Counts the calls. */
const modelReturning = (...responses: readonly (readonly Part[])[]) => {
  let calls = 0;
  const model = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not used");
    },
    async doStream() {
      const parts = responses[Math.min(calls, responses.length - 1)] ?? EMPTY;
      calls += 1;
      return { stream: streamOf(parts) };
    },
  };
  return { model, calls: () => calls };
};

const drain = async (model: { doStream: (o: never) => Promise<{ stream: ReadableStream<Part> }> }) => {
  const { stream } = await model.doStream({ prompt: [] } as never);
  const parts: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
};

describe("a stream with no content in it", () => {
  it("is asked again, and the answer is what comes back", async () => {
    const { model, calls } = modelReturning(EMPTY, ANSWER);
    const retries: number[] = [];
    const wrapped = withEmptyCandidateRetry(model, { onRetry: ({ attempt }) => retries.push(attempt), onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(calls()).toBe(2);
    expect(retries).toEqual([1]);
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe(
      "You have three accounts connected.",
    );
  });

  it("gives up after the last attempt rather than looping, and says so as an error", async () => {
    /**
     * Three empty answers in a row say something real about the request — observed in production on a
     * prompt that answered locally and failed every time there — and an unbounded retry turns one bad
     * turn into a stuck worker. So the run **fails visibly** instead of completing with nothing in it:
     * "the assistant finished without producing an answer" is not something a user can act on.
     */
    const { model, calls } = modelReturning(EMPTY);
    const wrapped = withEmptyCandidateRetry(model, { attempts: 3, onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(calls()).toBe(3);
    expect(parts.some((p) => p.type === "text-delta")).toBe(false);

    /**
     * The error is **last**, and it is an `Error`.
     *
     * Both of these were wrong, and this test asserted them wrongly — it read *"the error comes first:
     * the engine reads in order and stops at `finish`"* and checked `error: { code: "no_content" }`.
     * Neither claim survives contact with the engine:
     *
     *  - `engine.js` is `for await (const chunk of chunks)` dispatching each chunk through `mapChunk`.
     *    The `finish` case yields `usage.updated` and returns from that call, not from the loop. So an
     *    error in front threw *before* `finish` was mapped, and three billed attempts were recorded as
     *    zero tokens. Appended, usage is emitted and the throw still lands.
     *  - the chunk handler is `chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))`.
     *    A plain object takes the second branch and `String({…})` is `"[object Object]"` — which is
     *    what the user was actually shown in place of the sentence below.
     *
     * A test written from the same wrong belief as the code cannot catch the code, which is why this
     * one passed for months. The assertions are now on the two things the engine actually reads.
     */
    const last = parts.at(-1) as { type: string; error: unknown };
    expect(last.type).toBe("error");
    expect(last.error).toBeInstanceOf(Error);
    expect((last.error as Error).message).toBe(EMPTY_CANDIDATE_MESSAGE);

    const finishAt = parts.findIndex((p) => p.type === "finish");
    expect(finishAt).toBeGreaterThanOrEqual(0);
    expect(finishAt).toBeLessThan(parts.length - 1);
  });

  it("reports the provider's own finish reason when it gives up", async () => {
    /**
     * The reason an empty candidate happened appears nowhere else: the platform logs neither
     * `finishReason` nor provider metadata, so a repeatable empty answer in production was
     * unexplainable from the outside. This is the one place that has it.
     */
    const withMeta: readonly Part[] = [
      { type: "text-start", id: "0" },
      { type: "text-end", id: "0" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 5046, outputTokens: 0 },
        providerMetadata: { google: { promptFeedback: { blockReason: "OTHER" } } },
      },
    ];
    const { model } = modelReturning(withMeta);
    const seen: unknown[] = [];
    const wrapped = withEmptyCandidateRetry(model, {
      attempts: 2,
      onRetry: () => {},
      onExhausted: (input) => seen.push(input),
    });

    await drain(wrapped as never);

    expect(seen).toHaveLength(1);
    const reported = seen[0] as { attempts: number; finish?: { finishReason?: unknown; providerMetadata?: unknown } };
    expect(reported.attempts).toBe(2);
    expect(reported.finish?.finishReason).toBe("stop");
    expect(JSON.stringify(reported.finish?.providerMetadata)).toContain("blockReason");
  });

  it("counts a tool call as content, since a turn that calls a tool did something", async () => {
    const { model, calls } = modelReturning(TOOL_CALL, ANSWER);
    const wrapped = withEmptyCandidateRetry(model, { onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(calls()).toBe(1);
    expect(parts.some((p) => p.type === "tool-call")).toBe(true);
  });

  it("counts an error as content, so a failure is reported rather than retried into silence", async () => {
    const failure: readonly Part[] = [
      { type: "stream-start", warnings: [] },
      { type: "error", error: { message: "provider overloaded" } },
    ];
    const { model, calls } = modelReturning(failure, ANSWER);
    const wrapped = withEmptyCandidateRetry(model, { onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(calls()).toBe(1);
    expect(parts.some((p) => p.type === "error")).toBe(true);
  });

  it("does not treat an empty text delta as content", async () => {
    // `{delta: ""}` is the same nothing as no delta at all, and a provider that brackets an empty block
    // must not be able to defeat the check by sending one.
    const bracketed: readonly Part[] = [
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "" },
      { type: "text-end", id: "0" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 0 } },
    ];
    const { model, calls } = modelReturning(bracketed, ANSWER);
    const wrapped = withEmptyCandidateRetry(model, { onRetry: () => {}, onExhausted: () => {} });

    await drain(wrapped as never);
    expect(calls()).toBe(2);
  });
});

describe("a stream that does answer", () => {
  it("is passed through untouched, in order, with nothing dropped", async () => {
    /**
     * The chunks read while deciding are **replayed**, not discarded: `stream-start`,
     * `response-metadata` and `text-start` all arrive before the first delta and the consumer needs
     * them in order.
     */
    const { model, calls } = modelReturning(ANSWER);
    const wrapped = withEmptyCandidateRetry(model, { onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(calls()).toBe(1);
    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("hands over the first token before the rest has arrived", async () => {
    /**
     * The cost of this wrapper has to be one chunk, not the whole answer. Buffering to a `finish` in
     * order to inspect it would turn a streaming assistant into one that appears to think in silence
     * and then paste — so the test holds the stream open after the first delta and asserts that delta
     * is already readable.
     */
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const model = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not used");
      },
      async doStream() {
        return {
          stream: new ReadableStream<Part>({
            async start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-delta", id: "0", delta: "first" });
              await held;
              controller.enqueue({ type: "finish", finishReason: "stop", usage: {} });
              controller.close();
            },
          }),
        };
      },
    };

    const wrapped = withEmptyCandidateRetry(model, { onRetry: () => {}, onExhausted: () => {} });
    const { stream } = await (wrapped as never as { doStream: (o: never) => Promise<{ stream: ReadableStream<Part> }> }).doStream(
      {} as never,
    );
    const reader = stream.getReader();

    expect((await reader.read()).value?.type).toBe("stream-start");
    expect((await reader.read()).value?.delta).toBe("first");

    release?.();
    expect((await reader.read()).value?.type).toBe("finish");
    await reader.cancel();
  });
});

/**
 * A discarded attempt was still billed, and its tokens were being thrown away with the stream.
 *
 * `withEmptyCandidateRetry` calls `doStream()` up to three times. Each call sends the whole prompt —
 * for this assistant the system prompt, the rendered context block and twenty tool schemas, measured
 * at ~5,000 input tokens — and the provider charges for it whether or not a candidate came back with
 * any `parts`. The retry then dropped the failed stream, and with it the only `finish` chunk carrying
 * that number. The engine reads usage in exactly one place, so three billed calls reached the ledger
 * as one: spend under-counted by up to 3×, silently, in the direction that looks cheaper.
 *
 * Not visible in any earlier test, because every one of them asserted on *parts* rather than on the
 * arithmetic — and the shape was right the whole time. It is a wrong number, not a wrong shape.
 */
describe("the tokens a retried attempt already cost", () => {
  const usageOf = (parts: readonly Part[]) =>
    (parts.find((p) => p.type === "finish") as { usage?: Record<string, number> } | undefined)?.usage;

  it("adds the discarded attempts onto the answer that eventually arrives", async () => {
    // Two empties at 5,046 input each, then a real answer at 5,046 + 12 out. Billed: 15,138 in, 12 out.
    const { model, calls } = modelReturning(EMPTY, EMPTY, ANSWER);
    const wrapped = withEmptyCandidateRetry(model, { attempts: 3, onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(calls()).toBe(3);
    expect(usageOf(parts)).toEqual({ inputTokens: 5046 * 3, outputTokens: 12 });
  });

  it("adds them onto the failure too, so a run that answered nothing still reports its cost", async () => {
    /**
     * The path that matters most: three empties bill 15,138 input tokens and produce no answer. Before
     * this the number reached the ledger as 5,046 — if it arrived at all, since the error chunk threw
     * ahead of `finish`.
     */
    const { model } = modelReturning(EMPTY);
    const wrapped = withEmptyCandidateRetry(model, { attempts: 3, onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(usageOf(parts)).toEqual({ inputTokens: 5046 * 3, outputTokens: 0 });
  });

  it("does not double-count the attempt that survived", async () => {
    // The off-by-one this is most likely to have: the carry must hold the *discarded* attempts only.
    const { model, calls } = modelReturning(ANSWER);
    const wrapped = withEmptyCandidateRetry(model, { attempts: 3, onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(calls()).toBe(1);
    expect(usageOf(parts)).toEqual({ inputTokens: 5046, outputTokens: 12 });
  });

  it("carries a field it has never heard of, rather than dropping it", async () => {
    /**
     * The reason the sum is generic over field names. The platform reads seven usage fields today and
     * providers keep adding them; a hand-written list here would carry the ones someone remembered and
     * silently zero the rest, which is the same under-count in a smaller place.
     */
    const withNewField: readonly Part[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-end", id: "0" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 100, thoughtTokens: 40, modelTier: "pro" } },
    ];
    const { model } = modelReturning(withNewField);
    const wrapped = withEmptyCandidateRetry(model, { attempts: 2, onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(usageOf(parts)).toMatchObject({ inputTokens: 200, thoughtTokens: 80 });
    // And a non-numeric field is passed through untouched rather than turned into NaN.
    expect(usageOf(parts)).toMatchObject({ modelTier: "pro" });
  });

  it("leaves the stream alone when nothing was discarded", async () => {
    // A pass-through in the ordinary case: no extra stream wrapper on the path every turn takes.
    const { model } = modelReturning(TOOL_CALL);
    const wrapped = withEmptyCandidateRetry(model, { attempts: 3, onRetry: () => {}, onExhausted: () => {} });

    const parts = await drain(wrapped as never);

    expect(usageOf(parts)).toEqual({ inputTokens: 5046, outputTokens: 9 });
    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "tool-input-start",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
  });
});
