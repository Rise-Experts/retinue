/**
 * The web-search providers.
 *
 * `search_web` was registered and refusing every call: the toolkit built a provider only when a key
 * *and* an endpoint were both set, compose passed the key and a `RETINUE_SEARCH_PROVIDER` nothing read,
 * and never passed the endpoint at all. On top of that the one hardcoded shape — `Authorization:
 * Bearer` with `?q=&count=` — is wrong for three of the five providers anyone uses: Brave wants
 * `X-Subscription-Token`, Tavily and Serper are POST, and Serper's key header is `X-API-KEY`.
 *
 * So the parsers and the header/verb choices are the whole substance here, and they are the part that
 * fails silently: a wrong header is a 401 the model reports as "search is unavailable", and a wrong
 * parser is an empty result set indistinguishable from "nothing found". The payloads below are the
 * documented response shapes, trimmed.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_PROVIDER,
  SEARCH_PROVIDERS,
  searchProviderFrom,
} from "../search-providers.js";

const pick = (env: Record<string, string | undefined>) => {
  const choice = searchProviderFrom(env);
  if (!choice.ok) throw new Error(`expected a provider: ${choice.why}`);
  return choice;
};

describe("choosing a provider", () => {
  it("defaults to the keyless one, so search works with nothing configured", () => {
    /**
     * The point of the default. Before the cutover this deployment searched with DuckDuckGo and no
     * key; a default that needed one would have made "search is unavailable" the out-of-the-box state.
     */
    const choice = pick({});
    expect(choice.name).toBe(DEFAULT_SEARCH_PROVIDER);
    expect(choice.name).toBe("duckduckgo");
    expect(choice.provider.headers?.["Authorization"]).toBeUndefined();
  });

  it("honours RETINUE_SEARCH_PROVIDER, which nothing used to read", () => {
    expect(pick({ RETINUE_SEARCH_PROVIDER: "brave", RETINUE_SEARCH_API_KEY: "k" }).name).toBe("brave");
    expect(pick({ RETINUE_SEARCH_PROVIDER: "TAVILY", RETINUE_SEARCH_API_KEY: "k" }).name).toBe("tavily");
  });

  it("refuses a keyed provider with no key, and says which variable", () => {
    /**
     * A refusal rather than a quiet fallback to DuckDuckGo: a deployment that asked for Brave and
     * forgot the key wants to hear about the key, not to get a different index without being told.
     */
    const choice = searchProviderFrom({ RETINUE_SEARCH_PROVIDER: "brave" });
    expect(choice.ok).toBe(false);
    expect(choice.ok === false && choice.why).toContain("RETINUE_SEARCH_API_KEY");
  });

  it("refuses searxng with no instance to query", () => {
    const choice = searchProviderFrom({ RETINUE_SEARCH_PROVIDER: "searxng" });
    expect(choice.ok === false && choice.why).toContain("RETINUE_SEARCH_ENDPOINT");
  });

  it("refuses an unknown name and lists the real ones", () => {
    const choice = searchProviderFrom({ RETINUE_SEARCH_PROVIDER: "google" });
    expect(choice.ok).toBe(false);
    for (const name of SEARCH_PROVIDERS) expect(choice.ok === false && choice.why).toContain(name);
  });
});

