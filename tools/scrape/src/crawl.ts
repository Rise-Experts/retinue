/**
 * The crawl, and its four bounds — REQ-055 (#237), task #238, AC-4.
 *
 * A crawl is the tool in this package that can go wrong quietly. A scrape is one request; a crawl is however
 * many the frontier grows to, against somebody else's server, and the failure mode is not an error — it is a
 * job that keeps running, keeps costing, and keeps loading a site that never agreed to any of it.
 *
 * So there are four bounds and they are independent, because each catches something the others do not:
 *
 * | Bound | Catches |
 * |---|---|
 * | `maxPages` | A site with more pages than anybody meant to read |
 * | `maxDepth` | A frontier that widens forever — pagination, calendars, faceted search |
 * | `maxBytes` | A small number of enormous pages |
 * | `maxDurationMs` | A slow server, where none of the other three would ever be reached |
 *
 * `maxDurationMs` is the one most often left out and the one that matters most in practice: a host answering
 * in thirty seconds hits no page, depth or byte limit for a very long time.
 *
 * **AC-4 asks for the effect to be asserted, not the option.** A bound that exists in a type and is never read
 * is the "built, tested and unreachable" shape, and it looks exactly like a working bound from the outside. So
 * every bound here has a test that exceeds it and checks what actually came back — and `truncated` says which
 * one stopped it, because "there was more" and "there was more because you asked for ten pages" are different
 * things to tell a caller.
 */

import { isAllowed, crawlDelayOf, EMPTY_ROBOTS, parseRobots, type Robots } from "./robots.js";
import type { Gate } from "./politeness.js";
import type { PageContent, ScrapeProvider } from "./provider.js";

export type CrawlBounds = {
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
  /** Bytes for any single page. Separate from the crawl total. */
  readonly maxBytesPerPage?: number;
};

export const CRAWL_DEFAULTS = {
  maxPages: 20,
  maxDepth: 2,
  maxBytes: 5_000_000,
  maxDurationMs: 60_000,
  maxBytesPerPage: 1_000_000,
} as const;

export const CRAWL_CEILINGS = {
  maxPages: 200,
  maxDepth: 5,
  maxBytes: 50_000_000,
  maxDurationMs: 300_000,
  maxBytesPerPage: 5_000_000,
} as const;

export type CrawlPage = {
  readonly url: string;
  readonly depth: number;
  readonly title: string;
  readonly markdown: string;
  readonly status: number;
  readonly bytes: number;
};

export type CrawlFailure = { readonly url: string; readonly depth: number; readonly error: string };

/** Which bound ended the crawl, or `null` when the frontier simply ran out. */
export type StopReason = "pages" | "depth" | "bytes" | "time" | "robots" | null;

export type CrawlResult = {
  readonly pages: readonly CrawlPage[];
  readonly failures: readonly CrawlFailure[];
  readonly truncated: boolean;
  readonly stoppedBy: StopReason;
  readonly pagesVisited: number;
  readonly bytesFetched: number;
  readonly durationMs: number;
  /** URLs the frontier held when a bound stopped it — so a caller can resume rather than start again. */
  readonly remaining: readonly string[];
};

export type CrawlOptions = CrawlBounds & {
  readonly seed: string;
  readonly provider: ScrapeProvider;
  readonly gate: Gate;
  readonly userAgent: string;
  readonly timeoutMs: number;
  /** Off means the operator has accepted responsibility — see the tool description and the docs. */
  readonly respectRobots: boolean;
  /** Fetches a host's robots.txt. Absent means none is consulted. */
  readonly fetchRobots?: (origin: string) => Promise<string | null>;
  /** Same host as the seed only. The default, because "follow every link" leaves the site immediately. */
  readonly sameHostOnly?: boolean;
  readonly now?: () => number;
};

const clamp = (value: number | undefined, fallback: number, ceiling: number): number =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), ceiling);

