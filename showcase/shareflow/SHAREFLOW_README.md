# `@retinue/shareflow`

The ShareFlow integration. ShareFlow is the platform's first consumer and stays outside the generic
packages: `docs/01-architecture.md` requires those to *"build and test without ShareFlow or Twenty
installed"*, and product-specific names *"live only in that application's integration package."*

This package depends on `@retinue/agentkit`. Nothing generic depends on it — R8 in
`../scripts/check-boundaries.mjs` fails the build if that reverses.

## Where this lives, and why it moved

This package used to be a workspace in the retinue monorepo. It is product code — its tools, prompts
and parity gates are specific to ShareFlow and are not a supported extension point — so it lives with
the product it serves, and consumes `@retinue/agentkit` from the registry like any other consumer.

Two things follow, and both are improvements rather than costs:

- **The image builds from source on the server.** `docker-compose.oracle.yml` builds `./shareflow` as
  part of the deploy that already SSHes in and runs `up -d --build`. While the source lived in a
  private monorepo that is not on that box, the image had to be shipped with
  `docker save | ssh docker load`.
- **The platform is consumed the way a customer consumes it.** A project reference could resolve types
  from source that the published package does not ship. Now it cannot: if a subpath is missing from
  agentkit's `exports` map, the build fails here rather than in someone else's deployment.

The dependency is `@retinue/agentkit@^0.3.2`, and the floor matters. 0.3.1 added
`RETINUE_DATABASE_SCHEMA`, which this deployment needs because it shares a Supabase database whose
`public` belongs to the product — on 0.3.0 the variable is simply ignored, no error, and the
platform's 34 tables land in `public` beside the product's 53. 0.3.2 then fixed *how* it is applied:
0.3.1 used a per-connection `SET` that pg deprecates and will remove in v9, and it built the path
with a space after the comma, which libpq reads as the end of one option and the start of another —
`invalid value for parameter "search_path": "retinue,"`. It now goes in as a connection startup
parameter and is verified once at boot, so a pooler that dropped it fails the boot instead of putting
every table in the wrong schema silently.

### `ai` is pinned to an exact version, and that is not caution

The monorepo's lockfile pinned `ai` at 7.0.66. The first standalone install resolved `^7.0.66` to
7.0.93 and four shadow-runner tests failed: the tool call was recorded and then finalised as
*"interrupted before it completed"*, because the SDK never executed the tool.

Bisected to one patch release, and reproduced against `streamText` directly with no retinue code
involved:

```
ai@7.0.69  start → start-step → tool-call → tool-result → finish-step → … → finish   (execute: 1)
ai@7.0.70  start → start-step → tool-call → finish-step → finish                     (execute: 0)
```

Every version from 7.0.70 through 7.0.93 behaves the second way. It is not the tool-input lifecycle
parts, not the `input` encoding — an object gets `toolCall.input.trim is not a function`, so a string
is still what it wants — and not the provider `specificationVersion`. Whether a *real* provider is
affected is unsettled; that needs a live model call.

Which is exactly why the version is pinned rather than ranged: the deployed image must run what the
platform was tested against, not whatever a rebuild resolves. `src/__tests__/dependencies.test.ts`
fails on a range, and fails on a bump past 7.0.69 — so raising it comes with a run of the
shadow-runner suite, which is the thing that actually catches the regression.

Note that agentkit itself declares `ai: ^7.0.66`, so this affects any consumer installing it fresh.
Its own 3414 tests pass on 7.0.70 — they do not exercise SDK-executed tool calls this way — so this
package's shadow runner is currently the only thing that catches it.


## The seam, and why the dependency is inverted

`src/services/` declares the interfaces ShareFlow's publishing, connector, media and database
services must satisfy. **ShareFlow implements them; this package never imports ShareFlow.**

That is not fastidiousness. The existing services are Next.js app internals: `getConnector()` reads
environment credentials at call time, imports use `@/…` aliases plain Node cannot resolve, and
`social_integgration/web` is not a workspace of this monorepo, so there is no import path to them at
all. Three further things about their shape decided the seam:

| What the existing service does | What the seam does instead | Why |
|---|---|---|
| `PlatformAdapter.publish(payload, authTokens)` takes decrypted platform credentials | refers to a destination by `SocialAccountId` | a token in a tool argument is one bug from a model prompt |
| `PublishResult.error.rawResponse` carries the provider's raw body | carries a stable code and one sentence | that body can hold tokens and third-party PII, and the error contract says a payload is *"shown to a model and a user"* |
| `PublishResult` reports failure as `{ success: false }` | **throws** `AgentPlatformError` | the delegating envelope stores the delegate's return value under the idempotency key, so a failure *returned* becomes that call's permanent answer |
| nothing in the publish path takes an idempotency key | requires one on every write | docs/07 asks for one; making it mandatory in the type turns a missing parameter into a compile error rather than a duplicate post |

## Capabilities

