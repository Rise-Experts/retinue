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
| `context/` | the shared `ContextSection` builder for docs/07's context providers |
| `skills/` | built-in skills, validated at import time by the platform's own validator |
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
Publishing (#119). Engagement, research and analytics land in #120–#125.

`npm test` in this workspace runs `tsc -b` first. That is deliberate: this package value-imports
`@agentkit/backend`, whose entry point is `dist/`, so `vitest run` on its own tests whatever was last
built — see the note in `vitest.config.ts`.
