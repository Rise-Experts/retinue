# Tool Catalogue

Status: specification · REQ-047 ([#206](https://github.com/Rise-Experts/retinue/issues/206)), task [#213](https://github.com/Rise-Experts/retinue/issues/213)
Written **before** the tools, so classification is a decision rather than something discovered at review.

Every tool this package intends to ship, with the six things that have to be decided about each one. The
reference list is the Agno toolkit index — 139 toolkits, **588 functions**, counted function by function — used
as a roadmap of what people ask for and nothing else. **No code is ported.** Their toolkit classes carry none of
what ours must, and the API call is the easy fifth of the work.

## The rules this catalogue applies

**One contract, several providers.** Five search providers are one `web_search` tool with five adapters, not
five tools. This single rule removes about 120 of the 588: the choice of Tavily over Brave is a deployment's,
and a model does not benefit from seeing both.

**Not everything is a tool.** A large share of that list maps, in this architecture, onto *ports that already
exist* — as adapters, not as tools. Getting this wrong is how 588 becomes our number:

| In the reference list | Here it is |
|---|---|
| Azure OpenAI, Gemini, Groq, OpenAI, Nebius, Morph | **Model providers.** `./providers`, already built |
| Mem0, Zep | **`PrincipalMemoryStore` adapters.** The port exists |
| E2B, Daytona | **`Sandbox` adapters** for `shell_exec` (#215), not tools in their own right |
| Knowledge tools | **Already ours** — `search_knowledge`, `read_document` |
| User Control Flow, User Feedback | **HITL.** `ask_questions`, `request_approval` |
| Postgres, Redshift, BigQuery, Neo4j, DuckDb | **`sql_query` with a dialect adapter**, not five tools |
| AgentOS Studio, Scheduler | **The platform** (REQ-042), a different product |
| Docling, Newspaper, Trafilatura | **Document parsers.** The extraction port takes them |

**Effect drives approval, and never a name.** `read` | `internal-write` | `external-write` | `destructive`,
with `never` | `policy` | `always`. Anything `external-write` or `destructive` carries
`requiresIdempotencyKey: true`, so a retry returns the first result instead of firing the side effect twice.
Deciding "is this dangerous" by matching on a tool's name is a losing game; declaring an effect is not.

**Packaging.** First-party primitives that need no vendor SDK ship in `@retinue/agentkit`. Everything else is a
sibling package, so a vendor API change is not a runtime release and the runtime's dependency-free root
survives.

**Credentials are the deployer's.** A tool takes a `credentialRef`; the host resolves it. No tool reads an
environment variable. That is what makes a multi-tenant deployment possible later without rewriting every
toolkit, and it takes vendor app review off this repository's critical path entirely.

## Categories

Preloading is *by category*, so a category is a loadout unit and not a filing convenience. Five today; twelve
proposed, because a hundred tools in one bucket is one bad default away from being resident.

`web` · `data` · `files` · `code` · `knowledge` · `general` · `communication` · `project` · `crm` ·
`productivity` · `media` · `finance` · `cloud` · `meta`

---

## Wave 1 — no third-party auth · `@retinue/agentkit`

Extensions of what exists. Nothing here needs a vendor account, so nothing here is blocked on anything.

| Tool | Category | Effect | Approval | Idem. | Status |
|---|---|---|---|---|---|
| `fetch_url` | web | `read` | `policy` | no | **built** |
| `fetch_json` | web | `read` | `policy` | no | **built** |
| `http_request` | web | `read` | `policy` | no | **built** |
| `http_write` | web | `external-write` | `always` | yes | **built** |
| `parse_csv` | data | `read` | `never` | no | **built** |
| `query_json` | data | `read` | `never` | no | **built** |
| `sql_query` | data | `read` | `policy` | no | **built** |
| `sql_schema` | data | `read` | `never` | no | **built** |
| `search_knowledge` | knowledge | `read` | `never` | no | **built** |
| `read_document` | knowledge | `read` | `never` | no | **built** |
| `read_attachment` | files | `read` | `never` | no | **built** |
| `list_attachments` | files | `read` | `never` | no | **built** |
| `now` | general | `read` | `never` | no | **built** |
| `calculate` | general | `read` | `never` | no | **built** |
| `web_search` | web | `read` | `policy` | no | **built** (placeholder provider — see wave 2) |
| `fs_read` | files | `read` | `never` | no | #215 |
| `fs_list` | files | `read` | `never` | no | #215 |
| `fs_search` | files | `read` | `never` | no | #215 |
| `fs_write` | files | `internal-write` | `policy` | no | #215 — scoped to the writable root, never the source tree |
| `shell_exec` | code | `destructive` | `always` | yes | #215 — sandbox only; the in-process adapter refuses in production |
| `file_generate` | files | `internal-write` | `never` | no | CSV/Markdown/PDF to an artifact; the renderers exist |
| `sleep` | general | `read` | `never` | no | Bounded by the run's step ceiling, not by the model's patience |
| `think` | general | `read` | `never` | no | A scratchpad that structures reasoning without a side effect |
| `sql_write` | data | `internal-write` | `always` | yes | Deliberately separate from `sql_query`; a read tool that can write is a read tool nobody can reason about |

## Meta — the machinery · `@retinue/agentkit`

Not domain tools; the mechanism the rest of the catalogue depends on. Listed because the check below covers every
registered tool, and a tool absent from this file is a tool nobody classified.

| Tool | Category | Effect | Approval | Status |
|---|---|---|---|---|
| `learn_tools` | meta | `read` | `never` | **built** |
| `execute_tool` | meta | `read` | `never` | **built** — the effect of what it runs is re-checked at execution |
| `load_skill` | meta | `read` | `never` | **built** |
| `ask_questions` | meta | `read` | `never` | **built** |
| `request_approval` | meta | `read` | `never` | **built** |
| `read_tool_output` | meta | `read` | `never` | **built** |

## Wave 2 — API key only · sibling packages

One contract per capability, providers behind it. The provider is a deployment's choice; the model sees one
tool.

| Tool | Package | Category | Effect | Approval | Providers |
|---|---|---|---|---|---|
| `web_search` | `tools-search` | web | `read` | `policy` | Tavily, Brave, Exa, Serper, SearXNG, DuckDuckGo, Perplexity, Linkup, You.com |
| `web_scrape` | `tools-scrape` | web | `read` | `policy` | Firecrawl, Jina Reader, Crawl4AI, Spider, Oxylabs, BrightData, ScrapeGraph |
| `web_crawl` | `tools-scrape` | web | `read` | `always` | Same. `always` because a crawl is a load someone else pays for |
| `browser_navigate` | `tools-browser` | web | `read` | `always` | Browserbase, Playwright. A driven browser carries a session; approval is not optional |
| `research_search` | `tools-research` | knowledge | `read` | `never` | Wikipedia, arXiv, PubMed, Hacker News — no key, but its own package for its HTTP clients |
| `stock_quote` | `tools-finance` | finance | `read` | `never` | yfinance, OpenBB, Financial Datasets |
| `stock_fundamentals` | `tools-finance` | finance | `read` | `never` | Same |
| `weather_forecast` | `tools-weather` | general | `read` | `never` | OpenWeather |
| `place_search` | `tools-maps` | general | `read` | `never` | Google Maps |
| `image_generate` | `tools-media` | media | `internal-write` | `policy` | DALL·E, Replicate, Fal, ModelsLab |
| `speech_generate` | `tools-media` | media | `internal-write` | `policy` | ElevenLabs, Cartesia |
| `transcribe` | `tools-media` | media | `read` | `never` | Whisper-compatible endpoints |
| `video_generate` | `tools-media` | media | `internal-write` | `always` | Luma, Replicate. `always` — minutes of GPU per call |

## Wave 3 — token or OAuth · sibling packages

Each is a `credentialRef`. Every write is `external-write` or `destructive`, gated and idempotent, because these
reach systems other people depend on.

| Package | Tools | Category | Notes |
|---|---|---|---|
| `tools-github` | `search_code`, `get_file`, `list_issues`, `create_issue`, `comment`, `create_pr`, `merge_pr`, `list_runs` | project | **First one built.** Token auth needs no OAuth plumbing; a GitHub App is the upgrade path. `merge_pr` is `destructive` |
| `tools-slack` | `list_channels`, `read_history`, `post_message`, `reply_thread`, `upload_file` | communication | Second. Exercises the `credentialRef` seam before connections exist. Useful only with triggers (REQ-042 piece 3) |
| `tools-email` | `send_email`, `list_messages`, `read_message` | communication | SMTP, Resend, AWS SES behind one contract. `send_email` is `external-write`, `always` |
| `tools-google` | Drive, Sheets, Calendar, Gmail, Slides | productivity | Four consent surfaces in one vendor; scope sprawl is the cost driver, not the API |
| `tools-jira` | `search_issues`, `create_issue`, `transition`, `comment` | project | API token per-user works today; OAuth 3LO for multi-tenant |
| `tools-linear` | `search_issues`, `create_issue`, `update_issue` | project | |
| `tools-notion` | `search`, `read_page`, `create_page`, `append_block` | project | |
| `tools-confluence` | `search`, `read_page`, `create_page` | project | |
| `tools-tasks` | Todoist, Trello, ClickUp behind one task contract | project | Three vendors, one shape. If the shape does not fit all three, that is a finding and they split |
| `tools-zendesk` | `search_articles`, `create_ticket`, `comment_ticket` | crm | |
| `tools-salesforce` | `query`, `create_record`, `update_record` | crm | |
| `tools-shopify` | `list_products`, `list_orders`, `update_product` | crm | |
| `tools-discord` | `read_channel`, `post_message` | communication | |
| `tools-telegram` | `send_message`, `read_updates` | communication | |
| `tools-meta` | WhatsApp `send_message`/`send_template`, Instagram `publish`/`read_insights` | communication | Vendor app review is the deployer's, not ours. Template approval is a WhatsApp concept the tool must expose rather than hide |
| `tools-x` | `post`, `search`, `read_mentions` | communication | |
| `tools-reddit` | `search`, `read_thread`, `post` | communication | |
| `tools-meetings` | Zoom, Webex, Cal.com behind one scheduling contract | productivity | |
| `tools-aws` | `invoke_lambda`, `send_email` (SES), `s3_read`, `s3_write` | cloud | |
| `tools-azure` | `blob_read`, `blob_write` | cloud | "Azure" is a dozen products; two, deliberately |
| `tools-gitlab` | mirror of `tools-github`'s shape | project | Built after GitHub, from the same contract |

## Deferred, with the reason

A deferred item is a decision, not a backlog. Recording the reason is what stops the same argument recurring.

| Deferred | Why |
|---|---|
| ~120 duplicate provider tools | The one-contract rule. A deployment picks a provider; a model should not have to |
| Composio, Apify, Superserve | Aggregators. Wrapping one means reselling a hosted product and inheriting its outages |
| OpenCV, MoviePy, MLX Transcribe | Heavy native or Python-only dependencies for a TypeScript runtime |
| EVM / crypto | No customer has asked. Reversibility semantics deserve their own design, not a tool |
| Spotify, Giphy, Luma, Nano Banana, Desi Vocal, Smallest AI, TwelveLabs, Brandfetch, Adanos | Long tail with no demand signal. Cheap to add later against this specification |
| Airflow, Antigravity | Orchestrators that overlap flows (REQ-038). Integrating one before our own flow engine is used in anger would be premature |
| Bitbucket | After GitHub and GitLab, from the same contract, when someone asks |
| Zoom/Webex transcription | Separate consent surface from scheduling; splits out if demand appears |

## What has to be true of every entry

- [ ] An `effect`, and an `approvalPolicy` consistent with it. `external-write` or `destructive` ⇒ `requiresIdempotencyKey`.
- [ ] A category from the list above.
- [ ] Every external call through the egress policy — including one whose URL the model chose.
- [ ] Rate limits and pagination handled *in the tool*. A tool that returns page one and says nothing about page two loses data silently.
- [ ] Errors as the shared result envelope, never a vendor's error shape. A model should not have to learn nine error formats.
- [ ] A docs page on the one template, and a test that the tool is reachable from the example app — "built, tested and unreachable" has happened six times in this repository.
- [ ] An entry in this file. `npm run check:catalogue` fails on a registered tool that is not listed.

## Counting honestly

**24** tools in wave 1, **13** contracts in wave 2, **21** packages in wave 3 — call it **~120 tools** at v1
against the reference list's 588, with about 120 of the difference removed by the one-contract rule and most of
the rest either deferred with a reason or reclassified as an adapter for a port that already exists.

At the measured ~35 tokens per catalog entry, 120 tools is **~4,200 tokens** resident — which is still too much
to carry on every turn, and is why REQ-045 ([#204](https://github.com/Rise-Experts/retinue/issues/204)) is a
prerequisite for this REQ rather than a companion to it.