| Category | Tools | Effect |
|---|---|---|
| `posts` (#115) | `list_post_drafts`, `get_post_draft` | `read` |
| `posts` (#123) | `propose_post_angles`, `generate_content` | `read` — writes nothing |
| `posts` (REQ-015) | `repurpose_source` | `read` — writes nothing |
| `research` (#124) | `search_web`, `read_source`, `read_pdf` | `read` |
| `research` (#234) | `capture_website` | `internal-write` — stores a screenshot |
| `analytics` (#125) | `get_post_metrics`, `get_campaign_metrics`, `get_attribution` | `read` |
| | `create_post_draft`, `update_post_draft`, `duplicate_post_draft` | `internal-write` |
| `campaigns` (#116) | `list_campaigns`, `get_campaign`, `get_campaign_calendar` | `read` |
| | `create_campaign`, `update_campaign` | `internal-write` |
| `campaigns` (REQ-041) | `generate_campaign`, `suggest_campaign_ideas`, `evaluate_campaign` | `read` — writes nothing |
| `accounts` (#117) | `list_accounts`, `check_account_health`, `get_connection_setup` | `read` |
| `media` (#118) | `list_media`, `inspect_media`, `check_media_for_platforms` | `read` |
| `media` (REQ-019) | `enhance_media_prompt`, `plan_video_scenes`, `describe_image` | `read` — writes prompts and descriptions, generates nothing |
| `media` | `render_diagram` | `internal-write` — stores a drawing |
| | `attach_media_to_post`, `convert_media` | `internal-write` |
| | `check_media_storage` | `external-write` |
| `publishing` (#119) | `validate_publish`, `get_publish_status` | `read` |
| | `publish_post_now`, `schedule_post`, `retry_publish_target` | `external-write`, approval **always** |
| `engagement` (#120) | `list_comments` | `read` |
| | `dismiss_comment` | `internal-write` |
| | `reply_to_comment` | `external-write`, approval **always** |
| `leads` (#120) | `list_leads` | `read` |
| | `create_lead`, `update_lead` | `internal-write` |

Three things about the Posts tools generalise to every category that follows:

- **`.strict()` on every schema.** A model passing `status: "approved"` is refused, not silently
  ignored. Silent ignoring is the dangerous outcome — the model then reports success and the user
  believes the post was approved for publishing.
- **A list returns summaries; a read returns the body.** One caption is bounded by platform limits and
  is the thing the assistant reasons about. Twenty of them in one tool result is a context overflow
  waiting for a busy tenant.
- **`duplicate` is the documented remedy for `update`'s conflict**, not a fifth independent verb. A
  post can be *half*-published — its status is not `published`, but one destination already succeeded —
  and editing it would make the record disagree with what is publicly visible. `update` refuses with
  `details.remedy = "duplicate-then-edit"` so the assistant can offer the recovery instead of
  reporting a dead end.

Nothing in either category can publish: every capability delegates to `ContentService` and none is
classified `external-write`. That guarantee holds only while the publishing tools (#119) *are*
classified `external-write` — ShareFlow creates an assistant-authored post **approved**, deliberately,
because the human-in-the-loop confirmation on publish is the gate rather than a review queue.

The two generative campaign tools are a **pair, and the pair is deliberate**: `suggest_campaign_ideas`
proposes distinct angles for a person to write, and `generate_campaign` writes the posts. One tool doing
both would decide on the caller's behalf which of the two they came for. Neither saves anything — a
campaign plan is returned for the caller to persist with `create_post_draft` per post.

`suggest_campaign_ideas` also reports something the old `POST /campaign/suggest` did not. It runs the same
trend search (`"{theme} social media trends"`, five results), but `websearch.py` is fail-soft — *"network
errors, timeouts, or a missing package yield an empty result list instead of raising"* — so the old route's
trends block was simply absent when the search failed, and an idea invented from the model's own priors was
indistinguishable from one grounded in this morning's findings. `trendGrounded`, with `trendReason` when it
is false, carries that distinction to the caller instead of swallowing it. Its two safety rules are the old
runtime's, transcribed into the adapter: `format` clamped to text/image/video, and `channels` filtered to
the workspace's own ids *"so a drifting model can't suggest platforms the workspace doesn't have"* — the
filter case-insensitive, which the old one was not, because the ids arrive lower-cased and a model
answering "LinkedIn" would otherwise have a **correct** channel filtered away.

`evaluate_campaign` is the third, and it took a port method with it. The old
`evaluate_campaign(theme, goal, stats: str)` was told *"use only the numbers provided — never invent
metrics"* — worth nothing once the caller is a model, since the model supplies the numbers it is then told
to stick to. The old *web* route knew this and re-read everything server-side (*"RLS-scoped, so the summary
always reflects true data, never client-supplied numbers"*), so the tool takes **only a campaign id**;
`.strict()` refuses a `stats` field rather than ignoring one. The numbers come from
`AnalyticsService.campaignBreakdown`, which is new because "which post did best" is unanswerable from
`campaignMetrics` — that method aggregates, by design — and the prose lives on `ContentGenerator` rather
than on `AnalyticsService`, whose envelope has no `interpretation` field on purpose.

Two of its behaviours depart from the old route deliberately. A metric nobody collected renders as
`not measured`, never as `0` — the same defect `analytics.ts` exists to avoid, now on the prompt side. And
posts that never went out are **counted** instead of filtered away: dropped, the totals read as the whole
campaign, so an evaluation of three published posts out of eight looks like an evaluation of eight and
"what to change next time" misses the largest thing that went wrong. The window defaults to the campaign's
own `startsOn`/`endsOn`, not the seven-day metrics refresh window, or a campaign that ran in August would
come back unmeasured and be told to publish itself first.

### Nothing is missing

`generate_pdf` was the last one, and the inventory reads **37 implemented / 0 partial / 0 missing / 8
dropped / 6 retained**. Every capability the old runtime has is now replaced, signed off as dropped with
a name and a date, or retained where it already lives in `web/`.

What is left of the cutover is not code:

- **Shadow data.** Every gated workflow is capability-complete, so the parity report has moved from
  `incomplete` to `insufficient-sample` — *"1 runs, and the gate needs 200"*. The precedence was
  deliberate: capabilities before numbers, because the numbers are the thing that lies.
- **The `documents` gate is unsigned.** It arrived with REQ-041's artifact tools, *after* shadow data
  existed, so agreeing its threshold now would be the thing #128 AC-1 forbids. A blocking unsigned gate
  is the correct state.
- **The flag, per workspace.** `assistant_runtime_flags` has no rows, so every workspace resolves to
  `agno`. Seven web routes are repointed behind it, `POST /api/ai/campaign` among them — the post-count
  ceiling that blocked it is gone, because `generate_campaign` now batches angles instead of refusing
  past six.
- **`ai_backend` is removed.** The container, the service, the CI job and the 81-file tree are gone,
  along with the legacy chat that was its last caller. See "The removal" below for what that took and
  what it cost.

The parity report's named-capability assertion has no fourth name to move to, so it asserts the tally
instead: `(missing)` must not appear at all, and the counted line has to match the inventory.

### Chromium, and the SSRF hole that measuring found

Three capabilities need a headless browser, and `makepdf.py` says why they share one: *"Chromium is
already in this image for `read_url` and `capture`, so `page.pdf()` adds no dependency."* All three are
built: `capture_website`, `render_diagram` and `generate_pdf`.

The operational lesson came with them. `core/browser.py` was written after an outage: *"a headless
Chromium is by far the largest thing this service runs. It OOM-killed the FastAPI process in production
— the kernel log read `chrome-headless invoked oom-killer / Killed process (python)` — which severed the
assistant's SSE stream mid-run, so the user saw no response at all and nothing was logged anywhere."*
So `browser.ts` holds **one browser at a time, process-wide**, for the browser's whole lifetime rather
than just its launch, and `mem_limit` goes 1g → 2g to match `ai_backend`'s. The slot is a promise chain
rather than a polling loop, because the queue has to be fair — and it survives a render that throws,
since a rejected promise left in the chain would take the capability down for the life of the process.

**The old capture had an SSRF hole, and closing it took three defences rather than one.** `capture.py`
validated the URL and handed it to `page.goto`; Chromium follows redirects itself, so a public URL that
302s to `169.254.169.254` was screenshotted, and subresources were never checked at all. What each
defence actually covers was **measured against a real Chromium**, not assumed:

| Defence | Covers | Measured |
|---|---|---|
| `guardRequests` (route handler) | every **subresource** | two off-host requests aborted |
| `assertNoRedirect` (pre-flight, `redirect: manual`) | **server-side** redirects, before any request to the target | a local 302 refused, naming its target |
| the **landed** URL, re-checked before the screenshot | a meta refresh or a script navigation | `page.url()` reports where it landed |

The middle row exists because the first does not cover it: **Playwright's route handler is not called
for a navigation redirect** — a local page 302ing to another host was followed, the navigation
succeeded, and the guard saw only the first request. A comment claiming otherwise would have been wrong
in a file whose whole subject is refusal. The residual limit is stated in `browser.ts`: for a
client-side redirect the request to the final address *has been made* by the time it is caught; nothing
is returned or captured, so no content leaks, but a bare GET happened, and preventing that would mean
not running a browser.

`render_diagram` runs mermaid **in the page**, because *"mermaid is a browser library — the same one the
chat uses, so a diagram looks identical whether it is read in the conversation or attached to a post."*
`securityLevel: 'strict'` (diagram source is model-generated text, and mermaid can otherwise emit raw
HTML and clickable callbacks), `parse()` before `run()` with the error **returned** rather than thrown
(*"Playwright surfaced a bare `Page.evaluate: Object` … it apologised and re-sent the same broken
syntax"*), and a wait for `#wrap svg` without which the screenshot catches the raw `<pre>` source — a
picture of the code that looks enough like a result to ship.

`repairMermaidLabels` is the **third copy** of a function that also lives in the chat renderer and in
`makepdf.py`, and the Python one records why the second was needed: *"a diagram that displayed fine in
the conversation failed to export as an image — which is exactly what happened in production."* Four
diagram kinds were drawn against real mermaid, including that exact case.

Two sabotages went uncaught the first time and both are now pinned: bypassing the background allow-list
in the page builder (CSS injection into a page this package builds), and loosening `securityLevel` to
`'loose'`. A script in a template string is prose until something reads it.

### The PDF, and the diagram inside it

One HTML pipeline for four kinds of input, which is the old renderer's decision and its reason: *"a
second code path per input type would mean four sets of pagination and font bugs instead of one."*
Markdown is converted, text is wrapped in a `<pre>`, HTML passes through as the **body** so the print
setup always applies — *"a model-supplied `<html>` wrapper would otherwise silently drop the page
setup"* — and images become a page each.

The feature it exists for is a diagram **inside** the document. A ```mermaid fence becomes
`<pre class="mermaid">` and mermaid draws it to inline SVG in the print page, so *"the vector survives —
sharp at any zoom, text selectable, and far smaller than a PNG. Before this, a fence printed as literal
source and the only workaround was exporting a PNG and passing it as kind='media', one image per page
with the surrounding prose thrown away."* A real PDF with a real diagram between two paragraphs of real
prose was printed against Chromium: 70 KB, one page, and a broken fence came back as *"Diagram 1 in that
document has a syntax error"* — the index matters, because *"'the second diagram' is the difference
between a fixable error and a guess."*

`kind: "media"` inlines the images as `data:` URLs instead of passing signed URLs for the page to fetch.
The page then makes no request at all: no expiry, no question about whether the container can reach
storage, and nothing for the request guard to weigh.

A document with a diagram and no mermaid bundle is **refused, not degraded**: *"printing the diagram's
raw source into the document is the exact bug this path exists to fix, and a silently ugly PDF is worse
than a clear error — the bundle is baked into the image, so its absence is a deployment fault, not a
user one."*

Two sabotages passed before there were tests for them — dropping the wait for every diagram's SVG, and
letting a missing bundle degrade — and writing the second test surfaced a third mistake in the same
direction: `service(page, undefined)` hit a **default parameter**, so the no-bundle test had been
running *with* a bundle. Two mistakes pointing the same way is what makes the sabotage pass worth the
time.

### Vision, and a deprecated spelling that worked

`describe_image` runs a vision model over one image in one of three modes, and they are not three tones
of one answer: `alt_text` is an accessibility description with a hard rule and a 125-character ceiling,
`caption` is copy, `competitor` is analysis of a screenshot. All three prompts are transcribed.

It needed the model layer to grow. `StructuredGenerate` now takes an optional image, so the model, its
credentials and its pricing are still resolved in exactly one place — the reason `structuredGenerateFrom`
exists: *"two readings of the same variables agree by coincidence until one gains a default the other does
not."* An image turns the call into a `messages` array; without one the `prompt` string is passed through
exactly as before, because that is the path `scripts/shadow-turn.mjs` exercises against a real model.

**Two deliberate departures from the old runtime.** The brand voice reaches `caption` and `competitor`
but *not* `alt_text` — the old route passed it to all three, and a brand voice is how "a tabby cat on a
windowsill" becomes "the cosy moment your morning deserves", which alt text's own instruction forbids.
And the 125-character ceiling is *enforced*, not merely asked for: an `<img alt>` that runs to a paragraph
is read out in full by a screen reader before the page can continue.

`data` (base64) is gone from the input — a model cannot produce image bytes, and a field for them invites
a hallucinated payload — and so is a storage path, for the reason `read_pdf` records. Both remaining
sources are read through `ResearchService`, where the guarded fetch and the byte resolver already live,
rather than a second egress policy in the media tools. The media tools' own rule still holds: the result
carries the byte *count*, never the bytes.

The content-part spelling was settled by measurement. `{ type: "image", image: bytes }` **works** — and
logs *"The 'image' content part type is deprecated. Use a 'file' part with mediaType"*. That is the fourth
time on this project that a deprecated spelling worked well enough to ship silently, so the wiring uses
`{ type: "file", data: bytes, mediaType }`, and `promptOrMessages` is extracted precisely so a mutation
putting `prompt` back alongside `messages` fails a unit test rather than the first vision call in
production. All three modes were then run against a live model: alt text came back at 117 characters and
factual, the caption in the brand's voice, and the competitor analysis at 1,252 characters of real
argument.

The mime type is **sniffed from the bytes**, not taken from the URL or the `content-type`: an extension is
a claim by whoever wrote the link and a header is a claim by the server, while a wrong media type is a
decode error inside the provider that surfaces as the model failing.

### Reading a PDF, and the first new dependency

`read_pdf` is the third member of the read-a-source family and `read_source` genuinely cannot cover it:
Chromium renders a PDF in a plugin viewer whose contents `innerText` cannot see. All four caps are
transcribed — 25 MB, 30 pages, 12,000 characters, a 20-second fetch — and the byte cap is the one that is
not a courtesy: *"the whole PDF must be resident to parse it."*

It needed two things nothing else here did. `unpdf` for the extraction — the first dependency this
package has added — and a **byte-capable guarded fetch**, because the platform's HTTP client returns a
string and caps at 200 KB: right for a page a model reads as prose, and smaller than almost every real
PDF. The egress policy is still the platform's `validateHttpEgress`, imported rather than rewritten, for
the reason its own header gives: *"writing the checks again in the tool would be a second SSRF defence
that drifts from the first, and the one that drifts is the one nobody re-reads."* Redirects are refused
rather than followed — the old runtime followed them by hand and re-validated each hop, which is the same
defence spelled differently, but one rule beats two, and the target is reported so it can be asked for
explicitly.

**Its second source changed shape.** The old tool took a storage path and the web app signed it — *"the
workspace-prefix check there is what stops another tenant's object being read"*. Nothing in this runtime
can produce a path: the media tools return ids and never a path or a URL. So it takes an asset id, and
the adapter refuses anything that is not a uuid *before* it reaches a signer.

Resolving an id to bytes goes through the app: `mediaBytesFrom` reads the asset's path from
`generated_assets` under the caller's tenant scope, `POST /api/internal/media-url` signs it — checking
the workspace prefix again on its side — and the signed URL is read by the same guarded fetcher a linked
file goes through. Two checks rather than one because they answer different questions: the query proves
the *asset* belongs to this workspace, the endpoint proves the *path* does. The path never leaves that
function.

The hop exists because this container holds **no Supabase URL or key at all**, checked on the running
deployment. `store-media`'s own header gives the reason: *"giving it one would widen its blast radius
considerably for the sake of one upload. The web app already holds that key for the publish path."*
Absent `WEB_INTERNAL_URL`, both readers refuse the asset source by name and still read a linked file —
a narrower capability rather than a broken one.

Two things measuring the library turned up, both recorded where they matter: a browser-printed PDF's
`/Title` came back as `"about:blank"` (passed through — inventing a filter for the ways a title can be
junk is worse than showing what the document claims), and a single `Tj` operator saturates at **92
extracted characters** whatever its real length, which is why the test's PDF generator draws one line at
a time.

### Every gated workflow's capabilities are now built

`read_pdf` was the last unbuilt capability in `create-post` and `campaign-planning`, and with it every
workflow the parity gates measure is complete. The report says so by changing verdict: those workflows
now read `insufficient-sample` — *"1 runs, and the gate needs 200"* — instead of `incomplete`. The
precedence is deliberate and this is it working: capabilities are checked before the numbers, because the
numbers are the thing that lies, and what is missing now is **shadow data** rather than code.

The four capabilities still missing are attached to no gate at all, so no verdict is held back on them.
That is exactly how a report goes quiet about work nobody measures, so two tests hold it open: one counts
the ungated capabilities, and one asserts the report names all four out loud.

### The two media capabilities that make no media

`enhance_media_prompt` expands a short brief into one rich generation prompt; `plan_video_scenes` splits
a concept into N scene prompts that cut together as one film. Both are `read`, both return text, and
neither touches `MediaService` — the generation job they feed is ShareFlow's (`generation_jobs`), and
that is where the cost and the approval question live. They are `media` by category because that is what
they are *about*, and `ContentGenerator` by port because that is the model-backed one.

Three clauses are transcribed rather than paraphrased, because each one is load-bearing:

- The **per-kind branch**. Video gets motion over time and audio cues; a still gets composition, detail
  and mood. One instruction for both produces still-image language for a clip, and the video model then
  renders a photograph.
- *"Output ONLY the rewritten prompt — no preamble, no quotes, no options."* The caller stores the string
  as the generation prompt, so "Here are three options:" becomes part of the image brief.
- *"restate them explicitly in every scene prompt — the video model has no memory between scenes"*.
  Without it the scenes describe one world and the model renders three unrelated clips, which is the
  whole failure the planner exists to prevent.

`enhance_media_prompt` **no longer swallows a model failure**, which is the one behavioural change. The
old route returned the user's original prompt on any error (*"enhancement must never block generation"*)
— and its caller already keeps the raw prompt in a `try`/`catch` when the call fails. The guarantee lives
on the caller's side either way, and swallowing it twice only costs the ability to tell a degraded run
from a working one. `changed` is the other addition: a model handed an already-detailed brief returns it
nearly verbatim, and a UI showing "enhanced" over unchanged text is a small lie.

Implementing them also tripped a check worth naming: both had `workflows: []`, harmless while missing,
and `manifest.test.ts` refuses an `implemented` capability that **no gate measures** — *"it would be a
replaced capability that no gate measures, which is the position this whole REQ exists to make
visible"*. They now name `create-post` and `campaign-planning`, both of which really do generate media.

### Repurposing, and where its caller lives

`repurpose_source` turns one source into N distinct posts with the destinations cycling across them —
one model call, which is the old engine's shape and not an economy: a per-piece call sees one angle at a
time and cannot tell that two of them are the same takeaway reworded.

Two old behaviours are deliberately gone. The engine **degraded** on a parse failure to a single post
labelled `angle: "primary takeaway"` — written for a model call that returned free text and might not be
JSON, which a schema plus the platform's retry makes impossible, and one post where five were asked for
looks like a result rather than a failure. And `_split_hashtags` has no equivalent, for the reason
`generate_content` already records. One thing it gained: the source was truncated at 6,000 characters
**silently**, so posts drawn from the first fifth of a transcript read exactly like posts drawn from all
of it. `truncatedSource` says which.

`/repurpose` has **no Next.js route**. Its live caller is the `repurpose` tool in
`web/src/lib/mcp/server.ts` — a `retained` surface that outlives the cutover — and the same is true of
`describe_image`. All three of that file's AI tools (`repurpose`, `describe_image`, `generate`) now go
through the flag like every other repointed caller, which closes a hole worth naming: while they did
not, a workspace switched to agentkit still reached the **old** backend through MCP even though its
composer route no longer did. Its principal is `ctx.createdBy ?? ctx.workspaceId`, because an MCP call
has a workspace for certain and a person only sometimes.

### The agentic planner, and why it is not a sub-agent

`route:POST /campaign/agent` ran an autonomous Agno agent — `web_search` plus `capture_website` under a
15-call limit — and its own docstring notes the web layer *"falls back to POST /campaign if this fails"*.
The faithful port would be a sub-agent inside a tool, and that is worse here in three specific ways: it
runs a second tool budget the caller cannot see (this deployment's is `maxToolCalls: 18`), its searches
never appear in the transcript the user is watching, and it sits outside the approval gate the platform
applies per tool call.

This runtime **is** the agent that route was emulating. An assistant asked to plan a campaign with
research calls `search_web` and then `generate_campaign`, visibly and under one budget. What a
form-shaped caller cannot do is hold a conversation, so `generate_campaign` takes `researchFirst`: one
deterministic search of the theme (the theme alone — the old per-post researcher's comment says why: *"a
compact query … not the long structured expansion prompt"*), its findings handed to the planner with the
anti-fabrication clause, and `trendGrounded` reporting whether it happened. Off by default, as the old
runtime also kept its grounded path on a separate endpoint.

The screenshots that route could take are **not** covered here. They are their own capability
(`route:POST /capture`) and still missing.

### PDF headings, from the document's own type sizes — #321

`read_pdf` returned flat prose, so a model reasoned over a wall of text and could not reproduce a
document's structure in a post.

**The issue's premise had expired.** It was written against `pypdf` — *"extracts text but has no
layout model, so true markdown is not directly available"* — and offered heuristics (*"cheap,
unreliable on real decks"*), `pymupdf4llm` (AGPL, and Python), or an ML model (*"far too heavy"*).
There is no Python in this stack. `read_pdf` uses **`unpdf`**, whose `extractTextItems` returns a
`height` per item: the rendered font size. The signal the issue assumed was missing was already there,
in a dependency already installed and already used by that exact tool.

A heading is **larger than the body text**, and that is the whole rule. Bold-vs-regular needs
font-name parsing that differs per producer, position needs a column model, and numbering is a
convention. Size is the one signal that is universal and directly measured. Levels come from **rank
among the sizes present**, so an 18pt document and a 48pt one both start at `#` — what a reader
recovers is a hierarchy, not a typography.

Three things it refuses to do. It does not attempt **tables** — that is a position problem, and a
markdown table with the wrong columns is worse than the prose there now because it looks
authoritative. It does not replace the flat text unless the structured pass kept **at least 90% of
its length**, because a pass that found two headings while dropping a third of the prose is a worse
read that looks like a better one. And it reports `headingsFound` rather than leaving it to be
inferred from the absence of `#`: a document with no headings, a scanned page, and a structure pass
that failed all produce identical flat text.

**A real PDF found what the unit tests could not.** pdf.js emits one item per visual line with
`hasEOL` on the one that ends it and **no trailing space** — the space *is* the break. Joining them
directly produced `we arebuilding`. A synthetic fixture has no wrapped lines, so it would have
shipped.

### `repurpose_to_formats` — a set, not several posts, #458

`repurpose` returns N captions. That is "several posts", not REQ-015 AC-2's *"multi-format set"* —
every piece it could produce was a post body, so the acceptance had no way to be expressed at all.

`repurpose_to_formats` returns a **tagged union**, and the three arms have three destinations:

| arm | goes to | publishable |
|---|---|---|
| `post` | `create_post_draft` | yes |
| `thread` | `create_thread_draft` (#456) | yes |
| `script` | `create_artifact` | **no** — it is a document |

A union rather than one widened type, for the reason `generate_alternatives` is separate from
`generate_content` (#266): a caller that read `caption` off a script would get an empty string and
publish it, where a union makes that a compile error.

**One model call**, for a sharper version of the reason `repurpose` gives for its own: a per-format
call could not tell that the thread and the reel script are the same argument twice.

**The counts are an explicit manifest in the prompt.** A model told to write "a few of each" writes
posts, because posts are what it has seen most of.

**Each arm is narrowed after the fact, and an item that does not carry what its format needs is
dropped.** A thread with one part, a script with no beats, a post with no caption — none of those is a
shorter version of itself. The tool reports `shortfall` per format rather than refusing, because an
assistant saying "here is your thread and your reel" over a set containing neither is the failure.

**The script's markdown is rendered by the adapter, not asked of the model.** A model asked for a
document *and* a structure will eventually return one that does not match the other, and the document
is the half a person reads.

What a script contains — and why each field is in it — is `docs/specs/458-script-shape.md`, written
before the prompt that asks for it.

### Threads — `create_thread_draft`, #456

REQ-015 AC-2 asked for multi-format sets and could not be built: `posts.raw_content` is one text
column, `posts.format` admitted `post` and `story`, and no connector published a multi-part post.

**Two tables, and the split is the design.** `post_parts` is what somebody *wrote*; `scheduled_item_parts`
is what actually *published*, per destination. They cannot be one table — a thread published to X and
to Threads is two sets of platform ids for the same authored parts — and the second is what makes a
partial publish **recoverable** rather than merely reported.

**`PARTIAL` is a status because the other two are lies.** A thread of five whose third part fails
leaves parts one and two *public*. `SUCCESS` tells every reader the post went out; `FAILED` says
nothing reached the platform, and a person acting on that retries — posting parts one and two to an
audience that has already read them. It is terminal in the worker and refused by `reschedule` for
exactly that reason.

**A connector without `publishThread` is a refusal, not a fallback.** `publishViolationFor` returns a
terminal violation, because the alternative is falling through to `publish` and sending one post
containing every part concatenated, to a real audience, reported as success — and nothing downstream
could tell that apart from a thread.

Hashtags are validated **across the thread** while length is validated **per part**. ShareFlow's
shipped `x` rule requires one hashtag and `instagram` requires five; per part, a five-part X thread
would need five and an Instagram one twenty-five. A hashtag rule is about the post a reader receives,
and a reader receives a thread as one thing. The real `platform_rules` rows are what made that
obvious — the first implementation validated per part and the DB-backed test refused a perfectly
ordinary thread.

`X` cannot attach media to a thread part, because `publish` cannot attach media either — X needs a
separate upload to obtain `media_ids` and this connector has never implemented it. Threads can, so it
does. Stated rather than silently dropped.

### `research_hashtags` — REQ-016 AC-2, #287

The tailoring half of REQ-016 shipped with #287. This is the clause that was left: *"hashtags
researched (search-backed), relevance-ranked, not invented"*.

**"Relevance" had to be given a meaning before it could be ranked.** The one chosen is *reach for
people who care*, not volume — a tag with ten million posts buries a small brand, so the prompt
prefers specific over generic. That is a judgement, and it is in the prompt where it can be argued
with rather than implied by a score nobody can see.

**"Not invented" is a property of the prompt, and it has two halves.** With findings, every tag must
be traceable to one and the rationale must say which. Without them, the instruction *changes* rather
than the findings block merely being absent — a model handed nothing and told to stay grounded in it
produces a confident list and a rationale that invents a source. So an ungrounded run is told it is
ungrounded, and says what the tag is *for* instead of where it came from.

`trendGrounded` is then reported rather than implied, the same contract `generate_campaign` and
`suggest_campaign_ideas` use. That is REQ-016 AC-5's graceful fallback: graceful means *saying so*,
because a list from the model alone looks exactly like one from a live search and the difference is
the whole feature. It is **absent** when no search was asked for — `false` there would read as a
failed search rather than one nobody requested.

`research` defaults to **on**, unlike `generate_campaign`'s `researchFirst`. The defaults differ
because the acceptances do: a campaign is worth planning without a live search, and a hashtag list
that was not researched is the thing AC-2 exists to replace.

Normalisation is in the adapter, not the schema: a model writing `spring lot` has done the useful part
and failed the punctuation, and refusing the batch over a missing `#` would lose the research.
Deduplication is case-folded, because `#Coffee` and `#coffee` are one hashtag to every platform.

### `generate_alternatives` — the quality loop, REQ-014, #266

`generate_content` returns one version per **destination**. `generate_alternatives` returns N versions
for **one**. They look similar, mean opposite things, and the confusion had already cost the product a
feature: `/api/ai/generate` accepted `variants: 1..5` for the composer's picker and the adapter
**refused** anything above 1, so a shipped control failed every time somebody ticked it.

The distinction is #115's. The store holds one caption plus `target_platforms` — so per-destination
versions are what gets *saved*, and alternatives are what gets *chosen between*. Folding a count into
`generate_content` would fill the picker with captions for platforms the user did not choose.

**The loop, at most six model calls:**

| | |
|---|---|
| write | N candidates in **one** call — a model writing five in one breath can see that two are the same idea; five separate calls cannot |
| score | all of them in **one** call against hook / on-brand / CTA / platform-fit — a rubric applied one at a time has nothing to compare against, and scores drift between calls |
| re-draft | **once**, only if the best is below `QUALITY_FLOOR`, told the first round's critiques |
| refine | the winner, told its own weakest dimension and the critique naming it |
| re-score | the refinement, and keep it **only if it scored higher** |

That last step is the one worth arguing for. A model asked to improve something always returns
something different; returning it as "the refined one" without re-scoring is how a quality loop makes
captions worse while reporting that it improved them, and nothing downstream could tell.

Three smaller decisions:

- **A candidate the rubric skipped is dropped, not given a default.** A zero ranks it last and a five
  ranks it in the middle — both are inventions the picker would present as the rubric's opinion.
- **`critique` travels with the score.** A bare 6.8 says which to pick and nothing about why the
  others lost.
- **It does not validate.** `validate_content` is the authority on whether a caption is publishable. A
  draft scoring 3/10 is a bad caption, not an invalid one, and the person choosing is entitled to see
  it.

The bounds live in the implementation rather than in the caller's hands (AC-5) — an unbounded quality
loop is how one click becomes a bill.

### The voice corpus reaches generation — REQ-013, #265

`generate_content` and `generate_campaign` write every caption in the product, and until #265 neither
had ever seen the workspace's own posts.

Everything else worked. `posts.is_voice_exemplar`, the toggle on the post detail page, the coverage
selector from spike #279, `BrandService.listVoiceExamples`, and `shareflow.examples` — a context
provider putting the examples in front of the model on every **assistant turn**. That last word is the
gap: the generation tools are invoked directly by the compose screen and the campaign route, with no
prompt assembly and therefore no context providers.

So `GeneratorConfig` gained `voiceExamples`, wired at the composition root from
`brand.listVoiceExamples` — three, not the provider's four, because the caption prompt already carries
the brand, the platform bounds, the angle, the funnel stage and the sibling hooks.

Two details decide whether it helps:

- **The instruction names voice, not content.** *"Match their VOICE — sentence length, register,
  punctuation, how they open and close — and not their subject matter."* Without it the strongest
  signal in the prompt is three posts about coffee, and the model writes a fourth.
- **Each example is labelled by source.** A post somebody ticked and a post the metrics ranked are
  different claims; presented identically the model imitates a viral post as though the workspace had
  endorsed its voice.

An empty corpus renders nothing at all — no header, no "no examples available" — which is REQ-013
AC-5's cold start arriving by another route.

**A test now refuses the next instance of this.** `services.test.ts` already asserted that every
optional capability on `ShareFlowAdapterConfig` is wired or named; `GeneratorConfig`'s were one level
below that scan, which is exactly where `voiceExamples` was sitting, declared and supplied by nobody.
Deleting the wire left all 255 tests green. It does not any more.

### The strategy layer — REQ-018, #291

`generate_campaign` takes a `strategy` and returns a `funnelStage` per post, which is what makes a
campaign a *plan* rather than a batch of posts on one theme.

Everything else already existed and none of it was connected. `campaigns.persona`, `primary_goal` and
`template_key` were written by the create form; `campaign_templates` holds three playbooks whose
`post_plan` names a stage, an angle and a CTA per slot; `posts.funnel_stage` has a CHECK constraint and
three writers in the web app. The planner had no parameter for any of it, so both callers **refused** a
request carrying a strategy rather than returning a plan with every stage null — which meant choosing a
playbook was the one thing that guaranteed the campaign would not be created.

The three inputs arrive together and travel apart, because they do different jobs:

| input | where it goes | why |
|---|---|---|
| `audience` | the planning brief | frames every post — the same call `goal` makes |
| `primaryGoal` | the planning brief | ditto, and it is *not* `goal`: one is free text, the other a funnel outcome |
| `funnelPlan` | per slot, to **both** model calls | shapes the sequence |

`proposeAngles` is shown the whole ordered plan, because that is where the sequence is decided — an
angle for position 3 should not repeat the argument position 2 is making, and only the planner can see
both. `generate` is shown one slot: an angle is *what a post argues* and a stage is *what it asks for*,
so a caption told the angle and not the stage writes the wrong ending to the right argument. Stages
render as behaviour rather than as a word — "conversion" is a label a model nods at, *"ask for the
decision now"* is an instruction it follows.

**A plan is a shape, not a length.** A playbook has six steps because that is how a product launch goes;
`postCountFor(startsOn, endsOn, cadence)` has twelve because the user picked three weeks of daily.
`expandFunnelPlan` samples the plan evenly with **both ends pinned** — `round(i * (len-1) / (n-1))` — so
the first post is always the plan's first step and the last is always its last, at every length. The
obvious `floor(i * len / n)` drops the final step whenever `n < len`, which turns a launch plan whose
only conversion post is last into a campaign that never asks for anything.

**Four stages, not three.** The requirement names awareness/consideration/conversion;
`posts_funnel_stage_check` admits `retention` too. The column is the authority — and a stage that passed
validation and failed on insert would lose a generated campaign after the model calls were paid for.

**`funnelStage` is absent, not null, for an unplanned campaign**, and that survives every hop out to the
insert. A field that is always present and always empty is the shape that let this whole layer look
finished while doing nothing.

Two more from Campaigns:

- **`plannedPostCount` is returned, never computed here.** The store caps a fan-out at 31 posts, so a
  daily campaign over a year produces 31 — and an assistant that inferred the count from the dates
  would report 365. The field exists so the cap is visible; recomputing it locally would duplicate the
  logic it exists to expose.
From the parity gates (#128) — **which do not close that issue**:

- **Every gate is `proposed`, and the evaluator refuses to pass one that is not `agreed`.** AC-1's real
  content is *"not decided after seeing the results"*, and a threshold chosen once the numbers are in is a
  rationalisation. I can propose — I have seen no data — and I cannot agree, because an acceptable quality
  bar is a product decision. Refusing to compute a pass against an unsigned gate makes that a precondition
  rather than a hope.
- **The analytics and engagement-read gates declare themselves unmeasurable.** Shadow mode compares
  *writes*, and those workflows make none — a write-based gate would pass vacuously on every run, which is
  a green tick nobody earned.
- **`canRemoveOldRuntime` currently returns `allowed: false`, for six separate reasons.** The removal is 71
  files in `social_integgration` — a different repository — and docs/README lists removing Agno before
  parity as an explicit non-goal. What ships here is the machinery that refuses, not the removal.
- **AC-3's decision-maker is unnamed and AC-6's data question is unanswered**, deliberately. A blank gets
  filled; a plausible guess gets followed.

From rollout (#127):

- **There was no flag mechanism to reuse.** ShareFlow's existing flags are process-wide env vars, and one is
  explicitly non-production — both disqualified by AC-1 itself, since **an env var requires a deploy to
  change**. `bot_settings.enabled` is the right shape and the wrong subject, so it is the precedent rather
  than the mechanism.
- **A flag is resolved once per run and pinned.** Re-reading it per step means a mid-run rollback switches
  runtimes halfway through an answer — which *is* the "silently dropped mid-answer" AC-3 forbids.
- **So the time-to-effect an operator needs is not the cache bound.** It is `staleness + the longest
  in-flight run`, and both are in the rollback report so nobody has to reason it out during an incident.
- **Rollback has two modes and the urgent one is loud.** `complete-in-flight` by default;
  `abandon-in-flight` names every stopped run, and each user is told nothing was published and asking
  again is safe. A stopped run that looks slow is one the user retries, and the retry is what duplicates.
- **The default, and the store-unavailable answer, are both the old runtime.** Failing open to the new one
  would migrate a customer during an outage.

From shadow mode (#126):

- **Suppression is in the envelope, so no capability can forget it.** A capability invented in the test
  file, which has never heard of shadow mode, is suppressed anyway — the property a per-tool flag could
  never have.
- **Suppression runs *before* the approval gate.** A shadow run must not ask a human to approve something
  that will not happen; doing so teaches people that approving is meaningless, which is the one thing an
  approval gate cannot survive. Whether approval *would* have been required is recorded instead.
- **A shadow run with nowhere to record its suppressions is refused.** The absent flag defaults to "real
  run" — unavoidable, since defaulting the other way would make every existing context a shadow one — so
  the dangerous direction is closed here instead.
- **Shadow mode measures everything up to the external write and nothing after it.** All three return
  shapes change the agent's trajectory; only a truthful one avoids teaching it to report a publish that
  never happened.
- **The diff reports kinds of difference, not a verdict** — *"some differences are improvements"*. It does
  surface one number directly: whether the new runtime would have published more times than the old one.

From analytics (#125):

- **The envelope has no room for an interpretation.** AC-2 asks for facts and interpretations to be
  separated; the strongest form is that one of them cannot be in there. Who would fill an
  `interpretation` field? The model, after reading the facts — so a tool emitting one would do exactly
  what AC-1 forbids. Labelling a hypothesis and ending with a measurable experiment are the *reply's*
  properties, so #125 extends the `analytics-reporting` skill with both rather than leaving them unowned.
- **A scoped aggregate says it is partial — and does not say how much.** The obvious way to admit it, an
  excluded count, **is itself the leak**: it reveals the volume of data the caller may not see. That is
  the classic aggregate attack arrived at by trying to be helpful. So: a boolean, and only a boolean.
- **An unmeasured metric is not a zero.** `computeAnalyticsKpis` returns 0 for engagement rate when
  impressions are zero — right for a dashboard tile, wrong as a fact, because an assistant handed 0 will
  report "engagement was 0%". Third instance of the same shape after #120's suppressed lead and #124's
  unavailable search, and the same fix: a discriminated union, so the absent case has no success shape to
  hide in.
- **Traceable means an auditor can find the rows, not that the rows are inlined.** A fact carries its
  record type and count always, and the ids only when the set is small enough to be worth reading.

From research (#124):

- **An unavailable search is not an empty result.** The existing search is deliberately fail-soft — an
  error yields `[]` — which is right for a background enrichment step and wrong for an agent, because
  "found nothing" invites answering from memory while "could not look" has to stop it. `SearchOutcome`
  separates `searched` from `results`, and AC-6 is unachievable without that.
- **AC-3 is delivered as delimited data, not as directive-stripping.** Pattern-matching directives cannot
  be complete, mangles legitimate content (a page *about* prompt injection), and creates the confidence
  that causes the breach. What is defensible: content is a tool result rather than an instruction, it is
  fenced, and **the fence is removed from the content** so a page cannot forge its way out of its own
  block — the same class of bug as #105's `runJobId` collision. Plus #122's always-on rule.
- **A citation opens what was read, not what was requested.** `safefetch.py` exists because the two
  differ: *"a perfectly public URL can 302 to `http://169.254.169.254/…`"*. The port requires every
  redirect hop to be re-validated, since `validateEndpoint` checks one URL.
- **The egress policy is reused, not reimplemented.** Two SSRF guards is one guard and one liability.

From content generation (#123) — the one capability with nothing to wrap:

- **Per-channel variants are per-channel *drafts*.** #115 found the store holds one caption plus
  `target_platforms`, with nowhere for an authored variant, and left the question here. The answer needs
  no schema change: generation returns one variant per channel and saves nothing; the assistant saves one
  draft per channel. Each then has its own status, approval and publish target — which is what
  `socialPostTargets` already models.
- **AC-4 asked for something a model cannot promise.** "A forbidden claim is never produced" is not
  guaranteeable; "never *returned*" is. Generate, check, repair, and if it survives the bound, refuse and
  name the phrase.
- **The repair bound is 2, and the dangerous case argues for a low bound rather than a high one.** On a
  forbidden claim a model asked repeatedly produces near-variants of the same claim — repairing that many
  times is a search for a phrasing that slips past the checker, not persistence.
- **The model call is still a port.** R3 confines the AI SDK to `models/` and R7 keeps I/O out of
  `tools/`, so what is built here is the harness — validation, repair, the bound — not the inference.

From the migrated skills (#122):

- **No limit value survives in a skill body.** Character ceilings, hashtag counts and per-platform media
  rules are `platform_rules` — workspace-overridable — so restating them in prose creates a second source
  that can disagree with the tenant's configuration, and the model would work from the wrong one with no
  error anywhere. The guidance became "ask the tool", which the original already said was the reliable
  path.
- **Three things the originals claimed are no longer true**, and were changed rather than shipped:
  confirmation is *not* automatic (a gated call returns `approval_required`); "a published post cannot be
  edited" is too narrow (any destination succeeding is enough); and `captionLength` arithmetic was
  replaced by a boolean in #115 precisely because a model is bad at that comparison.
- **No skill names a tool that does not exist.** A loaded skill instructing a call into nothing is worse
  than an absent skill: the model follows it and fails. The two artifact skills are migrated at
  `status: "draft"` — present and versioned, kept out of discovery until REQ-028 lands.
- **The always-on rule a skill asked for.** `research-and-citation` says the untrusted-content rule
  "must never depend on this skill being loaded". It now does not: it is a `base-policy` section, and the
  skill keeps a pointer rather than a copy.

From the context providers (#121):

- **Five of the eight read the same seam the tools read.** Campaign, accounts, current post, examples and
  performance all come from ports #115–#120 already declared. A context provider with its own query is
  how *"the context said the account was healthy and the tool then refused"* happens.
- **The claim policy is `base-policy`, which the assembler never prunes.** In `user-context` it would be
  prunable, so an oversized brand profile could push the constraint out of the prompt — and the model
  would then produce the forbidden claim with nothing having gone wrong anywhere. Failing loudly is the
  correct outcome if it does not fit.
- **`findForbiddenClaims` is a floor, not a guarantee.** It matches literal phrasings, so the prompt-side
  instruction is not redundant — that is the half that handles rewording. It also over-matches in the
  recoverable direction, on purpose.
- **Performance insights are off by default.** `ExecutionContext` carries identity, not intent, so a
  provider cannot know whether *this* request needs analytics — and adding a hint field would open the
  channel its own docstring forbids. The per-request form is the assistant asking, which is #125.
- **`shareflow.products` was removed.** docs/07 lists products and offers; nothing in ShareFlow stores
  them, so the id sat in the manifest with no provider behind it — exactly the silent gap #114's own
  comment warned about. A test now asserts every id has a provider.

From Engagement and Leads:

- **A reply is keyed on the comment, not the call** — the same reasoning as publishing. ShareFlow already
  refuses a second reply on `reply_status` of `sent`, so the comment is the natural unit; a call-derived
  key would let a second distinct call send a second public reply.
- **A suppressed lead has no success shape to be reported in.** `createLead` returns a discriminated
  union — `created` | `existing` | `suppressed`. Suppression is enforced inside the insert path, so the
  risk is not a tool bypassing it but a tool **misreporting** it: telling the user a lead was captured
  for someone who opted out.
- **`approve_comment` and `suppress_lead` are deliberately absent.** The first sends the reply already
  drafted in `inbox_comments.reply`, and `needs_review` exists so a person looks first — an assistant
  that could approve its own draft would route around the review rather than pass through it. The second
  retires up to 200 existing lead rows.
- **Assignment does not exist in the substrate.** `inbox_comments` has no assignee column and there is no
  assign function; what exists is triage, so `dismiss_comment` is the no-approval internal change. A tool
  that claimed to assign and did nothing would be worse than an absent one.

From Publishing — the zero-tolerance category:

- **The idempotency key is per draft + destination, and not derived from the call.** `create_post_draft`
  threads the *envelope's* key, because two create calls are two drafts. Publishing is the opposite: a
  second, distinct call to publish the same draft to the same account must be deduplicated, and a
  call-derived key would republish. `socialPostTargets` already holds one row per (post, platform), and
  ShareFlow's documented way to publish the same content again is to duplicate the draft.
- **Validation runs before the approval gate**, through the envelope's `preflight`. A human asked to
  approve a publish that then fails learns that their approval does not mean much — a worse outcome
  than the failed publish.
- **The outcome is derived, and `unconfirmed` outranks `published`.** `AWAITING_PLATFORM` is the normal
  path for video, not an edge case: the platform took the upload and confirmed nothing. Reporting
  success while a destination is mid-transcode would be claiming an outcome nobody confirmed.

> **Known gap, not fixed here.** `allow-once` issues no grant, `ApprovalGate` consults standing grants
> only, and nothing reads `PendingApproval.normalizedInput` back to execute an approved call. So the
> *refusal* direction holds — nothing publishes unapproved — while an approved-once publish cannot
> proceed. Tracked separately; see #119.

From Media:

- **No limit is written down in the provider.** Not a byte count, a file count, a MIME list or a
  platform rule. `platform_rules` is workspace-overridable data, so a constant copied here would be
  silently wrong for any workspace that overrode it — and wrong in the direction that refuses
  legitimate media. A test asserts the absence against the shipped source, because a stub cannot
  demonstrate that a constant is missing.
- **Convert takes a format, not a platform.** Deciding which format a destination accepts *is* the
  platform-rules knowledge this package must not hold. The conversion service's supported set is not
  duplicated either: an unrecognised format reaches the service, which is the only thing that knows.
- **`check_media_storage` is an `external-write`, so it is approval-gated.** It PUTs a diagnostic
  object, and `check_account_health` is `read` only because it GETs. Classified honestly rather than
  relabelled to dodge the prompt — the cost is real, and it is raised as a taxonomy question rather
  than hidden.

From Accounts:

- **Nothing changes a connection, in either direction.** Connecting requires the user's consent at the
  platform; the assistant's job is to say where to go and what is needed. `connect_test_account` exists
  in `twenty-social` and is *deliberately* not exposed: it creates an active destination with a fake
  token that accepts posts without contacting any platform, so an assistant holding it has a way to
  manufacture a destination that silently swallows posts and then report success.
- **A credential cannot appear in a result because there is no field for one.** The account view carries
  stable codes, ids and a credential *expiry* timestamp — `healthDetail` is not propagated, since free
  prose from an adapter is where a provider error message, and therefore a token, ends up. A guard
  scans what does go out and **fails** rather than scrubbing, because a silent scrub hides the adapter
  bug that produced it.
- **The remediation is derived from the health in one place.** `expired`/`revoked` mean reconnect;
  `not-configured` means an admin registers the OAuth app, and no amount of reconnecting will help. An
  assistant that conflated them would send the user round a loop that cannot terminate.

- **No paid operations, and the catalog is pinned by a test.** ShareFlow has no ad account, spend or
  boost anywhere, so there is nothing to withhold. What is worth recording is what would have to be
  true before there were: an ad spend moves money out of the tenant's account, so it is an
  `external-write` behind the approval gate, not a campaign edit with a budget field.

## Layout

| Directory | Contains |
|---|---|
| `services/` | the seam: `ConnectorService`, `ContentService`, `MediaService`, `PublishingService` |
| `tools/factory.ts` | what a capability declares and receives — its own module, because the barrel re-exports every factory and the helper is a runtime value |
| `tools/` | the `ToolProvider` and the closed category vocabulary from docs/07 |
| `context/` | the eight providers from docs/07, the shared section builder, and the forbidden-claim checker |
| `skills/` | the seven migrated skill bodies, validated at import time by the platform's own validator |
| `manifests/` | the Social Assistant — `id` neutral, branding in the display name |
| `shadow/` | shadow-run recording, the per-workflow parity diff, and the runner that produces one |
| `rollout/` | per-workspace runtime flags, rollback, and the written procedure |
| `parity/` | the parity gates, their evaluator, the cutover runbook and the removal gate |
| `adapters/` | three of the ten services, over ShareFlow's own tables and the host's model (#190) |

Nothing under `tools/` performs I/O; a ShareFlow tool is the envelope from `defineDelegatingTool` over
a service method, and R7 fails the build on an attempt.

## Wiring it up

**All ten services now have adapters in this package.** `content`, `brand`, `publishing`, `connectors`,
`engagement`, `leads`, `media` and `analytics` read ShareFlow's own tables through a `SqlExecutor`;
`generator` fronts the host's model and `research` the platform's guarded web toolkit, because neither has a
table behind it.

```ts
import { createShareFlowServices, backedContextProviders } from "@retinue/shareflow";

const services = createShareFlowServices({ sql, transaction, setup, generate });
const providers = backedContextProviders(services);
```

`setup` is required for the same reason `transaction` is — see below. `backedContextProviders` now includes
the accounts provider, which it could not while `ConnectorService` had no adapter: it reads `connectors` on
every turn, and a throwing provider takes the turn down.

`transaction` is required rather than optional, and only because of `publishing`: `scheduled_items` has **no
unique constraint** on `(post_id, social_account_id)`, so publish-once rests on `SELECT … FOR UPDATE` on the
draft held across two statements on one connection — which `pool.query` cannot provide, since it takes a
different connection per call. A deployment that cannot supply one should not be publishing.

`createShareFlowServices` returned a **narrower type** while some were ports, and that argument is now
discharged rather than forgotten. It was a measured decision, not caution: `backend/src/context/assembler.ts:35`
runs context providers in a bare `for` loop with no `try`, and `createAccountsContextProvider` calls
`services.connectors.listAccounts` on every turn — so a declare-and-throw object plus the standard base
providers would have been a deployment where every turn died before the model was called.

What has not changed is the rule that got it here. **Where a method needs something outside a ShareFlow
table, it is a dependency, and where a deployment cannot supply one the method refuses rather than
approximating.** Six do: `checkHealth`, `reply`, `convert`, `checkStorage`, and `search`/`readSource` through
their required providers. That is not defeatism — each refusal is a case where returning *something* would be
a false claim an assistant then relays to a user.


## Nine defects, measured against a real model and a real browser

Everything in this section was found the same way: by running the **real worker** — the platform's own
`bin.js worker`, `RETINUE_APP_MODULE` pointed at `dist/app/module.js` — against a local Postgres carrying
both the `retinue` schema and this application's 45 Supabase migrations, with a seeded workspace and a real
Gemini key, while recording every HTTP exchange with the provider.

Every defect below passed the whole suite, deployed green, and was invisible from the outside. Three of them
were *contradicted by the prompt the deployment was sending*.

### 1. Every tool was preloaded, and that is what made the assistant answer nothing

`createBuildTools` asked the registry for a catalogue with `categories: SHAREFLOW_TOOL_CATEGORIES` — every
category the application has. The registry preloads a tool when `preloadNames.has(name) ||
preloadCategories.has(category)`, so the second clause matched everything and all 58 tools were preloaded,
with `discoverable` empty. The comment directly above it described the opposite:

> The smallest set that lets the assistant start work without a discovery round trip. Every preloaded schema
> sits in context for the whole run, which is the cost the lazy catalogue exists to avoid.

What that cost, from the recorded requests:

| | declarations | declaration bytes | prompt tokens | empty candidates |
|---|---|---|---|---|
| every category | 61 | 45,467 | 12,162 | **7 of 29 calls** |
| none (the fix) | 21 | ~9,000 | ~5,500 median | **0 of 95 calls** |

An **empty candidate** is the provider answering `finishReason: "STOP"` with a candidate that has no `parts`
at all and `candidatesTokenCount` absent:

```
data: {"candidates":[{"content":{"role":"model"},"finishReason":"STOP","index":0}],
       "usageMetadata":{"promptTokenCount":12162,"totalTokenCount":12162}}
```

The platform's `finish` handler reads `chunk.totalUsage` and never inspects `finishReason`, so that becomes
`run.completed` with zero parts. From the app: send a message, watch nothing appear, and find nothing wrong
to retry. It reproduced locally on the same three prompts that failed in production, at the same 12,162
prompt tokens, which is what made it a bug about the tool list rather than about the questions.

It also made the two-tier catalogue dead weight — `find_tools` searching an empty set while the prompt spent
a whole clause explaining discovery. With the fix, `"Do I have any leads?"` runs `find_tools` →
`learn_tools` → `execute_tool(list_leads)` and answers from the database.

### 2. `learn_tools` answered in Zod, and the run failed before the model was called

The registry answers `learn_tools` with the descriptors themselves, and every ShareFlow descriptor carries a
**Zod** schema. So the tool result handed back to the model contained live Zod instances — objects with
methods — and the AI SDK validates its prompt before sending one:

```
Invalid prompt: The messages do not match the ModelMessage[] schema.
```

`status: failed`, no model call, no answer. It happened on exactly the turns where the model did the right
thing: discover, read the schema, then die. `withLearnableSchemas` converts them (`ai`'s `zodSchema`), and
wraps the **registry** rather than the tool object — because once `approvals` is wired the engine reaches
`registry.execute` directly and a conversion inside `ModelTurnTool.execute` would have silently stopped
running.

### 3. The prompt promised context the request did not carry

`createDefaultEngine`'s `systemPrompt` is optional; absent, it sends `manifest.instructions` alone. That is
what the worker did — while those instructions said:

> Your context includes the workspace's brand profile and recent post behaviour — honour that brand voice
> automatically, without asking the user to repeat it.

The recorded request carried a 5,184-character system instruction and no context block: no brand voice, no
connected accounts, no audience, no examples. Eight context providers, unit-tested, listed in the manifest,
exported as `allContextProviders` — and called by nothing. `src/app/context-for-turn.ts` wires them, and
three decisions in it are each a defect somewhere first: a declared-but-unwired provider id **throws**, a
provider that fails loses its section rather than the turn (`gatherSections` has no `try`, and four of six
providers threw on a database missing the app's tables while the turn still answered), and untrusted sections
go through the platform's own `renderContextBlock` with a fresh nonce.

Skills were the same story twice over. `load_skill` is advertised only when `ToolRegistryConfig.skills` is
wired, and it was not, so the meta-tool was absent from every catalogue — while the prompt said *"ALWAYS load
the `mermaid-diagrams` skill before turning a diagram into a file"*. And `manifest.skillPolicy.assigned` was
`[]`, which `createSkillResolver` uses to gate **both** listing and loading, so even a wired resolver would
have found nothing. Seven active skills, ~20,000 characters of reviewed instructions, unreachable; meanwhile
`createShareFlowApp` returned an `assignedSkills` field holding exactly the list the manifest omitted.
`engine.ts` imported `SHAREFLOW_BUILT_IN_SKILLS` and never used the import.

### 4. Publishing could not happen by any path

Two omissions, one symptom. `ToolRegistryConfig.approval` is what "makes approval unbypassable"; without it
the registry refuses every `approvalPolicy: "always"` tool:

```
Tool publish_post_now has approvalPolicy "always" and no approval check is configured
(ToolRegistryConfig.approval), so it can never run. This is a wiring error, not a refusal.
```

That is what the assistant relayed, in its own words, to *"Publish my Ethiopia draft to Instagram"*. A gate
**was** constructed four lines away and handed to the tool deps, where the registry never looks. And
`DefaultEngineDeps.approvals` was absent, whose own documentation says that means "no HITL: tool calls go
straight to `buildTools`' own `execute`" — so nothing could have raised an approval either, and the pending-
approval card the web app renders had nothing that could produce it.

Both are wired now, and the whole loop was run end to end against the local stack:

1. the model calls `publish_post_now`;
2. the run parks at `waiting-for-approval` with a pending interaction carrying the tool, the normalized
   input, the risk category, a summary, an expiry and an idempotency key;
3. `POST /api/interactions/:id/decide` with `allow-once` answers `{"ok":true,"resumed":true,"granted":false}`;
4. the worker resumes, executes the approved call, and the tool refuses for a **product** reason — Instagram
   wants at least five hashtags — which the assistant reports accurately.

`questions` is wired for the same reason: without it "a run that parked on a question resumes with no idea it
was answered, and the model asks the same question again".

One thing this does not fix: a gated tool reached through `execute_tool` is *refused* by the registry rather
than paused, because `RunApprovals.runTool` resolves the descriptor by the declared call's name and a
meta-tool has none. Every gated tool a conversation is expected to reach — `publish_post_now`,
`schedule_post`, `validate_publish`, `retry_publish_target`, `reply_to_comment` — is in the preloaded set and
therefore takes the pausing path.

### 5. The empty candidate itself, which the tool list only made likely

Removing the declaration bloat took the empty answers from 7 of 29 model calls to 0 of 95 locally — and
did not take them to zero in production. The same prompt that answered at 10:14 came back empty at
10:47, at 5,053 and 5,046 prompt tokens respectively. So size raises the rate and is not the trigger;
the provider simply does this sometimes.

`retry-empty-candidate.ts` wraps the model so a stream carrying **no content chunk at all** is asked
again, up to three times, before the engine ever sees it. It costs one chunk of latency and no
streaming: an empty candidate produces a stream with no content in it, so the wrapper only buffers up
to the *first* content chunk, replays it, and pipes the rest. A tool call and an `error` chunk both
count as content — the first is a turn doing something, and the second is a real outcome that must be
reported rather than retried into silence.

After the last attempt the empty stream is returned as it is. Three empty answers in a row say
something real about the request, and an unbounded retry turns one bad turn into a stuck worker; the
web app labels a settled turn that produced nothing, which is visible in a way silence is not.

### 6. `chorus-artifact:`, `chorus-media:` and `chorus:post/` were deleted before the renderer saw them

Found by clicking an artifact link in the deployed app and getting nothing at all. The DOM said why:

```html
<a href="">Instagram New Product Launch Playbook</a>
```

react-markdown's `defaultUrlTransform` allows `http`, `https`, `mailto`, `irc`, `ircs` and `xmpp` and
returns `''` for every other protocol. So all three of the app's own schemes were blanked before the `a`
and `img` overrides ran — `isArtifactRef('')` is false, and the link fell through to the plain-anchor
branch with no href.

Three product features, each named in the system prompt (*"add a markdown link to it: `[short
label](chorus:post/<the postId a tool returned>)`"*), each implemented in `Markdown.tsx`, each
unreachable in a browser: the artifact chip that opens the side panel, the post preview card, and the
workspace-media reference. `urlTransform` has never appeared anywhere in this repository's history,
which is exactly why — the ref parsers are pure and were unit-tested, and nothing rendered them in a
DOM this repo does not have.

`assistantUrlTransform` passes those three schemes through and sends everything else to the sanitiser,
because `javascript:` and `data:` hrefs in model-written markdown are what it is there for.

### 7. `search_web` had no provider, and the variable that looked like the switch was inert

Reported as "search on web is not working", and it was three separate omissions:

- `webToolkitFrom` built a provider only when `RETINUE_SEARCH_API_KEY` **and**
  `RETINUE_SEARCH_ENDPOINT` were both set;
- compose passed the key and a `RETINUE_SEARCH_PROVIDER` that **nothing in the application reads**, and
  never passed the endpoint at all — so setting a key on the server changed nothing;
- the one hardcoded shape, `Authorization: Bearer` with `?q=&count=`, is wrong for three of the five
  providers anyone uses: Brave wants `X-Subscription-Token`, Tavily and Serper are POST, and Serper's
  key header is `X-API-KEY`.

`search_web` stayed registered throughout and refused every call as "not configured", which reads as a
broken tool rather than an unset variable.

`src/adapters/web/search-providers.ts` is now a table, and `RETINUE_SEARCH_PROVIDER` means what it says:

| provider | key | notes |
|---|---|---|
| `duckduckgo` | none | **the default.** Instant Answer API |
| `searxng` | none | a real index; needs `RETINUE_SEARCH_ENDPOINT` pointing at an instance |
| `brave` | yes | `X-Subscription-Token` |
| `tavily` | yes | POST; returns extracted page content rather than snippets |
| `serper` | yes | POST; Google's results |

**The default needs no key**, because that is what the deployment had before the cutover: search works
out of the box and a key upgrades the index rather than switching the feature on. A provider named
without its key is a *refusal with a reason*, not a silent fallback to DuckDuckGo — a deployment that
asked for Brave and forgot the key wants to hear about the key, not to get a different index quietly.

What DuckDuckGo is, said plainly: an instant-answer API, not a web index. Verified against the live
endpoint — `coffee` returns five usable hits, `specialty coffee` four, and `instagram reels best
practices` **zero**. It is the honest free option rather than a good one; `tavily` or `brave` is what
research-grade answers need, and a self-hosted `searxng` is a real index for no money.

### 8. Replying had no send, and the fix needed a *new* action rather than the existing one

Reported from the app: `find_tools`, `learn_tools`, `list_comments`, two `reply_to_comment` attempts,
and *"this deployment cannot send replies because no platform connector is wired."*

`EngagementService.reply` takes an optional `send` and refuses without one — correctly, since the whole
purpose of the method is the external effect. The platform tokens live in the web app, deliberately
(`store-media`'s header: *"giving it one would widen its blast radius considerably"*), and that app has
had the connector **and** an internal endpoint the old runtime used all along. Nothing joined them.

The join needed a new action, not the existing `reply`. The runtime marks the row `sent` **before**
sending — its own comment explains why: read-then-send-then-write puts a second public reply on a
customer's post and only notices afterwards, and a duplicate reply cannot be taken back. The app's
`reply` action refuses precisely that state (*"That comment has already been replied to"*), which is
right for a person clicking Approve in the inbox and wrong for the runtime. So `sendClaimedReply` is
the send half alone: it owns the platform call and `sent_reply_external_id`, and leaves `reply_status`
to the caller that already wrote it.

### 9. Two `.composerRow` blocks in one stylesheet

Reported as *"we have a line in the input which looks weird"*, and it was exactly that: a 1px
`border-top` drawn across the composer. `.composerRow` was defined twice in `assistant.module.css`, and
the second — from the pre-restoration chat, a hundred lines later — won on every property it declared.
Its `.threadList` was doing the same to the thread rail: a `grid-row` and a second `border-right`.

That block's own header claimed *"every class here is new rather than reused, so nothing in the current
chat can shift underneath it."* Two of its classes were reused. Thirteen dead rules are gone and the
four the question card still needs are kept and labelled; no duplicated class blocks remain in the
file. Duplicate blocks are the cascade collision that is invisible in review, because both rules read
as correct on their own.

### And the cast that hid two of them

The deps object handed to `createDefaultEngine` was `as never`. It let `loadManifest` return
`shareFlowManifest()` — the five-field *seed* for `socialAssistantManifest`, so the engine ran on a manifest
with no `id`, no `toolPolicy`, no `skillPolicy` and no `contextProviderIds`, every policy field reading as
`undefined` — and it would have accepted any future misspelled field just as quietly. The cast is gone; the
deps satisfy `DefaultEngineDeps` on their own, and `engine.test.ts` asserts each field whose absence is
silent.


## The deployable backend

`src/app/module.ts` is what a deployment actually loads. It default-exports `{ authenticate, deps }` — the
contract `RETINUE_APP_MODULE` names — and `Dockerfile.shareflow` builds an image around it:

```bash
docker build -f Dockerfile.shareflow -t retinue-shareflow .
```

A separate image from the reference app's, because the two carry different *applications*: the host binary is
the same, but the module it loads decides which workspaces must compile and which optional peers must be
installed. One image serving both would ship twenty toolkits to a deployment that registers none.

### Every dependency either works or refuses by name

The module's first version passed `undefined as never` for four dependencies. It typechecked, and it would
have produced a container that booted, reported healthy, and failed on the first turn that touched a
connector, the web or the model. All four are real now, and two of them **degrade rather than refuse**,
because the distinction is one a user can act on:

| Dependency | With nothing configured |
| --- | --- |
| `SHARED_API_SECRET` | Every request is refused. Never a fallback secret: an unset secret means *deny*, or a backend serves an open API to whoever forgot to configure it. |
| `PUBLIC_APP_URL` | Refuses to boot. The connection setup tells someone which redirect URL to paste into a developer console, and a wrong one fails at consent with no explanation. Plain http outside localhost boots but sets `ConnectionSetup.warning`, because every platform refuses that redirect. |
| `RETINUE_MODEL_API_KEY` | Refuses to boot, rather than admitting a drafting turn it cannot finish. |
| Search provider | **Degrades.** `{ searched: false, reason: "not-configured" }`, never an empty result list — an empty list is indistinguishable from "nothing out there" and invites a model to answer from what it already believes. |

The page fetcher is always the platform's `createFetchPage`, never a second one: it is where the egress
policy, the redirect refusal and the body ceiling live.

### The worker, and the five contract violations between healthy and working

`RETINUE_APP_MODULE` must default-export `{ authenticate, deps, engine, buildContext }`. The first two
satisfy the API host, which is what made the rest expensive: the deployment answered `/healthz` and
`/readyz`, accepted a `sendMessage`, and every run failed the instant a worker claimed it.

Each of these was found by driving a real turn through a real worker against a real database, and none
was visible to the build:

| Failure | What it was |
| --- | --- |
| ``must default-export an `engine``` | The worker needs an engine; no generic entrypoint can invent one |
| `A TransactionRunner is required` | The worker supplies none — and `config` carries the URL, so one is derivable. Refusing was right only while nothing could derive it |
| `deps.buildContext is not a function` | The contract's fourth member: who a background run acts as |
| `engine.run is not a function` | The worker does not `await` the factory, so it must be synchronous. Construction is deferred to the first `run` |
| `config.authorization.filterTools is not a function` | The placeholder implemented `can` alone, behind a cast |

That last one is the third time a cast in this package hid a missing member — after `ConnectorDeps.setup`
(an object where a function was wanted) and `engine` itself (a promise where an object was wanted). The
pattern is the lesson: **a cast to an interface is a promise the compiler stops checking**, and all
three were found by running the thing.

### The prompt is the old runtime's, and its tool names are checked

`instructions.ts` carries the Python runtime's 5,327-character prompt — a cutover means the same
instructions — but *transcribed*, not copied. Four tools were renamed here and one does not exist:

```
publish_now → publish_post_now      create_draft → create_post_draft
read_url    → read_source           get_post     → get_post_draft
read_pdf    → (missing)
```

A verbatim copy would have told the model to call five tools it does not have. A prompt is prose, and
prose compiles, so `__tests__/instructions.test.ts` asserts every tool name in the assembled prompt is
one the registry registers. Clauses whose tools are missing are withheld and listed with the capability
that would restore them — an assistant told to offer a PDF it cannot generate will offer it.

### One thing the type system did not catch

`ConnectorDeps.setup` is a *function* — `createPostgresConnectorService` calls `deps.setup(context)`. The
first implementation returned a plain object through `as unknown as ConnectorDeps["setup"]`. `tsc -b` was
clean, the image built, and the first person to ask "how do I connect LinkedIn?" would have got
`deps.setup is not a function`. What found it was the **test** typecheck added by #276, rejecting a cast in a
test that mirrored the cast in the source. The cast is gone; the annotation is checked.

### What guarantees the image can load its own code

The runtime declares `pg`, `ioredis`, `bullmq`, `graphql-yoga`, `@whatwg-node/server` and six `@ai-sdk/*`
providers as **optional** peers, so the application has to name the ones its wiring uses. Both Dockerfiles
used to claim their `npm ci --omit=dev` caught a missing one. It does not: with `pg` deleted from this
package's manifest the image still built and still resolved `pg`, because `bullmq` depends on `pg` and
brought it along.

That is two guarantees, and they live in the two places that can hold them:

- **The image can load what it runs.** `scripts/collect-runtime-imports.mjs` walks the compiled graph from
  both entry points — the CMD and the app module — crossing into workspace packages, and
  `scripts/check-runtime-imports.mjs` resolves every specifier it found against the production install,
  inside the image. Both halves are derived from the build; the version of this with fourteen specifiers
  typed into it was a test whose expectation was the same hand-maintained list it checked.
- **Nothing is installed by luck.** `scripts/check-optional-peers.mjs`, in `npm run ci:local`, compares that
  reached set against this package's own dependencies. It is the half resolution cannot see, and it is what
  fails on the `pg` case above. It also found five: this package declared `@ai-sdk/openai` and needed all
  six, because `provider-factory.js` imports every one of them statically.


### A capability declares the services it reads

```ts
export const getPostDraftTool = shareFlowTool(["content"], ({ services, deps }) => …);
```

`services` inside that factory is `Pick<ShareFlowServices, "content">` — reading anything else does not
compile. `createShareFlowToolProvider` takes a **`Partial<ShareFlowServices>`** and refuses at construction
when a registered capability needs a service the deployment does not have, naming the tools and the services
to supply rather than failing mid-conversation:

```
these ShareFlow tools need services this deployment does not provide: publish_post_now (publishing);
schedule_post (publishing). Supply publishing, or leave those factories out of the list …
```

All thirty-seven capabilities are now servable, so the complete factory list is accepted. The refusal is not
obsolete: a deployment may still register a narrower set — the cutover moves workflows one at a time — and
`requires` is what keeps that a checked decision rather than a hopeful one.

Two properties keep the declaration honest, because it can go stale in both directions. Declaring **too
little** does not compile, since `services` is a `Pick` of exactly `requires`. Declaring **too much** compiles
but would make the provider refuse a deployment it could have served, so a test scans the source of all 37
factories and compares each declaration with the `services.` accesses in its body.

Registration validates at construction: a duplicate tool name, a category outside the vocabulary, or a
capability whose service is absent stops the process starting, rather than producing a confusing catalog on
someone's first conversation.

## Running a real shadow turn

Every part of the parity machinery existed for weeks except the measurement itself: the recorder (#126), the
diff, the gates (#128), the flag (#127), and a report that correctly refused to run on an empty set. Nothing
could produce a run.

```bash
RETINUE_TEST_SHAREFLOW_URL=postgresql://… node --env-file=../.env scripts/shadow-turn.mjs \
  --workflow create-post \
  --message "Draft an Instagram post about the launch. Propose angles first." \
  --message "Use the durability angle, then save it as an Instagram draft." \
  --out shadow-new.json
```

It makes real model calls against a real ShareFlow database and prints the tool calls, the suppressed writes,
and the rows the turn actually wrote. `--message` is repeatable because **a workflow is not one turn**: asked
once, the assistant proposes three angles and asks which to use — exactly as docs/07 step 5 says — and a
comparison of "asked a question" against a completed old-runtime workflow measures nothing.

**A shadow run does create real drafts.** Suppression covers `external-write` and `destructive`, not
`internal-write`, so the script runs in a workspace of its own and prints what it made.

## The input ceiling, and where it is enforced

`maxInputTokens: 120_000` was declared in `compose.ts` and enforced nowhere. `assemblePrompt` — the
platform's budgeter — had **zero callers** anywhere, including inside `@retinue/agentkit`;
`compactThread` likewise; and `maxInputTokens` was read exactly twice, both times in `main.ts` and both
only to *display* the limit in the context meter. So `estimatedTokens`, `priority` and `pruneStage` were
computed on every section and consulted by nothing, and five well-written tests in
`context/__tests__/providers.test.ts` asserted pruning behaviour that never ran.

What the window actually holds, measured on the production workspace rather than estimated:

| | tokens |
| --- | --- |
| system prompt | 1,296 |
| tool declarations (22 tools) | 3,335 |
| skill catalogue | 542 |
| five skill bodies (the per-run cap) | 3,240 |
| context block | 148 |
| **fixed subtotal** | **8,561** of 120,000 |

And what runs cost, from `usage_records` over 139 production runs: mean 17,245, p95 25,478, **max
38,559**. The ceiling has never been approached — this closes a latent hole rather than putting out a
fire, and the allocations are sized to be invisible in normal use.

**The growth is not in the context block.** That is 148 tokens, and a workspace that fills in every
brand field reaches a few thousand. It is history: `conversationHistory` reads the most recent 400
messages and passes all of them, and `HISTORY_READ_LIMIT`'s own comment says the bound "exists to keep
one query bounded, not as a context policy — when compaction is wired, it should fire long before this
matters." Compaction is not wired.

So the budget is enforced in two places, and the large allocation is the one that matters:

- **`context-for-turn.ts`** runs sections through `assemblePrompt` before rendering. A brand profile
  too large for its bucket is pruned by priority and *reported*, so the claim policy cannot be crowded
  out — AC-6, true on the production path for the first time.
- **`history.ts`** bounds history in **tokens**, keeping the newest turns. A message count cannot bound
  a token cost. Past the budget it **condenses** rather than truncates — see below.

### Long threads are condensed, not truncated

`compactThread` had no caller anywhere, in this package or in `@retinue/agentkit`, while its store
(`createPostgresThreadSummaryStore`) and its table (`thread_summaries`, migrated by the platform) both
existed and waited. It is wired now: past the history budget the older turns become a stored, versioned
summary and the recent ones stay verbatim.

**The cost control is the design.** `compactThread` re-summarizes its whole `older` prefix on every
call — it layers on `priorSummary` but does not skip what that summary covers — so calling it once per
turn would spend a model call and write a summary version *every turn*: the same prompt size as
trimming, plus a round trip. Two things stop that. The prefix the stored summary already covers is
removed before anything is measured, and the summarizer is reached only when what remains is *still*
over budget. Verified against a real database:

```
30 turns x ~250 tok, budget 3,000
turn 1 (over budget)   1 summarizer call, summary covers 24 messages, 6 kept verbatim, stored v1
turn 2 (nothing new)   still 1 call        <- the covered prefix was excluded
turn 3 (+20 messages)  2 calls, layered on the prior summary, stored v2
```

Three properties are worth naming because each was a bug on the way here:

- **The summary is protected from trimming.** `withinTokenBudget` drops from the front and the summary
  sits at the front, so it was the *first* thing dropped — a model call spent condensing the thread and
  the condensation then discarded. And because it is protected, it must be bounded:
  `HISTORY_FLOOR_TOKENS` is *derived* from `SUMMARY_MAX_CHARS` so a summary can never exceed its own
  budget, whatever `maxInputTokens` a deployment sets.
- **The turn being answered is never summarized away.** `engine.js` builds the model's list as
  `[...history]` and finds "the newest user turn" inside it, so the last message *is* the question.
  `keepRecent` is floored at one for that reason.
- **It cannot fail a turn.** A summarizer is a model call and model calls fail; so does a store whose
  table is missing. Either falls back to the token trim — degraded, because the thread loses its
  beginning instead of having it condensed, and not a refused turn.

The summary is a `system` turn, because nobody said it: attributing it to the person would put words in
their mouth a later turn could quote back, and attributing it to the assistant would let the model treat
its own summary as a commitment.

`prompt-budget.ts` holds the division and derives it from `maxInputTokens`, so the buckets and the
history remainder cannot drift apart. History gets 80,000 tokens — 2.1x the largest run ever recorded.

Measured end to end:

```
today's production shape (132 + 16 tok)   both sections kept, nothing pruned
a 60,000-token brand profile              dropped and reported; warning and destinations kept
                                          block 60,150 -> 167 tokens
400 messages x 500 tokens (200,000 tok)   160 turns, 80,000 tokens, newest kept
```

**It degrades rather than failing a turn.** `assemblePrompt` throws `context_overflow` when a
`base-policy` bucket does not fit — right for a budgeter, wrong here, since a refused turn is strictly
worse than a long prompt at a third of the limit. A refusal falls back to today's behaviour and logs
which workspace configuration caused it. If that ever fires, the fix is a length guard where the field
is written, not a larger number here.

## Exercising every tool

The unit suite proves each tool against a fake. This runs all 58 against a real database and reports what
each one actually does — which is the only way to find a tool that is registered, described to the model,
named by the prompt, and has nothing behind it.

```bash
RETINUE_DATABASE_URL=postgresql://… PUBLIC_APP_URL=http://localhost:3000 \
RETINUE_MODEL_PROVIDER=google RETINUE_MODEL_API_KEY=… \
  npm run exercise:tools
```

```
58 tools exercised — 41 ran, 7 correctly gated, 10 refused, 0 failed.

  provider_unavailable (3): render_diagram, generate_pdf, capture_website
  capability_unavailable (2): check_account_health, convert_media
  conflict (2): evaluate_campaign, replace_media_on_post
  provider_error (2): describe_image, read_pdf
  not_found (1): check_conversion
```

It fails the build on two things. **A gated tool that executes without a grant** — the seven
`approvalPolicy: "always"` tools are called with no approval and must come back `approval_required`. And
**an `invalid_input`**, which is a bug in the script's own fixtures rather than a finding about the tool:
the first version of this reported "31 refused by name" and most of them were its own malformed arguments,
which reads as coverage and proves nothing.

Two things it does that are easy to get wrong in a script like this, both learned the hard way:

- **It passes an explicit per-call idempotency key.** Without one, `createDelegatingTool` falls back to a
  key derived from tenant, conversation, tool and arguments — and the platform's comment on that fallback
  says it "collides for *any* call with identical arguments **across runs**". The fixtures here are constant
  by design, so every run replayed the first run's stored results: `create_post_draft` returned `ok` with
  the same id every time while `select count(*)` for that id returned 0.
- **It leaves the workspace as it found it.** The sweep writes, and three runs took a workspace from five
  post drafts to eight — after which the tools whose fixtures read "the first row of the list" start reading
  a previous run's leftovers. Everything created is deleted by recorded id. `EXERCISE_KEEP=1` opts out, which
  is how the replay above was found.

Media is seeded — two `generated_assets` rows and the `storage.objects` rows the listing's inner join
requires — so the media tools work on something real instead of reporting `not_found` against a random uuid.

## Evaluating the agent

`npm run exercise:tools` asks whether each tool works. This asks whether the *agent* does — #669. It replays the
2026-09-30 design conversation (a one-page price sheet, a restyle, a six-slide deck asked for three ways, a merge to
four slides, a dark theme, a recall question) and scores every turn from what the run stored, not from what the reply
says:

- **the documents** — read back with `get_artifact` after the turn: kind, slide count (the deck renderer's own split),
  the asked-for colours and fonts, the required text, nothing that should be gone, no `[Customer Name]` placeholders,
  and an edit that stayed on the same document instead of a new one;
- **the PDF** — the `generate_pdf` result's render facts: page count, a page per slide, orientation, nothing cut off,
  fonts installed;
- **the claims** — "here is your PDF" with no `generate_pdf` behind it, a tool record written as text, a failed call
  the reply passes over in silence;
- **the cost** — context tokens, turn input, cache share, output, steps, latency and time to first part, per turn.

With `EVAL_ARCHIVE_PARTS` it then pads the conversation with ~7k-token filler turns (each must answer `Noted N` and
call nothing) until the conversation sent reaches `EVAL_TARGET_TOKENS` (1M by default), and asks for the four facts
planted in the first turn. That is the long-context half: it shows where history is condensed (⤵ in the table) and
whether a turn is refused. Three refusals in a row stop it — the 520k lock was the finding last time, and more turns
past it only cost money.

On production, inside the running container (it already has `SHARED_API_SECRET`):

```bash
docker exec -e EVAL_WORKSPACE_ID=c02190c9-fe43-4f24-a857-8fbd6ec447dd -e EVAL_USER_ID=<a member> \
  social_share-shareflow-1 node scripts/agent-eval.mjs
```

Add `-e EVAL_ARCHIVE_PARTS=150` for the long run. Locally, against `npm run serve`: `EVAL_BASE_URL=… SHARED_API_SECRET=…
EVAL_WORKSPACE_ID=… EVAL_USER_ID=… npm run eval:agent`. The report goes to stdout and, as `report.md` and
`report.json`, to `EVAL_OUT`; the exit code is 1 when any check failed. Every setting is listed at the top of
`scripts/agent-eval.mjs`.

**Workspace and model.** The workspace is "Credit test (Claude)", kept for this — not a customer's. The model is that
workspace's own (gemini-2.5-flash, the production default), so the numbers describe what users get; `EVAL_MODEL`
overrides it per turn. The long run needs a model whose window the 1M target can reach — on Gemini's 1M window the
conversation is condensed before then, which is the behaviour being measured; a BYO key with a larger limit reaches
it without condensing.

**What it costs and leaves.** Every turn is a real chat turn: credits, or the BYO provider's bill — about ten for the
design run, ~150 more for a 1M long run. It leaves its conversation and the documents and PDFs it made in that
workspace; nothing is deleted.

The scoring is `src/eval/agent-eval.ts`, pure and unit-tested against the 2026-09-30 failures; colour and font are
checked as "named in the document", which a stylesheet that never applies them would also pass.

## Publishing, and what the schema does not guarantee

`PublishingService` is the first adapter whose methods are `external-write`, which is what gives a shadow run
something to suppress. Three findings about this schema are load-bearing:

- **Nothing stops a double publish.** `scheduled_items` has no unique constraint on
  `(post_id, social_account_id)`; the only unique index is `(posting_schedule_id, social_account_id,
  occurrence_at)`, partial on `posting_schedule_id IS NOT NULL`, so it governs recurring rules and not one-off
  scheduling. `schedule` therefore takes a row lock on the draft and checks inside the transaction. The
  residual gap is stated rather than hidden: this serialises *this adapter's* callers, and ShareFlow's own
  route takes no lock, so an app publish concurrent with an agent publish can still produce two rows. Closing
  that needs a partial unique index in ShareFlow's schema — a migration in that repository, and a decision
  about whether the app ever legitimately schedules one draft to one account twice.
- **This adapter does not enqueue.** ShareFlow's route inserts the row *and* adds a BullMQ job. Reaching Redis
  from here would add a queue dependency the boundary rules forbid and make this a second producer for a queue
  ShareFlow owns — where the sweep's whole safety argument rests on `jobId` being the item id. The row is
  enough because ShareFlow's reconciliation sweep collects due `PENDING` items, at a cost of
  `SWEEP_WORST_CASE_MS` (six minutes) versus seconds. That is a real behavioural difference between the two
  runtimes and a parity report should carry it; a deployment that wants the seconds back supplies `enqueue`.
- **Two states the port describes are unreachable.** `awaiting-platform` is not a value `scheduled_items.status`
  holds, and the port's "ShareFlow gives up after 24 hours" is not this deployment's rule — there is no
  24-hour threshold and no `finish-pending-targets` sweep. `stuck` is derived from the sweep's own alert
  threshold instead, because reporting the port's number would assert a rule that is not running.

### Shadow mode skips the preflight, and a parity report must know

The registry suppresses a gated effect at `backend/src/tools/registry.ts:721` and **returns before
`tool.execute`**, so the delegating envelope's read-only preflight never runs in shadow mode.
`publish_post_now`'s preflight calls `PublishingService.validate`, which refuses a draft id that does not
exist — so a shadow run can record *"the new runtime would have published draft X"* for an id the model
invented. The first real publish turn did exactly that:

```
publish_post_now → PublishingService.schedule (external-write)
  would require approval: true
  input: {"postDraftId":"draft456","accountIds":["linkedin123"]}
  targets: MISSING postDraftId=draft456 (not a UUID), accountId=linkedin123 (not a UUID)
```

Diffed against the old runtime's real publish that is a **manufactured divergence** — the report would blame
the runtime for a model error. `scripts/shadow-turn.mjs` checks every suppressed write's targets against the
database and says so, which makes the pollution visible rather than silent. Fixing the ordering is a platform
decision with its own trade: the registry would have to trust every preflight to be read-only.

## The last five, and what each schema would not give

Six adapters in, the pattern is consistent enough to state once: **read the CHECK constraint, not the calling
code, and never live rows.** It has now been wrong three times in the other direction — a column permitting a
value nothing writes, and live rows suggesting a vocabulary narrower than the real one.

| Service | What the schema would not give | What it does instead |
|---|---|---|
| `engagement` | nothing — `inbox_comments_reply_status_check` is the port's four states in `snake_case` | maps, and claims the row as `sent` **before** sending, because read-then-send-then-write posts the second public reply and only then finds the conflict |
| `leads` | `rejected` is in the port's union and **not** in `leads_status_check` | refuses it by name with the three that work, rather than mapping it onto `contacted` and telling a salesperson to chase someone who was turned down |
| `leads` | no suppression table, and no suppression path in ShareFlow | `LEAD_SUPPRESSION.enforced` says so, so a caller checks rather than inferring from never seeing the outcome |
| `analytics` | `post_metrics` has **no workspace column** | scoped only by the join through `scheduled_items` to `posts` — a query reading it directly would sum every tenant's numbers into one plausible-looking answer |
| `media` | `generated_assets` has **no size column**, and `MediaAsset.bytes` is not optional | reads the real byte count from `storage.objects.metadata->>'size'`, rather than `bytes: 0` — a lie an assistant repeats |
| `research` | nothing at all; there is no table | wraps the platform's `createWebSearch` and `createFetchPage`, where the egress policy lives |

### Two places the database already provides what the port wants

`leads` has two partial unique indexes — `(workspace_id, lower(email))` and
`(workspace_id, name, captured_from)` — so the dedupe the port asks for is `ON CONFLICT DO NOTHING` in one
atomic statement with no lock. Worth reading beside `PublishingService`, which needs a row lock for the same
guarantee: **the difference between the two adapters is the index, not the care taken.**

And `inbox_comments_reply_status_check` matches the port's `CommentReplyState` exactly, four for four. Where a
schema and a specification agree, saying so is as useful as documenting a gap.

### The one the port names, with the line it lives on

`web/src/lib/campaign-stats.ts:92` guards divide-by-zero as `impressions === 0 ? 0 : engagements / impressions`
— correct for a dashboard tile and **wrong as a fact**. No impressions makes engagement rate *undefined*, and
an assistant handed `0` reports "engagement was 0%" when the truth is "nothing was measured". So zero
impressions yields `unavailable: "no-data"`, and a post with no metrics row at all yields `not-collected`:
"we cannot see this" and "we looked and there were none" are different sentences to a user.

## Connectors, and two questions a database cannot answer

`ConnectorService` exists because of a gap the publishing work exposed: all five publishing capabilities
worked and **nothing could tell the assistant where to publish**. `list_accounts` is the only capability that
surfaces an account id, so a real turn could do nothing but guess — and it did, inventing
`accountIds: ["linkedin123"]`.

`social_accounts` answers "which destinations exist and what does the store think of them". It does not answer
two of the three methods' questions, so both are injected rather than invented:

- **"Is the platform's OAuth app configured?"** In ShareFlow that is `connector.isConfigured()` — a runtime
  read of environment variables **in ShareFlow's own process**, which this package cannot see and must not
  try to. Absent `configuredPlatforms`, `not-configured` is *never reported* — which is not a claim that
  everything is configured.
- **"What does connecting this platform require?"** Redirect URLs, console field labels, scopes and
  environment variable *names* are deployment knowledge. `setup` is required, because a default would have an
  assistant confidently naming a variable this deployment does not use.

`checkHealth` **refuses** without a `probe` rather than answering from the store, and it is the one place in
these adapters where refusing beats returning what is known: the tool's own description is *"rather than
reading the stored status"*, and the model reaches for it precisely when the stored status is what it has
stopped trusting. `getClaimPolicy` answering empty is truthful; this answering `ACTIVE` from a row would be a
false claim relayed to a user as a live check.

`auth_tokens` is never selected — not merely dropped in the mapper. That is defence in depth rather than
observable behaviour: sabotage added the column to the `SELECT` and every output assertion still passed,
because the mapper does not copy it. For a column holding access and refresh tokens the defence is worth
pinning, so a test scans the source and fails if the column list grows.

### Read the constraint, not the calling code

The account-status vocabulary was mapped from what ShareFlow *writes* — `ACTIVE` from the connect callback,
`EXPIRED` from the refresh route and TikTok webhook — and the conclusion was that the port's `revoked` was
unreachable. `social_accounts_status_check` says `ARRAY['ACTIVE', 'EXPIRED', 'DISCONNECTED']`, and the
database refused a fixture until the map grew a `revoked` arm. **The constraint is the authority on what a
column can hold; the calling code shows only what one version of it happens to write today.** Same lesson as
the post-status trigger.

One ordering matters: a lapsed `token_expires_at` overrides a stored `ACTIVE` — so `list_accounts` and
`PublishingService.validate` reach the same conclusion instead of one saying "active" while the other refuses
with `credential-expired` — but it does **not** override `DISCONNECTED`, because `revoked` is more specific
and tells a user something different.

### What the first real turns found

Seven defects, none visible to the compiler and none to the 52 adapter tests, every one reached from a model
argument:

| | |
|---|---|
| An authorization role listing `tools: ["*"]` | there is no wildcard — `filterTools` is an exact name-or-category match, so the model got an **empty catalogue**, called nothing, and answered from memory. Nothing said the catalogue was empty. |
| `ValidationIssue.repairable` omitted behind a cast | it is required, and `generate_content`'s repair loop reads `!i.repairable`. `!undefined` is `true`, so every finding read as unrepairable and generation never made a second attempt — instagram wants five hashtags, the model writes two, and the loop recovers on the very next attempt when told. |
| `campaignId: "1"` from the model | reached `$7::uuid` and surfaced as `invalid input syntax for type uuid` under code `internal`. |
| `cursor: "/"`, and once a hundred characters of parallel-tool-call junk | reached `$3::timestamptz` and surfaced as `date/time field value out of range` under `internal`. One bad argument took out an otherwise complete turn. |
| A well-formed id for another workspace's campaign | `posts_campaign_id_fkey` references `campaigns(id)` **and nothing else**, so the database will attach workspace B's draft to workspace A's campaign. Verified, then closed in the service. |
| `campaignId: idString.optional()` | told not to attach a campaign, gpt-4o called `create_post_draft` seven times in one turn inventing an id each time. A field description changed nothing; removing the field made the workflow complete first try. It is now a discriminated `campaign` union, so **"none" is sayable** rather than something to omit. |
| `parity-report.mjs` on a run with no old half | crashed with `Cannot read properties of null`. The guard was `=== undefined`, and JSON cannot express `undefined`. The one script whose job is refusing bad input threw on the likeliest bad input there is. |

Two changes were tried, measured and **reverted**: `.uuid()` on the tool-level `idString` and `.datetime()` on
`cursorString`. Neither stopped the fabrication — the model simply produced well-formed garbage instead — and
both pushed a storage detail into the model-facing contract, where `PostDraftId` is a branded string and
`nextCursor` is opaque. Those checks live in the adapter, which is the layer that knows.

### What the adapters found

The ports were written from docs/07 and the tables were written by ShareFlow, so every gap between them
was a mapping decision — and the mappings were wrong in ways only a real database showed:

| The port | ShareFlow | Consequence of the first version |
|---|---|---|
| `post_drafts` | `posts`, drafts and published rows in one table | — |
| `draft`, `in-review`, … | `DRAFT`, `IN_REVIEW`, … (five, per `web/src/lib/data/posts.ts:5`) | mapped three statuses that do not exist, one of them to `approved` |
| `3x-week` | `3x_week`, held by `campaigns_cadence_check` | every `3x-week` campaign failed to insert |
| `plannedPostCount` | `postCountFor` in `web/src/lib/campaigns.ts:34` | three-a-week reported **a third** of the posts ShareFlow creates |
| `PublishTargetState` | `PENDING \| QUEUED \| SUCCESS \| FAILED` | no arm for `SUCCESS`, so every published destination read as pending |
| `mediaAssetIds` | `media_urls`, URLs not ids | returned as stored; no id table exists |
| optional `mode`, `mediaType` | `NOT NULL` with defaults | an omitted field became an explicit null and **every** campaign insert failed |
| `startsOn: string` | `date`, which node-postgres parses to a `Date` | `value.slice is not a function` |

The claim policy and the performance brief have **no table at all**; they answer empty and `BRAND_SUPPORTED`
says which, so a caller can tell "nothing is forbidden here" from "nobody stores that".

None of the eight was visible to the compiler, and the four campaign failures were in one code path that
nothing had ever called. That is why `adapters/postgres/__tests__/services.test.ts` runs against a real
database and skips — rather than falling back to a fake — when `RETINUE_TEST_SHAREFLOW_URL` is unset:

```bash
RETINUE_TEST_SHAREFLOW_URL=postgresql://... npm test --workspace @retinue/shareflow
```

## A gap the inventory cannot express: per-workspace BYO models

The capability inventory's unit is a **route, tool, agent, skill, webhook or cron** — that is the
vocabulary `scan-old-runtime-capabilities.mjs` emits, and `verifyAgainstManifest` refuses an entry
whose `oldRuntimeRef` is not something the scanner found. Verified rather than assumed: adding an
entry with `oldRuntimeRef: "option:generate.llm"` produces

```
"use a workspace BYO model" points at something that is not in the old runtime.
```

So a capability that lives in a request **field** is structurally invisible to the inventory, and
there is one that matters.

**Ten of the old runtime's request models carry an `llm` override** — `GeneratePostRequest`,
`ReplyRequest`, all three campaign requests, `EnhancePromptRequest`, `PlanScenesRequest`,
`RepurposeRequest`, `VisionRequest`. The web app resolves it per workspace from
`public.workspace_llm_configs`, decrypts `api_key_encrypted` with `ENCRYPTION_SECRET`, and forwards
the bundle in-process; `llm-config.ts` notes the decrypted key is *"NEVER"* persisted. Several of the
same models also carry `tone`, `system_prompt`, `persona` and `voice_examples`.

**This backend had one model**, from `RETINUE_MODEL_*`. A workspace with its own provider configured
was served by the platform's model and its key went unused — silently, and with the cost landing on the
wrong account. That is not a small parity gap and it was not in the tally.

**Closed for content generation on 2026-09-14 (#462)** and still open for the assistant's chat turns;
both are detailed below.

### Decision: out of scope for the cutover — Jane Doe, 2026-09-08

**Not carried.** The cutover shipped with one model per deployment, from `RETINUE_MODEL_*`.

Recorded here rather than left implicit because the consequence is silent: a workspace with a BYO
provider configured is served by the platform's model, its key is never used, and the cost lands on
the platform's account. Nothing errors.

### Closed for content generation — 2026-09-14 (#462)

**The second of the two options below was taken: this backend reads and decrypts the config itself.**

`structuredGenerateFrom` now resolves the model **per call** from the `ExecutionContext` it was always
handed. `adapters/model/workspace-model.ts` reads `public.workspace_llm_configs` for the calling
tenant, decrypts `api_key_encrypted` with `ENCRYPTION_SECRET`, maps the web app's provider names onto
`MODEL_PROVIDERS` (`self_hosted` -> `openai-compatible`), and answers `undefined` for a workspace that
has no config of its own — which is how choosing the platform is stored.

So a workspace that puts an Anthropic key into **Settings -> AI providers** now generates with Claude:
`generate_content`, `generate_alternatives`, repurposing, campaign planning, scripts, hashtags and
`describe_image` all go through that one function.

What made this worth doing ahead of the rest of the gap is that the surrounding product had shipped
without it. The settings screen offered `anthropic` with three Claude models and stored the key;
`/api/ai/generate` wrote `provider` and `model` into the `agent_runs` audit row; and the route billed
`credits_spent: 0` **because** a BYO row existed. The product asserted in a stored audit trail and in a
billing decision that the customer's provider had run, while every token was spent on
`RETINUE_MODEL_API_KEY`. An unimplemented feature is absent; this one answered.

**`ENCRYPTION_SECRET` is now required in this service too**, and must be the *same value* the web app
uses. Set in one and not the other, every BYO key fails to decrypt and every such workspace falls
silently back to the platform's model — while still being billed as free. That is the original defect
with an extra step, so an unset secret warns at construction and an undecryptable row warns once per
workspace, both naming the variable. `docker-compose.oracle.yml` passes it to `shareflow` and
`shareflow_worker`.

#### Closed too: the assistant's conversational turns — 2026-09-15

This section previously said chat could not be wired. That was true of the obvious approach and not of
the problem.

`resolveModel(manifest, context)` is still called **synchronously** by the engine
(`dist/agents/engine.js:141`), so the lookup genuinely cannot happen inside it. What changed is the
realisation that **the model may be lazy**: `resolveModel` has to return an object synchronously, but
nothing requires that object to know which provider it will talk to. `wrapLanguageModel` middleware is
asynchronous and receives the call's `params`, so the wrapper does the lookup on the first model call
and hands `params` to a different provider's model entirely. `app/workspace-turn-model.ts`.

A synchronous cache primed in the background stays rejected for the reason it always was: the first
turn for every workspace would quietly run on the platform's key, which is this defect made rarer
rather than fixed.

**What still comes from the deployment on a BYO turn**, stated rather than implied:

- `price` **is** handled — the wrapper and the price function are built together per turn and share a
  flag, so a turn that ran on the workspace's model reports a platform cost of zero. That is the
  truth: those tokens were billed to the customer's provider account.
- `modelId` and `definition` are **not**. They are decided before anyone knows whether the turn is
  BYO, so a BYO turn is labelled in the usage ledger with the deployment's model id, and the declared
  limits are the deployment's (`contextTokens: 0`, i.e. no ceiling). Worth fixing when `resolveModel`
  can be awaited — Rise-Experts/retinue#279, which remains open and is now an ergonomics issue rather
  than a blocker.

#### Still open: one way the two services can disagree about billing

`web`'s `resolveWorkspaceLlm` and this resolver apply nearly the same rules, and `workspace-model.ts`
restates them rather than trusting them precisely because a rule enforced in one of two readers holds
only until someone uses the other. One divergence remains reachable: a **self-hosted** config saved
with no model named (`/api/llm/config` stores `model?.trim() || null`). `web` counts that as BYO and
waives the credit; this resolver refuses it, because a self-hosted endpoint's catalogue is not knowable
from here and inventing a model id produces a 404 from a server nobody here can inspect. The result is
a free generation on the platform's key. It is narrow, it is warned about per workspace, and the fix is
a validation change on the save route rather than a change here.

The two ways this gap could have been closed, kept for the record:

- **The web app forwards the resolved bundle**, which means extending `/api/message` and the client
  with a per-turn model override. The key crosses the compose network on every turn — no new exposure
  versus the old runtime, but a wider contract, and a decrypted credential in a header on every
  request.
- **This backend reads and decrypts the config itself**, which puts `ENCRYPTION_SECRET` in a second
  service. **This is what was done.** One extra indexed read per generation was judged a smaller price
  than a credential on the wire, and it covers callers the web app does not mediate.

`tone`, `system_prompt`, `persona` and `voice_examples` are a separate question and still open. The
brand provider and the `post-composition` skill cover the *intent* of `tone` and `voice_examples` —
both are workspace-level rather than per-request in this design. Nothing covers a per-request
`system_prompt` override, and `persona` is unmapped.

## Status

The seam and the scaffolding (#114); Posts (#115); Campaigns (#116); Accounts (#117); Media (#118);
Publishing (#119); Engagement and Leads (#120); context providers (#121); the seven skills (#122);
content generation (#123); research (#124); analytics (#125). **All eleven docs/07 tool categories and
both net-new capabilities are implemented.** Shadow mode (#126) suppresses external writes in the
envelope, #127 adds per-workspace rollout with a rehearsed rollback, and #128 defines the parity gates and
the gate that blocks the Agno removal.

**The removal itself is still blocked, and #128 remains open** — three of its acceptance criteria need a
person (agreeing the thresholds, naming a decision-maker, deciding what happens to historical data) and one
needs shadow data from a deployment running both runtimes, which does not exist yet.
`canRemoveOldRuntime` returns `allowed: false` today, and lists every reason.

The assistant itself now runs the way it was designed to: 21 declarations instead of 61, the workspace's
brand voice and connected accounts in the prompt, seven loadable skills, discovery through `find_tools` →
`learn_tools` → `execute_tool`, web search with a keyless default, replies that reach the platform, and a
publish that pauses for a human and resumes when they decide. See *Nine defects, measured against a real
model and a real browser* for what each of those was before, and how it was measured.

The app's own conversation timestamps were repaired at the same time: all 104 were dated 2020-01-01 by the
adapter's test clock (defect 7's neighbour, in `module.ts`), and
`scripts/repair-conversation-timestamps.mjs` rebuilt them from the message times. It is idempotent and
`--dry-run`-able, and it has been run against production.

`npm test` in this workspace runs `tsc -b` first. That is deliberate: this package value-imports
`@retinue/agentkit`, whose entry point is `dist/`, so `vitest run` on its own tests whatever was last
built — see the note in `vitest.config.ts`.

### Running the whole thing locally

The four defects above were all found this way, and none of them was visible any other way. Everything the
stack needs is a Postgres, a Redis and a model key:

```
docker run -d --name shareflow-trace-pg -e POSTGRES_PASSWORD=trace -e POSTGRES_DB=shareflow -p 55987:5432 postgres:17-alpine
node node_modules/@retinue/agentkit/dist/server/bin.js migrate     # the retinue schema
psql ... -f ../supabase/migrations/*.sql                           # and the app's own tables
node dist/app/main.js                                              # the product's HTTP surface
RETINUE_APP_MODULE=file://$PWD/dist/app/module.js \
  node node_modules/@retinue/agentkit/dist/server/bin.js worker    # the process that runs the engine
```

Then `POST /api/message` with `X-API-Secret`, `X-Workspace-Id` and `X-User-Id`, and read `GET /api/events`.
Two notes for whoever does this next, both of which cost time here:

- The app's Supabase migrations need `auth.users`, a `storage` schema, the `authenticated`/`anon`/
  `service_role` roles and a `supabase_realtime` publication to exist first; 45 of 48 then apply to a plain
  Postgres. The three that do not are storage policies and `pg_cron`.
- `auth.uid()` must return **null**, not a user id. The service-role path is the one the backend uses, and
  `enforce_post_status_insert` refuses a `PUBLISHED` insert from a caller it can see.

A wrapper around `globalThis.fetch`, installed with `node --import`, records the provider exchange —
`finishReason`, `promptTokenCount`, the function declarations and the full system instruction. The platform
logs none of that, and all four defects are legible in it immediately.

## The capability inventory

`src/inventory/` — REQ-041 ([#194](https://github.com/Rise-Experts/retinue/issues/194)).

#128's parity gate compares **write sets** between the two runtimes. A capability the new runtime does not
implement writes **nothing**, and comparing nothing against nothing gives an identical-write rate of 100%. So the
strongest form of that defect was never a failing gate — it was a *passing* one, on a workflow nobody had built.

The inventory makes coverage a precondition of comparison rather than a conclusion from it:

| | |
|---|---|
| `missing` or `partial` | The workflow's verdict becomes **`incomplete`** — its own value, not a `failed`, because "we did not build it" and "it diverged" ask for different work from different people. No rate is computed, because the rate is the thing that lies |
| `dropped` | Needs a name, a date and a reason, as data. A capability removed silently is a customer's workflow removed silently |
| `shadowRuns` | **Counted**, from the shadow data, by matching tool calls against each entry's replacement. Never supplied — an entry's author is the person most likely to believe their capability is covered, and a number they can write is a number that says what they expect |
| zero shadow runs | Cannot contribute to a passing gate. An untested replacement contributes nothing to parity |
| scheduled, triggered, webhook | Carry their own `coverageEvidence`, because nobody shadows 03:00 and a webhook arrives when a third party decides. Requiring shadow runs of these would be requiring the impossible and then calling its absence a defect |

`canRemoveOldRuntime` blocks on an inventory that was never evaluated, for the same reason it blocks on an unrun
reference scan: **"I did not look" must never be worth the same as "there is nothing there."**

### It is read from the old runtime now, not written from memory

`scripts/scan-old-runtime-capabilities.mjs` reads `social_integgration` and emits
`src/inventory/old-runtime.ts`: every `@tool()` and whether it is confirmation-gated, which agent carries which
tools, the FastAPI routes, the skills directory, the inbound webhook routes, and the `cron.schedule` calls in the
migrations. `npm run scan:old-runtime-capabilities -- --check` fails when the committed snapshot and the live
source disagree.

That scan is why this section was rewritten. The previous inventory had 27 entries whose `oldRuntimePath` strings
were typed from memory, and **almost none of them resolved**: there is no `post_writer`, no `ideation`, no
`copywriter`, no `publish_guard`, no `publisher.publish`, no `scheduler.enqueue`, no `campaigns.create`, no
`engagement.inbox`, no `analytics.attribution`, no `accounts.health`, no `leads.*`, no cron `publish_due_posts`,
no cron `refresh_metrics` and no `POST /webhooks/:platform/comments`. Two thirds of the surface that *does* exist
had no entry at all — artifacts, diagrams, PDFs, `read_pdf`, `delete_post`, `repost_post`, branding writes, the
four agent-skill tools, fourteen HTTP endpoints, five webhooks.

It passed `validateInventory` cleanly, which is the point worth keeping: **structural validity was never the hard
part.** A prose path cannot be wrong about anything. So `oldRuntimePath` is gone and `oldRuntimeRef` replaces it —
`tool:publish_now`, `route:POST /campaign`, `webhook:/api/webhooks/stripe`, `cron:chorus-schedule-sweep` — a
reference that has to resolve against the scan, in a check that also fails when a capability has **no entry**.
That second direction is the one that mattered.

### What it says today

`incomplete`, and honestly so. The old runtime is 31 Agno tools across 9 components, 14 purpose-built HTTP
endpoints, 7 skills, 5 inbound webhooks and 1 cron job — 51 capabilities:

The tally below is the one the inventory tests pin, and it moves as capabilities land — the numbers here
were 18/3/16 when this section was written and are re-stated rather than left to rot:

| | |
|---|---|
| 37 `implemented` | a replacement exists with a behavioural test against the old contract |
| 0 `partial` | reached zero when `POST /api/tools/:name` shipped: all three were done tools missing a non-conversational entry point |
| 0 `missing` | **nothing.** Every capability the old runtime has is replaced, signed off as dropped, or retained where it already lives |
| 8 `dropped` | signed 2026-09-07: the six workspace-configuration tools and `POST /llm/validate`, `POST /assistant/session-name`. Two of the signatures record a **cost**, not a redirection — see below |
| 6 `retained` | five webhooks and the publish sweep, which live in `web/` and call the AI backend not at all — verified by grep. Removing Agno leaves every one of them running |

`retained` is the fifth status and was added deliberately rather than found convenient. `missing` would claim we
failed to build a Stripe webhook; `dropped` would demand a signature for deleting something nobody is deleting.
The hazard in adding a status is that a new value falls through every `if` and contributes **no problem** — so
both `validateInventory` and `gateStatus` switch exhaustively with a `never` default, and `validateInventory`
refuses `retained` for any capability whose source is under `ai_backend/`. Without that guard, `retained` is the
escape hatch that empties the file.

### The deployed backend could not generate anything, and only a live call said so

Found by calling `POST /api/tools/suggest_campaign_ideas` on the running container: `422` with
`{"error":"Not Found"}`.

`docker-compose.oracle.yml` passes optional variables through as `RETINUE_MODEL_ID=${RETINUE_MODEL_ID:-}`
— the ordinary compose idiom for "optional" — and they arrive as the **empty string**. This line therefore
resolved to `""`:

```ts
const modelId = env["RETINUE_MODEL_ID"] ?? DEFAULT_MODEL_IDS[provider] ?? "gpt-4o";
```

`??` falls through on `undefined` and `null`, not on `""`. Every model call went to Google with an empty
model name and came back 404. Nothing caught it: the value typechecks, `/healthz` and `/readyz` answer 200,
the container is healthy with zero restarts, and the only clue anywhere was one boot line reading
`no pricing for ""`. `required()` in main.ts had this right — `value === undefined || value === ""` — one
layer up; the *optional* reads did not.

Four sites had it, and one of them was `Number(process.env["PORT"] ?? 4000)`: `Number("")` is **0**, so a
deployment passing `PORT=` through would bind a random free port and look like a networking fault. All four
now go through `optionalEnv` / `optionalNumberEnv`, and a source scan in `app/__tests__/env.test.ts` refuses
a fifth. `modelSelectionFrom` had no tests at all, which is the other half of why it shipped.

Two things came out of writing those tests:

- **The manifest's `modelPolicy` was not a `ModelPolicy`.** It was `{ modelId: … }` behind an
  `as unknown as` cast, and the cast hid both that `ModelPolicy` has no `modelId` field and that its one
  required field, `role`, was missing. Inert today — this app always passes its own `resolveModel`, and the
  platform only falls back to `registry.resolve(manifest.modelPolicy)` when nothing does — but inert is not
  harmless. It is `{ role: "smart" }` now, and the platform's own comment says why that is the right shape:
  *"Agents never name a model, so re-pointing a role here changes no agent code."*
- **A blank provider is still refused, not defaulted.** The first version of the fix applied `optionalEnv`
  to `RETINUE_MODEL_PROVIDER` too, and `module.test.ts` caught it. The two variables differ: an absent model
  id has a safe provider-specific default, an absent provider does not, because the key is already set and
  keys are provider-specific — defaulting to `openai` would send a Google key to OpenAI and fail inside the
  first model call rather than at boot.

Also confirmed live, and worth stating: `search_web` answers `{"searched":false,"reason":"not-configured"}`
on this deployment, because no search provider is configured there. That is the honest degradation working
end to end — and it means `suggest_campaign_ideas` and `generate_campaign --researchFirst` will report
`trendGrounded: false` until a provider is set.

### The web routes that now speak to this backend

Repointing is per route and per workspace: each one resolves `assistant_runtime_flags` for its workflow and
takes the agentkit path only when the flag says so, which is nobody until someone sets it. Every repointed
route answers with `X-Assistant-Runtime: agentkit` so a response can be attributed afterwards, and each
adapter's own file carries the table of what maps and what is refused.

| Route | Tool | Workflow flag | Note |
|---|---|---|---|
| `POST /api/ai/generate` | `generate_content` | `create-post` | refuses a missing platform and `variants > 1`; `hashtags` comes back empty by design |
| `POST /api/ai/campaign/suggest` | `suggest_campaign_ideas` | `campaign-planning` | `media_type: none` maps to `text`, an empty channel list is omitted rather than sent |
| `POST /api/ai/campaign/evaluate` | `evaluate_campaign` | `campaign-planning` | **the stats block is not sent** — the tool reads the metrics itself |
| `POST /api/ai/campaign` | `generate_campaign` | `campaign-planning` | refuses when the request carries the strategy layer — see below |
| `POST /api/ai/vision` | `describe_image` | `media` | takes `mediaPath` and signs it in-process; the container holds no Supabase key |
| `POST /api/ai/capture` | `capture_website` | `research` | refuses search-then-capture: the tool captures a URL, it does not find one |
| `POST /api/ai/generate-media` | `enhance_media_prompt`, `plan_video_scenes` | `media` | refuses with no platform |
| MCP `repurpose`, `describe_image`, `generate` | the same three tools | per that tool's workflow | `web/src/lib/mcp/server.ts`, a `retained` surface |

`POST /api/ai/campaign`'s blocker is half gone. `postCountFor` caps a campaign at 31 posts and
`generate_campaign` accepted at most `MAX_ANGLES` (6), because *"beyond a handful they stop being distinct,
which is the point of them"* — so a daily month-long campaign could not be planned at all. It now **batches**:
up to `MAX_CAMPAIGN_POSTS` (31) posts in chunks of six, each batch told which angles are already covered, and
it stops when a batch returns nothing new. The angle ceiling is intact and the month-long campaign is
reachable.

What remains is the **strategy layer** — persona, primary goal, a template's funnel plan — which has no
equivalent in the tool. The route refuses those requests with a 422 naming `funnel_stage` rather than serving
them, because a repoint that silently dropped it would return a campaign that looks complete and has lost the
thing a funnel template exists to set.

### The interaction surface

Three routes, and they were named 501s until the platform's question and approval services were wired through
to HTTP:

| Route | Answers |
|---|---|
| `POST /api/interactions/:id/answer` | `{ ok, resumed }` — record answers and wake the parked run |
| `POST /api/interactions/:id/decide` | `{ ok, resumed, granted }` — record a decision, maybe issue a grant, wake the run |
| `POST /api/runs/:id/cancel` | `{ ok, requested, status }` — record a cancellation request |

The 501s said what the work was, and it was accurate: answering is not a row to write, it is *waking a parked
run*. What made it a wiring job in the end is that `createQuestionService` and `createApprovalService` already
held a `RunStore` in this app's composition — and the platform's own comment explains why that matters,
because without it *"the resume enqueues a run the worker cannot claim, and the run waits forever"*.

Four things these routes do that a thinner version would not:

- **The tenant comes from the caller, never from the body or the path.** An interaction id is opaque and
  arrives from the client, so this is the check that makes accepting one safe: without it, one workspace could
  decide another's approval. The sabotage run caught a test that asserted this and could not have failed — it
  sent no competing tenant, so a body-trusting route passed it.
- **An unknown decision is a 400, validated against the platform's own `APPROVAL_DECISIONS`.** Only *allow*
  decisions authorize the stored call, so a typo forwarded through would be recorded, read as "not an allow",
  and resume the run as a denial — the person clicked approve, the tool did not run, and nothing said why.
- **Answers are validated, not cast.** They are handed to the model as somebody's reply, so
  `{ tone: { nested: true } }` would reach the prompt as `[object Object]`. An empty multi-select is refused
  too: it means nobody chose anything, and recording it resumes the run believing it was told something.
- **`requested`, not `cancelled`.** Cancellation is cooperative — the worker observes the request — so a
  client told a run had stopped and then watching three more tool calls arrive has been lied to.

### `/reply`, and the mapping that was wrong rather than missing

`route:POST /reply` was the last endpoint with no successor, and the inventory said otherwise: it named
`draft_comment_reply` as the replacement and read `implemented`. That tool stores a draft against a
comment **already in the inbox** for a person to approve. `/reply` *classifies* an inbound comment
against `bot_rules` and answers `{reply, confidence, ruleTitle, escalate, lead}` for the ingest cycle
to act on — and the confidence is what gates auto-send, which no tool produced.

So the tally was right and one of its mappings pointed at a different capability. That is the harder
error to see than a missing row, and it surfaced only when removing `ai_backend` forced a reading of
what each remaining endpoint actually did. The entry is corrected and `draft_comment_reply` now has no
entry at all, which is right for a *parity* inventory: it replaces nothing in `ai_backend`, and the
manifest scan refused the old-runtime ref when one was invented for it.

**Almost none of `/reply` was a model call.** Rule matching, confidence, escalation, lead detection and
every language, style and persona signal are keyword heuristics; only the reply prose goes through a
model. `src/reply/auto-reply.ts` is a transcription of them, kept separate from the model call for the
reason the Python kept it separate: it is testable without one, and what it decides is whether a reply
reaches a stranger's public comment with nobody having read it.

Which is why it is verified twice. 45 tests ported from `ai_backend/tests/test_reply_agent.py` with
their assertion strings intact, and a **differential run against the real Python source** — the module
imported with its pydantic models stubbed, both implementations over the same 638 values (topics, rule
match, confidence, lead, language and style signals): **0 differences**. The parity tests alone would
not have been enough; they all passed on the first run, which for a transcription is a reason for
suspicion rather than confidence.

Three transcription traps the differential run and the sabotages between them caught or confirmed:

- **`\w` is not `\w`.** Python's `re.UNICODE` word class counts Urdu letters; JavaScript's `\w` is
  ASCII-only. The naive translation reads a written Urdu sentence as having *zero* words and labels it
  "emoji-only" — in the branch that decides whether the reply may be emoji.
- **`or` is not `??`.** `tone or 'friendly'` treats `""` as absent and `??` does not, so a blank tone
  would have reached the prompt as `Tone: `.
- **The odd clauses are kept.** `scoreConfidence` adds 0.1 for non-empty text when the text is already
  known non-empty, so a topic-overlapping match scores exactly 1.0 and a non-overlapping one 0.7.
  Transcribed rather than tidied: the deployed thresholds were set against those numbers.

The `escalate` flag fails **closed** on the way back. Every other degraded field in the web adapter
falls to a safe default; an unreadable `escalate` becomes `true`, because that flag blocks auto-send
regardless of confidence — a wrong `true` costs a person reading a comment, and a wrong `false`
auto-answers a refund complaint. A confidence that is not a number drops the draft entirely rather than
being coerced, since `'1' >= 0.7` is true in JavaScript.

One behaviour change, stated rather than inferred: the agentkit path sends **no BYO model override**.
Per-workspace models are out of scope for the cutover by decision and `draft_auto_reply` has no
parameter for one, so a workspace with its own text provider drafts on the platform model once its flag
flips.

The adapter also lives in its own module, `autoReplyViaAgentkit.ts`, rather than beside its six
siblings in `toolsViaAgentkit.ts`. Those serve `/api/ai/*` routes and may use `@/` aliases; this one is
called by the **worker**, which runs under `node --experimental-strip-types` and resolves neither
aliases nor extensionless relative imports. Putting it with the others pulled the route module into the
worker's import graph, and `worker-imports.test.ts` found two imports it could not load — including a
pre-existing one that had been harmless until the graph reached it.

### The removal

`ai_backend` is gone: the compose service, the CI job, `web`'s `depends_on`, both services'
`AI_BACKEND_URL`, and the 81-file Python tree. Its source is readable at **`a085917c`** — the scan
scripts' refusal message says so, because they are the thing that needs it.

Removing the container was the easy part. Four things had to go with it:

**The legacy chat, and 74 files behind it.** `/assistant/legacy` was the rollback, and its own plumbing
(`/api/assistant/{runs,continue,sessions,components}`) was three of the four remaining `ai_backend`
callers. An import-graph pass over real import statements — comments stripped, so a module named in
prose is not an edge — found **49 modules** reachable only from those entry points: the whole
`AssistantChat` component tree, `parseEvent`, `messageReducer`, `sse`, `agentkitTurn`, `client.ts`,
`urlState`, and 17 test files whose subject no longer existed.

One of the 49 had to be kept, and finding it is the reason the pass was worth writing: `deepMerge.ts`
is imported by `src/i18n/request.ts`, which **Next loads by convention rather than by import**, so the
graph called it unreachable and it is not. Every other candidate was verified the same way — by listing
its real importers and checking each one was itself inside the deletion set.

**The per-workspace flag.** `assistant_runtime_flags` chose between two runtimes; with one, a flag
saying `agno` names a process that does not exist — and since that table has no rows, *every* workspace
resolved exactly that way. Keeping the read would have pointed all six at a deleted container. So
`runtimeFlag.ts` and its two test files are gone and every call site now checks only whether the
backend is **configured**, answering a 503 that names `ASSISTANT_AGENTKIT_URL` when it is not. The
table itself is now unused; dropping it is a migration, not a code change.

**Two callers that had never been repointed**, and both were invisible to the check that should have
found them. `web/src/lib/mcp/server.ts`'s campaign helper and `web/src/lib/campaign/planJob.ts` called
`ai_backend` **unconditionally** — no flag read at all — and the flag-call-site scan looked for flag
*reads*. A call site with no flag to read did not appear in it. Both are repointed;
`planJob` calls the tool endpoint directly because it runs in the plain-Node worker, which resolves
neither `@/` aliases nor extensionless relative imports.

#### The measurement apparatus went too, and one table was already polluted

`PARITY_RECORDING=1` was **live on the box**, and the recorder it gates wraps every
`/api/internal/*` route. Those routes are now called by `shareflow` — so the recorder was writing the
**new** runtime's writes into `agno_parity_turns` as if they were the old runtime's baseline. Three
such rows landed there from a verification probe (`store-media`, all with `run_id: null`) before this
was noticed, taking the table from 4 rows to 7.

A measurement apparatus that cannot tell its subject from its control is worse than none, and its
baseline no longer exists in any case, so `recorded()` is unwrapped from all 16 routes and
`parity-recorder.ts` is deleted. `shadowRun.ts` went with it — a shadow run exists to be compared
against the runtime it shadows, and `assistant_shadow_runs` held 0 rows and never held more. Its
`SuppressedWrite` type moved into `agentkitClient.ts`, because `shadowTurn` still usefully reports
which writes a run *would* have made.

`supabase/migrations/20260909060000_drop_agno_schema.sql` dropped the rest, **applied 2026-09-09**:
the `ai` schema, `agno_parity_turns`, and the three flag/shadow tables. 311 rows — including 242
memories and 49 sessions — were dumped to `~/social_share/backups/agno-schema-dump-20260909.json`
(82 MB) first, because irreversible and unrecoverable are not the same thing.

**Six relations went unbacked, and the migration header says so.** The `ai` schema held **14**
relations; the backup script iterated a *hardcoded list* of 8 instead of querying
`information_schema`, and the listing I checked it against had been truncated by a `tail -14`, so the
count mismatch was invisible until the apply printed `ai_tables: 14`. The six are recoverable by
*name* from `ai.agno_schema_versions` — Agno's own ledger, which was in the backup —
and their contents are not. The migration records which they were and the evidence that they were
empty or code-derived: four have no reference anywhere in `ai_backend/`, `agno_knowledge` is mentioned
only in a prose comment (the Knowledge API is never constructed), and `agno_components` held AgentOS's
registration of the nine agents, derived from Python still readable at `a085917c`. Evidence, not
proof — Supabase PITR before ~04:45 UTC is the only source that still has them.

The lesson is small and cheap: **enumerate from the catalogue, not from a list you typed**, and do not
verify a count through a pipe that can truncate it.

**The migration names two tables it must not touch**, and that is the most useful line in it:
`public.assistant_artifacts` and `public.assistant_artifact_versions` match the same `assistant_%`
prefix and belong to the **new** runtime — they are the store behind `/api/internal/artifacts` and
REQ-041's document tools, and one of them has a row in it. A future sweep of "leftover `assistant_%`
tables from the cutover" is exactly how that data gets deleted, so the migration says so explicitly.

#### What the removal cost, stated rather than buried

`/api/ai/generate`'s Agno path assembled context that `generate_content` has no parameter for, so
three things are gone:

| Lost | What it did |
|---|---|
| REQ-012 | Folded the workspace's own performance signal in, so generation learned from what actually performed |
| REQ-013 | Few-shot examples drawn from its best approved posts |
| REQ-016 | The resolved per-platform tailoring rules — the tool writes "for that platform's conventions", a weaker model-side version |

The brand itself is **not** lost: `generate_content` reads it through `config.brand(context)`.
REQ-014's ranked variants are gone too — the adapter refuses `variants > 1` rather than returning one
where several were asked for. REQ-018's funnel plan is refused rather than dropped, in all four places
that can carry one, so a campaign never comes back looking complete with every stage null. And REQ-017's
token-and-tool-call billing becomes per-post: it measured a planner with its own 15-call budget, and
one tool call's usage is already recorded in the platform's own store.

All of these were already absent for any workspace on the new runtime, and none was recorded as a gap —
the inventory said `generate_content` replaces `route:POST /generate` and marked it `implemented`. That
is the same class of error as the `/reply` mapping below: a replacement named for a capability it only
partly covers.

#### One bug the removal introduced, and where it was caught

Moving `/api/ai/generate`'s call from *above* the credit gate to where the `ai_backend` fetch had been
was not tidying. The agentkit branch had sat before the gate and returned directly, so a workspace on
the new runtime generated **unmetered, with no `agent_runs` row** — harmless while the flag was unset
and nobody was on it, permanent the moment it became the only path. It now runs inside the gate, the
audit row and the credit decrement, exactly where the old fetch did.

### `/llm/validate` moved rather than being deleted

It is a dropped feature by the BYO decision, and it is also a **button somebody clicks** on the
settings page, next to a badge stored in `workspace_llm_configs.status`. Deleting the route would have
left the button 404ing and the badge frozen, which is worse than one more module — so the validation
moved into `web` and the `ai_backend` hop is gone.

One tiny completion per provider, which is what Agno did (`agent.arun(input="ping")`), and it matters
that it is a *completion*: a models-list call validates the key and says nothing about the model id,
which is the second most common way a BYO config is wrong. `max_tokens: 1`, so it is near-free. The
four providers and their default models are transcribed from `app/llm/registry.py`, environment
variable names included, so a deployment that pinned a BYO model keeps its pin.

Two things this version does that the old path did not:

- **The Google key goes in a header**, not `?key=…`. The query-string form is the more commonly
  documented one and it writes the API key into every access log and proxy trace that records a
  request line.
- **The base URL is guarded.** `self_hosted` means the server fetches a URL a person typed, and that
  was already true — the old route forwarded `base_url` to `ai_backend`, which fetched it unchecked —
  but moving the fetch into `web` moves it *inside the compose network*, next to `shareflow`, `redis`
  and the cloud metadata endpoint. `assertPublicUrl` **resolves** the host and refuses loopback,
  private, CGNAT, link-local and unique-local addresses, because the attacks that matter are names:
  `127.0.0.1.nip.io` is a public-looking hostname resolving to loopback, and a textual check on
  `127.0.0.1` catches only the examples nobody uses. Every resolved address is checked, not the first.
  Redirects are refused rather than followed, since a followed redirect carries the `Authorization`
  header to whatever host the response names — the same hole one hop later. It is admin-only, which
  lowers the severity and does not remove it.

### The chat is the package's now

`/assistant` renders `@retinue/react`. It was built at `/assistant/next` first so both could run on one
workspace, and that route is gone; the Agno chat stays at `/assistant/legacy` until `ai_backend` does, because
a rollback that needs a deploy is not a rollback.

**This moves every workspace's chat onto the new runtime, and it does so outside the flag.**
`assistant_runtime_flags` governs the seven repointed *tool* routes — each resolves its workflow's flag per
workspace and takes the agentkit path only when the flag says so. The chat has no such switch, because the
route choice *is* the choice: the old chat talks to Agno and this one talks to `/api/assistant/agentkit/*`,
and there is no third thing for a flag to select. So the flag still gates the tool routes and the chat is
cut over for all six workspaces as of this commit. `/assistant/legacy` is the fallback, and it needs no
deploy to reach.

What the package replaces is roughly 480 lines of hand-rolled stream folding — `parseEvent.ts`,
`messageReducer.ts`, `sse.ts` — plus `agentkitTurn.ts`'s translation layer, which existed only because the old
UI was written against Agno's frame shape. The package's buffer also promises something the hand-rolled
version never did: a reconnect resumes from a cursor, where the old one reconnected from zero and re-rendered
the turn.

Two things are worth recording about the integration:

- **The URL carries the conversation** (`/assistant/c/<uuid>`), written with `history.replaceState`. Holding
  the id only in component state would have reintroduced exactly the bug the old catch-all route was built to
  fix: a refresh landing you in a brand-new chat. The old three-segment shapes resolve to a new conversation
  rather than erroring, because the uuid in them names an **Agno session** — a row in a different store that
  this runtime cannot read and the cutover removes.
- **Multi-select answers do not go through the package.** `RetinueClient.answerQuestion` declares
  `answers: Record<string, string>` while the platform's `QuestionAnswer` is `string | readonly string[]`, so
  the interface is narrower than the runtime behind it and a `multiple` question cannot be answered through it
  at all. `answerQuestionWithLists` posts to the same route with the array intact. Joining the choices was the
  tempting workaround and it is wrong: the backend would record `"instagram, linkedin"` as one literal answer
  and tell the model the person picked a single option with a comma in its name.

### Decisions of 2026-09-08 — full replacement, and how replay is measured

Four decisions, recorded here because the inventory carries statuses and not reasons.

**1. `ai_backend` is replaced completely.** No partial cutover, no cluster left behind. Every one of the 19
unreplaced capabilities gets built — including the five I recommended leaving on Agno (diagrams, PDFs,
`/vision/describe`, `/capture`, `/plan-video-scenes`) and the five campaign/repurpose endpoints. Nothing
further is dropped.

**2. Replay restores a snapshot.** The recorder logs each old-runtime turn against a database snapshot taken
when recording starts; the replay restores that snapshot and runs the same turn through the new runtime in
shadow mode. So the reads are identical and **any write-set difference is the runtime** rather than the world
having moved. The alternative — logging the read set and discarding runs whose reads changed — needs no
snapshot but throws away sample size on exactly the busy workspaces worth measuring.

**3. `skills/mermaid-diagrams` flips to `active` when `render_diagram` ships**, for the same reason
`document-generation` did: a skill describing tools that do not exist instructs the model into nothing, and
tools shipping without their instructions is the AC-5 defect.

**4. The reply review step is built.** `POST /reply` drafts into `needs_review` and sends nothing;
`reply_to_comment` sends. They are different capabilities and the queue where a human looks first is kept.

## The premise that changed, and what it bears on

The decision above came with a fact that was not on the table when the eight drops were signed on
2026-09-07: **there are no public users yet — the platform is in testing.**

That matters, because the case for each of those eight was partly that dropping them removes capability *a
user has today*. Two are worth revisiting on the new premise rather than left standing on the old one:

- **`update_branding`** is the only writer of `workspace_ai_profile` anywhere in the product. After the
  cutover, `brand_voice`, `audience` and `custom_instructions` can be changed only in the database — and six
  generation routes read them.
- **the four agent-skill tools** are the only surface `workspace_agent_skills` has. Per-workspace custom
  skills stop being editable at all.

Neither drop is wrong. Both were signed knowing the cost — it is written into `droppedBy.reason`. But a
signature given for "no user loses this" reads differently from one given for "no user exists yet", and the
second is the one that is now true. Reversing either is a one-line status change plus a tool; leaving them
dropped is equally defensible. It is a decision, and it should be made on the premise that holds.

### The three that were a tool away

`create_artifact`, `update_artifact` and `get_artifact`, built once the inventory said what they needed.
`assistant_artifacts`, `assistant_artifact_versions` and the `chorus-artifact:` scheme were already in
ShareFlow; what was missing was an `ArtifactService`, a Postgres adapter and three tools. Eleven services now,
forty tools.

**It reads ShareFlow's table, not the platform's.** `@retinue/agentkit` ships its own `createArtifactService`
and using it would have been less code and the wrong rows: every `chorus-artifact:` link in a customer's chat
history resolves against an `assistant_artifacts` id, so a replacement writing elsewhere would leave all of
them dead while reporting a migrated capability.

**Archive before update, now under a lock.** The old lib's invariant is kept exactly — *"the OLD content is
archived before the update, not after — if the archive write fails, the revision is refused and the previous
version is still intact"*. What is added is `select … for update`. The old path reads, archives and updates on
separate connections, so two concurrent revisions both read version 1 and both try to archive version 1;
`assistant_artifact_versions_artifact_id_version_key` refuses the second, which means **the old safety was the
unique index rather than the sequencing**, and that caller got a 500 for a queueing problem. Under the lock the
second writer waits, sees version 2 and produces version 3. That difference is recorded on the inventory entry
rather than smoothed over.

**One side effect no port mentions.** The old runtime writes an `audit_log` row from every internal write, and
ShareFlow's `/audit` screen reads that table. No adapter in this package did. The artifact adapter does, best
effort, following the app's own rule that *"an audit write must never break the action it records"* — and the
gap for the other ten adapters is a finding rather than something this change fixed.

**The skill was `draft` because these three did not exist.** `skills/document-generation` was migrated and
held out of discovery with a comment naming `create_artifact`, `update_artifact` and `get_artifact` as the
reason. It is `active` now. Leaving it would have been the AC-5 defect in its purest form: three replaced tools
running without the instructions the old runtime ran them under, producing identical write sets on every run
where the guidance did not happen to change a decision. Its body names no tool, so `generate_pdf` being
absent at the time made nothing in it false; both exist now. `mermaid-diagrams` went `active` in the same
change that built `render_diagram`, and it had to: the prompt's `diagram-files` clause says *"ALWAYS load the
`mermaid-diagrams` skill before turning a diagram into a file"*, and a prompt naming a skill discovery hides
is its own instruction into nothing. **No skill is `draft` any more** — the mechanism stays, exercised by the
test that resolves a body by exact version the way a pinned run does.

**A new parity gate, unsigned.** The three name a `documents` workflow, which is a gate that now exists with
`status: "proposed"`. The alternative was giving them no workflow, which would have put three *replaced* tools
in the same position as the 19 nothing measures — and a capability no threshold covers cannot fail, which is
worse than failing. It stays proposed because it is the first gate written *after* shadow data existed:
agreeing a threshold now is what #128 AC-1 forbids, so `gate-not-agreed` blocks until somebody signs it having
looked at the runs. It is the only unsigned gate, and a test pins that.

### `repost_post` and `delete_post` — and the first complete workflow

Both were `requires_confirmation=True` in the old runtime and both are now replaced, over
`scheduled_items` and a connector seam that already existed. **42 tools.**

**A repost duplicates.** Not a stylistic choice — the old tool's docstring states the constraint: *"The
platform APIs cannot edit or re-publish a live post, so this DUPLICATES the content into a new post and
publishes that — the original stays intact with its own history and metrics."* Keeping the original is the
point; its engagement numbers belong to it. It is a service method rather than two tool calls for a related
reason: `duplicate_post_draft` then `publish_post_now` is the same two writes, but a model doing it across two
turns can duplicate and then fail to publish, leaving an orphan draft nobody asked for.

Its default is **narrower than the destinations the original was sent to** — only the ones it published to
*successfully*. A target that failed the first time is not silently retried under cover of a repost;
`retry_publish_target` is the tool for that, per target. And a post with no successful target is **refused**
rather than treated as a first publish, because otherwise a model reaches for `repost_post` when the honest
tool is `publish_post_now`, whose validation and approval it would then have skipped.

**A delete asks the platforms first, and keeps the record when any of them still has a copy.** Partial
deletion is the normal case rather than the error case — TikTok has no delete API, Instagram refuses ads and
single items inside a carousel — so the result is per platform and `removedFromDatabase` is true only when
every one confirmed. A live post with no row is a post nobody can find again, which is worse than a row for a
post that is half gone. A connector that *throws* is recorded exactly like one that refuses, because both mean
the copy is still live and `stillLive` must not be able to miss one.

It is the only **`destructive`** tool in the package. `defineTool` derives `approvalPolicy: "always"` and a
required idempotency key from that, so the old decorator's flag becomes an effect the gate reads.

**`publish` is now the first workflow whose every capability is built** — 7 of 7. It is also the
highest-consequence one, an irreversible external write against REQ-021's *"zero unauthorized or duplicate
actions"*, so it is the gate whose becoming measurable matters most. A test asserts it, so the milestone
cannot regress quietly.

### The eight drops, and what two of them cost

A drop needs a name, a date and a reason as data, because a capability removed silently is a customer's
workflow removed silently. Signed on 2026-09-07:

- **`get_branding`, `update_branding`, `list_agent_skills`, `save_agent_skill`, `delete_agent_skill`,
  `set_agent_skill_enabled`** — the new runtime ships skills as versioned code, reviewed and deployed rather
  than written in a chat turn, and reaches the brand as context.
- **`POST /llm/validate`, `POST /assistant/session-name`** — not ShareFlow agent capabilities.

Two of those signatures say what is given up rather than where it went, and the difference matters because
"it moved to the UI" would be false in both cases:

- **`update_branding` is the only writer of `workspace_ai_profile` in the product.** The white-label settings
  screen writes `workspace_branding` — a brand name, a logo, an accent colour — which is a different table,
  and `web/src/lib/mcp/server.ts` only reads the AI profile. Six generation routes read `brand_voice`,
  `audience` and `custom_instructions` from it. After the cutover those fields can be changed only in the
  database until the web app grows an editor.
- **`workspace_agent_skills` has no UI at all.** The four Agno tools are its only surface, so per-workspace
  custom skills stop being editable rather than moving elsewhere.

`dropped` does **not** block a workflow verdict — the control on a drop is the signature, not the gate — which
makes signing one a way to turn a blocking capability into a passing one. All eight name no workflow, so no
verdict moved, and a test asserts that: if a later drop covers something a gate measures, it fails and somebody
has to decide whether the gate still means anything.

A dropped entry is asked for no `coverageEvidence`, and that exemption is deliberate rather than convenient.
Two of the eight are `triggered` routes, and the text they used to carry — *"the cutover runbook has to carry
it"* — became false the moment somebody signed them off. A stale reassurance is worse than a blank. Removing
the signature still fails.

### The verdict was unreachable from the report

The defect this REQ found in its own predecessor. #194 built the `incomplete` verdict, tested it through
`evaluateWorkflow`'s optional `capabilities` argument, and wired the inventory into `canRemoveOldRuntime`. But
`evaluateParity` — the only function `parity-report.mjs` calls — **never passed capabilities**. Every workflow
was evaluated against an empty list, the report had a `○` symbol nothing could produce, and a workflow whose
tools are not built reported on the rate.

`evaluateParity`'s second argument is required now, not defaulted: a default of `[]` is the same silence with a
nicer signature. Each gate sees the entries naming its workflow, which is what `CapabilityEntry.workflows` is
for, and both directions are asserted — every name must be a real gate, and every measurable gate must be named
by at least one entry. 19 of the 51 name **no** workflow at all: PDFs, diagrams, branding, the agent-skill
tools. No threshold measures them, so nothing about them can fail, which is worse than failing — the report
prints them rather than letting an empty list read as nothing to do.

### The approval requirement, compared rather than asserted

The most extractable part of the old runtime's observable contract, and the one whose loss is invisible: a
runtime asking for **fewer** approvals looks like an improvement in every metric anyone plots.

Nine of the old tools are `@tool(requires_confirmation=True)`. `approvalParity` compares each against the new
tool's `approvalPolicy`, read off the **built descriptor** — `defineTool` derives it from `effect`, so
relabelling `publish_post_now` as `internal-write` to skip a prompt moves the number rather than leaving a
hand-maintained list saying yes:

| verdict | |
|---|---|
| `held` (3) | `publish_now`, `schedule_post`, `reply_to_comment` — all `external-write`, all still gated |
| `no-replacement` (6) | `repost_post`, `delete_post`, `update_branding` and the three agent-skill writes |
| `lost` (0) | the only verdict that is a defect |

Deliberately one-directional. A new tool requiring approval where the old one did not is a stricter product, and
failing that would turn the check into pressure to relax the gate.

`absent` and `false` are kept as separate facts: 9 of the 31 tools never state `requires_confirmation`, and the
derived boolean uses the old runtime's **own** reading of the default — `getattr(fn, "requires_confirmation",
False)` in `ai_backend/tests/assistant/test_factory_and_studio.py` — rather than an assumption made here.

### What no comparison can decide

Both runtimes carry the same seven skills, by name, and `skillParity` checks it — a tool-for-tool match under
different instructions is a different product, and that difference produces identical write sets on every run
where the missing guidance did not happen to change a decision.

Eleven ship. The seven are the parity set and the number `skillParity` is about; four more —
`campaign-planning`, `comment-triage`, `lead-capture`, `account-connection` — were written for this package
because four whole tool groups arrived with no skill at all: nine campaign tools, five engagement, three lead,
three account. They are deliberately *not* in the parity claim, because the old runtime had nothing to compare
them against, and folding them in would turn a checked statement about two runtimes into an unchecked one.
See `skills/workflows.ts`, which also records the constraint that shaped them: every tool a skill names must be
preloaded, and preloading all 58 is the empty-answer bug.

The composition cannot be checked, only recorded. The old runtime is nine components: a generalist, a studio
agent, six role-scoped specialists and a coordinating team, each with its own instructions and its own subset of
the tools. This package is one assistant holding all 37. On any run where the old leader would have routed to the
member that owns the work, both runtimes call the same tool and write the same rows, and the gate reads
agreement. `compositionFinding` states it; nothing measures it.

### The reference scan could not run

Not part of this REQ, found while writing it, and worth recording because it is the same shape. `canRemoveOldRuntime`
takes a `remainingReferences` count and refuses to treat an absent one as zero; `scan-old-runtime.mjs` exists to
produce that number. Its default root resolved one directory too far up, onto a decoy `social_integgration`
holding only `supabase/` — so the configured roots were absent, the scan refused, and **the only outcome it could
produce was "could not scan"**. Its docstring then generalised the wrong constant into a claim that `web/src` and
`ai_backend/app` do not exist anywhere.

Both scans resolve the root by looking for the directories they need now, and an explicit `--root` is the only
candidate when one is given — falling through from a named path to a guessed sibling meant answering about a
repository the operator did not ask about. The scan reports **71 referencing files against a baseline of 71**.
