# @retinue/tools-scrape

Read the pages a [Retinue](https://github.com/Rise-Experts/retinue) agent finds. `web_scrape`,
`web_scrape_batch` and `web_crawl`, behind one provider-swappable contract.

```bash
npm i @retinue/tools-scrape
```

## Usage

```ts
import { createScrapeToolkit } from "@retinue/tools-scrape";

// The direct provider is the default: no account, no key, no third party.
const toolkit = createScrapeToolkit({
  politeness: { perHostConcurrency: 2, minIntervalMs: 1000 },
});
```

`firecrawl({ apiKey })` and `jinaReader({ apiKey })` swap in a hosted extractor for pages that need JavaScript
to render. The result shape does not change — a test asserts it.

## What makes this safe to point at a URL a model chose

**SSRF is closed at the point of connection.** Three vectors, three defences, three tests:

1. A private, loopback or link-local literal — including `169.254.169.254`, `::ffff:169.254.169.254` and the
   6to4 form of the same address.
2. A public hostname that *resolves* to a private address.
3. A redirect to either of the above.

The resolved address is pinned as the connection's `lookup`, so there is no second DNS resolution between the
check and the socket. That window is DNS rebinding, and a check that can lose a race against it reports safety
it does not provide.

**Page content arrives marked as untrusted.** Every page's text comes back inside the platform's
`<untrusted-content>` envelope, which neutralises forged headings, provider turn markers and escaping fences.
It is a boundary, not a filter — see the decision in `docs/23`.

**A crawl is bounded four ways** — pages, depth, bytes, wall clock — and reports which bound stopped it, so a
caller raises the right one. `robots.txt` is honoured by default, with longest-match semantics. Per-host
concurrency and spacing are on by default, so a wide seed page cannot be turned into a small denial of service.

## Not in scope

No authentication, no cookies, no sessions. No bot-detection evasion of any kind — no browser impersonation, no
CAPTCHA solving, no proxy rotation. The User-Agent is honest, so a site that wants to refuse this can.

MIT.
