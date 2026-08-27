---
sidebar_position: 4
---

# Web search

Brave, Tavily, Serper and self-hosted SearXNG — behind the one `web_search` tool the runtime already ships.

```bash
npm i @retinue/tools-search
```

## Tools

**None — and that is the point.** This package adds no tool to the catalogue. It supplies *providers* for the
`web_search` tool `@retinue/agentkit` already ships:

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `web_search` (in `@retinue/agentkit`) | `read` | `policy` | Exists only when a provider is configured. This package is where the providers come from |

That is the rule the whole catalogue follows: **one contract, several providers.** Four search vendors are four
values of one parameter rather than four tools. A model shown `brave_search`, `tavily_search` and `serper_search`
would be choosing a vendor — which is your decision, and one it cannot make well.

| Provider | Transport | Key travels in | Notes |
|---|---|---|---|
| `braveSearch` | GET | `X-Subscription-Token` header | |
| `tavilySearch` | POST | request body | `depth: "advanced"` costs more per query |
| `serperSearch` | POST | `X-API-KEY` header | Google results |
| `searxngSearch` | GET | no key | Self-hosted; `baseUrl` is required |

## Wire it up

```ts
import { createStandardToolProvider } from "@retinue/agentkit/tools";
import type { DelegatingToolDeps } from "@retinue/agentkit/tools";
import { braveSearch } from "@retinue/tools-search";

// Your authorization policy, idempotency store and approval gate — see Getting Started → Configuration.
declare const deps: DelegatingToolDeps;

const tools = createStandardToolProvider({
  deps,
  http: {},
  // No provider means no `web_search` at all — see below.
  search: braveSearch({ apiKey: process.env.BRAVE_API_KEY ?? "" }),
});
```

Switching vendor is one import. The tool, its schema, its name and your prompts stay exactly as they are.

## Credentials and scopes

There are no scopes — a search key is a single key with no permission model, which is part of why the next
paragraph matters.

A search key is **platform** configuration, not a per-tenant credential, so it is a constructor argument rather
than a `credentialRef`. The distinction is worth knowing because getting it wrong either way is a real bug: a
per-tenant credential must be resolved per call or one tenant's request goes out with another's token, while a
key the vendor bills *you* for is one key for the whole deployment and resolving it per call buys nothing.

If you ever need per-tenant search billing, that becomes a `credentialRef` — a change, rather than an oversight.

## Behaviour worth knowing

**No provider means there is no `web_search` tool**, rather than one that always answers "not configured". The
second kind costs the model a turn to discover and reads, in a transcript, exactly like a broken integration.

**A search that could not run says so.** The result carries `searched: false` and a reason, and the tool's
description tells the model to say it could not search rather than answer from memory. A stubbed search returning
plausible results is the worst possible failure: the model trusts it and cannot check it.

**An unexpected response shape yields no hits, not an exception.** A provider changing its JSON degrades to
"found nothing" instead of failing the run.

**Results are untrusted content.** Titles and snippets are written by whoever owns the page.

## Limits

No `web_scrape` and no `web_crawl`: fetching and rendering a page is a different contract with different failure
modes, and it belongs in `@retinue/tools-scrape` when that lands. Exa, DuckDuckGo, Perplexity, Linkup and You.com
are each one more adapter object — additions rather than work, deferred only because four providers already prove
the seam.

No result caching. A cache across tenants would leak one tenant's queries into another's results, and a per-tenant
cache is a store this package would have to own.

## Choosing one

Brave and Serper return links and snippets, which is what a citation needs. Tavily returns summarised answers,
which reads better and is harder to attribute — prefer it when the agent is briefing someone, not when it must
show its sources. SearXNG is the only option if queries cannot leave your network at all.
