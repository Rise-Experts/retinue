<img src="https://raw.githubusercontent.com/Rise-Experts/retinue/main/brand/retinue-mark.svg" alt="Retinue" width="72" />

# @retinue/tools-search

[![npm](https://img.shields.io/npm/v/@retinue/tools-search)](https://www.npmjs.com/package/@retinue/tools-search)
[![licence](https://img.shields.io/npm/l/@retinue/tools-search)](https://github.com/Rise-Experts/retinue/blob/main/LICENSE)

**Web-search providers for a [Retinue](https://github.com/Rise-Experts/retinue) agent.** Brave, Tavily, Serper
and self-hosted SearXNG — behind the one `web_search` tool the runtime already has.

## This package exports no tools

That is the point. `web_search` exists in `@retinue/agentkit` and takes its provider as configuration, so five
search vendors are **five values of one parameter**, not five tools. A model shown `tavily_search`,
`brave_search` and `serper_search` would be choosing a vendor — which is your decision, not its.

## Install

```bash
npm i @retinue/tools-search
```

## Use

The provider is configuration. Hand it to the standard tool provider and `web_search` appears; hand it nothing
and there is no `web_search` at all, rather than one that always answers "not configured".

```ts
import { createStandardToolProvider } from "@retinue/agentkit/tools";
import type { DelegatingToolDeps } from "@retinue/agentkit/tools";
import { tavilySearch } from "@retinue/tools-search";

// Your authorization policy, idempotency store and approval gate — see the getting-started guide.
declare const deps: DelegatingToolDeps;

const tools = createStandardToolProvider({
  deps,
  http: {},
  search: tavilySearch({ apiKey: process.env.TAVILY_API_KEY ?? "" }),
});
```

Switching provider is one import. Nothing else changes — not the tool, not the prompt, not the agent.

## Providers

| Provider | Transport | Key goes | Notes |
|---|---|---|---|
| `braveSearch` | GET | `X-Subscription-Token` header | |
| `tavilySearch` | POST | request body | `depth: "advanced"` costs more per query |
| `serperSearch` | POST | `X-API-KEY` header | Google results |
| `searxngSearch` | GET | no key | Self-hosted; `baseUrl` is required, because there is no public instance this package should send your queries to |

## Why these keys are plain configuration, not a `credentialRef`

A distinction worth knowing, because getting it wrong either way is a real bug.

A **per-tenant** credential — a customer's GitHub token, their Slack workspace — must be resolved per call, or
one tenant's request goes out with another's token. A **platform** credential — a search key the vendor bills
*you* for — is one key for the whole deployment, and resolving it per call is overhead that buys nothing.

Search keys are the second kind. If you ever need per-tenant search billing, that becomes a `credentialRef`, and
this paragraph is why it would be a change rather than an oversight.

## Behaviour worth knowing

**No provider means "I did not search."** Not "I found nothing" — the runtime returns `searched: false` with a
reason, and the tool's description tells the model to say so rather than answer from memory. A stubbed search
returning plausible results is a tool the model trusts and cannot verify.

**An unexpected response shape yields no hits, not an exception.** A provider changing its JSON should degrade to
"found nothing", not fail the run.

## Licence

MIT — see [LICENSE](https://github.com/Rise-Experts/retinue/blob/main/LICENSE).

Copyright (c) 2026 [Azeem Sarwar](https://github.com/azeem-sarwar) and
[Rise Experts](https://github.com/Rise-Experts).
