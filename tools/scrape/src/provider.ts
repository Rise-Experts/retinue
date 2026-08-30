/**
 * One contract, several providers — REQ-055 (#237), task #238, AC-1.
 *
 * The rule `tools-search` established: a vendor is a **value of a parameter**, not a tool. Five extractors are
 * not five tools, because choosing between them is a deployment's decision about cost and quality, and a model
 * offered `firecrawl_scrape` and `jina_scrape` would be making a purchasing decision it has no information to
 * make.
 *
 * So the shape below is what every provider returns, and swapping providers changes what a scrape *costs* and
 * how good it is, never what a caller has to handle. A test asserts the direct and hosted providers produce
 * the same keys, because a contract nothing checks is a comment.
 *
 * ## Why the direct provider is the default
 *
 * It needs no account, no key and no third party, and the SSRF work in `ssrf.ts` is what makes it safe to
 * point at a model-chosen URL. A hosted extractor is better on pages that need JavaScript and worse on
 * everything else — it costs money, adds a hop, and sends the URL the agent is reading to a third party, which
 * is a disclosure some deployments cannot make.
 */

import { htmlToMarkdown, linksIn } from "./html.js";
import { DEFAULT_USER_AGENT, safeFetch, type Resolve, type SafeTransport } from "@retinue/agentkit/tools";

/** What every provider returns, whatever it did to get there. */
export type PageContent = {
  readonly url: string;
  readonly status: number;
  readonly title: string;
  readonly markdown: string;
  readonly canonicalUrl?: string;
  readonly description?: string;
  /** Absolute links found on the page — the crawl frontier. Empty when a provider cannot supply them. */
  readonly links: readonly string[];
  /** True when a byte bound stopped the read. */
  readonly truncated: boolean;
  readonly contentType: string;
};

export type FetchRequest = {
  readonly url: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly userAgent: string;
};

export type ScrapeProvider = {
  readonly name: string;
  readonly fetch: (request: FetchRequest) => Promise<PageContent>;
};

/** The keys every provider must produce, asserted in the tests so a provider cannot quietly return less. */
export const CONTRACT_KEYS = ["url", "status", "title", "markdown", "links", "truncated", "contentType"] as const;

const CONTENT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/xml|text\/xml)/i;

export type DirectProviderOptions = {
  readonly resolve?: Resolve;
  readonly transport?: SafeTransport;
  readonly maxRedirects?: number;
};

/**
 * Fetch it here, convert it here. No third party, no key.
 *
 * Everything a model can influence — the URL — goes through `safeFetch`, which is where all three SSRF vectors
 * are closed.
 */
export const directProvider = (options: DirectProviderOptions = {}): ScrapeProvider => ({
  name: "direct",
  async fetch(request) {
    const response = await safeFetch(request.url, {
      maxBytes: request.maxBytes,
      timeoutMs: request.timeoutMs,
      headers: { "user-agent": request.userAgent },
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    });

    const contentType = response.headers["content-type"] ?? "";
    /**
     * A PDF, an image or a zip is not converted and not returned as text.
     *
     * Handing a model the bytes of a binary as though they were a document produces confident nonsense, and
     * the `truncated` flag would make it look like a large document rather than the wrong kind of thing.
     */
    if (contentType !== "" && !CONTENT_TYPES.test(contentType)) {
      return {
        url: response.url,
        status: response.status,
        title: "",
        markdown: "",
        links: [],
        truncated: response.truncated,
        contentType,
      };
    }

    const isHtml = contentType === "" || /html|xml/i.test(contentType);
    const extraction = isHtml
      ? htmlToMarkdown(response.body, response.url)
      : { title: "", markdown: response.body.trim() };
    return {
      url: response.url,
      status: response.status,
      title: extraction.title,
      markdown: extraction.markdown,
      ...(extraction.canonicalUrl === undefined ? {} : { canonicalUrl: extraction.canonicalUrl }),
      ...(extraction.description === undefined ? {} : { description: extraction.description }),
      links: isHtml ? linksIn(response.body, response.url) : [],
      truncated: response.truncated,
      contentType: contentType === "" ? "text/html" : contentType,
    };
  },
});

