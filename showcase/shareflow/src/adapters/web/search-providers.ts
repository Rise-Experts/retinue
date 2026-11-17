/**
 * Web-search providers, as configuration — REQ-041's `search_web`, finally wired to something.
 *
 * `search_web` has been registered and refusing every call: `webToolkitFrom` builds a provider only
 * when `RETINUE_SEARCH_API_KEY` **and** `RETINUE_SEARCH_ENDPOINT` are both set, compose passed the key
 * and a `RETINUE_SEARCH_PROVIDER` that nothing read, and the endpoint was never passed at all. So the
 * one variable that looked like the switch was inert, and the two that mattered could not both be set.
 *
 * This makes `RETINUE_SEARCH_PROVIDER` mean what it says, and **defaults to the one that needs no
 * key**, because that is what the deployment had before the cutover: DuckDuckGo. Search works out of
 * the box again, and a key upgrades it rather than enabling it.
 *
 * The shape is the platform's `SearchProvider`: where to send a query, what headers to send, whether
 * it is a POST and how to read the JSON back. Every provider here is a table entry rather than a code
 * path, which is what makes "we need all of these" a list rather than a rewrite.
 *
 *   duckduckgo  keyless   Instant Answer API. Real answers for entities and definitions; thin for
 *                         open-ended research — see the note on its parser.
 *   searxng     keyless   A SearXNG instance's JSON API. A real web index, and needs an endpoint:
 *                         self-hosted, or a public instance that has left JSON enabled.
 *   brave       key       Brave's own index. `X-Subscription-Token`, not a bearer.
 *   tavily      key       Built for retrieval: returns extracted page content, not just snippets. POST.
 *   serper      key       Google's results. POST, `X-API-KEY`.
 *
 * Snippets are clipped here as well as downstream: `MAX_SNIPPET_CHARS` bounds what reaches the model,
 * and a provider that returns a whole page in one field would otherwise spend the budget before the
 * platform's own limit applies.
 */

import type { SearchHit, SearchProvider } from "@retinue/agentkit/tools";

/** The providers this deployment can be pointed at. `RETINUE_SEARCH_PROVIDER` takes one of these. */
export const SEARCH_PROVIDERS = ["duckduckgo", "searxng", "brave", "tavily", "serper"] as const;

export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

/** The default, and deliberately the keyless one: search must work with no configuration at all. */
export const DEFAULT_SEARCH_PROVIDER: SearchProviderName = "duckduckgo";

/** Which providers refuse to work without a key. */
export const KEYED_PROVIDERS: readonly SearchProviderName[] = ["brave", "tavily", "serper"];

/** Which providers need an endpoint supplied, because there is no single vendor URL to default to. */
export const ENDPOINT_PROVIDERS: readonly SearchProviderName[] = ["searxng"];

const SNIPPET_CHARS = 400;

