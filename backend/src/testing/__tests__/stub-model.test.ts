/**
 * The scripted model — REQ-060 (#251), task #253 AC-4.
 *
 * Testing an agent used to mean writing a `streamTurn` by hand, and every consumer wrote the same one badly: a
 * single `text-delta` and a `finish`. That exercises none of the paths that break, because the interesting
 * behaviour of this platform lives in what the model does *across steps*.
 */
import { describe, expect, it } from "vitest";
import type { ModelTurnRequest, NeutralStreamChunk } from "../../models/streaming.js";
import { createStubModel } from "../stub-model.js";

const drain = async (iterable: AsyncIterable<NeutralStreamChunk>): Promise<NeutralStreamChunk[]> => {
  const out: NeutralStreamChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
};

const request = {} as ModelTurnRequest;

describe("scripted turns", () => {
  it("answers with text", async () => {
    const model = createStubModel([{ say: "hello" }]);
    const chunks = await drain(model.streamTurn(request));
    expect(chunks.map((c) => c.type)).toEqual(["text-delta", "finish"]);
    expect((chunks[0] as { text: string }).text).toBe("hello");
  });

  it("calls tools and then answers, in one turn", async () => {
    const model = createStubModel([
      { call: [{ tool: "lookup", input: { id: 1 } }, { tool: "other" }], then: "done" },
    ]);
    const chunks = await drain(model.streamTurn(request));
    expect(chunks.map((c) => c.type)).toEqual(["tool-call", "tool-call", "text-delta", "finish"]);
    expect((chunks[0] as { toolName: string }).toolName).toBe("lookup");
    expect((chunks[0] as { input: unknown }).input).toEqual({ id: 1 });
  });

  it("does not emit its own tool-result", async () => {
    // The engine runs the tool, and that is the path under test. A stub producing its own result would test the
    // stub and hide an unwired tool completely.
    const model = createStubModel([{ call: [{ tool: "lookup" }] }]);
    const chunks = await drain(model.streamTurn(request));
    expect(chunks.some((c) => c.type === "tool-result")).toBe(false);
  });

  it("advances one turn per call, so a multi-turn script reads in order", async () => {
    const model = createStubModel([{ say: "one" }, { say: "two" }]);
    expect(((await drain(model.streamTurn(request)))[0] as { text: string }).text).toBe("one");
    expect(((await drain(model.streamTurn(request)))[0] as { text: string }).text).toBe("two");
    expect(model.turns()).toBe(2);
  });

  it("records every request, so a test can assert what the model was given", async () => {
    const model = createStubModel([{ say: "x" }]);
    await drain(model.streamTurn({ system: "be brief" } as ModelTurnRequest));
    expect(model.requests[0]?.system).toBe("be brief");
  });
});

describe("failures", () => {
  it("throws a platform error, retryable by default", async () => {
    // The retry path is the one worth scripting; a non-retryable failure is just a thrown error.
    const model = createStubModel([{ fail: "upstream exploded" }]);
    await expect(drain(model.streamTurn(request))).rejects.toMatchObject({
      code: "provider_error",
      retryable: true,
    });
  });

  it("can be told not to be retryable", async () => {
    const model = createStubModel([{ fail: "no", code: "capability_unavailable", retryable: false }]);
    await expect(drain(model.streamTurn(request))).rejects.toMatchObject({ retryable: false });
  });

  it("scripts a failure then a success — the retry test", async () => {
    const model = createStubModel([{ fail: "transient" }, { say: "recovered" }]);
    await expect(drain(model.streamTurn(request))).rejects.toThrow(/transient/);
    expect(((await drain(model.streamTurn(request)))[0] as { text: string }).text).toBe("recovered");
  });
});

describe("running past the end of the script", () => {
  it("throws, naming both possibilities", async () => {
    // Loud, not empty. An agent that took one more turn than the author expected is a finding, and an empty
    // turn would let an assertion pass against a model that said nothing.
    const model = createStubModel([{ say: "only one" }]);
    await drain(model.streamTurn(request));
    await expect(drain(model.streamTurn(request))).rejects.toThrow(/script has 1 turn\(s\)/);
  });

  it("throws on the first call when the script is empty", async () => {
    await expect(drain(createStubModel([]).streamTurn(request))).rejects.toThrow(/0 turn\(s\)/);
  });
});

describe("the in-memory assembly", () => {
  it("gives a fresh world per call, because here the factory is the state", async () => {
    const { createMemoryStores } = await import("../memory-backend.js");
    const a = createMemoryStores();
    const b = createMemoryStores();
    expect(a.conversations).not.toBe(b.conversations);
    // The symptom of sharing one: a message that vanishes between being written and being read.
    expect(Object.keys(a).length).toBeGreaterThan(10);
  });
});
