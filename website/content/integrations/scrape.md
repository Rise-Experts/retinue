---
sidebar_position: 14
---

# Web scraping

`tools-search` lets an agent find a page. This lets it read one — and follow the links it finds, within
bounds a stranger's server can live with.

```bash
npm i @retinue/tools-scrape
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `web_scrape` | `read` | `policy` | One URL to markdown, with title and canonical URL. Bounded bytes |
| `web_scrape_batch` | `read` | `policy` | Up to 20 URLs. One dead URL does not fail the call |
| `web_crawl` | `read` | **always** | Seed plus bounds on pages, depth, bytes and time. `robots.txt` honoured by default |

All three are reads, and a test asserts the package contains no write so that stays true. `web_crawl` is
gated unconditionally for a reason worth stating: **a crawl is a load somebody else pays for.** A scrape is one
request to a stranger's server; a crawl is up to two hundred, and the person bearing that cost is not the one
who asked for it.

`web_scrape` is `policy` rather than `never` because fetching an arbitrary URL is a read that *leaves the
building* — it tells a third party what an agent is interested in, and some deployments cannot make that
disclosure without a decision.

## Wire it up

```ts
import { createScrapeToolkit, firecrawl } from "@retinue/tools-scrape";

// The default: no account, no key, no third party.
const toolkit = createScrapeToolkit();

// Or a hosted extractor, for pages that need JavaScript to render.
const hosted = createScrapeToolkit({
  provider: firecrawl({ apiKey: process.env.FIRECRAWL_KEY ?? "" }),
  politeness: { perHostConcurrency: 2, minIntervalMs: 1000 },
  // A deployment that cannot accept the legal exposure refuses the robots override outright.
  allowRobotsOptOut: false,
});
```

## Credentials and scopes

**The direct provider needs no credential.** It fetches public pages, which is the point.

A hosted extractor's API key is a **platform** credential — one key for the deployment, billed to the operator
— so it is a constructor argument rather than a `credentialRef`. That is the same distinction `tools-search`
draws: a per-tenant credential must be resolved per call or one tenant spends another's; a platform credential
resolved per call is overhead that buys nothing.

Nothing here signs in to anything. See **Limits**.

## Behaviour worth knowing

**Page content is untrusted, and is marked as such.** Every page's text comes back inside the platform's
`<untrusted-content>` envelope, with its source. That envelope is not decoration: it neutralises forged
headings, provider turn markers like `<|im_start|>` and `[INST]`, and a code fence long enough to escape the
surrounding one. Pages carrying instructions aimed at an agent are common; the envelope is what keeps "the page
says" separate from "the operator says". It is not a filter — see the decision recorded in `docs/23`.

**Private network space is unreachable, and the check happens at connect time.** Three vectors are closed
separately: a private or link-local literal (including `169.254.169.254` and its IPv6-mapped and 6to4 forms), a
public hostname that *resolves* to a private address, and a redirect to either. The resolved address is pinned
as the connection's `lookup`, so there is no second DNS resolution between the check and the socket — that
window is DNS rebinding, and a check you can lose a race against reports safety it does not provide.

**A crawl has four bounds and they are independent.** Pages, depth, total bytes, and wall clock. The last is
the one most often left out and the one that matters most: against a host answering in thirty seconds, none of
the other three is reached for a very long time. `truncated` is reported along with **which** bound stopped it,
so a caller raises the right one instead of guessing, and `remaining` carries the frontier so a crawl can be
resumed rather than restarted.

**Per-host politeness is on by default.** Two concurrent requests per host and a minimum gap between starts.
Both, because they bound different things: concurrency bounds instantaneous load, spacing bounds the sustained
rate — two-at-a-time against a server answering in 5ms is four hundred requests a second. `Crawl-delay` from
`robots.txt` raises the spacing and never lowers it.

**`robots.txt` matching is not first-match.** Longest match wins and a tie goes to `Allow`, which is what the
major crawlers do and what site owners write against. A missing or unreachable file means allowed, per the
standard. The most specific `User-agent` group wins and *replaces* `*` rather than merging with it.

**Binaries are not read as text.** A PDF or an image comes back with its content type and no content, rather
than as bytes pretending to be prose.

**Provider choice does not change the result shape.** Direct, Firecrawl and Jina Reader all return the same
fields; a test asserts it. Swapping providers changes what a scrape costs and how good it is, never what a
caller has to handle.

## Limits

**No authentication.** This does not sign in, carry cookies, or use a session. A page behind a login is out of
scope, and the tool that would change that is `tools-browser`, which has its own issue and its own isolation
argument.

**No bot-detection evasion.** No browser impersonation, no CAPTCHA solving, no proxy rotation, no fingerprint
spoofing. The User-Agent is honest — `RetinueBot/1.0` with a URL explaining what it is — so a site that wants
to refuse this can. That is a deliberate position, not a missing feature: a package whose purpose is reading
public pages does not need to pretend to be a person, and one that did would be a different kind of tool with
different questions attached.

**No JavaScript rendering in the direct provider.** A page that renders client-side comes back thin. That is
what the hosted extractors are for, and it is the main reason to configure one.

**`robots.txt` can be overridden, and the override is the operator's legal responsibility.** The argument
exists because there are legitimate uses — crawling your own site, a contractual arrangement with the operator
of another. In several jurisdictions ignoring an access-control signal is the difference between reading a
public page and unauthorised access, which is not a decision a toolkit can make on an operator's behalf. A
deployment that cannot accept the exposure sets `allowRobotsOptOut: false`, and the override is then refused
rather than quietly ignored.

**No paging past the bounds, and no resume built in.** `remaining` gives a caller the frontier; feeding it back
is theirs to do.

**No `research_search`.** A multi-source research tool is a composition over search and scrape. It waits until
both exist rather than being guessed at now.
