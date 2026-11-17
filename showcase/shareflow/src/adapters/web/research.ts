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

import { structureFrom } from "./pdf-structure.js";
import {
  looksLikeMp4,
  mapPexelsPhoto,
  mapPexelsVideo,
  PEXELS_MAX_PHOTO_BYTES,
  PEXELS_MAX_VIDEO_BYTES,
  pickPexelsPhotoFile,
  pickPexelsVideoFile,
  stockMediaNotEnabled,
  type PexelsClient,
} from "./pexels.js";

import type {
  ReadSourceResult,
  ResearchService,
  SearchOutcome,
  SourcePassage,
  WebContentGuard,
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

/**
 * The PDF caps, all four transcribed from `readpdf.py` — and its reasons with them.
 *
 * *"A byte cap so a huge file cannot exhaust the container's memory (the whole PDF must be resident to
 * parse it), a page cap so a 500-page report does not stall a chat turn, and a character cap so one tool
 * result cannot swallow the model's context window."*
 *
 * The byte cap is 25 MB *"well under the media bucket's 50 MB limit"*. It is far larger than the
 * platform's own `MAX_RESPONSE_BYTES` (200 KB), which is why this adapter reads the body itself instead
 * of going through `createFetchPage`: 200 KB is right for a page a model reads as prose and excludes
 * almost every real PDF.
 */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 30;
/**
 * The image cap, and what a vision provider will accept.
 *
 * 20 MB is a *provider* ceiling rather than a memory one — Google, OpenAI and Anthropic all reject
 * larger inline images — so a bigger local cap would only move the failure into the model call, where it
 * reads as the model being broken rather than as a file that is too big.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** What a vision model can actually decode. A TIFF is a decode error inside the provider. */
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_PDF_TEXT_CHARS = 12_000;
export const PDF_FETCH_TIMEOUT_MS = 20_000;

/**
 * A media asset id, checked before it is handed to whatever signs storage objects.
 *
 * `idString` in the tool layer is deliberately permissive — *"the format check belongs in the adapter,
 * which does know"* — and this is the adapter. The check matters more here than in most places: the
 * value goes to a deployment-supplied resolver that signs a storage object, and
 * `"other-workspace/secret.pdf"` is a perfectly good string. A uuid check removes the entire class of
 * path-shaped arguments rather than trusting every resolver to notice.
 *
 * The seventh copy of this regex in the package, and the duplication is deliberate: sharing it would
 * make the web adapters depend on the postgres ones for a two-line format rule.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResearchDeps = {
  /** #667: the optional web-content guard, handed to the tools on the service. */
  readonly guard?: WebContentGuard;
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
  /**
   * The bytes of one of the workspace's own media assets. **Absent means `readPdf` refuses that source.**
   *
   * The same shape as `MediaDeps.convert` and `checkStorage`, and for the same reason: signing a storage
   * object needs credentials, and *"credentials, signing and an outbound fetch are all outside this
   * package"*. A deployment that cannot supply this can still read a PDF the user linked to.
   *
   * On `ResearchDeps` rather than `MediaDeps` because the *reader* is research and nothing in
   * `MediaService` reads bytes — the media tools return references precisely so content never lands in
   * a tool result.
   */
  readonly readAssetBytes?: (input: {
    readonly context: ExecutionContext;
    readonly assetId: string;
  }) => Promise<{ readonly bytes: Uint8Array; readonly mime?: string }>;
  /**
   * The browser read — #621. **Absent means a refused fetch stays refused.**
   *
   * `RenderService.readPageText`, under `capture_website`'s guards: the egress check before launch, the
   * redirect pre-flight, the per-request guard and the landed-URL check. Used only when the plain fetch was
   * refused by the *server* (401/403/429) or came back as a bot wall — never for a URL the egress policy
   * refused, which the browser would refuse too, and never as a first attempt, because it costs a Chromium.
   */
  readonly browserRead?: (input: {
    readonly context: ExecutionContext;
    readonly url: string;
  }) => Promise<{ readonly url: string; readonly title: string; readonly text: string; readonly truncated: boolean }>;
  /**
   * The stock library (Pexels) — #615. **Absent means the stock tools refuse by name**, telling the person
   * which variable enables them. Built by the deployment only when `PEXELS_API_KEY` is set.
   */
  readonly stockMedia?: PexelsClient;
  /** Overridable for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
};

/**
 * Collapse extracted whitespace without touching the words.
 *
 * Transcribed from `_collapse`, including its reason: pypdf and pdfjs both emit ragged line breaks and
 * long blank runs from page furniture, and *"script-agnostic, so non-Latin text passes through intact"*
 * — which rules out anything that reasons about word characters.
 */
export const collapsePdfText = (text: string): string => {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line !== "") out.push(line);
    else if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  }
  return out.join("\n").trim();
};

