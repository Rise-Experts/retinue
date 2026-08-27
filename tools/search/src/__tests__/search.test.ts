/**
 * Search providers — REQ-047 (#206), task #214.
 *
 * These test the *adapters*, and the fact that they are adapters is the point: this package exports no tools, so
 * there is nothing here about approval or classification. Five vendors are five values of one parameter.
 */
import { describe, expect, it, vi } from "vitest";
import { createWebSearch } from "@retinue/agentkit/tools";
import { braveSearch, searxngSearch, serperSearch, tavilySearch, SEARCH_PROVIDERS } from "../index.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("each provider builds its own request", () => {
  it("Brave: GET, key in its own header, never `authorization`", () => {
    const provider = braveSearch({ apiKey: "brave-key" });
    expect(provider.method ?? "GET").toBe("GET");
    expect(provider.endpoint("cats", 3)).toContain("q=cats");
    expect(provider.endpoint("cats", 3)).toContain("count=3");
    // `authorization` is reserved by the HTTP client: a tool input that could set it would let a model choose
    // which credential to spend and where to send it.
    expect(Object.keys(provider.headers ?? {})).not.toContain("authorization");
    expect(provider.headers?.["x-subscription-token"]).toBe("brave-key");
  });

  it("Tavily: POST with the key in the body", () => {
    const provider = tavilySearch({ apiKey: "tv-key" });
    expect(provider.method).toBe("POST");
    expect(provider.body?.("cats", 4)).toMatchObject({ api_key: "tv-key", query: "cats", max_results: 4 });
  });

  it("Serper: POST with the key in its own header", () => {
    const provider = serperSearch({ apiKey: "sp-key" });
    expect(provider.method).toBe("POST");
    expect(provider.headers?.["x-api-key"]).toBe("sp-key");
    expect(provider.body?.("cats", 2)).toMatchObject({ q: "cats", num: 2 });
  });

  it("SearXNG: self-hosted, and requires its base URL", () => {
    // No default instance on purpose: there is no public endpoint this package should send a tenant's queries to.
    const provider = searxngSearch({ baseUrl: "https://searx.internal/" });
    expect(provider.endpoint("cats", 5).startsWith("https://searx.internal/search?")).toBe(true);
    expect(provider.headers?.["x-api-key"]).toBeUndefined();
  });
});

describe("each provider reads its own response shape", () => {
  it("maps Brave's nested results", () => {
    const hits = braveSearch({ apiKey: "k" }).parse({ web: { results: [{ title: "T", url: "u", description: "d" }] } });
    expect(hits).toEqual([{ title: "T", url: "u", snippet: "d" }]);
  });

  it("maps Tavily's content field to a snippet", () => {
    expect(tavilySearch({ apiKey: "k" }).parse({ results: [{ title: "T", url: "u", content: "c" }] })).toEqual([
      { title: "T", url: "u", snippet: "c" },
    ]);
  });

  it("maps Serper's organic results, whose url field is `link`", () => {
    expect(serperSearch({ apiKey: "k" }).parse({ organic: [{ title: "T", link: "u", snippet: "s" }] })).toEqual([
      { title: "T", url: "u", snippet: "s" },
    ]);
  });

  it("returns no hits rather than throwing on an unexpected shape", () => {
    // "Searched, found nothing" and "the provider changed its response" both have to be survivable: a throw here
    // becomes a failed run, and a made-up hit is worse than either.
    for (const provider of [braveSearch({ apiKey: "k" }), tavilySearch({ apiKey: "k" }), serperSearch({ apiKey: "k" })]) {
      expect(provider.parse({ unexpected: true })).toEqual([]);
      expect(provider.parse(null)).toEqual([]);
      expect(provider.parse("not json at all")).toEqual([]);
    }
  });
});

describe("through the runtime's own contract", () => {
  it("a POST provider actually sends a body — the reason the contract gained `method`", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [{ title: "T", url: "https://x", content: "c" }] }));
    const search = createWebSearch({ provider: tavilySearch({ apiKey: "k" }), fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await search("cats", 2);
    expect(outcome.searched).toBe(true);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ query: "cats" });
  });

  it("a GET provider sends no body", async () => {
    const fetchImpl = vi.fn(async () => json({ web: { results: [] } }));
    const search = createWebSearch({ provider: braveSearch({ apiKey: "k" }), fetchImpl: fetchImpl as unknown as typeof fetch });
    await search("cats", 2);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit | undefined;
    expect(init?.body).toBeUndefined();
  });

  it("with no provider it says it did not search, rather than returning nothing found", async () => {
    // The distinction the runtime already draws, restated here because this package is what makes it moot: a
    // stubbed search that returns plausible results is a tool the model trusts and cannot verify.
    const outcome = await createWebSearch({})("cats");
    expect(outcome.searched).toBe(false);
    if (!outcome.searched) expect(outcome.reason).toBe("not-configured");
  });
});

describe("the package exports providers, not tools", () => {
  it("names every provider it offers", () => {
    expect([...SEARCH_PROVIDERS]).toEqual(["brave", "tavily", "serper", "searxng"]);
  });

  it("exports no ToolProvider", async () => {
    // The "one contract, several providers" rule: `tavily_search` and `brave_search` as separate tools would make
    // a model choose a vendor, which is a deployment's decision.
    const module = await import("../index.js");
    expect(Object.keys(module).some((k) => /Toolkit|Tool$/.test(k))).toBe(false);
  });
});
