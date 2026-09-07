# `@retinue/shareflow`

The ShareFlow integration. ShareFlow is the platform's first consumer and stays outside the generic
packages: `docs/01-architecture.md` requires those to *"build and test without ShareFlow or Twenty
installed"*, and product-specific names *"live only in that application's integration package."*

This package depends on `@retinue/agentkit`. Nothing generic depends on it — R8 in
`../scripts/check-boundaries.mjs` fails the build if that reverses.

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
| `research` (#124) | `search_web`, `read_source` | `read` |
| `analytics` (#125) | `get_post_metrics`, `get_campaign_metrics`, `get_attribution` | `read` |
| | `create_post_draft`, `update_post_draft`, `duplicate_post_draft` | `internal-write` |
| `campaigns` (#116) | `list_campaigns`, `get_campaign`, `get_campaign_calendar` | `read` |
| | `create_campaign`, `update_campaign` | `internal-write` |
| `accounts` (#117) | `list_accounts`, `check_account_health`, `get_connection_setup` | `read` |
| `media` (#118) | `list_media`, `inspect_media`, `check_media_for_platforms` | `read` |
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

Three of the ten services now have adapters in this package. `content` and `brand` read ShareFlow's own
tables through a `SqlExecutor`; `generator` fronts the host's model, because it is the one capability with
no table behind it.

```ts
import { createShareFlowServices, backedContextProviders } from "@retinue/shareflow";

const services = createShareFlowServices({ sql, generate });
const providers = backedContextProviders(services);
```

The other seven — `connectors`, `media`, `publishing`, `engagement`, `leads`, `research`, `analytics` —
are still ports, and `createShareFlowServices` returns a **narrower type** rather than a ten-member object
whose missing members throw. That is a measured decision, not caution: `backend/src/context/assembler.ts:35`
runs context providers in a bare `for` loop with no `try`, and `createAccountsContextProvider` calls
`services.connectors.listAccounts` on every turn — so a declare-and-throw object plus the standard base
providers is a deployment where every turn dies before the model is called. `backedContextProviders` is the
base list minus that one provider, and the omission is deliberate: such an assistant does not know which
destinations are connected and may propose posting somewhere the workspace cannot, which is the honest
state of a partial rollout.

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

That is what makes a partial rollout representable: twelve of the thirty-seven capabilities read only the
three implemented services — the five post tools, the five campaign tools and the two generation tools — so a
deployment can serve those and nothing else.

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

`npm test` in this workspace runs `tsc -b` first. That is deliberate: this package value-imports
`@retinue/agentkit`, whose entry point is `dist/`, so `vitest run` on its own tests whatever was last
built — see the note in `vitest.config.ts`.

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

### What it says today

`incomplete`. Three capabilities are genuinely not built, and all three are ones normal traffic would never have
revealed:

- **the scheduled publish itself** — `schedule_post` records the intent; the job that fires at 03:00 lives in
  `social_integgration` and nothing here replaces it. No shadow run happens at 03:00 either, so this workflow
  would have compared nothing against nothing forever.
- **the inbound comment webhook** — arrives when a platform decides, so no shadow run produces one.
- **the nightly metrics refresh** — same shape.

Everything else is `implemented` with a behavioural test against the old contract. That is a weaker claim than
parity and is meant to be: `implemented` means "a replacement exists and is tested against the old tool's
observable contract", and the gate adds "and shadow traffic exercised it". No deployment runs both runtimes yet,
so the second half is unearned by construction — which is why the file cannot assert it.
