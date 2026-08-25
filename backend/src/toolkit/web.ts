/**
 * Reading the web — REQ-039 (#188).
 *
 * Two functions the library's `fetch_url`, `fetch_json` and `web_search` tools delegate to. Both go through
 * `createHttpClient`, so the egress policy, the redirect refusal, the byte ceiling and the untrusted-content
 * fence are decided in one place rather than three.
 */

import { createHttpClient } from "./http.js";
import type { HttpClient, HttpClientConfig, HttpOutcome } from "./http.js";

/**
 * Strip HTML to something a model can read.
 *
 * Crude and openly so: `script` and `style` bodies removed, tags dropped, entities for the five characters that
 * matter, whitespace collapsed. It is not a parser and does not need to be — the goal is *legible text*, and a
 * DOM implementation is both a dependency and an attack surface for a tool whose output is prose either way.
 *
 * `script` and `style` go **with their contents**; otherwise a page's JavaScript arrives as sentences and the
 * model reads minified code as content.
 */
export const htmlToText = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level ends become newlines first, so paragraphs do not run together into one wall of text.
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Ampersand last: first would turn `&amp;lt;` into `<`, the classic double-decode.
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type PageResult =
  | { readonly ok: true; readonly url: string; readonly status: number; readonly truncated: boolean; readonly content: string }
  | { readonly ok: false; readonly url: string; readonly reason: string };

/** Fetch a page and return readable text. HTML is flattened; anything else comes back as it arrived. */
export const createFetchPage = (config: HttpClientConfig & { readonly client?: HttpClient } = {}) => {
  const client = config.client ?? createHttpClient(config);
  return async (rawUrl: string): Promise<PageResult> => {
    const outcome = await client.request({ url: rawUrl, accept: "text/html, text/plain;q=0.9, */*;q=0.1" });
    if (!outcome.ok) return { ok: false, url: outcome.url, reason: outcome.reason };
    // Flattening happens after fencing, which is safe: `htmlToText` only removes markup, and the fence's
    // delimiters are not markup. Doing it the other way would let a page's tags rewrite the fence.
    const content = /html/i.test(outcome.contentType) ? htmlToText(outcome.body) : outcome.body;
    return { ok: true, url: outcome.url, status: outcome.status, truncated: outcome.truncated, content };
  };
};

export type JsonResult =
  | { readonly ok: true; readonly url: string; readonly status: number; readonly data: unknown }
  | { readonly ok: false; readonly url: string; readonly reason: string };

/**
 * Fetch and parse JSON.
 *
 * Requested unfenced, because the body is parsed here and reaches the model as *structured data*, not as prose.
 * Fencing it would put delimiters inside string values. The safety argument is different in kind: a parsed object
 * cannot forge a section boundary, and a caller rendering one back into a prompt is the caller that must fence.
 */
export const createFetchJson = (config: HttpClientConfig & { readonly client?: HttpClient } = {}) => {
  const client = config.client ?? createHttpClient(config);
  return async (rawUrl: string): Promise<JsonResult> => {
    const outcome = await client.request({ url: rawUrl, accept: "application/json", fence: false });
    if (!outcome.ok) return { ok: false, url: outcome.url, reason: outcome.reason };
    try {
      return { ok: true, url: outcome.url, status: outcome.status, data: JSON.parse(outcome.body) };
    } catch {
      return {
        ok: false,
        url: outcome.url,
        // Named precisely, because "invalid JSON" plus a truncation flag is the difference between a broken
        // endpoint and a response the ceiling cut in half.
        reason: outcome.truncated
          ? "The response was larger than the byte limit, so what arrived is not parseable JSON."
          : "That URL did not return valid JSON.",
      };
    }
  };
};

export type SearchHit = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

/**
 * What a search returned, or why it did not.
 *
 * `searched: false` is not an empty result list, and the distinction is the whole type. "I searched and found
 * nothing" and "I could not search" lead a model to opposite next actions, and collapsing them into `[]` makes it
 * confidently report that nothing exists.
 */
export type SearchOutcome =
  | { readonly searched: true; readonly query: string; readonly hits: readonly SearchHit[] }
  | { readonly searched: false; readonly query: string; readonly reason: "not-configured" | "unavailable" | "timed-out"; readonly detail: string };

/**
 * A search provider, as configuration.
 *
 * Deliberately not a hard-coded vendor. Every usable search API is a GET with a key and a JSON body of results,
 * so the shape a deployment supplies is: where to send it, and how to read what comes back. `apiKey` is
 * configuration and never appears in a tool's input schema — a model must not be able to name the credential it
 * wants spent.
 */
export type SearchProvider = {
  readonly name: string;
  /** Build the request URL for a query. The key belongs in `headers`, not here, wherever the provider allows it. */
  readonly endpoint: (query: string, limit: number) => string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Read the provider's JSON into hits. Returning `[]` means "searched, found nothing". */
  readonly parse: (payload: unknown) => readonly SearchHit[];
};

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SNIPPET_CHARS = 400;

/**
 * Web search over a configured provider.
 *
 * With no provider this returns `not-configured` rather than throwing or pretending. A stubbed search that
 * returns plausible-looking results is worse than no search: it is a tool the model trusts and cannot verify.
 */
export const createWebSearch = (
  config: HttpClientConfig & { readonly provider?: SearchProvider; readonly client?: HttpClient; readonly limit?: number } = {},
) => {
  const provider = config.provider;
  const client = config.client ?? createHttpClient(config);
  const defaultLimit = config.limit ?? DEFAULT_SEARCH_LIMIT;

  return async (query: string, limit = defaultLimit): Promise<SearchOutcome> => {
    if (provider === undefined) {
      return {
        searched: false,
        query,
        reason: "not-configured",
        detail:
          "No web-search provider is configured, so I cannot search. Configure one, or give me a URL to read " +
          "directly.",
      };
    }
    const outcome = await client.request({
      url: provider.endpoint(query, limit),
      headers: provider.headers,
      accept: "application/json",
      fence: false,
    });
    if (!outcome.ok) {
      return {
        searched: false,
        query,
        reason: outcome.kind === "timeout" ? "timed-out" : "unavailable",
        detail: `${provider.name}: ${outcome.reason}`,
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(outcome.body);
    } catch {
      return { searched: false, query, reason: "unavailable", detail: `${provider.name} returned a response that is not JSON.` };
    }
    let hits: readonly SearchHit[];
    try {
      hits = provider.parse(payload);
    } catch (error) {
      // A provider that changed its response shape is an operational failure, not an empty search.
      return {
        searched: false,
        query,
        reason: "unavailable",
        detail: `${provider.name} returned a shape this configuration cannot read: ${(error as Error).message}`,
      };
    }
    return {
      searched: true,
      query,
      hits: hits.slice(0, limit).map((hit) => ({
        title: hit.title,
        url: hit.url,
        // Snippets are bounded here rather than trusting the provider: a "snippet" is whatever the remote decides
        // it is, and five of them at 40KB each is a context window.
        snippet: hit.snippet.length > MAX_SNIPPET_CHARS ? `${hit.snippet.slice(0, MAX_SNIPPET_CHARS)}…` : hit.snippet,
      })),
    };
  };
};

export type { HttpOutcome };
