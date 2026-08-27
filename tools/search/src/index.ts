/**
 * Web-search providers — REQ-047 (#206), task #214.
 *
 * **This package exports no tools.** That is the interesting thing about it, and it is the "one contract, several
 * providers" rule from `docs/23-tool-catalogue.md` applied literally.
 *
 * `web_search` already exists in the runtime and already takes its provider as configuration: a `name`, how to
 * build the request, and how to read the response. So five search vendors are not five tools — they are five
 * values of one parameter, and a model that saw `tavily_search`, `brave_search` and `serper_search` as separate
 * tools would be choosing a vendor, which is a deployment's decision and not a model's.
 *
 * Reading the reference list literally would have produced twenty-two search tools out of a hundred and thirty
 * toolkits. This is what removes about a hundred and twenty of the five hundred and eighty-eight.
 *
 * ## Why these keys are configuration rather than a `credentialRef`
 *
 * A distinction worth stating, because getting it wrong in either direction is a real bug.
 *
 * A **per-tenant** credential — a customer's GitHub token, their Slack workspace — must be resolved per call, or
 * one tenant sends another's token. A **platform** credential — a search API key the vendor bills *us* for — is
 * one key for the whole deployment, and resolving it per call is overhead that buys nothing.
 *
 * Search keys are the second kind, so they are constructor arguments. If a deployment ever needs per-tenant
 * search billing, that is a `credentialRef` and this comment is the reason it would be a change rather than an
 * oversight.
 */

import type { SearchHit, SearchProvider } from "@retinue/agentkit/tools";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Rows a provider returned, whatever it called the array. */
const rowsOf = (payload: unknown, ...keys: readonly string[]): readonly Record<string, unknown>[] => {
  if (payload === null || typeof payload !== "object") return [];
  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
  }
  return [];
};

const hit = (row: Record<string, unknown>, titleKey: string, urlKey: string, snippetKey: string): SearchHit => ({
  title: text(row[titleKey]),
  url: text(row[urlKey]),
  snippet: text(row[snippetKey]),
});

/**
 * Brave Search — GET, key in a header of its own.
 *
 * `X-Subscription-Token` rather than `authorization`, which the HTTP client reserves: a tool input that could set
 * `authorization` would let a model choose which credential to spend and where to send it.
 */
export const braveSearch = (config: { readonly apiKey: string }): SearchProvider => ({
  name: "brave",
  endpoint: (query, limit) => `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
  headers: { "x-subscription-token": config.apiKey, accept: "application/json" },
  parse: (payload) => {
    const web = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>).web : undefined;
    return rowsOf(web, "results").map((row) => hit(row, "title", "url", "description"));
  },
});

/**
 * Tavily — POST, key in the body.
 *
 * The body rather than a header because `authorization` is reserved, and Tavily accepts `api_key` in the payload.
 * This is why the provider contract gained `method` and `body`: it was GET-only, and Tavily, Serper and Exa are
 * all POST — a "several providers" rule with two possible providers.
 */
export const tavilySearch = (config: { readonly apiKey: string; readonly depth?: "basic" | "advanced" }): SearchProvider => ({
  name: "tavily",
  method: "POST",
  endpoint: () => "https://api.tavily.com/search",
  headers: { "content-type": "application/json" },
  body: (query, limit) => ({
    api_key: config.apiKey,
    query,
    max_results: limit,
    search_depth: config.depth ?? "basic",
  }),
  parse: (payload) => rowsOf(payload, "results").map((row) => hit(row, "title", "url", "content")),
});

/** Serper — POST, key in its own header. */
export const serperSearch = (config: { readonly apiKey: string }): SearchProvider => ({
  name: "serper",
  method: "POST",
  endpoint: () => "https://google.serper.dev/search",
  headers: { "x-api-key": config.apiKey, "content-type": "application/json" },
  body: (query, limit) => ({ q: query, num: limit }),
  parse: (payload) => rowsOf(payload, "organic").map((row) => hit(row, "title", "link", "snippet")),
});

/**
 * SearXNG — GET, self-hosted, no key.
 *
 * Included because it is the one provider a deployment can run itself, which makes it the only option for
 * somebody who cannot send queries to a third party at all. `baseUrl` is required for the same reason: there is
 * no public instance this package should default to sending a tenant's queries to.
 */
export const searxngSearch = (config: { readonly baseUrl: string }): SearchProvider => ({
  name: "searxng",
  endpoint: (query, limit) =>
    `${config.baseUrl.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(query)}&pageno=1&results=${limit}`,
  headers: { accept: "application/json" },
  parse: (payload) => rowsOf(payload, "results").map((row) => hit(row, "title", "url", "content")),
});

/** Every provider this package offers, so a host can pick one from configuration. */
export const SEARCH_PROVIDERS = ["brave", "tavily", "serper", "searxng"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

/**
 * This package declares no tools, and says so out loud.
 *
 * `npm run check:catalogue` requires every `tools/*` package to export this constant, and cross-checks its length
 * against the tool declarations in this file. An empty array is therefore a claim the check verifies rather than
 * a package it skips — the difference between "ships providers for a contract that already exists" and "somebody
 * forgot to classify six tools".
 */
export const SEARCH_TOOL_NAMES = [] as const;
