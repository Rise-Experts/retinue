/**
 * The embedding adapter's two invariants — REQ-050 (#209), task #219.
 *
 * Both are about *silent* corruption. An adapter that pairs a chunk with its neighbour's vector still returns
 * plausible search results, so nothing downstream notices; the only place it can be caught is here.
 */
import { describe, expect, it, vi } from "vitest";
import { createOpenAiEmbeddings } from "../openai.js";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const vector = (fill: number, dimensions = 1536) => Array.from({ length: dimensions }, () => fill);

const initOf = (call: unknown): RequestInit => (call as [string, RequestInit])[1];

describe("order and count are verified, not assumed", () => {
  it("sorts by the index the API reports, rather than trusting array order", async () => {
    // The response deliberately arrives out of order. A provider that did this would otherwise attach every
    // chunk to the wrong vector, and retrieval would keep working well enough to look fine.
    const fetchImpl = vi.fn(async () =>
      reply({
        data: [
          { index: 1, embedding: vector(0.2) },
          { index: 0, embedding: vector(0.1) },
        ],
      }),
    );
    const embeddings = createOpenAiEmbeddings({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const [first, second] = await embeddings.embed(["a", "b"]);
    expect(first?.[0]).toBe(0.1);
    expect(second?.[0]).toBe(0.2);
  });

  it("refuses a response with the wrong number of vectors", async () => {
    const fetchImpl = vi.fn(async () => reply({ data: [{ index: 0, embedding: vector(0.1) }] }));
    const embeddings = createOpenAiEmbeddings({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(embeddings.embed(["a", "b"])).rejects.toThrow(/received 1/);
  });

  it("refuses a vector of the wrong width, rather than storing it", async () => {
    // A column pinned at 1536 and a vector of 3072 is a corpus with two incomparable halves.
    const fetchImpl = vi.fn(async () => reply({ data: [{ index: 0, embedding: vector(0.1, 8) }] }));
    const embeddings = createOpenAiEmbeddings({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(embeddings.embed(["a"])).rejects.toThrow(/dimensions/);
  });
});

describe("failures are classified so a caller knows whether to retry", () => {
  it("treats a rate limit as retryable and a bad request as permanent", async () => {
    const rateLimited = createOpenAiEmbeddings({
      apiKey: "k",
      fetchImpl: (async () => reply({ error: { message: "slow down" } }, 429)) as unknown as typeof fetch,
    });
    await expect(rateLimited.embed(["a"])).rejects.toMatchObject({ code: "rate_limited", retryable: true });

    const badRequest = createOpenAiEmbeddings({
      apiKey: "k",
      fetchImpl: (async () => reply({ error: { message: "no such model" } }, 400)) as unknown as typeof fetch,
    });
    await expect(badRequest.embed(["a"])).rejects.toMatchObject({ code: "provider_error", retryable: false });
  });

  it("asks for nothing when given nothing", async () => {
    const fetchImpl = vi.fn(async () => reply({ data: [] }));
    const embeddings = createOpenAiEmbeddings({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await embeddings.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  it("batches rather than sending one enormous body, and does so sequentially", async () => {
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      sizes.push(body.input.length);
      return reply({ data: body.input.map((_, index) => ({ index, embedding: vector(0.1) })) });
    });
    const embeddings = createOpenAiEmbeddings({
      apiKey: "k",
      batchSize: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await embeddings.embed(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    expect(sizes).toEqual([2, 1]);
  });

  it("names the model and records a version the deployment chose", async () => {
    const fetchImpl = vi.fn(async () => reply({ data: [{ index: 0, embedding: vector(0.1) }] }));
    const embeddings = createOpenAiEmbeddings({
      apiKey: "k",
      modelId: "text-embedding-3-large",
      dimensions: 1536,
      version: "2026-08",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await embeddings.embed(["a"]);
    const body = JSON.parse(String(initOf(fetchImpl.mock.calls[0]).body)) as { model: string };
    expect(body.model).toBe("text-embedding-3-large");
    // Providers change what an id returns without renaming it; the version is how that becomes detectable.
    expect(embeddings.model.version).toBe("2026-08");
  });

  it("sends the key as a bearer token", async () => {
    const fetchImpl = vi.fn(async () => reply({ data: [{ index: 0, embedding: vector(0.1) }] }));
    const embeddings = createOpenAiEmbeddings({ apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await embeddings.embed(["a"]);
    const headers = new Headers(initOf(fetchImpl.mock.calls[0]).headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
  });
});
