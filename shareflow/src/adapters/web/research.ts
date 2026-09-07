/**
 * `ResearchService` over the platform's own guarded web toolkit — REQ-041 (#190).
 *
 * `adapters/web/`, not `adapters/postgres/`: nothing here reads a ShareFlow table. Like `generator`, it
 * fronts a capability the platform already has, and the reason that matters is the three obligations the port
 * puts on the implementation — redirect re-validation, a body cap enforced by tearing the connection down,
 * and a timeout spanning the whole fetch. Those live in `toolkit/web.ts`'s HTTP client, which is where the
 * egress policy is. Writing a second fetcher here would be a second egress policy, and the one that mattered
 * would be whichever the caller happened to use.
 *
 * ## The redirect obligation is met by refusing redirects, which is stronger
 *
 * The port asks that *"every redirect hop is re-validated against the egress policy"*, because
 * *"a perfectly public URL can 302 to `http://169.254.169.254/…`"*. The platform's fetcher does not follow
 * redirects **at all** — `fetch_url`'s description says so and tells the caller to ask for the target
 * directly. That satisfies the requirement by removing the hops rather than checking them.
 *
 * It has one consequence worth stating, because it contradicts a docstring: `SourcePassage.url` is documented
 * as *"the URL that was actually read, after redirects. Not the requested one."* With no redirects followed,
 * the two are the same, and this adapter reports what the fetcher returned rather than the string it was
 * handed — so the field stays truthful either way and would keep working if the policy ever changed.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

import type {
  ReadSourceResult,
  ResearchService,
  SearchOutcome,
  SourcePassage,
} from "../../services/index.js";

/**
 * What the platform's search returns. Structurally the port's own outcome with different field names.
 *
 * Declared here rather than imported so this file does not depend on `@retinue/agentkit/tools`' shape for a
 * value it only maps. Both unions carry `searched` and the same three refusal reasons, which is not
 * coincidence — the port was written from this.
 */
export type ToolkitSearchOutcome =
  | { readonly searched: true; readonly query: string; readonly hits: readonly ToolkitHit[] }
  | {
      readonly searched: false;
      readonly query: string;
      readonly reason: "not-configured" | "unavailable" | "timed-out";
      readonly detail: string;
    };

export type ToolkitHit = { readonly title: string; readonly url: string; readonly snippet: string };

export type ToolkitPageResult =
  | {
      readonly ok: true;
      readonly url: string;
      readonly status: number;
      readonly truncated: boolean;
      readonly content: string;
    }
  | { readonly ok: false; readonly url: string; readonly reason: string };

/** Passage size, and how many. A tool result enters the context window. */
export const MAX_PASSAGE_CHARS = 1_200;
export const MAX_PASSAGES = 10;
/** Search results this adapter will ask for, whatever the caller requests. */
export const MAX_SEARCH_RESULTS = 10;

export type ResearchDeps = {
  /**
   * The platform's `createWebSearch`. Required: there is no fail-soft alternative.
   *
   * The port's whole point is that a search must report *whether it ran* — the old runtime's
   * `websearch.py` is *"deliberately fail-soft: network errors, timeouts, or a missing package yield an empty
   * result list instead of raising"*, and an empty list is indistinguishable from "nothing out there", which
   * invites a model to answer from what it already believes.
   */
  readonly search: (query: string, limit?: number) => Promise<ToolkitSearchOutcome>;
  /** The platform's `createFetchPage` — where the egress policy, the redirect refusal and the cap live. */
  readonly fetchPage: (url: string) => Promise<ToolkitPageResult>;
  readonly now?: () => number;
};

/**
 * A stable id for a URL, so a search hit can be read without the model echoing the URL back.
 *
 * Derived from the URL rather than a counter, which is what makes it survive across calls: `readSource` takes
 * a `resultId` from *a prior search*, and a per-call counter would make yesterday's id point at something
 * else today. Not a hash — the URL is recoverable, which is the point, and a hash would need a store.
 */
export const encodeResultId = (url: string): string => `src_${Buffer.from(url, "utf8").toString("base64url")}`;

export const decodeResultId = (resultId: string): string | undefined => {
  if (!resultId.startsWith("src_")) return undefined;
  try {
    const url = Buffer.from(resultId.slice(4), "base64url").toString("utf8");
    return url === "" ? undefined : url;
  } catch {
    return undefined;
  }
};

/**
 * Split readable text into passages on blank lines, then on length.
 *
 * Per *passage* rather than per document because the port requires it: *"docs/07 wants a citation to resolve
 * to the specific text that was used, and a document-level citation is an invitation to go and find it."*
 * Paragraph boundaries first, because a passage cut mid-sentence cites something nobody wrote.
 */