const clip = (value: unknown): string => {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Keep only hits with both a title and an http(s) URL — a hit the model cannot cite is noise. */
const usable = (hits: readonly SearchHit[]): readonly SearchHit[] =>
  hits.filter((hit) => hit.title !== "" && /^https?:\/\//iu.test(hit.url));

/**
 * A readable title from the last path segment of a URL, or `null` when there is nothing to read.
 *
 * `https://duckduckgo.com/Coffee_bean` → "Coffee bean". Used only where the provider gives no title of
 * its own; a guessed title is better than a title that repeats the snippet, and worse than a real one.
 */
const titleFromUrl = (url: string): string | null => {
  const segment = url.split(/[?#]/u)[0]?.replace(/\/+$/u, "").split("/").pop() ?? "";
  const decoded = (() => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  })();
  const words = decoded.replace(/[_+]+/gu, " ").replace(/\s+/gu, " ").trim();
  // `/c/Specialty_coffees` and the like: a single short token is a category, not a title worth showing.
  return words.length < 2 ? null : words;
};

/**
 * DuckDuckGo's Instant Answer API.
 *
 * **What this is and is not.** DuckDuckGo publishes no web-index API; this endpoint answers with an
 * *instant answer* — an abstract for an entity, plus related topics — and returns nothing at all for
 * many ordinary queries. It is keyless, official and stable, which is why it is the default, and it is
 * the honest free option rather than a good one. A deployment that needs research-grade results wants
 * `tavily` or `brave`; one that wants a real index for free wants a `searxng` instance.
 *
 * Scraping `html.duckduckgo.com` would give better results and is not done here: the platform's client
 * parses JSON, the markup is undocumented and changes, and it is against DuckDuckGo's terms — a
 * provider that breaks silently on someone else's deploy is worse than one with known limits.
 *
 * `RelatedTopics` nests: a disambiguation answer puts its entries under `Topics`, one level down.
 */
const duckduckgo = (): SearchProvider => ({
  name: "duckduckgo",
  endpoint: (query) =>
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&skip_disambig=0`,
  parse: (payload) => {
    const body = (payload ?? {}) as {
      AbstractText?: unknown;
      AbstractURL?: unknown;
      Heading?: unknown;
      RelatedTopics?: unknown;
    };

    const abstract: readonly SearchHit[] =
      str(body.AbstractText) !== "" && str(body.AbstractURL) !== ""
        ? [
            {
              title: str(body.Heading) !== "" ? str(body.Heading) : str(body.AbstractURL),
              url: str(body.AbstractURL),
              snippet: clip(body.AbstractText),
            },
          ]
        : [];

    const flatten = (topics: unknown): readonly SearchHit[] => {
      if (!Array.isArray(topics)) return [];
      return topics.flatMap((topic): readonly SearchHit[] => {
        const entry = (topic ?? {}) as { Text?: unknown; FirstURL?: unknown; Topics?: unknown };
        if (entry.Topics !== undefined) return flatten(entry.Topics);
        const text = str(entry.Text);
        const url = str(entry.FirstURL);
        if (text === "" || url === "") return [];
        /**
         * `Text` is usually "Title - description", and sometimes just a sentence.
         *
         * When the separator is there, split on the first one. When it is not — which is what a
         * disambiguation list returns — the title falls back to the URL's last segment, because the
         * alternative is a hit whose title and snippet are the same sentence: seen against the live
         * endpoint, where "coffee" came back as three results each titled *"Coffee A beverage brewed
         * from roasted ground coffee beans."* Reading the slug gives "Coffee", "Coffee bean",
         * "Coffea arabica".
         */
        const split = text.indexOf(" - ");
        if (split !== -1) {
          return [{ title: clip(text.slice(0, split)), url, snippet: clip(text.slice(split + 3)) }];
        }
        return [{ title: titleFromUrl(url) ?? clip(text), url, snippet: clip(text) }];
      });
    };

    return usable([...abstract, ...flatten(body.RelatedTopics)]);
  },
});

/**
 * A SearXNG instance's JSON API.
 *
 * Keyless and a real web index, at the cost of needing an instance: `RETINUE_SEARCH_ENDPOINT` points at
 * one. Many public instances disable `format=json`, so a deployment that wants this reliably runs its
 * own — which is also the only version where the query log belongs to the deployment.
 */
const searxng = (endpoint: string): SearchProvider => ({
  name: "searxng",
  endpoint: (query) => `${endpoint.replace(/\/+$/u, "")}/search?q=${encodeURIComponent(query)}&format=json`,
  parse: (payload) => {
    const results = ((payload ?? {}) as { results?: unknown }).results;
    if (!Array.isArray(results)) return [];
    return usable(
      results.map((row) => {
        const entry = (row ?? {}) as { title?: unknown; url?: unknown; content?: unknown };
        return { title: clip(entry.title), url: str(entry.url), snippet: clip(entry.content) };
      }),
    );
  },
});

/** Brave's index. The key goes in `X-Subscription-Token`, which is not a bearer — a common mis-wire. */
const brave = (apiKey: string, endpoint?: string): SearchProvider => ({
  name: "brave",
  endpoint: (query, limit) =>
    `${(endpoint ?? "https://api.search.brave.com/res/v1/web/search").replace(/\/+$/u, "")}` +
    `?q=${encodeURIComponent(query)}&count=${String(limit)}`,
  headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  parse: (payload) => {
    const results = (((payload ?? {}) as { web?: { results?: unknown } }).web ?? {}).results;
    if (!Array.isArray(results)) return [];
    return usable(
      results.map((row) => {
        const entry = (row ?? {}) as { title?: unknown; url?: unknown; description?: unknown };
        return { title: clip(entry.title), url: str(entry.url), snippet: clip(entry.description) };
      }),
    );
  },
});

/**
 * Tavily, which returns extracted page content rather than snippets.
 *
 * The best answers of the five for an assistant, because the model gets prose it can quote instead of a
 * title and forty words. POST with a bearer key.
 */
const tavily = (apiKey: string, endpoint?: string): SearchProvider => ({
  name: "tavily",
  endpoint: () => (endpoint ?? "https://api.tavily.com/search").replace(/\/+$/u, ""),
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: (query, limit) => ({ query, max_results: limit, search_depth: "basic" }),
  parse: (payload) => {
    const results = ((payload ?? {}) as { results?: unknown }).results;
    if (!Array.isArray(results)) return [];
    return usable(
      results.map((row) => {
        const entry = (row ?? {}) as { title?: unknown; url?: unknown; content?: unknown };
        return { title: clip(entry.title), url: str(entry.url), snippet: clip(entry.content) };
      }),
    );
  },
});

/** Serper, which is Google's results. POST, and the key is `X-API-KEY`. */
const serper = (apiKey: string, endpoint?: string): SearchProvider => ({
  name: "serper",
  endpoint: () => (endpoint ?? "https://google.serper.dev/search").replace(/\/+$/u, ""),
  method: "POST",
  headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
  body: (query, limit) => ({ q: query, num: limit }),
  parse: (payload) => {
    const body = (payload ?? {}) as { organic?: unknown; answerBox?: unknown };
    const answer = (body.answerBox ?? {}) as { title?: unknown; link?: unknown; snippet?: unknown };
    const first: readonly SearchHit[] =
      str(answer.link) !== ""
        ? [{ title: clip(answer.title), url: str(answer.link), snippet: clip(answer.snippet) }]
        : [];
    const organic = Array.isArray(body.organic)
      ? body.organic.map((row) => {
          const entry = (row ?? {}) as { title?: unknown; link?: unknown; snippet?: unknown };
          return { title: clip(entry.title), url: str(entry.link), snippet: clip(entry.snippet) };
        })
      : [];
    return usable([...first, ...organic]);
  },
});

export type SearchProviderChoice =
  | { readonly ok: true; readonly provider: SearchProvider; readonly name: SearchProviderName }
  | { readonly ok: false; readonly why: string };

/**
 * Pick a provider from the environment.
 *
 * A **refusal with a reason**, not a silent fallback to "no search": a deployment that set
 * `RETINUE_SEARCH_PROVIDER=brave` and forgot the key wants to hear about the key. Falling back to
 * DuckDuckGo there would answer the question with a worse index and never mention it, which is the
 * class of quiet substitution this application keeps finding.
 */
export const searchProviderFrom = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): SearchProviderChoice => {
  const asked = (env["RETINUE_SEARCH_PROVIDER"] ?? "").trim().toLowerCase();
  const name = (asked === "" ? DEFAULT_SEARCH_PROVIDER : asked) as SearchProviderName;

  if (!(SEARCH_PROVIDERS as readonly string[]).includes(name)) {
    return {
      ok: false,
      why:
        `RETINUE_SEARCH_PROVIDER is "${asked}", which is not one of ${SEARCH_PROVIDERS.join(", ")}. ` +
        `Leave it unset for ${DEFAULT_SEARCH_PROVIDER}, which needs no key.`,
    };
  }

  const apiKey = (env["RETINUE_SEARCH_API_KEY"] ?? "").trim();
  const endpoint = (env["RETINUE_SEARCH_ENDPOINT"] ?? "").trim();

  if (KEYED_PROVIDERS.includes(name) && apiKey === "") {
    return { ok: false, why: `the ${name} search provider needs RETINUE_SEARCH_API_KEY.` };
  }
  if (ENDPOINT_PROVIDERS.includes(name) && endpoint === "") {
    return {
      ok: false,
      why: `the ${name} search provider needs RETINUE_SEARCH_ENDPOINT — the instance to query.`,
    };
  }

  switch (name) {
    case "duckduckgo":
      return { ok: true, name, provider: duckduckgo() };
    case "searxng":
      return { ok: true, name, provider: searxng(endpoint) };
    case "brave":
      return { ok: true, name, provider: brave(apiKey, endpoint === "" ? undefined : endpoint) };
    case "tavily":
      return { ok: true, name, provider: tavily(apiKey, endpoint === "" ? undefined : endpoint) };
    case "serper":
      return { ok: true, name, provider: serper(apiKey, endpoint === "" ? undefined : endpoint) };
  }
};