describe("duckduckgo", () => {
  const provider = pick({}).provider;

  it("asks the Instant Answer API for JSON with the query encoded", () => {
    const url = provider.endpoint("coffee trends 2026", 5);
    expect(url).toContain("api.duckduckgo.com");
    expect(url).toContain("q=coffee%20trends%202026");
    expect(url).toContain("format=json");
  });

  it("reads the abstract as the first hit", () => {
    const hits = provider.parse({
      Heading: "Coffee",
      AbstractText: "Coffee is a beverage brewed from roasted coffee beans.",
      AbstractURL: "https://en.wikipedia.org/wiki/Coffee",
    });
    expect(hits[0]).toEqual({
      title: "Coffee",
      url: "https://en.wikipedia.org/wiki/Coffee",
      snippet: "Coffee is a beverage brewed from roasted coffee beans.",
    });
  });

  it("splits a related topic into a title and a snippet", () => {
    const hits = provider.parse({
      RelatedTopics: [{ Text: "Cold brew - Coffee brewed with cold water over many hours.", FirstURL: "https://example.com/cold-brew" }],
    });
    expect(hits[0]?.title).toBe("Cold brew");
    expect(hits[0]?.snippet).toBe("Coffee brewed with cold water over many hours.");
  });

  it("takes the title from the URL when the text has no separator", () => {
    /**
     * Against the live endpoint, "coffee" returns three disambiguation entries whose `Text` is one
     * sentence with no " - " in it — so the title and the snippet came out identical: *"Coffee A
     * beverage brewed from roasted ground coffee beans."* twice. The slug reads better and is true.
     */
    const hits = provider.parse({
      RelatedTopics: [
        { Text: "Coffee A beverage brewed from roasted ground coffee beans.", FirstURL: "https://duckduckgo.com/Coffee_bean" },
      ],
    });
    expect(hits[0]?.title).toBe("Coffee bean");
    expect(hits[0]?.snippet).toBe("Coffee A beverage brewed from roasted ground coffee beans.");
  });

  it("keeps the text as the title when the URL has no readable segment", () => {
    const hits = provider.parse({ RelatedTopics: [{ Text: "Some answer", FirstURL: "https://example.com/x" }] });
    expect(hits[0]?.title).toBe("Some answer");
  });

  it("flattens the nested Topics a disambiguation answer returns", () => {
    // The shape that would otherwise silently produce nothing: entries one level down under `Topics`.
    const hits = provider.parse({
      RelatedTopics: [
        { Name: "Drinks", Topics: [{ Text: "Espresso - A concentrated coffee.", FirstURL: "https://example.com/espresso" }] },
      ],
    });
    expect(hits.map((hit) => hit.title)).toEqual(["Espresso"]);
  });

  it("drops a hit with no usable URL rather than offering an uncitable one", () => {
    expect(provider.parse({ RelatedTopics: [{ Text: "No link here", FirstURL: "" }] })).toEqual([]);
    expect(provider.parse({ AbstractText: "x", AbstractURL: "not-a-url", Heading: "x" })).toEqual([]);
  });

  it("is empty, not broken, for a query the API has no answer for", () => {
    // Which is common — this is an instant-answer API and not a web index. Empty means "found nothing".
    expect(provider.parse({ RelatedTopics: [] })).toEqual([]);
    expect(provider.parse({})).toEqual([]);
  });
});

describe("brave", () => {
  const provider = pick({ RETINUE_SEARCH_PROVIDER: "brave", RETINUE_SEARCH_API_KEY: "brave-key" }).provider;

  it("sends the key as X-Subscription-Token, not a bearer", () => {
    // The mis-wire the old generic provider shipped: a bearer here is a 401 on every search.
    expect(provider.headers?.["X-Subscription-Token"]).toBe("brave-key");
    expect(provider.headers?.["Authorization"]).toBeUndefined();
  });

  it("is a GET with the query and the count in the URL", () => {
    expect(provider.method ?? "GET").toBe("GET");
    expect(provider.endpoint("coffee", 3)).toContain("q=coffee&count=3");
  });

  it("reads web.results", () => {
    const hits = provider.parse({
      web: { results: [{ title: "Coffee trends", url: "https://example.com/a", description: "What is changing." }] },
    });
    expect(hits).toEqual([{ title: "Coffee trends", url: "https://example.com/a", snippet: "What is changing." }]);
  });
});

