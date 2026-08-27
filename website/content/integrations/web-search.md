---
sidebar_position: 4
---

# Web search

Brave, Tavily, Serper and self-hosted SearXNG — behind the one `web_search` tool the runtime already ships.

```bash
npm i @retinue/tools-search
```

## This package exports no tools

That is deliberate, and it is the rule the whole catalogue follows: **one contract, several providers.**
`web_search` exists in `@retinue/agentkit` and takes its provider as configuration, so four search vendors are
four values of one parameter rather than four tools. A model shown `brave_search`, `tavily_search` and
`serper_search` would be choosing a vendor — which is your decision, and one it cannot make well.

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

## Credentials

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

## Choosing one

Brave and Serper return links and snippets, which is what a citation needs. Tavily returns summarised answers,
which reads better and is harder to attribute — prefer it when the agent is briefing someone, not when it must
show its sources. SearXNG is the only option if queries cannot leave your network at all.