export const toPassages = (content: string, maxPassages: number): { passages: string[]; truncated: boolean } => {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);

  const passages: string[] = [];
  for (const paragraph of paragraphs) {
    if (passages.length >= maxPassages) break;
    if (paragraph.length <= MAX_PASSAGE_CHARS) {
      passages.push(paragraph);
      continue;
    }
    // A long paragraph is cut on a word boundary, so an excerpt is still quotable text.
    for (let at = 0; at < paragraph.length && passages.length < maxPassages; at += MAX_PASSAGE_CHARS) {
      const slice = paragraph.slice(at, at + MAX_PASSAGE_CHARS);
      const lastSpace = slice.lastIndexOf(" ");
      passages.push(lastSpace > MAX_PASSAGE_CHARS - 200 ? slice.slice(0, lastSpace) : slice);
    }
  }
  // `truncated` counts paragraphs, so "there is more" is true even when the cap fell mid-paragraph.
  return { passages, truncated: passages.length < paragraphs.length || paragraphs.length > maxPassages };
};

export const createWebResearchService = (deps: ResearchDeps): ResearchService => {
  const now = deps.now ?? Date.now;

  return {
    async search(context: ExecutionContext, input): Promise<SearchOutcome> {
      if (input.query.trim() === "") {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "There is no query to search for.",
          retryable: false,
        });
      }
      const limit = Math.min(Math.max(Math.trunc(input.maxResults), 1), MAX_SEARCH_RESULTS);
      const outcome = await deps.search(input.query, limit);

      /**
       * The refusal is passed through with its reason, never flattened to an empty list.
       *
       * `not-configured`, `unavailable` and `timed-out` are three different things to tell a user, and all
       * three are different from "nothing out there". The port and the toolkit already agree on the vocabulary
       * — this maps names, not meanings.
       */
      if (!outcome.searched) return { searched: false, reason: outcome.reason };

      return {
        searched: true,
        results: outcome.hits.slice(0, limit).map((hit) => ({
          resultId: encodeResultId(hit.url),
          title: hit.title,
          snippet: hit.snippet,
          url: hit.url,
        })),
      };
    },

    async readSource(context: ExecutionContext, input): Promise<ReadSourceResult> {
      /**
       * A URL **or** a result id, never both — the port says so, and the reason is that they can disagree.
       *
       * Accepting both and preferring one would mean a caller that passed a stale `resultId` alongside a fresh
       * URL got whichever this code happened to favour, with nothing saying which was read.
       */
      if ((input.url === undefined) === (input.resultId === undefined)) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "Pass either `url` or a `resultId` from a previous search, and not both.",
          retryable: false,
        });
      }

      const target = input.url ?? decodeResultId(String(input.resultId));
      if (target === undefined) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `${String(input.resultId)} is not a resultId this service issued. Search again and use one of its ids.`,
          retryable: false,
        });
      }

      const page = await deps.fetchPage(target);
      if (!page.ok) {
        /**
         * The fetcher's refusal, classified rather than passed through as prose.
         *
         * The port requires `forbidden` for a disallowed host and `timeout` for either limit, *"both distinct
         * from an empty result"*. The reason string is the toolkit's; the code is what a caller branches on,
         * and an assistant needs to tell "that host is not allowed" from "that page is slow".
         */
        const reason = page.reason.toLowerCase();
        const code = /timed? *out|timeout|deadline/.test(reason)
          ? "timeout"
          : /private|loopback|link-local|blocked|not allowed|refused|redirect|scheme|http:/.test(reason)
            ? "forbidden"
            : "provider_error";
        throw new AgentPlatformError({
          code,
          message: `${target} could not be read: ${page.reason}`,
          retryable: code === "timeout",
        });
      }

      const maxPassages = Math.min(Math.max(Math.trunc(input.maxPassages), 1), MAX_PASSAGES);
      const { passages, truncated } = toPassages(page.content, maxPassages);
      const retrievedAt = new Date(now()).toISOString();

      return {
        /**
         * The id of what was **read**, not of what was asked for.
         *
         * So `sourceId` round-trips to the URL the fetcher reports. It is the same string today, because the
         * platform refuses redirects; deriving it from `page.url` means this stays correct if that ever
         * changes rather than quietly citing the wrong page.
         */
        sourceId: encodeResultId(page.url),
        passages: passages.map(
          (excerpt): SourcePassage => ({ url: page.url, retrievedAt, excerpt }),
        ),
        /** The fetcher's own cap counts too: a body cut at the byte ceiling has more, whatever the passages say. */
        truncated: truncated || page.truncated,
      };
    },
  };
};