describe("tavily", () => {
  const provider = pick({ RETINUE_SEARCH_PROVIDER: "tavily", RETINUE_SEARCH_API_KEY: "tvly" }).provider;

  it("is a POST with a bearer key and the limit in the body", () => {
    expect(provider.method).toBe("POST");
    expect(provider.headers?.["Authorization"]).toBe("Bearer tvly");
    expect(provider.body?.("coffee", 4)).toEqual({ query: "coffee", max_results: 4, search_depth: "basic" });
  });

  it("reads the extracted content as the snippet", () => {
    const hits = provider.parse({ results: [{ title: "Trends", url: "https://example.com/b", content: "Extracted prose." }] });
    expect(hits[0]?.snippet).toBe("Extracted prose.");
  });
});

describe("serper", () => {
  const provider = pick({ RETINUE_SEARCH_PROVIDER: "serper", RETINUE_SEARCH_API_KEY: "serp" }).provider;

  it("is a POST with X-API-KEY and Google's field names", () => {
    expect(provider.method).toBe("POST");
    expect(provider.headers?.["X-API-KEY"]).toBe("serp");
    expect(provider.body?.("coffee", 6)).toEqual({ q: "coffee", num: 6 });
  });

  it("puts the answer box first, then the organic results", () => {
    const hits = provider.parse({
      answerBox: { title: "Direct answer", link: "https://example.com/answer", snippet: "42" },
      organic: [{ title: "First result", link: "https://example.com/1", snippet: "…" }],
    });
    expect(hits.map((hit) => hit.title)).toEqual(["Direct answer", "First result"]);
  });
});

describe("searxng", () => {
  const provider = pick({ RETINUE_SEARCH_PROVIDER: "searxng", RETINUE_SEARCH_ENDPOINT: "https://searx.test/" }).provider;

  it("asks the instance for JSON without doubling the slash", () => {
    expect(provider.endpoint("coffee", 5)).toBe("https://searx.test/search?q=coffee&format=json");
  });

  it("reads results", () => {
    const hits = provider.parse({ results: [{ title: "Coffee", url: "https://example.com/c", content: "A drink." }] });
    expect(hits[0]?.url).toBe("https://example.com/c");
  });
});

describe("every provider", () => {
  const configured = [
    pick({}),
    pick({ RETINUE_SEARCH_PROVIDER: "searxng", RETINUE_SEARCH_ENDPOINT: "https://searx.test" }),
    pick({ RETINUE_SEARCH_PROVIDER: "brave", RETINUE_SEARCH_API_KEY: "k" }),
    pick({ RETINUE_SEARCH_PROVIDER: "tavily", RETINUE_SEARCH_API_KEY: "k" }),
    pick({ RETINUE_SEARCH_PROVIDER: "serper", RETINUE_SEARCH_API_KEY: "k" }),
  ];

  it("covers the whole list, so a name cannot be advertised with nothing behind it", () => {
    expect(configured.map((choice) => choice.name).sort()).toEqual([...SEARCH_PROVIDERS].sort());
  });

  it("survives a payload of the wrong shape without throwing", () => {
    /**
     * A provider that throws inside `parse` takes the turn down; one that returns `[]` reports "found
     * nothing". Providers change their response shapes, and an error page is not always HTML.
     */
    for (const { name, provider } of configured) {
      for (const payload of [null, undefined, 42, "text", [], {}, { results: "no" }, { web: null }]) {
        expect(() => provider.parse(payload), name).not.toThrow();
        expect(provider.parse(payload), name).toEqual([]);
      }
    }
  });

  it("clips a snippet that arrives as a whole page", () => {
    // Tavily in particular can return a lot; the budget should not be spent by one hit.
    const hits = pick({ RETINUE_SEARCH_PROVIDER: "tavily", RETINUE_SEARCH_API_KEY: "k" }).provider.parse({
      results: [{ title: "Long", url: "https://example.com/long", content: "x".repeat(5_000) }],
    });
    expect(hits[0]?.snippet.length).toBe(400);
    expect(hits[0]?.snippet.endsWith("…")).toBe(true);
  });

  it("names itself, so a failure says which provider failed", () => {
    for (const { name, provider } of configured) expect(provider.name).toBe(name);
  });
});
