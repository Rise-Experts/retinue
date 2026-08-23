# `@agentkit/shareflow`

The ShareFlow integration. ShareFlow is the platform's first consumer and stays outside the generic
packages: `docs/01-architecture.md` requires those to *"build and test without ShareFlow or Twenty
installed"*, and product-specific names *"live only in that application's integration package."*

This package depends on `@agentkit/backend`. Nothing generic depends on it — R8 in
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
| `tools/` | the `ToolProvider` and the closed category vocabulary from docs/07 |
| `context/` | the eight providers from docs/07, the shared section builder, and the forbidden-claim checker |
| `skills/` | the seven migrated skill bodies, validated at import time by the platform's own validator |
| `manifests/` | the Social Assistant — `id` neutral, branding in the display name |

Nothing under `tools/` performs I/O; a ShareFlow tool is the envelope from `defineDelegatingTool` over
a service method, and R7 fails the build on an attempt.

## Wiring it up

ShareFlow supplies the implementations and registers the provider:

```ts
import { createShareFlowToolProvider, type ShareFlowServices } from "@agentkit/shareflow";

const services: ShareFlowServices = {
  connectors: myConnectorAdapter,   // implemented in the ShareFlow app
  content: myContentAdapter,
  media: myMediaAdapter,
  publishing: myPublishingAdapter,
};

const provider = createShareFlowToolProvider({ services, factories: [/* #115 onward */] });
```

Registration validates at construction: a duplicate tool name or a category outside the vocabulary
stops the process starting, rather than producing a confusing catalog on someone's first conversation.

## Status

The seam and the scaffolding (#114); Posts (#115); Campaigns (#116); Accounts (#117); Media (#118);
Publishing (#119); Engagement and Leads (#120); context providers (#121); the seven skills (#122).
Content generation, research and analytics land in #123–#125.

`npm test` in this workspace runs `tsc -b` first. That is deliberate: this package value-imports
`@agentkit/backend`, whose entry point is `dist/`, so `vitest run` on its own tests whatever was last
built — see the note in `vitest.config.ts`.