export const crawl = async (options: CrawlOptions): Promise<CrawlResult> => {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const maxPages = clamp(options.maxPages, CRAWL_DEFAULTS.maxPages, CRAWL_CEILINGS.maxPages);
  const maxDepth = Math.min(Math.max(Math.trunc(options.maxDepth ?? CRAWL_DEFAULTS.maxDepth), 0), CRAWL_CEILINGS.maxDepth);
  const maxBytes = clamp(options.maxBytes, CRAWL_DEFAULTS.maxBytes, CRAWL_CEILINGS.maxBytes);
  const maxDurationMs = clamp(options.maxDurationMs, CRAWL_DEFAULTS.maxDurationMs, CRAWL_CEILINGS.maxDurationMs);
  const maxBytesPerPage = clamp(options.maxBytesPerPage, CRAWL_DEFAULTS.maxBytesPerPage, CRAWL_CEILINGS.maxBytesPerPage);

  let seedUrl: URL;
  try {
    seedUrl = new URL(options.seed);
  } catch {
    throw new Error(`"${options.seed}" is not a URL.`);
  }
  const sameHostOnly = options.sameHostOnly ?? true;

  const robotsByOrigin = new Map<string, Robots>();
  const robotsFor = async (origin: string): Promise<Robots> => {
    const cached = robotsByOrigin.get(origin);
    if (cached !== undefined) return cached;
    let robots = EMPTY_ROBOTS;
    if (options.respectRobots && options.fetchRobots !== undefined) {
      try {
        const text = await options.fetchRobots(origin);
        // A missing or unreachable robots.txt means allowed — the standard's rule. Treating a failed fetch as
        // a prohibition would make every site with a flaky origin uncrawlable.
        robots = text === null ? EMPTY_ROBOTS : parseRobots(text);
      } catch {
        robots = EMPTY_ROBOTS;
      }
    }
    robotsByOrigin.set(origin, robots);
    const delay = crawlDelayOf(robots, options.userAgent);
    // A site that asks for a gap gets it. `requireInterval` only ever raises.
    if (delay !== undefined) options.gate.requireInterval(new URL(origin).host, delay * 1000);
    return robots;
  };

  const seen = new Set<string>([seedUrl.toString()]);
  const frontier: { url: string; depth: number }[] = [{ url: seedUrl.toString(), depth: 0 }];
  const pages: CrawlPage[] = [];
  const failures: CrawlFailure[] = [];
  let bytesFetched = 0;
  let stoppedBy: StopReason = null;

  const outOfTime = () => now() - started >= maxDurationMs;

  while (frontier.length > 0) {
    if (pages.length >= maxPages) {
      stoppedBy = "pages";
      break;
    }
    if (bytesFetched >= maxBytes) {
      stoppedBy = "bytes";
      break;
    }
    /**
     * Checked before taking the next URL, not only after fetching one.
     *
     * A crawl that checks the clock only after a request always makes one more request than its budget allows,
     * and against a slow host that request can be most of the overrun.
     */
    if (outOfTime()) {
      stoppedBy = "time";
      break;
    }

    const next = frontier.shift();
    if (next === undefined) break;
    let url: URL;
    try {
      url = new URL(next.url);
    } catch {
      failures.push({ url: next.url, depth: next.depth, error: "not a URL" });
      continue;
    }

    const origin = url.origin;
    const robots = await robotsFor(origin);
    if (options.respectRobots && !isAllowed(robots, options.userAgent, url.toString())) {
      failures.push({ url: url.toString(), depth: next.depth, error: "disallowed by robots.txt" });
      continue;
    }

    let content: PageContent;
    try {
      content = await options.gate.run(url.host, () =>
        options.provider.fetch({
          url: url.toString(),
          maxBytes: Math.min(maxBytesPerPage, Math.max(1, maxBytes - bytesFetched)),
          timeoutMs: options.timeoutMs,
          userAgent: options.userAgent,
        }),
      );
    } catch (error) {
      // One bad page does not end a crawl. It is reported and the frontier continues.
      failures.push({ url: url.toString(), depth: next.depth, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const bytes = Buffer.byteLength(content.markdown, "utf8");
    bytesFetched += bytes;
    pages.push({
      url: content.url,
      depth: next.depth,
      title: content.title,
      markdown: content.markdown,
      status: content.status,
      bytes,
    });

    if (next.depth >= maxDepth) {
      // The page was read; its links are simply not followed. Recorded so `stoppedBy` can say `depth` when
      // that is genuinely what ended the crawl rather than an empty frontier.
      if (content.links.length > 0 && stoppedBy === null) stoppedBy = "depth";
      continue;
    }

    for (const link of content.links) {
      if (seen.has(link)) continue;
      let target: URL;
      try {
        target = new URL(link);
      } catch {
        continue;
      }
      if (sameHostOnly && target.host !== seedUrl.host) continue;
      seen.add(link);
      frontier.push({ url: link, depth: next.depth + 1 });
    }
  }

  /**
   * `depth` is only the reason if nothing else stopped it.
   *
   * A crawl that hit the page limit *and* had unfollowed links at maximum depth was stopped by the page limit;
   * reporting `depth` would send a caller to raise the wrong bound.
   */
  const truncated = stoppedBy !== null || frontier.length > 0;

  return {
    pages,
    failures,
    truncated,
    stoppedBy: truncated ? stoppedBy : null,
    pagesVisited: pages.length,
    bytesFetched,
    durationMs: now() - started,
    remaining: frontier.map((entry) => entry.url),
  };
};