/**
 * A stable id for a URL, so a search hit can be read without the model echoing the URL back.
 *
 * Derived from the URL rather than a counter, which is what makes it survive across calls: `readSource` takes
 * a `resultId` from *a prior search*, and a per-call counter would make yesterday's id point at something
 * else today. Not a hash — the URL is recoverable, which is the point, and a hash would need a store.
 */
export const encodeResultId = (url: string): string => `src_${Buffer.from(url, "utf8").toString("base64url")}`;

/**
 * A decoded id that is not a URL is a damaged id, not an address to fetch — #746.
 *
 * Production, 2026-10-11: the model copied a long id with `?srsltid=` pasted into the middle of the base64, it
 * decoded to `https://www.claycoffeeco.com/blogs/news/specialty-coffee-trends-202=���m�`, and that was fetched —
 * a 404 the model read as the page being gone. A clean http(s) URL with no replacement or control characters is
 * the only thing an id this service issued can decode to.
 */
export const decodeResultId = (resultId: string): string | undefined => {
  if (!resultId.startsWith("src_")) return undefined;
  try {
    const url = Buffer.from(resultId.slice(4), "base64url").toString("utf8");
    // eslint-disable-next-line no-control-regex
    if (url === "" || /[\uFFFD\u0000-\u001F\u007F\s]/u.test(url)) return undefined;
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** Query parameters that only track the click, never choose the page. */
const TRACKING_PARAM = /^(utm_\w+|srsltid|gclid|gbraid|wbraid|fbclid|msclkid|yclid|dclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|_ga|_gl|ref_src)$/i;

/**
 * A search hit's URL without its tracking parameters — #746.
 *
 * Google appends `?srsltid=…` (60-odd characters) to shop and blog results. In a result id that is a third of
 * the length the model has to copy exactly, and the 2026-10-11 loop began with the model mangling one. It never
 * selects content, so it is dropped before the id is made.
 */
export const withoutTracking = (url: string): string => {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    if (!keys.some((key) => TRACKING_PARAM.test(key))) return url;
    for (const key of keys) if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return url;
  }
};

/**
 * Is this paragraph part of the document, or part of the page around it?
 *
 * **The distinction the reader was missing.** `toPassages` used to take the first N paragraphs in
 * document order, and on a real web page the first N are the navigation. Measured against
 * `hackernoon.com/ai-coding-tip-034-…`: 14,937 characters of readable text in 162 paragraphs, and the
 * four passages `read_source` returned by default were
 *
 *     "source: https://… title: GET hackernoon.com (200)"
 *     "Discover Anything"
 *     "Signup Write"
 *     "New Story 914 reads AI Coding Tip 034 - … I'm a sr software engineer specialized in…"
 *
 * — 395 characters, not one sentence of the article, and `truncated: true`. The assistant reported
 * *"I couldn't read the full content of the article… therefore I cannot generate a post"*, which was an
 * accurate description of what it had been handed. A caption written from that would have been invented.
 *
 * The test is structural rather than a list of site-specific words, because a keyword list is a
 * maintenance burden that fails on the next site: prose is long, or it is a sentence. Menu items are
 * short and have no sentence end.
 */
const isProse = (paragraph: string): boolean =>
  paragraph.length >= PROSE_MIN_CHARS ||
  (paragraph.length >= SENTENCE_MIN_CHARS && /[.!?]["'”’)\]]?$/u.test(paragraph));

/** Below this a paragraph must look like a sentence to count as prose. */
const PROSE_MIN_CHARS = 120;

/** And below *this* nothing counts, sentence or not — "Sign up." is a sentence. */
/**
 * Strip the toolkit's untrusted-content envelope before the text is read as prose.
 *
 * `createFetchPage` wraps every body in `encloseUntrusted`, which prepends
 *
 *     <untrusted-content id="NONCE">
 *     source: <url>
 *     title: GET <host> (200)
 *
 * and appends the closing tag. That envelope is addressed to *this* layer, not to the model, and until now it
 * went straight into `toPassages` — which splits on blank lines and therefore saw `source: … title: …` as the
 * page's first paragraph. On a thin page it was the first passage returned, so the assistant quoted the
 * fetcher's own header back as though it were the article: reading `https://hrflare.com/` produced the passage
 * `source: https://hrflare.com/ title: GET hrflare.com (200)`.
 *
 * Both shapes have to be handled, because the envelope survives differently by content type. For `text/html`
 * the toolkit flattens with `htmlToText` *after* fencing, and the delimiters — which are angle-bracket tags,
 * whatever the comment at that call site says — are removed as markup, leaving the two header lines bare. For
 * anything else there is no flattening and the literal `<untrusted-content id="…">` line survives.
 *
 * This is presentation, not defence: the fence that matters is re-applied per passage by `fenceContent` in
 * `tools/research.ts`, which is what the model actually receives.
 */
export const FETCH_ENVELOPE = /^\s*(?:<untrusted-content\b[^>]*>[^\S\n]*\n)?source:[^\n]*\n[^\S\n]*title:[^\n]*\n/;

export const stripFetchEnvelope = (content: string): string =>
  content
    .replace(FETCH_ENVELOPE, "")
    .replace(/<\/?untrusted-content\b[^>]*>/g, "")
    .trim();

/**
 * How many hops a redirect chain may take before the read is refused.
 *
 * Five is the figure every HTTP client settles on, and the number is not the interesting part — what matters
 * is that there is a ceiling at all, because a chain can be a loop.
 */
export const MAX_REDIRECT_HOPS = 5;

/**
 * The URL a redirect refusal points at, resolved against the URL that was asked for.
 *
 * The toolkit reports a 3xx as `{ ok: false, reason: "That URL redirects to <location>. Redirects are not
 * followed automatically — …" }` and drops the structured `kind`/`location` its HTTP client had, so the
 * target has to come back out of the sentence. `Location` is frequently relative (`/2024/1/1`), which is why
 * this resolves rather than parses.
 */
export const redirectTargetOf = (reason: string, from: string): string | undefined => {
  const matched = /\bredirects to (.+?)\.\s+Redirects are not followed\b/.exec(reason);
  if (matched === null) return undefined;
  const location = matched[1]?.trim();
  if (location === undefined || location === "" || location === "somewhere unspecified") return undefined;
  try {
    return new URL(location, from).toString();
  } catch {
    return undefined;
  }
};

/**
 * Follow a redirect chain **through the guarded fetcher**, one hop at a time.
 *
 * The toolkit refuses to follow redirects itself, and its reasoning is sound: a `Location` is chosen by the
 * page, so following one automatically would let a permitted host hand the fetcher an unpermitted one. Its
 * remedy — *"ask for that URL directly if you want it, and it will be checked on its own merits"* — is the
 * right remedy, and nothing was doing it. So a user pasting an ordinary link got a refusal:
 * `https://youtu.be/…`, any shortener, and every host that redirects to its `www` or trailing-slash form.
 * Worse, `readSource` classified that refusal as `forbidden`, which tells the user their link is not allowed
 * when in fact it was never fetched.
 *
 * Each hop re-enters `fetchPage`, so the egress policy, the scheme check and the byte ceiling run again on
 * every target. That is the whole safety argument: this adds no second fetcher and no second policy — it
 * takes the toolkit's own advice, `MAX_REDIRECT_HOPS` times, and stops at a repeat so a loop terminates.
 */
export const fetchFollowingRedirects = async (
  fetchPage: ResearchDeps["fetchPage"],
  url: string,
  maxHops: number = MAX_REDIRECT_HOPS,
): Promise<ToolkitPageResult> => {
  const seen = new Set<string>([url]);
  let current = url;

  for (let hop = 0; ; hop += 1) {
    const page = await fetchPage(current);
    if (page.ok) return page;

    const next = redirectTargetOf(page.reason, current);
    // Not a redirect: the refusal is the answer, and it is the *original* refusal rather than a summary of it.
    if (next === undefined) return page;

    if (hop >= maxHops) {
      return {
        ok: false,
        url: current,
        reason: `that URL redirected more than ${maxHops} times (last hop: ${next})`,
      };
    }
    if (seen.has(next)) {
      return { ok: false, url: current, reason: `that URL redirects in a loop (${next} was already visited)` };
    }
    seen.add(next);
    current = next;
  }
};

const SENTENCE_MIN_CHARS = 60;

/**
 * Did the *server* turn the fetcher away — #621?
 *
 * The toolkit reports a non-2xx as `That URL returned <status>: <body>`. 401, 403 and 429 are what a site
 * answers a bare HTTP client it does not like (Pexels' docs answered 403), and a browser is usually served.
 * Anything else — a 404, a policy refusal, a timeout — is not something a browser would change.
 */
export const refusedByServer = (reason: string): boolean => /\breturned (401|403|429)\b/.test(reason) || looksLikeBotWall(reason);

/** Longer than this, a page is content even if it mentions a captcha somewhere. */
const BOT_WALL_MAX_CHARS = 3_000;

/**
 * A 200 that is not the page: a "checking your browser" interstitial or a captcha wall — #621.
 *
 * Short and saying so, because an article that mentions "captcha" is still the article.
 */
export const looksLikeBotWall = (content: string): boolean =>
  content.length <= BOT_WALL_MAX_CHARS &&
  /just a moment\.\.\.|checking your browser|checking if the site connection is secure|enable javascript and cookies to continue|attention required|verify (that )?you are (a )?human|are you a robot|cf-browser-verification|access denied|request blocked|captcha/i.test(
    content,
  );

/**
 * Split readable text into passages on blank lines, then on length.
 *
 * Per *passage* rather than per document because the port requires it: *"docs/07 wants a citation to resolve
 * to the specific text that was used, and a document-level citation is an invitation to go and find it."*
 * Paragraph boundaries first, because a passage cut mid-sentence cites something nobody wrote.
 *
 * **Prose first, then document order.** The paragraphs that read like prose are chosen, and then put
 * back in the order they appeared — so an article reads top to bottom rather than longest-first. A page
 * with no prose at all (a link list, a table) falls back to its longest paragraphs, because returning
 * nothing would make `read_source` refuse a page a person can plainly read.
 */
export const toPassages = (content: string, maxPassages: number): { passages: string[]; truncated: boolean } => {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);

  const prose = paragraphs.filter(isProse);
  /**
   * Ordered by length, capped, then restored to document order.
   *
   * Longest-first is the selection and not the presentation: a reader needs the article's own sequence,
   * and a citation out of order is a citation that is hard to check against the page.
   */
  const chosen = (prose.length > 0 ? prose : [...paragraphs].sort((a, b) => b.length - a.length))
    .slice()
    .sort((a, b) => b.length - a.length)
    .slice(0, maxPassages);
  const ordered = paragraphs.filter((paragraph) => chosen.includes(paragraph));

  const passages: string[] = [];
  for (const paragraph of ordered) {
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

  /**
   * `truncated` counts the **prose** left behind, not the chrome.
   *
   * It used to compare against every paragraph, so a page whose menu items outnumbered the passages
   * reported `truncated: true` however completely the article had been read — and a model told the
   * source was truncated declines to use it. Now it means what it says: there is more of the document.
   */
  const candidates = prose.length > 0 ? prose.length : paragraphs.length;
  return { passages, truncated: candidates > passages.length };
};

/**
 * Fetch a URL's bytes, guarded.
 *
 * Named for what it does rather than for its first caller: `read_pdf` needs it and so does
 * `describe_image`, and the caps differ between them while the *policy* must not.
 *
 * **The egress policy is the platform's**, via `validateHttpEgress` — its own header says why that
 * function exists: *"writing the checks again in the tool would be a second SSRF defence that drifts
 * from the first, and the one that drifts is the one nobody re-reads."* So the policy decision is
 * imported and only the byte reading is local.
 *
 * Three properties, and each one is load-bearing:
 *
 * 1. **Redirects are refused, not followed.** The platform's decision, adopted deliberately: following
 *    one lets a permitted host bounce the request to a forbidden one, *"the standard SSRF bypass"*. The
 *    old runtime followed them by hand and re-validated each hop, which is the same defence spelled
 *    differently — but this way there is one rule and the target is reported so the caller can ask for
 *    it explicitly and have it checked on its own merits.
 * 2. **The cap is enforced while reading**, not after. `await response.arrayBuffer()` on a
 *    multi-gigabyte body buffers all of it before any length check could run.
 * 3. **A timeout covers the whole read**, so a server that dribbles bytes cannot hold a worker slot.
 */
export const fetchGuardedBytes = async (
  rawUrl: string,
  options: {
    readonly maxBytes?: number;
    readonly accept?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<Uint8Array> => {
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
  const timeoutMs = options.timeoutMs ?? PDF_FETCH_TIMEOUT_MS;
  const { validateHttpEgress } = await import("@retinue/agentkit/mcp");
  const { DEFAULT_EGRESS_POLICY } = await import("@retinue/agentkit/tools");

  let url: URL;
  try {
    url = validateHttpEgress(DEFAULT_EGRESS_POLICY, rawUrl);
  } catch (error) {
    throw new AgentPlatformError({
      code: "forbidden",
      message: `That URL cannot be fetched: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: options.accept ?? "application/pdf,*/*" };
    const send = (to: URL) =>
      (options.fetchImpl ?? fetch)(to.toString(), { redirect: "manual", signal: controller.signal, headers });

    /**
     * The redirect chain, followed one validated hop at a time — see `fetchFollowingRedirects`, which does the
     * same thing for pages and explains why.
     *
     * This path refused a redirect outright, as `forbidden`. The reason given was *"the policy checked the URL
     * you asked for"*, which is true and is exactly what makes following one safe: every hop goes back through
     * `validateHttpEgress` below, so the target is checked on its own merits rather than inheriting the
     * origin's permission. Without this, `read_pdf` refused the ordinary case — a PDF served off a CDN, or any
     * host that redirects to its canonical form — and told the user their link was not allowed.
     */
    let response = await send(url);
    const seen = new Set<string>([url.toString()]);

    for (let hop = 0; response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get("location");
      if (location === null || location.trim() === "") {
        throw new AgentPlatformError({
          code: "provider_error",
          message: `That URL answered ${response.status} without saying where it redirects to.`,
          retryable: false,
        });
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new AgentPlatformError({
          code: "provider_error",
          message: `That URL redirected more than ${MAX_REDIRECT_HOPS} times.`,
          retryable: false,
        });
      }

      let next: URL;
      try {
        // Resolved against the URL that answered, because `Location` is very often relative.
        next = validateHttpEgress(DEFAULT_EGRESS_POLICY, new URL(location, url).toString());
      } catch (error) {
        throw new AgentPlatformError({
          code: "forbidden",
          // Named as a redirect target, because "that URL cannot be fetched" about a URL the user never typed
          // is the kind of message that sends someone looking at the wrong link.
          message:
            `That URL redirects to ${location}, which cannot be fetched: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
        });
      }

      if (seen.has(next.toString())) {
        throw new AgentPlatformError({
          code: "provider_error",
          message: `That URL redirects in a loop (${next.toString()} was already visited).`,
          retryable: false,
        });
      }
      seen.add(next.toString());
      url = next;
      response = await send(url);
    }
    if (!response.ok) {
      throw new AgentPlatformError({
        code: "provider_error",
        message: `That URL answered ${response.status}.`,
        retryable: response.status >= 500,
      });
    }

    const body = response.body;
    if (body === null || body === undefined) {
      // Transcribed: *"The PDF download was empty."*
      throw new AgentPlatformError({ code: "provider_error", message: "The download was empty.", retryable: true });
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, which is more than can be read in one turn.`,
            retryable: false,
          });
        }
        chunks.push(value);
      }
    } finally {
      // Without this the connection stays open pulling a body nobody wants.
      await reader.cancel().catch(() => undefined);
    }

    if (total === 0) {
      throw new AgentPlatformError({ code: "provider_error", message: "The download was empty.", retryable: true });
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    if (error instanceof AgentPlatformError) throw error;
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new AgentPlatformError({
      code: aborted ? "timeout" : "provider_unavailable",
      message: aborted
        ? `That file did not download within ${timeoutMs / 1_000} seconds.`
        : `That file could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Extract a PDF's text.
 *
 * `unpdf` rather than a browser: Chromium renders a PDF in a plugin viewer whose contents `innerText`
 * cannot see, which is exactly why the old runtime needed a separate path too. Its API was verified
 * against a real document before this was written — `getDocumentProxy` gives `numPages`, `extractText`
 * with `mergePages: false` gives one string per page, and `getMetadata()` gives `info./Title`.
 */
export const extractPdfText = async (
  bytes: Uint8Array,
): Promise<{
  text: string;
  title?: string;
  pages: number;
  pagesRead: number;
  truncated: boolean;
  /** How many headings the structure pass recovered — #321. Zero means the text is flat prose. */
  headingsFound: number;
}> => {
  const { extractText, getDocumentProxy } = await import("unpdf");

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch (error) {
    /**
     * Password-protected is its own answer, because it is the one a person can act on.
     *
     * pdfjs throws a `PasswordException` for a user password and opens an owner-password-only document
     * normally — which is the behaviour the old code hand-rolled with `reader.decrypt("")`.
     */
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "PasswordException" || /password/i.test(message)) {
      throw new AgentPlatformError({ code: "invalid_input", message: "That PDF is password-protected.", retryable: false });
    }
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `That file could not be read as a PDF: ${message}`,
      retryable: false,
    });
  }

  const pages = pdf.numPages;
  if (pages === 0) {
    throw new AgentPlatformError({ code: "invalid_input", message: "That PDF has no pages.", retryable: false });
  }

  const extracted = await extractText(pdf, { mergePages: false });
  const perPage = (Array.isArray(extracted.text) ? extracted.text : [String(extracted.text)]).map((page) => String(page));
  const pagesRead = Math.min(pages, MAX_PDF_PAGES);

  /**
   * Headings recovered from font size — #321.
   *
   * The issue was written against `pypdf` and says structure *"is not directly available"*. `unpdf`
   * exposes `extractTextItems` with a `height` per item, which is the rendered font size, so it is —
   * from a dependency already installed and already used two lines above. See `pdf-structure.ts`.
   *
   * **Best-effort, and it degrades to the flat text.** `extractTextItems` is a second pass over the
   * same document and can fail where `extractText` succeeded; a read that worked must not start
   * failing because the structure pass did. `headingsFound === 0` is reported rather than hidden, so
   * a caller can tell a structured read from a flat one instead of guessing from the absence of `#`.
   */
  let headingsFound = 0;
  let structured = "";
  try {
    const { extractTextItems } = await import("unpdf");
    const result = (await extractTextItems(pdf)) as { items?: unknown };
    const raw = Array.isArray(result.items) ? result.items : [];
    // One array per page, or one flat array — both shapes are handled rather than assumed.
    const items = (Array.isArray(raw[0]) ? (raw as unknown[][]).slice(0, pagesRead).flat() : raw)
      .filter((item): item is { str: string; height: number } => {
        const candidate = item as { str?: unknown; height?: unknown };
        return typeof candidate.str === "string" && typeof candidate.height === "number";
      });
    const structure = structureFrom(items);
    headingsFound = structure.headingsFound;
    structured = structure.markdown;
  } catch {
    // Deliberately silent: the flat text below is the answer, and it is a complete one.
  }

  /*
   * The structured text replaces the flat text **only when it found something**, and only when it did
   * not lose anything doing it. The length guard is the important half: `extractTextItems` reads the
   * same document a second way, and a pass that recovered two headings while dropping a third of the
   * prose would be a worse read that looked like a better one.
   */
  const flat = collapsePdfText(perPage.slice(0, pagesRead).join("\n\n"));
  const useStructured = headingsFound > 0 && structured.length >= flat.length * 0.9;
  if (headingsFound > 0 && !useStructured) headingsFound = 0;
  let text = useStructured ? structured : flat;

  if (text === "") {
    /**
     * Transcribed, including the reason: *"Overwhelmingly a scanned/image-only PDF; there is no OCR
     * here, and saying so is more useful than returning ''."*
     */
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "No text could be extracted — the PDF looks scanned or image-only.",
      retryable: false,
    });
  }

  const truncated = pagesRead < pages || text.length > MAX_PDF_TEXT_CHARS;
  if (text.length > MAX_PDF_TEXT_CHARS) text = text.slice(0, MAX_PDF_TEXT_CHARS).trimEnd();

  let title: string | undefined;
  try {
    const metadata = (await pdf.getMetadata()) as { info?: { Title?: unknown } } | undefined;
    const raw = metadata?.info?.Title;
    if (typeof raw === "string" && raw.trim() !== "") title = raw.trim();
  } catch {
    // A document with unreadable metadata still has readable text; the title is the optional half.
    title = undefined;
  }

  return { text, pages, pagesRead, truncated, headingsFound, ...(title === undefined ? {} : { title }) };
};

/**
 * What the bytes actually are.
 *
 * Magic numbers rather than a filename or a `content-type`: an extension is a claim by whoever wrote the
 * link and a header is a claim by the server, while the first bytes of the file are the file. An unknown
 * signature is refused rather than guessed at, because a wrong mime is a decode error *inside the
 * provider* and reads as the model failing.
 */
export const sniffImageMime = (bytes: Uint8Array): string => {
  const at = (index: number) => bytes[index];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  throw new AgentPlatformError({
    code: "invalid_input",
    message: "That file is not a PNG, JPEG, GIF or WebP image, which are the formats a vision model can read.",
    retryable: false,
  });
};

export const createWebResearchService = (deps: ResearchDeps): ResearchService => {
  const now = deps.now ?? Date.now;

  /**
   * An asset's bytes, with the two refusals that belong to the *source* rather than the file type.
   *
   * Shared by `readPdf` and `readImage`, because otherwise both are checked in two places and, in time,
   * in one of them. The uuid check is first and it is the security-relevant one: the value goes to a
   * deployment-supplied resolver that signs a storage object, and `"other-workspace/secret.pdf"` is a
   * perfectly good string.
   *
   * The missing-resolver refusal is the same shape as `convert_media`'s — *"reporting missing
   * configuration by name only"*: it says which capability the deployment has not wired, and nothing
   * about the asset, because there is nothing to say.
   */
  const assetBytes = async (
    context: ExecutionContext,
    assetId: unknown,
  ): Promise<{ bytes: Uint8Array; mime?: string }> => {
    const value = String(assetId).trim();
    /*
     * #607: or a `chorus-media:` reference — what a slide deck names its images by, since the renderers
     * return references and never ids. Passed to the same resolver, which scopes it to the workspace's own
     * folder before anything is signed; a traversal is refused here first.
     */
    const reference = value.startsWith("chorus-media:") && !value.includes("..") && /^chorus-media:[^\s]+$/.test(value);
    if (!UUID.test(value) && !reference) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "assetId must be an id from this workspace's own media, not a path or a URL.",
        retryable: false,
      });
    }
    if (deps.readAssetBytes === undefined) {
      throw new AgentPlatformError({
        code: "provider_unavailable",
        message:
          "This deployment cannot read files from the workspace's own media — no asset reader is " +
          "configured. A file the user links to can still be read.",
        retryable: false,
      });
    }
    return deps.readAssetBytes({ context, assetId: String(assetId).trim() });
  };

  return {
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    async searchStockMedia(_context, input) {
      if (deps.stockMedia === undefined) throw stockMediaNotEnabled();
      return deps.stockMedia.search(input);
    },

    async fetchStockMedia(_context, input) {
      if (deps.stockMedia === undefined) throw stockMediaNotEnabled();
      const raw = await deps.stockMedia.get({ id: input.id, kind: input.kind });
      const item = input.kind === "video" ? mapPexelsVideo(raw) : mapPexelsPhoto(raw);
      const file =
        input.kind === "video"
          ? pickPexelsVideoFile(raw, input.size === "sd" ? "sd" : "hd")
          : pickPexelsPhotoFile(raw, input.size === "large" || input.size === "original" ? input.size : "large2x");
      if (item === undefined || file === undefined) {
        throw new AgentPlatformError({
          code: "provider_error",
          message: `Pexels returned no downloadable ${input.kind} for that id.`,
          retryable: false,
        });
      }
      /*
       * Through the guarded reader: the egress policy, every redirect hop re-validated, and the cap enforced
       * while reading. The URL was picked from the library's own response and checked to be a pexels.com
       * https host by the mapper.
       */
      const bytes = await fetchGuardedBytes(file.url, {
        maxBytes: input.kind === "video" ? PEXELS_MAX_VIDEO_BYTES : PEXELS_MAX_PHOTO_BYTES,
        accept: input.kind === "video" ? "video/mp4" : IMAGE_MIMES.join(","),
        timeoutMs: input.kind === "video" ? 60_000 : 20_000,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      let mime: string;
      if (input.kind === "video") {
        if (!looksLikeMp4(bytes)) {
          throw new AgentPlatformError({ code: "provider_error", message: "The Pexels download is not an MP4 video.", retryable: false });
        }
        mime = "video/mp4";
      } else {
        mime = sniffImageMime(bytes);
      }
      return { bytes, mime, width: file.width, height: file.height, item };
    },

    async readImage(context, input) {
      const source = input.source;
      if (source.kind === "url") {
        const bytes = await fetchGuardedBytes(source.url, {
          maxBytes: MAX_IMAGE_BYTES,
          accept: IMAGE_MIMES.join(","),
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        });
        /**
         * The mime is sniffed from the bytes, not taken from the URL or the response — see
         * `sniffImageMime`.
         */
        return { bytes, mime: sniffImageMime(bytes) };
      }
      const asset = await assetBytes(context, source.assetId);
      /**
       * A resolver that reports a mime is believed, since it read the object's own metadata; one that
       * does not falls back to the bytes. Sniffing unconditionally would override a resolver that knows
       * better — a storage object's recorded content type is a fact about the object, not a claim by a
       * stranger.
       */
      return { bytes: asset.bytes, mime: asset.mime ?? sniffImageMime(asset.bytes) };
    },

    async readPdf(context, input) {
      const source = input.source;
      const bytes =
        source.kind === "url"
          ? await fetchGuardedBytes(source.url, {
              maxBytes: MAX_PDF_BYTES,
              accept: "application/pdf,*/*",
              ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            })
          : (await assetBytes(context, source.assetId)).bytes;

      return extractPdfText(bytes);
    },

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
        results: outcome.hits.slice(0, limit).map((hit) => {
          const url = withoutTracking(hit.url);
          return { resultId: encodeResultId(url), title: hit.title, snippet: hit.snippet, url };
        }),
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
          message: String(input.resultId).startsWith("src_")
            ? "That resultId is damaged — it was not copied exactly. Copy the id character for character from the search result, or pass the result's `url` instead."
            : `${String(input.resultId)} is not a resultId this service issued. Search again and use one of its ids.`,
          retryable: false,
        });
      }

      const fetched = await fetchFollowingRedirects(deps.fetchPage, target);
      const refused = fetched.ok ? looksLikeBotWall(stripFetchEnvelope(fetched.content)) : refusedByServer(fetched.reason);
      /**
       * #621: a server that turned the fetcher away, read with a browser instead.
       *
       * Only for a *server's* refusal — 401/403/429 or a bot wall on a 200. A URL the egress policy refused is
       * refused by the browser path too (it checks the same policy before launching), so it is not retried.
       * The text that comes back is the page's, and goes through the same passages and the same fence in the
       * tool as fetched text: nothing about it is more trusted for having come through a browser.
       */
      let page: ToolkitPageResult = fetched;
      let browserFailure: string | undefined;
      if (refused && deps.browserRead !== undefined) {
        try {
          const read = await deps.browserRead({ context, url: target });
          if (read.text.trim() === "" || looksLikeBotWall(read.text)) {
            browserFailure = "the browser was shown the same wall";
          } else {
            page = { ok: true, url: read.url, status: 200, truncated: read.truncated, content: read.text };
          }
        } catch (error) {
          browserFailure = error instanceof Error ? error.message : String(error);
        }
      }
      if (page.ok && refused && page === fetched) {
        // A bot wall with no browser to try, or a browser that failed: the wall is not the page.
        throw new AgentPlatformError({
          code: "provider_error",
          message:
            `${target} could not be read: the site answered with a bot check instead of the page` +
            (browserFailure === undefined ? "." : `, and a browser could not read it either (${browserFailure}).`),
          retryable: false,
        });
      }
      if (!page.ok) {
        /**
         * The fetcher's refusal, classified rather than passed through as prose.
         *
         * The port requires `forbidden` for a disallowed host and `timeout` for either limit, *"both distinct
         * from an empty result"*. The reason string is the toolkit's; the code is what a caller branches on,
         * and an assistant needs to tell "that host is not allowed" from "that page is slow".
         */
        const reason = page.reason.toLowerCase();
        /**
         * `redirect` is deliberately **not** in the forbidden set any more.
         *
         * It used to be, and it was the wrong answer twice over: the chain is followed now, so a redirect
         * reaching here is an exhausted or looping one rather than a policy decision — and calling that
         * "forbidden" told a user their link was disallowed when it had never been fetched at all.
         */
        const code = /timed? *out|timeout|deadline/.test(reason)
          ? "timeout"
          : /private|loopback|link-local|blocked|not allowed|refused|scheme|not permitted/.test(reason)
            ? "forbidden"
            : "provider_error";
        throw new AgentPlatformError({
          code,
          message:
            `${target} could not be read: ${page.reason}` +
            (browserFailure === undefined ? "" : ` — and a browser could not read it either: ${browserFailure}`),
          retryable: code === "timeout",
        });
      }

      const maxPassages = Math.min(Math.max(Math.trunc(input.maxPassages), 1), MAX_PASSAGES);
      const { passages, truncated } = toPassages(stripFetchEnvelope(page.content), maxPassages);
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