export type HostedProviderConfig = {
  readonly name: string;
  /** The extractor's own API endpoint. Fixed — never a URL a model chose. */
  readonly endpoint: (target: string) => string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "POST";
  readonly body?: (target: string, maxBytes: number) => unknown;
  /** Reads the extractor's response into the shared shape. */
  readonly parse: (payload: unknown, target: string) => {
    readonly markdown: string;
    readonly title?: string;
    readonly canonicalUrl?: string;
    readonly description?: string;
    readonly links?: readonly string[];
  };
  readonly fetchImpl?: typeof fetch;
};

/**
 * A hosted extractor behind the same contract.
 *
 * **No SSRF check here, deliberately.** The URL this connects to is the extractor's fixed API endpoint, which
 * the operator configured; the model-chosen URL travels *inside* the request as data. That inverts the trust
 * relationship — the risk moves to the extractor, which is one of the things an operator is buying — and
 * running the address checks against `api.firecrawl.dev` would be checking the wrong thing while looking
 * reassuring.
 */
export const hostedProvider = (config: HostedProviderConfig): ScrapeProvider => ({
  name: config.name,
  async fetch(request) {
    const send = config.fetchImpl ?? fetch;
    const endpoint = config.endpoint(request.url);
    const method = config.method ?? "GET";
    const response = await send(endpoint, {
      method,
      headers: { accept: "application/json", "user-agent": request.userAgent, ...config.headers },
      ...(method === "POST" && config.body !== undefined
        ? { body: JSON.stringify(config.body(request.url, request.maxBytes)), }
        : {}),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`${config.name} returned ${response.status}: ${text.slice(0, 300)}`), {
        status: response.status,
      });
    }
    const payload = (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Jina's reader answers with markdown directly rather than JSON, which is not an error.
        return text;
      }
    })();
    const parsed = config.parse(payload, request.url);
    const markdown = parsed.markdown.slice(0, request.maxBytes);
    return {
      url: parsed.canonicalUrl ?? request.url,
      status: response.status,
      title: parsed.title ?? "",
      markdown,
      ...(parsed.canonicalUrl === undefined ? {} : { canonicalUrl: parsed.canonicalUrl }),
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      links: parsed.links ?? [],
      truncated: parsed.markdown.length > request.maxBytes,
      contentType: "text/markdown",
    };
  },
});

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Firecrawl — POST, returns markdown plus metadata. */
export const firecrawl = (config: { readonly apiKey: string; readonly fetchImpl?: typeof fetch }): ScrapeProvider =>
  hostedProvider({
    name: "firecrawl",
    endpoint: () => "https://api.firecrawl.dev/v1/scrape",
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: (target) => ({ url: target, formats: ["markdown"], onlyMainContent: true }),
    parse: (payload) => {
      const data = record(record(payload).data);
      const metadata = record(data.metadata);
      const title = str(metadata.title);
      const canonical = str(metadata.sourceURL);
      const description = str(metadata.description);
      return {
        markdown: str(data.markdown),
        ...(title === "" ? {} : { title }),
        ...(canonical === "" ? {} : { canonicalUrl: canonical }),
        ...(description === "" ? {} : { description }),
      };
    },
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

/** Jina Reader — GET a prefixed URL, answers markdown as plain text. */
export const jinaReader = (config: { readonly apiKey?: string; readonly fetchImpl?: typeof fetch } = {}): ScrapeProvider =>
  hostedProvider({
    name: "jina",
    endpoint: (target) => `https://r.jina.ai/${target}`,
    headers: {
      accept: "text/plain",
      ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
    },
    parse: (payload) => {
      const text = typeof payload === "string" ? payload : str(record(record(payload).data).content);
      // Jina puts `Title: …` in a small header block before the content.
      const title = /^Title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
      const body = text.replace(/^(Title|URL Source|Published Time|Markdown Content):.*$/gm, "").trim();
      return { markdown: body, ...(title === "" ? {} : { title }) };
    },
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
