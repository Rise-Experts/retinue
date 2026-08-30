/**
 * Read the pages an agent finds — REQ-055 (#237), task #238.
 *
 * `tools-search` shipped `web_search`, which left an agent able to find a page and unable to read it: ten URLs
 * and a snippet each, and no way forward. This is the other half.
 *
 * Three tools, all `read`, behind one provider-swappable contract. The substance of the package is not the
 * scraping — that part is a fetch and a converter — it is the two things that make pointing a fetch at a
 * model-chosen URL acceptable at all:
 *
 * - **SSRF, closed at the point of connection.** See `ssrf.ts`. Three vectors, three defences, three tests.
 * - **Content marked as untrusted.** A scraped page is prose somebody else wrote, arriving in a model's
 *   context. It goes through the platform's own `encloseUntrusted`, so the boundary between what the page says
 *   and what the operator says is explicit rather than inferred.
 *
 * Plus the things that make a crawl something one can responsibly point at a stranger's server: four
 * independent bounds, `robots.txt` on by default, and per-host concurrency and spacing.
 */

import type { Tool, ToolProvider } from "@retinue/agentkit/tools";

import { createGate, type Gate, type PolitenessOptions } from "./politeness.js";
import { directProvider, type ScrapeProvider } from "./provider.js";
import { safeFetch } from "./ssrf.js";
import { scrapeTools, type ScrapeToolsConfig } from "./tools.js";

export {
  BlockedError,
  DEFAULT_USER_AGENT,
  isPrivateAddress,
  isPrivateV4,
  isPrivateV6,
  nodeTransport,
  refuseUrl,
  resolvePublicly,
  safeFetch,
  systemResolve,
} from "./ssrf.js";
export type { Resolve, SafeFetchOptions, SafeResponse, SafeTransport } from "./ssrf.js";
export { decodeEntities, findElement, htmlToMarkdown, linksIn, parseHtml, textOf } from "./html.js";
export type { Extraction, Node } from "./html.js";
export { crawlDelayOf, EMPTY_ROBOTS, groupFor, isAllowed, matchesRule, parseRobots } from "./robots.js";
export type { Robots, RobotsGroup } from "./robots.js";
export { createGate } from "./politeness.js";
export type { Gate, PolitenessOptions } from "./politeness.js";
export { CONTRACT_KEYS, directProvider, firecrawl, hostedProvider, jinaReader } from "./provider.js";
export type { FetchRequest, HostedProviderConfig, PageContent, ScrapeProvider } from "./provider.js";
export { crawl, CRAWL_CEILINGS, CRAWL_DEFAULTS } from "./crawl.js";
export type { CrawlBounds, CrawlOptions, CrawlPage, CrawlResult, StopReason } from "./crawl.js";
export { describeFetchFailure, scrapeTools, MAX_BATCH, MAX_BYTES_CEILING } from "./tools.js";
export type { ScrapeToolsConfig } from "./tools.js";

export type ScrapeToolkitConfig = {
  /** Defaults to the direct provider, which needs no account and no third party. */
  readonly provider?: ScrapeProvider;
  readonly politeness?: PolitenessOptions;
  readonly gate?: Gate;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  /**
   * Whether a caller may pass `ignoreRobotsTxt`. Default `true` — the argument exists and is gated by the
   * operator, not removed. A deployment that cannot accept the legal exposure sets this `false` and the
   * override is refused rather than quietly ignored.
   */
  readonly allowRobotsOptOut?: boolean;
  /** Ship only these. Mutually exclusive with `exclude`; an unknown name is refused. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};

export const select = (
  all: readonly Tool[],
  config: Pick<ScrapeToolkitConfig, "include" | "exclude">,
): readonly Tool[] => {
  if (config.include !== undefined && config.exclude !== undefined) {
    throw new Error(
      "createScrapeToolkit was given both include and exclude. Pick one: include names what ships, exclude names what does not.",
    );
  }
  const known = new Set(all.map((tool) => tool.descriptor.name));
  const requested = config.include ?? config.exclude ?? [];
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `createScrapeToolkit was given ${config.include === undefined ? "exclude" : "include"} names this toolkit ` +
        `does not have: ${unknown.join(", ")}. It has: ${[...known].join(", ")}.`,
    );
  }
  if (config.include !== undefined) {
    const wanted = new Set(config.include);
    return all.filter((tool) => wanted.has(tool.descriptor.name));
  }
  if (config.exclude !== undefined) {
    const unwanted = new Set(config.exclude);
    return all.filter((tool) => !unwanted.has(tool.descriptor.name));
  }
  return all;
};

/**
 * Fetches a host's `robots.txt` through the same hardened path as everything else.
 *
 * Worth stating: `robots.txt` is fetched from a host the *frontier* chose, so it is exactly as untrusted a
 * destination as any page. Fetching it with a plain `fetch` because "it is only robots.txt" would be an SSRF
 * hole in the code that exists to be polite.
 */
const robotsFetcher = (timeoutMs: number, userAgent: string) => async (origin: string): Promise<string | null> => {
  try {
    const response = await safeFetch(`${origin}/robots.txt`, {
      maxBytes: 512_000,
      timeoutMs,
      headers: { "user-agent": userAgent, accept: "text/plain" },
    });
    // A 404 means no rules, which the standard reads as "allowed" — not as an error.
    return response.status >= 200 && response.status < 300 ? response.body : null;
  } catch {
    return null;
  }
};

export const createScrapeToolkit = (config: ScrapeToolkitConfig = {}): ToolProvider => {
  const provider = config.provider ?? directProvider();
  const gate = config.gate ?? createGate(config.politeness);
  const userAgent = config.userAgent ?? "RetinueBot/1.0 (+https://retinue.dev/integrations/scrape)";
  const timeoutMs = config.timeoutMs ?? 15_000;
  const toolConfig: ScrapeToolsConfig = {
    provider,
    gate,
    userAgent,
    timeoutMs,
    fetchRobots: robotsFetcher(timeoutMs, userAgent),
    ...(config.allowRobotsOptOut === undefined ? {} : { allowRobotsOptOut: config.allowRobotsOptOut }),
  };
  const tools = select(scrapeTools(toolConfig), config);
  return {
    id: "scrape",
    async listTools() {
      return tools;
    },
  };
};

/**
 * This package needs no credential — #260 AC-2.
 *
 * The direct provider fetches public pages, which is the whole point. A hosted extractor's key is a
 * **platform** credential like a search key — one key for the deployment, billed to the operator — so it is a
 * constructor argument rather than a `credentialRef`, exactly as `tools-search` argues.
 */
export const SCRAPE_AUTH = { modes: [] as const, schemes: [] as const };

export const SCRAPE_TOOL_NAMES = ["web_scrape", "web_scrape_batch", "web_crawl"] as const;
