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
| `web_search` | web | `read` | `policy` | no | **built**; real providers ship in `@retinue/tools-search` (#214) |
| `fs_read` | files | `read` | `never` | no | **built** (#215). Path-scoped; an absolute path, a `..` escape and a symlink out of the root are all refused, and the refusal does not depend on whether the target exists |
| `fs_list` | files | `read` | `never` | no | **built** (#215) |
| `fs_search` | files | `read` | `never` | no | **built** (#215). Literal-text search, bounded in files and matches, reporting when a ceiling stopped it |
| `fs_write` | files | `internal-write` | `policy` | no | **built** (#215) — a *different* root from the reads, so a model cannot edit the material it also cites |
| `shell_exec` | code | `destructive` | `always` | yes | **built** (#215). Two switches: a `Sandbox` wired **and** the `shell` capability declared. The local adapter throws unless a deployment types `allowUnsafeLocalExecution: true` |
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
| `find_tools` | meta | `read` | `never` | **built** (#210). Present only when a search is wired, and filtered by the same authorization as discovery |
| `execute_tool` | meta | `read` | `never` | **built** (#210) — the effect of what it runs is re-checked at execution. This row said "built" for months while nothing implemented it: the descriptor existed, the handler did not, and `find_tools` would have returned a name the model could not call |
| `load_skill` | meta | `read` | `never` | **built** |
| `ask_questions` | meta | `read` | `never` | **built** |
| `request_approval` | meta | `read` | `never` | **built** |
| `read_tool_output` | meta | `read` | `never` | **built** |

## Wave 2 — API key only · sibling packages

One contract per capability, providers behind it. The provider is a deployment's choice; the model sees one
tool.

| Tool | Package | Category | Effect | Approval | Providers |
|---|---|---|---|---|---|
| `web_search` | `tools-search` | web | `read` | `policy` | **Built** (#214): Brave, Tavily, Serper, SearXNG. Deferred: Exa, DuckDuckGo, Perplexity, Linkup, You.com — each is one more adapter object, so they are additions rather than work. The package exports **no tools**: this is the one-contract rule applied to itself |
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
reach systems other people depend on. Auth is per vendor and **both modes are supported where the vendor supports
both** — a token pasted in, or an OAuth flow the package performs
([REQ-063, #259](https://github.com/Rise-Experts/retinue/issues/259)).

Names are vendor-prefixed throughout. That is not cosmetic: [#210](https://github.com/Rise-Experts/retinue/issues/210)
measured that a plausible resident near-duplicate beats searching for the right tool, and a deployment wiring two
trackers has two of everything. `jira_create_issue` and `linear_create_issue` are distinguishable; `create_issue`
twice is not.

### Specified per tool

These have a per-tool contract — effect, approval and failure behaviour — in the issue named. The counts are what
the package will export, not an estimate.

| Package | Tools | Category | Issue |
|---|---|---|---|
| `tools-github` | `github_add_labels`, `github_add_project_item`, `github_close_issue`, `github_close_pull_request`, `github_create_branch`, `github_create_file`, `github_create_project`, `github_create_pull_request`, `github_create_release`, `github_delete_file`, `github_dispatch_workflow`, `github_get_commit`, `github_get_issue`, `github_get_project`, `github_get_pull_request`, `github_get_release`, `github_get_workflow_run`, `github_get_workflow_run_logs`, `github_list_branches`, `github_list_commits`, `github_list_directory`, `github_list_labels`, `github_list_milestones`, `github_list_projects`, `github_list_pull_requests`, `github_list_releases`, `github_list_tags`, `github_list_workflow_runs`, `github_remove_label`, `github_remove_project_item`, `github_reopen_issue`, `github_rerun_workflow`, `github_review_pull_request`, `github_search_issues`, `github_search_pull_requests`, `github_set_project_field`, `github_update_file`, `github_update_issue`, `github_update_pull_request`, `github_write_file` · **built:** `github_search_code`, `github_get_file`, `github_list_issues`, `github_create_issue`, `github_comment`, `github_merge_pull_request` | project | [#223](https://github.com/Rise-Experts/retinue/issues/223) |
| `tools-slack` | **4**, all built · `slack_list_channels`, `slack_read_history`, `slack_post_message`, `slack_reply_in_thread`. Slack answers `200` with `ok: false`, so the envelope is read and not the status. `upload_file` deferred: multipart to a second host | communication | [#214](https://github.com/Rise-Experts/retinue/issues/214) |
| `tools-jira` | **8** · `jira_search_issues`, `jira_get_issue`, `jira_list_projects`, `jira_list_transitions`, `jira_create_issue`, `jira_update_issue`, `jira_transition_issue`, `jira_comment` | project | [#225](https://github.com/Rise-Experts/retinue/issues/225) |
| `tools-confluence` | **6** · `confluence_search`, `confluence_get_page`, `confluence_list_spaces`, `confluence_create_page`, `confluence_update_page`, `confluence_comment` | project | [#225](https://github.com/Rise-Experts/retinue/issues/225) |
| `tools-linear` | **7** · `linear_search_issues`, `linear_get_issue`, `linear_list_teams`, `linear_list_states`, `linear_create_issue`, `linear_update_issue`, `linear_comment` | project | [#226](https://github.com/Rise-Experts/retinue/issues/226) |
| `tools-notion` | **7** · `notion_search`, `notion_get_page`, `notion_query_database`, `notion_create_page`, `notion_update_page`, `notion_append_blocks`, `notion_comment` | project | [#226](https://github.com/Rise-Experts/retinue/issues/226) |
| `tools-meta` | **10** · `whatsapp_list_templates`, `whatsapp_send_template`, `whatsapp_send_message`, `whatsapp_send_media`, `whatsapp_mark_read`, `instagram_get_account`, `instagram_list_media`, `instagram_get_media`, `instagram_publish_media`, `instagram_reply_comment` | communication | [#229](https://github.com/Rise-Experts/retinue/issues/229) |
| `tools-x` | **6** · `x_search_posts`, `x_get_post`, `x_get_user`, `x_list_user_posts`, `x_post`, `x_delete_post` (`destroys`) | communication | [#230](https://github.com/Rise-Experts/retinue/issues/230) |
| `tools-reddit` | **6** · `reddit_search`, `reddit_get_post`, `reddit_list_subreddit`, `reddit_get_user`, `reddit_submit_post`, `reddit_comment` | communication | [#230](https://github.com/Rise-Experts/retinue/issues/230) |
| `tools-discord` | **7** · `discord_list_channels`, `discord_read_messages`, `discord_get_message`, `discord_send_message`, `discord_reply_message`, `discord_add_reaction`, `discord_create_thread` | communication | [#231](https://github.com/Rise-Experts/retinue/issues/231) |
| `tools-telegram` | **6** · `telegram_get_chat`, `telegram_send_message`, `telegram_send_media`, `telegram_edit_message`, `telegram_delete_message` (`destroys`), `telegram_pin_message` | communication | [#231](https://github.com/Rise-Experts/retinue/issues/231) |
| `tools-google` | `calendar_create_event`, `calendar_delete_event`, `calendar_find_free_time`, `calendar_get_event`, `calendar_list_events`, `calendar_update_event`, `gmail_create_draft`, `gmail_get_message`, `gmail_get_thread`, `gmail_list_labels`, `gmail_modify_labels`, `gmail_reply_message`, `gmail_search_messages`, `gmail_send_message`, `docs_append_text`, `docs_create_document`, `docs_get_document`, `drive_create_folder`, `drive_get_file`, `drive_move_file`, `drive_search_files`, `drive_share_file`, `drive_upload_file`, `sheets_add_sheet`, `sheets_append_rows`, `sheets_get_values`, `sheets_list_sheets`, `sheets_update_values` | productivity | [#234](https://github.com/Rise-Experts/retinue/issues/234), [#235](https://github.com/Rise-Experts/retinue/issues/235) |
| `tools-azure` | `azure_get_metrics`, `azure_get_resource`, `azure_list_activity_log`, `azure_list_resource_groups`, `azure_list_resources`, `azure_list_subscriptions`, `azure_query_logs`, `azure_restart_resource`, `azure_tag_resource` | cloud | [#236](https://github.com/Rise-Experts/retinue/issues/236) |
| `tools-scrape` | **3** · `web_scrape`, `web_scrape_batch`, `web_crawl` | web | [#238](https://github.com/Rise-Experts/retinue/issues/238) |
| `tools-browser` | **6** · `browser_navigate`, `browser_read`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_close` | web | [#239](https://github.com/Rise-Experts/retinue/issues/239) |
| `tools-email` | **4** · `email_send`, `email_compose_preview`, `email_get_status`, `email_list_sent` | communication | [#241](https://github.com/Rise-Experts/retinue/issues/241) |

**163 tools specified across 16 packages**, of which 10 are built — every one named above, so
`npm run check:catalogue` counts 206 catalogued tools and the gap to the total below is exactly the sketched
packages that have no contract yet.

One discrepancy surfaced while enumerating: [#223](https://github.com/Rise-Experts/retinue/issues/223) is titled
*"38 more"* and its tables specify **40**. The names above are what the issue actually contains; whoever
implements it should trust the tables and correct the title.

### Sketched, not yet specified

The shape is decided; the per-tool contract is not. Each needs the same treatment as the rows above before it is
built — an issue with a tool table, effects and failure behaviour. Listing an estimate here rather than inventing
tool names is the honest version: a name written down without a contract behind it is a name somebody will
implement differently.

| Package | Category | Shape | Rough |
|---|---|---|---|
| `tools-gitlab` | project | Mirror of `tools-github`'s contract, built from the same one | ~20 |
| `tools-tasks` | project | Todoist, Trello, ClickUp behind one task contract. If the shape does not fit all three, that is a finding and they split | ~6 |
| `tools-zendesk` | crm | Article search, ticket create, ticket comment | ~5 |
| `tools-salesforce` | crm | SOQL query, record create, record update | ~5 |
| `tools-shopify` | crm | Product list, order list, product update | ~6 |
| `tools-meetings` | productivity | Zoom, Webex, Cal.com behind one scheduling contract | ~5 |
| `tools-aws` | cloud | Read-first like `tools-azure`: S3 read/write, Lambda invoke, CloudWatch query | ~8 |
| `tools-research` | knowledge | Wikipedia, arXiv, PubMed, Hacker News. A composition over `web_search` and `web_scrape`, so it waits for both — see [#237](https://github.com/Rise-Experts/retinue/issues/237) | ~3 |
| `tools-finance` | finance | `stock_quote`, `stock_fundamentals` | 2 |
| `tools-weather` | general | `weather_forecast` | 1 |
| `tools-maps` | general | `place_search` | 1 |
| `tools-media` | media | `image_generate`, `speech_generate`, `transcribe`, `video_generate`. The audio two need a runtime modality first — [REQ-062, #257](https://github.com/Rise-Experts/retinue/issues/257) | 4 |

**~66 more across 12 packages.**

### Auth model per package

Both modes where the vendor offers both. This table is what
[#260](https://github.com/Rise-Experts/retinue/issues/260)'s per-toolkit declaration encodes, and what decides
whether an unconnected tool can pause a run for consent ([#264](https://github.com/Rise-Experts/retinue/issues/264))
or must simply fail.

| Auth | Packages |
|---|---|
| Token only — no login URL, so a missing credential fails rather than pausing | `tools-telegram` (bot token), `tools-discord` (bot token), `tools-notion` (integration token), `tools-linear` (API key) |
| Token **or** OAuth — a tenant chooses | `tools-github` (PAT / GitHub App / OAuth), `tools-jira` and `tools-confluence` (API token / OAuth 3LO), `tools-gitlab`, `tools-shopify` |
| OAuth required | `tools-google`, `tools-azure`, `tools-meta`, `tools-x`, `tools-reddit`, `tools-zendesk`, `tools-salesforce`, `tools-meetings` |
| API key, no per-user identity | Every wave 2 package: `tools-search`, `tools-scrape`, `tools-browser`, `tools-research`, `tools-finance`, `tools-weather`, `tools-maps`, `tools-media`, `tools-email` |

Two of the OAuth-required ones need a **tenant's own app** rather than the deployment's, and it is not a
preference: Meta's app review is per app and a shared app's approved use case may not cover a customer's, and X's
access tier is per app so a customer paying for a higher tier gains nothing from a shared one. That is why
[#263](https://github.com/Rise-Experts/retinue/issues/263) exists.

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

## The sandbox is a port, not a tool — task #215

`shell_exec` is the only tool in the package whose blast radius is not described by its schema, and its trigger is
natural language — including language the model merely *read*. What makes it defensible is `Sandbox`:

| Guarantee | Why it is not optional |
|---|---|
| No network | A command that can reach the network can exfiltrate anything it can read, and the egress policy does not apply inside a container |
| Read-only root, one writable tmpfs | A command that can write to the image can install a persistent foothold |
| Memory **and swap** capped together | A memory cap alone pushes the pressure onto the host's disk |
| Wall-clock timeout | `sleep 999` must end as a *timeout*, not as an empty success |
| Dropped capabilities, no new privileges, not root | Defence in depth behind the read-only filesystem |
| Output capped, truncation reported | Silent truncation makes a model believe it saw the whole answer |
| Exit code in the envelope | Inferring success from output text is guessing |

Every one of those is a flag in `dockerArgs`, and the tests assert the **argv** rather than only running a
command: a test that checked output would pass just as well with `--network=none` missing.

A timed-out command kills its whole **process group**, not just the shell. `sh -c "sleep 999 | cat"` forks, so a
`SIGKILL` aimed at the shell left `sleep` running on the host — and the orphan held the stdout pipe open, so the
call never returned either. Found by CI on a machine whose shell forked where mine had exec'd, then reproduced
locally in one line. Resolution is on `exit` rather than `close` for the same reason. The isolation
guarantees are then exercised for real against a local image — no network, read-only root, a killed timeout and an
OOM reported as `memory`.

**Gating is by effect, never by reading the command.** No refusing `rm -rf`, no allow-list of binaries: `find .
-delete`, `dd`, `python -c` and a base64 pipeline are all the same command wearing a different hat, and any list
of dangerous shapes is a list somebody gets around while *feeling* like protection.

## Bounding the catalogue — task #210

Three controls, all off by default, and the reason each exists:

| Control | Answers | Where |
|---|---|---|
| `catalogBudget` | *how much of this may sit in context* | `ToolRegistryConfig` (the client's view) and `DefaultEngineDeps` (the model's list) — two lists, so one number in one place would leave the other uncapped while looking capped |
| `find_tools` | *what exists that I was not shown* | `ToolRegistryConfig.search`, filtered by the same authorization as discovery |
| `execute_tool` | *how do I call what I just found* | The registry, unwrapped onto the ordinary call path so nothing is bypassed |
| `toolsets` | *does this tenant want this category at all* | `ToolRegistryConfig.toolsets`, applied **before** authorization |

Truncation is never silent: a `catalog.truncated` run event names every dropped tool, the budget that bound, and
whether `find_tools` was in the model's hands — the difference between a deferral and an amputation. The skill
catalogue gets the same budget through the same code, with its notice rendered into the prompt because a context
provider has no event stream.

## Built so far

**37** tools across four packages: 27 in `@retinue/agentkit`, 6 in `@retinue/tools-github`, 4 in
`@retinue/tools-slack`, and 0 in `@retinue/tools-search` — which ships four providers for a contract that already
exists. `npm run check:catalogue` reads every one of those packages, so a toolkit landing with an unclassified
tool is a failing build; it also requires each `tools/*` package to export its own `*_TOOL_NAMES` and
cross-checks that array's length against the declarations in the file, because a constant that has drifted from
the code is a check that passes while covering less than it says.

The estimate said ~0.5–1 PD per toolkit after the first. Slack and search together came in inside that, and the
long tail below is now addition rather than design.

## Counting honestly

The full inventory, which is the answer to "what tools do we need":

| | Tools | Built |
|---|---|---|
| **Wave 1** — no third-party auth, in `@retinue/agentkit` | 24 | 20 |
| **Meta** — the machinery | 7 | 7 |
| **Wave 2** — API key only, sibling packages | 12 | 0 |
| **Wave 3, specified** — 16 packages with a per-tool contract | 163 | 10 |
| **Wave 3, sketched** — 12 packages needing a spec first | ~66 | 0 |
| **Total** | **~272** | **37** |

Wave 2 counts **12**, not the 13 contracts its own table lists: `web_search` is a wave 1 tool and is counted
there. `@retinue/tools-search` ships four providers for it and exports no tool of its own — which is the
one-contract rule applied to itself, and the reason the built column reads 0 for a package that is finished.

That is more than double the **~120** this document estimated before wave 3 was specified per tool, and the
increase is almost entirely `tools-github` (6 → 44) and `tools-google` (5 surfaces → 28 tools). Both grew for the
same reason: "search issues, create issue, comment" describes a *demo*, and what people actually do on GitHub is
review pull requests, manage labels and milestones, and work with releases and workflows
([#222](https://github.com/Rise-Experts/retinue/issues/222) exists because that gap was pointed out).

At the measured ~35 tokens per catalog entry, 272 tools is **~9,500 tokens** resident if a deployment loaded them
all — and no deployment should. Two measured findings decide what to do about that, and they point the same way:

- Selection accuracy is **flat** from 20 to 200 tools (73.1% → 73.1%), so size is not a quality problem
  (`docs/24`).
- A catalogue **budget** costs 19-23 points of accuracy at 200 tools, because a plausible resident near-duplicate
  beats searching. So truncation is the wrong lever.

What is left is **per-tenant toolsets** — a deployment wires the four or five packages its customers use, and the
confusable neighbours are absent rather than merely unranked. A tenant with GitHub, Slack, Google and one tracker
carries ~90 tools, not 272. That is the number to design against.

The remaining cost of a large catalogue is tokens, not accuracy — 12.5× at 200 tools — and the fix for that is
prompt caching, which does not exist yet
([REQ-058, #246](https://github.com/Rise-Experts/retinue/issues/246)). The catalogue and system prompt are
byte-identical across every turn of a conversation, which is exactly the input caching exists for.

