/**
 * The service seam — AC-3.
 *
 * **The dependency is inverted, and that is the whole design.** These interfaces are *declared here*
 * and *implemented by ShareFlow* at its own wiring site. This package therefore has no import edge to
 * the application at all, which is what makes "tools depend on service interfaces, not concrete
 * application internals" structural rather than a convention someone has to remember.
 *
 * The alternative — importing `social_integgration/web/src/lib/**` — is not available and should not
 * be made available. Those modules read environment credentials at call time, use `@/…` path aliases
 * plain Node cannot resolve, and sit in a Next.js app that is not a workspace of this monorepo. R9 in
 * `scripts/check-boundaries.mjs` fails the build on an attempt.
 *
 * Three rules every port below obeys, each one a response to something the existing services actually
 * do:
 *
 * 1. **Accounts are named by id. No credential crosses.** ShareFlow's `PlatformAdapter.publish` takes
 *    `authTokens: Record<string, unknown>` — decrypted platform credentials — as an argument. A seam
 *    shaped that way would put access tokens one hop from a model prompt and one bug from a tool
 *    result. Token decryption stays inside the application, behind the account id.
 * 2. **Failure is thrown, never returned.** See `errors.ts` — a failure returned as a value gets
 *    cached by the idempotency store as that call's permanent answer.
 * 3. **Every write takes an `idempotencyKey`.** Required in the type. The existing publish path has no
 *    such parameter anywhere, so making it mandatory here turns "docs/07 asks for an idempotency key"
 *    into a compile error in the adapter rather than a duplicate post in production.
 *
 * Every method takes an `ExecutionContext` first, and the implementation must scope its query by
 * `context.tenantId`. A tenant id passed in the arguments would be a value the model can choose.
 */
import type { ExecutionContext } from "@agentkit/backend";
import type {
  CampaignId,
  InboxCommentId,
  LeadId,
  MediaAssetId,
  PlatformId,
  PostDraftId,
  PublishTargetId,
  SocialAccountId,
} from "./ids.js";

export * from "./ids.js";
export * from "./errors.js";

/** An idempotency key supplied by the envelope, opaque to the service beyond equality. */
export type ServiceIdempotencyKey = string;

// ---------------------------------------------------------------------------------------------------
// Connector service — "list destinations and connection health" (docs/07, Accounts).
// ---------------------------------------------------------------------------------------------------

/** Health as the assistant needs to reason about it, not as a provider reports it. */
export type AccountHealth = "active" | "expired" | "not-configured" | "revoked";

export type ConnectedAccount = {
  readonly id: SocialAccountId;
  readonly platformId: PlatformId;
  /**
   * Human label for the destination, e.g. a Page or channel name.
   *
   * The one field in this type that carries platform-supplied free text, and therefore the one an
   * adapter could get wrong. `tools/accounts.ts` scans it — see `assertNoSecrets`.
   */
  readonly displayName: string;
  readonly health: AccountHealth;
  /**
   * When the stored credential expires, if the platform sets an expiry.
   *
   * A timestamp, never the credential. Included because it is what lets the assistant warn *before* a
   * destination breaks rather than reporting it afterwards — ShareFlow already selects
   * `token_expires_at` for exactly that reason.
   */
  readonly accessExpiresAt?: string;
  /**
   * Set when `health` is not `active`, phrased for a person: what is wrong and what fixes it.
   *
   * **Not propagated into any tool result.** It is free prose from an adapter, and the obvious way to
   * fill it is with the provider's error message — which is where a token ends up. The agent-facing
   * remediation is a stable code plus `getConnectionSetup`'s structured payload instead. Kept on the
   * port because the app's own UI can legitimately show it.
   */
  readonly healthDetail?: string;
};

/**
 * What a platform's OAuth app needs before any account on it can connect.
 *
 * Mirrors twenty-social's `show_connection_setup` return: the redirect URL, the fields each platform's
 * developer console asks for *named as that console names them*, the scopes, and how long review takes.
 * Contains variable **names** (`META_CLIENT_ID`), never values.
 */
export type PlatformSetupGuide = {
  readonly platformId: PlatformId;
  /** Display label, which may cover more than one platform id ("Facebook and Instagram"). */
  readonly label: string;
  /** The platform's developer console. */
  readonly consoleUrl: string;
  /** Environment variable names the deployment must set. Names only. */
  readonly credentialVariables: readonly string[];
  /** Each URL the console asks for, labelled the way the console labels it. */
  readonly consoleFields: readonly { readonly label: string; readonly url: string }[];
  readonly scopes: readonly string[];
  /** What platform review is required, and roughly how long it takes. */
  readonly reviewNeeded?: string;
};

export type ConnectionSetup = {
  /** One redirect URL for every platform and workspace. */
  readonly redirectUrl: string;
  /** Where the deployment's credentials are entered. */
  readonly credentialsPageUrl: string;
  /**
   * Set when the deployment's own URL will make OAuth fail — plain http outside localhost. A real
   * condition worth surfacing: every platform refuses it, so connecting cannot work until it is fixed.
   */
  readonly warning?: string;
  readonly platforms: readonly PlatformSetupGuide[];
};

export interface ConnectorService {
  /** Destinations this principal may publish to. Filtering by permission is the app's job, not ours. */
  listAccounts(context: ExecutionContext): Promise<readonly ConnectedAccount[]>;

  /**
   * Re-check health against the platform.
   *
   * Separate from `listAccounts` because it costs a network call per account, and a tool that assembles
   * context should not pay for it.
   */
  checkHealth(
    context: ExecutionContext,
    input: { readonly accountIds: readonly SocialAccountId[] },
  ): Promise<readonly ConnectedAccount[]>;

  /**
   * What a platform needs before an account on it can connect.
   *
   * Deployment-wide rather than per account, because that is what the answer depends on: a missing
   * `META_CLIENT_ID` breaks every Facebook account at once. Wraps twenty-social's
   * `show_connection_setup`.
   */
  getConnectionSetup(context: ExecutionContext): Promise<ConnectionSetup>;
}

// ---------------------------------------------------------------------------------------------------
// Content service — the "database services": drafts and campaigns.
// ---------------------------------------------------------------------------------------------------

/**
 * Review state, in the platform's own vocabulary.
 *
 * ShareFlow's `PostStatus` is `DRAFT | IN_REVIEW | APPROVED | CHANGES_REQUESTED | PUBLISHED`; these are
 * the same states in the kebab-case docs/01 requires of a union.
 *
 * **No tool may set this.** A post's status is where ShareFlow's review policy lives — `draft.ts` is
 * explicit that routing creation through the app exists to *"keep one owner of that policy"* — and an
 * assistant that could move a post to `approved` would be approving its own content for publication.
 * Nothing in `tools/posts.ts` accepts a status, and `updateDraft`'s patch has no field for one.
 */
export const POST_DRAFT_STATUSES = [
  "draft",
  "in-review",
  "approved",
  "changes-requested",
  "published",
] as const;

export type PostDraftStatus = (typeof POST_DRAFT_STATUSES)[number];

export type PostDraft = {
  readonly id: PostDraftId;
  readonly campaignId?: CampaignId;
  readonly status: PostDraftStatus;
  /**
   * The authored post text, as stored. One caption for all destinations.
   *
   * **Not per-platform variants**, which is what this seam first assumed from docs/07 step 6's
   * "produce structured channel variants". The store holds one caption plus `target_platforms`, and
   * per-platform text is *derived* at render time (`toPlatformText`) — there is nowhere to put an
   * authored variant, so promising one here would make the adapter unwritable. Authored overrides need
   * a ShareFlow schema change; see the open question on #123.
   */
  readonly caption: string;
  readonly targetPlatforms: readonly PlatformId[];
  readonly mediaAssetIds: readonly MediaAssetId[];
  readonly updatedAt: string;
};

/**
 * What a list returns: enough to choose one, never the bodies.
 *
 * A tool result enters the model's context. One caption is bounded by platform limits and is the thing
 * the assistant has to reason about; twenty of them is a context-overflow waiting for a busy tenant.
 * So a single read returns the caption and a list returns an excerpt and the id to fetch.
 */
export type PostDraftSummary = {
  readonly id: PostDraftId;
  readonly status: PostDraftStatus;
  /** First line or so of the caption, for recognition. Never the whole body. */
  readonly excerpt: string;
  readonly captionLength: number;
  readonly targetPlatforms: readonly PlatformId[];
  readonly mediaCount: number;
  readonly updatedAt: string;
};

/**
 * The result of creating a draft, carrying two fields that exist because of failures ShareFlow already
 * had in production. Both are documented in `draft.ts`.
 */
export type CreatedPostDraft = PostDraft & {
  /**
   * Length of the caption **as stored**.
   *
   * ShareFlow's reason, verbatim: *"a model asked to repeat a long caption into a tool argument may
   * abbreviate it, and the result is a post that publishes a fragment of what the user was shown."*
   * Returning the stored length turns that from invisible into checkable.
   */
  readonly captionLength: number;
  /**
   * Attachments that were **refused** — an asset the caller may not attach.
   *
   * ShareFlow's reason, verbatim: *"Silence here is what let an assistant announce an attachment it
   * never made."* Refusals are reported, not dropped, so the tool can say which file did not attach.
   */
  readonly droppedMedia: readonly MediaAssetId[];
};

/**
 * A sparse patch: **only the fields present are touched.**
 *
 * This mirrors `EditPostPatch`, whose reason is that the composer can save a caption *"without having
 * to resend media it never loaded"*. For a model-driven caller that distinction is load-bearing in a
 * way it is not for a form: `mediaAssetIds: []` removes every attachment, and omitting the field
 * leaves them alone. Nothing here may be given a default — a default would silently wipe media on a
 * caption-only edit.
 *
 * There is deliberately no `status` field. See `PostDraftStatus`.
 */
export type PostDraftPatch = {
  readonly caption?: string;
  readonly targetPlatforms?: readonly PlatformId[];
  readonly mediaAssetIds?: readonly MediaAssetId[];
};

/**
 * Why `updateDraft` refuses, when it refuses for a reason a duplicate would solve.
 *
 * `assertEditable` has two gates, and the second is the one nobody would guess: a post to three
 * platforms can be **half-published** — its own status is not `published`, but one channel already
 * succeeded, so editing would make the record disagree with what is publicly visible.
 *
 * Carried in the error's `details` as a machine-readable remedy, because `internal/duplicate-post`
 * documents exactly what to do instead: *"duplicate, edit the copy, then publish the copy."* Without
 * it the assistant reports a dead end where a one-step recovery exists.
 */
export const EDIT_REMEDY_DUPLICATE = "duplicate-then-edit" as const;

/**
 * How often a campaign posts.
 *
 * Kebab-case per docs/01's union rule; the store's value is `3x_week`. **The adapter maps between
 * them** — noted here because it is exactly the kind of one-line translation that can go wrong
 * silently, producing a campaign whose cadence fails a CHECK constraint at insert time.
 */
export const CAMPAIGN_CADENCES = ["daily", "3x-week", "weekly"] as const;
export type CampaignCadence = (typeof CAMPAIGN_CADENCES)[number];

/** How a campaign's posts are authored. `autopilot` and `assisted` ask for generated text. */
export const CAMPAIGN_MODES = ["autopilot", "assisted", "manual"] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number];

/** Optional generated media attached to every post in the campaign. */
export const CAMPAIGN_MEDIA_TYPES = ["none", "image", "video"] as const;
export type CampaignMediaType = (typeof CAMPAIGN_MEDIA_TYPES)[number];

/**
 * Campaign lifecycle.
 *
 * **No tool may set this.** Like a post's review status, it is moved by the act of scheduling, not by
 * an edit — an assistant that could write `scheduled` would be claiming an outcome it had not produced.
 * `CampaignPatch` has no field for it.
 */
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "done"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * A calendar date, `YYYY-MM-DD`.
 *
 * Distinct from an instant, and deliberately so: `campaigns.starts_on` and `ends_on` are `date`
 * columns. A campaign runs over calendar days in the tenant's own reckoning, so an instant here would
 * force a timezone decision that nothing in the record supports.
 */
export type CalendarDate = string;

export type Campaign = {
  readonly id: CampaignId;
  readonly name: string;
  /** Required in the store. The subject the campaign's posts are about. */
  readonly theme: string;
  readonly goal?: string;
  /** Longer free-text brief, when one was supplied. */
  readonly brief?: string;
  readonly tone?: string;
  readonly startsOn: CalendarDate;
  readonly endsOn: CalendarDate;
  readonly cadence: CampaignCadence;
  readonly channels: readonly PlatformId[];
  readonly status: CampaignStatus;
  readonly mode: CampaignMode;
  readonly mediaType: CampaignMediaType;
  /**
   * How many posts this date range and cadence actually produce.
   *
   * **Computed by ShareFlow, never here.** `postCountFor` is *"capped at 31 so a runaway date range
   * can't fan out an absurd sequence"* — so "daily for the next year" is 31 posts, not 365. Without
   * this field the assistant would report a year of daily posts and have planned a month of them,
   * which is the same class of silent failure as a truncated caption. Recomputing it locally would
   * duplicate the logic the field exists to expose.
   */
  readonly plannedPostCount: number;
  readonly createdAt: string;
};

/** Enough to pick a campaign out of a list. No brief, no goal prose. */
export type CampaignSummary = {
  readonly id: CampaignId;
  readonly name: string;
  readonly theme: string;
  readonly status: CampaignStatus;
  readonly startsOn: CalendarDate;
  readonly endsOn: CalendarDate;
  readonly cadence: CampaignCadence;
  readonly channels: readonly PlatformId[];
  readonly plannedPostCount: number;
};

/**
 * A sparse patch, for the same reason `PostDraftPatch` is one: only the fields present are touched.
 *
 * No `status`, and no `plannedPostCount` — the second is derived, so accepting it would let a caller
 * assert a post count the dates do not produce.
 */
export type CampaignPatch = {
  readonly name?: string;
  readonly theme?: string;
  readonly goal?: string;
  readonly brief?: string;
  readonly tone?: string;
  readonly startsOn?: CalendarDate;
  readonly endsOn?: CalendarDate;
  readonly cadence?: CampaignCadence;
  readonly channels?: readonly PlatformId[];
  readonly mode?: CampaignMode;
  readonly mediaType?: CampaignMediaType;
};

/**
 * One entry in a campaign's content calendar.
 *
 * Two deliberate differences from ShareFlow's `toCalendarPosts`, which is otherwise the precedent —
 * it already excerpts rather than embedding (`caption.slice(0, 46)`):
 *
 * - **`scheduledAt` is the ISO instant, not a derived local date.** ShareFlow builds `YYYY-MM-DD` from
 *   `Date#getFullYear/getMonth/getDate`, which is the *server's* timezone: a post scheduled 00:30 UTC
 *   lands on the previous day for a server west of Greenwich. The frontend localizes, per docs/14.
 * - **It carries the draft's id, never the draft.** A thirty-entry calendar must not be thirty captions.
 */
export type CampaignCalendarEntry = {
  readonly postDraftId: PostDraftId;
  /** Short, single-line. For recognising the post, not for reading it. */
  readonly excerpt: string;
  readonly scheduledAt: string;
  readonly platformId: PlatformId;
  readonly state: PublishTargetStatus["state"];
};

/**
 * A page of results with an opaque cursor.
 *
 * Not an unbounded array: a tool result enters the model's context, and "list the drafts" against a
 * busy workspace would otherwise be a context-overflow waiting for a big enough tenant.
 */
export type Page<T> = {
  readonly items: readonly T[];
  readonly nextCursor?: string;
};

export interface ContentService {
  /**
   * One draft, with its caption.
   *
   * Must answer `not_found` for a draft in another tenant — **not** `forbidden`. ShareFlow's own
   * reason: *"the two must be indistinguishable, or the endpoint confirms the existence of other
   * tenants' ids."*
   */
  getDraft(context: ExecutionContext, input: { readonly id: PostDraftId }): Promise<PostDraft>;

  /** Summaries, never bodies — see `PostDraftSummary`. */
  listDrafts(
    context: ExecutionContext,
    input: {
      readonly campaignId?: CampaignId;
      readonly status?: PostDraftStatus;
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<Page<PostDraftSummary>>;

  createDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly caption: string;
      readonly targetPlatforms: readonly PlatformId[];
      readonly campaignId?: CampaignId;
      readonly mediaAssetIds?: readonly MediaAssetId[];
    },
  ): Promise<CreatedPostDraft>;

  /**
   * Apply a sparse patch to a not-yet-public draft.
   *
   * Throws `conflict` when the draft can no longer be edited, with
   * `details.remedy === EDIT_REMEDY_DUPLICATE` when duplicating would let the caller proceed.
   */
  updateDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: PostDraftId;
      readonly patch: PostDraftPatch;
    },
  ): Promise<PostDraft>;

  /**
   * Validate content that is **not saved yet**.
   *
   * AC-3 of #123 requires that nothing is saved when validation fails, and every existing validation
   * path takes a `draftId` — so there was no way to check content before it existed. This is that
   * primitive: the same `ValidationIssue[]` everything else returns, over text the store has never seen.
   *
   * Platform limits stay here, in the service, for the reason #118 and #122 both settled on:
   * `platform_rules` is workspace-overridable, so a limit known to the caller is a limit that can be
   * wrong for the workspace.
   */
  validateContent(
    context: ExecutionContext,
    input: {
      readonly caption: string;
      readonly platformIds: readonly PlatformId[];
      readonly mediaAssetIds?: readonly MediaAssetId[];
    },
  ): Promise<ValidationReport>;

  /**
   * Copy a draft into a new, editable, unpublished one.
   *
   * The original is never touched — *"its status, history, scheduled items and metrics all stay
   * intact. That is the whole point — a duplicate is safe in a way that mutating a published post
   * would not be."* Nothing is scheduled by this call.
   */
  duplicateDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: PostDraftId;
      /** Override the copy's destinations; defaults to the original's. */
      readonly targetPlatforms?: readonly PlatformId[];
    },
  ): Promise<PostDraft>;

  /** `not_found` for another tenant's campaign, for the same reason as `getDraft`. */
  getCampaign(context: ExecutionContext, input: { readonly id: CampaignId }): Promise<Campaign>;

  listCampaigns(
    context: ExecutionContext,
    input: {
      readonly status?: CampaignStatus;
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<Page<CampaignSummary>>;

  /**
   * A campaign's content calendar: its posts and when each destination is due.
   *
   * Separate from `listDrafts` because the question is different — "what is going out, and when" rather
   * than "which drafts exist" — and because the entries are per *destination*, so a post to three
   * channels is three rows with three states.
   */
  getCampaignCalendar(
    context: ExecutionContext,
    input: { readonly id: CampaignId; readonly limit: number; readonly cursor?: string },
  ): Promise<Page<CampaignCalendarEntry>>;

  /**
   * Create a campaign.
   *
   * Separate from `updateCampaign` rather than one upsert. `name`, `theme`, `cadence` and both dates are
   * `NOT NULL` in the store, so a create must require them — while an update must be sparse. One
   * signature cannot be both without either breaking a goal-only edit or admitting a nameless campaign.
   */
  createCampaign(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly name: string;
      readonly theme: string;
      readonly startsOn: CalendarDate;
      readonly endsOn: CalendarDate;
      readonly cadence: CampaignCadence;
      readonly channels: readonly PlatformId[];
      readonly goal?: string;
      readonly brief?: string;
      readonly tone?: string;
      readonly mode?: CampaignMode;
      readonly mediaType?: CampaignMediaType;
    },
  ): Promise<Campaign>;

  /**
   * Apply a sparse patch.
   *
   * **Must reject `endsOn` earlier than the stored `startsOn` with `invalid_input`.** The store has
   * `CHECK (ends_on >= starts_on)`, and a caller changing only one of the two has no access to the
   * other — so the tool validates the pair when it has both and this is the only place the one-sided
   * case can be caught. Left to the constraint, it would reach the model as a raw violation string.
   */
  updateCampaign(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: CampaignId;
      readonly patch: CampaignPatch;
    },
  ): Promise<Campaign>;
}

// ---------------------------------------------------------------------------------------------------
// Media service — "list, inspect, attach and convert".
// ---------------------------------------------------------------------------------------------------

export type MediaAsset = {
  readonly id: MediaAssetId;
  readonly kind: "image" | "video" | "document";
  readonly mimeType: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  /** Filename or caption. Never a signed URL — see the note on `inspect`. */
  readonly label: string;
};

export interface MediaService {
  listAssets(
    context: ExecutionContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<MediaAsset>>;

  /**
   * Metadata only, deliberately. No URL is returned.
   *
   * ShareFlow signs media URLs with an expiry (`lib/media-sign.ts`); a signed URL in a tool result
   * would be persisted in the run event log and readable by anyone who can read that conversation,
   * long outliving the check that produced it. Tools attach media *by id*; rendering resolves the URL
   * at display time under the viewer's own permissions.
   */
  inspect(context: ExecutionContext, input: { readonly id: MediaAssetId }): Promise<MediaAsset>;

  /**
   * Convert to a **format**, not to a platform.
   *
   * #114 had `targetPlatformId`, and that was wrong for the reason AC-5 of #118 gives: deciding which
   * format a platform accepts is platform-rules knowledge, and this package must not hold it. The
   * existing service takes a format (`convertMedia(path, to)`), so this does too. Choosing the format
   * for a destination is the assistant's job, informed by `checkPlatformCompatibility`.
   *
   * `targetFormat` is **not** validated against a list here. The accepted set is the conversion
   * service's own capability and can grow; a second copy would eventually refuse something the service
   * supports. An unsupported target must come back as `invalid_input` naming what is supported.
   *
   * Already idempotent underneath: ShareFlow's output path is content-addressed on source, target and
   * profile — *"Determinism IS the cache — an object already at this path means this exact conversion
   * was done before."* So a retry costs nothing rather than re-encoding, and the envelope's key and the
   * service's determinism point the same way. Long-running (a queued job), so the returned asset may
   * differ in id from the source.
   */
  convert(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: MediaAssetId;
      readonly targetFormat: string;
    },
  ): Promise<MediaAsset>;

  /**
   * Add attachments to a draft, by reference.
   *
   * An **add**, not a replace — which is why it is not `updateDraft({ mediaAssetIds })`. To append one
   * file through a replace the caller has to read the current list, append and write it back, and
   * ShareFlow keeps `addPostMedia` separate for the same reason.
   *
   * Two failures the caller must be able to tell apart, because ShareFlow's writer produces both:
   * `invalid_input` carrying `issues` when the resulting set breaks a destination's rules, and
   * `conflict` when the draft is no longer editable — the writer re-asserts that at write time because
   * *"the post may have been approved and published between the read above and this update."* The
   * second carries `details.remedy = EDIT_REMEDY_DUPLICATE`, as `updateDraft` does.
   */
  attachToDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly draftId: PostDraftId;
      readonly assetIds: readonly MediaAssetId[];
    },
  ): Promise<{ readonly draftId: PostDraftId; readonly mediaAssetIds: readonly MediaAssetId[] }>;

  /**
   * Would these attachments be publishable to these platforms?
   *
   * Read-only, and the answer is the **same `ValidationIssue[]`** `PublishingService.validate` returns,
   * so #119 consumes one shape and the judgement is made in one place. The point of asking before
   * publishing is that the repair is cheap beforehand and a partial publish afterwards is not.
   */
  checkPlatformCompatibility(
    context: ExecutionContext,
    input: {
      readonly assetIds: readonly MediaAssetId[];
      readonly platformIds: readonly PlatformId[];
    },
  ): Promise<readonly ValidationIssue[]>;

  /**
   * Is the media path working end to end?
   *
   * Wraps twenty-social's `check_media_storage`, which proves credentials, signing, the bucket write and
   * — the part that matters — *"whether the object comes back anonymously from the public domain …
   * because the platforms fetch media with no credentials and a bucket that is private fails only at
   * publish time."*
   *
   * It writes a diagnostic object, so it is an external write. See the note on the tool.
   */
  checkStorage(
    context: ExecutionContext,
    input: { readonly idempotencyKey: ServiceIdempotencyKey },
  ): Promise<MediaStorageCheck>;
}

/**
 * The outcome of a storage check.
 *
 * `stage` is where it stopped, so the answer is actionable rather than "media is broken": a config
 * failure, an unreachable host and a private bucket need three different fixes and look identical from
 * a failed publish.
 */
export type MediaStorageCheck = {
  readonly ok: boolean;
  /** Reached stage. `public-read` is the last one and the one that catches a private bucket. */
  readonly stage: "config" | "upload" | "public-read" | "complete";
  /** Configuration keys that are missing, by name. Names only — never values. */
  readonly missing?: readonly string[];
  /** What to do about it, as a stable code the assistant turns into a sentence. */
  readonly hint?: string;
};

// ---------------------------------------------------------------------------------------------------
// Publishing service — "validate, schedule, publish and retry" (docs/07, Workflow 2).
// ---------------------------------------------------------------------------------------------------

/** One destination for one draft. */
export type PublishTarget = {
  readonly accountId: SocialAccountId;
  /** Omitted means publish now. */
  readonly scheduledAt?: string;
  /**
   * The key that makes *this destination* publish once.
   *
   * Per draft + destination, and derived from **only** those two — never from the call. That is the
   * difference between the two guarantees, and it is the whole of AC-2 and AC-3:
   *
   * - A retry of the same call finds the succeeded destinations already done and completes only the
   *   outstanding ones.
   * - A **second, distinct** publish call for the same draft and account is also deduplicated. Derived
   *   from the call instead, it would republish — which is the failure the zero-tolerance criterion is
   *   about.
   *
   * This is not the argument-derived key #113 warned against. That danger was "identical arguments" not
   * meaning "the same intended act". Here the inputs are two durable record identities, `socialPostTargets`
   * already holds one row per (post, platform), and ShareFlow's own documented way to publish the same
   * content again is to **duplicate the draft** — which `duplicate_post_draft` exists for.
   */
  readonly idempotencyKey: ServiceIdempotencyKey;
};

export type ValidationIssue = {
  /**
   * Stable, so the frontend can localize it and a repair step can branch on it (docs/07 step 8).
   *
   * **A code is not a value.** The adapter assigns one per case it already distinguishes; the limit
   * itself — which platforms accept video, how many files a post may carry, a character ceiling — stays
   * in ShareFlow, where it is tenant-overridable data rather than a constant. See `MEDIA_ISSUE_CODES`.
   */
  readonly code: string;
  /** Which destination, when the issue is specific to one connected account. */
  readonly accountId?: SocialAccountId;
  /**
   * Which platform, when the issue is true of every destination on it.
   *
   * Both scopes exist because both occur: an expired credential is one account's problem, while "TikTok
   * requires a video" is true of every TikTok destination. `checkMediaCompatibility` maps over platforms
   * for exactly that reason, so a finding with no `accountId` is not an incomplete finding.
   */
  readonly platformId?: PlatformId;
  readonly message: string;
  /** Whether the assistant may attempt an automatic repair, or must ask. */
  readonly repairable: boolean;
};

/**
 * The media findings an adapter is expected to distinguish.
 *
 * A **vocabulary**, not a rule set. Each entry names a case `validateMediaForPlatform` already
 * separates; none of them carries the value that decides it. That is the line AC-5 of #118 draws: a
 * workspace can override `platform_rules`, so a limit copied into this package would be wrong for that
 * workspace, while a code for "the media is too large" is true wherever the ceiling sits.
 *
 * Not exhaustive by design — an adapter may report a code not listed here, and the assistant treats an
 * unknown code as non-repairable. Closing the set would mean this package deciding what ShareFlow is
 * allowed to notice.
 */
export const MEDIA_ISSUE_CODES = [
  /** The platform requires an attachment and there is none. */
  "media-required",
  /** The platform does not accept this kind of media at all (video, image). */
  "media-kind-unsupported",
  /** A document (PDF) sent somewhere with no document post type. */
  "document-unsupported",
  /** A document combined with images or video in one post. */
  "document-cannot-mix",
  /** More attachments than the platform or the store allows. */
  "too-many-attachments",
  /** Larger than the store or the platform accepts. */
  "media-too-large",
  /** A MIME type the store or the platform refuses. */
  "media-type-unsupported",
] as const;

export type MediaIssueCode = (typeof MEDIA_ISSUE_CODES)[number];

export type ValidationReport = {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
};

/**
 * What has happened to one destination.
 *
 * `awaiting-platform` is the one that matters, and it is not defensive modelling — it is the normal path
 * for video. `finish-pending-targets` exists because of it: *"Instagram Reels and TikTok videos are
 * accepted, then transcoded. Without this sweep they would sit at 'Awaiting platform' forever, which is
 * the single easiest way for a scheduler to quietly lose a post."*
 *
 * So it is the concrete form of AC-6's "unconfirmable outcome": the platform took the upload and has
 * confirmed nothing. `publishing` is the other unconfirmed state — an attempt in flight, or one whose
 * process died mid-attempt, since the status is set to `publishing` before the call.
 */
export const PUBLISH_TARGET_STATES = [
  "scheduled",
  "publishing",
  "awaiting-platform",
  "published",
  "failed",
  "cancelled",
] as const;

export type PublishTargetState = (typeof PUBLISH_TARGET_STATES)[number];

export type PublishTargetStatus = {
  readonly id: PublishTargetId;
  readonly accountId: SocialAccountId;
  readonly state: PublishTargetState;
  readonly scheduledAt?: string;
  readonly publishedAt?: string;
  /** The live post, when there is one. Public by definition, so safe to surface. */
  readonly externalUrl?: string;
  /**
   * How many attempts this destination has had.
   *
   * Surfaced because ShareFlow tracks it (`attemptCount`) and because it is what distinguishes "not
   * tried yet" from "tried and failed twice" — an assistant offering a retry should know which.
   */
  readonly attemptCount?: number;
  /** Stable failure code and a sentence. Never the provider's raw body. */
  readonly failure?: { readonly code: string; readonly message: string };
  /**
   * True when the destination has been unconfirmed long enough to be considered stuck rather than slow.
   *
   * ShareFlow gives up after 24 hours, because *"Instagram expires an unpublished container after 24
   * hours … Anything older is stuck, and saying so beats a row that claims to be publishing for a
   * week."* The threshold is ShareFlow's; this flag is the answer, so the assistant does not compute an
   * age against a constant that lives in another repository.
   */
  readonly stuck?: boolean;
};

export interface PublishingService {
  /**
   * Read-only. Claims, duplication, platform limits and media, per docs/07 step 7 — the check the
   * assistant runs *before* asking for approval, so a human is never asked to approve something that
   * cannot succeed.
   */
  validate(
    context: ExecutionContext,
    input: {
      readonly draftId: PostDraftId;
      readonly accountIds: readonly SocialAccountId[];
    },
  ): Promise<ValidationReport>;

  /**
   * The external write. Approval and the idempotency key are applied by the envelope before this is
   * reached; the key is passed on so ShareFlow's own queue can dedupe a re-delivered job.
   *
   * The two layers are not redundant: the envelope stops a second *agent* call, and this key stops a
   * second *delivery* of one accepted call. Either alone leaves a way to post twice.
   */
  schedule(
    context: ExecutionContext,
    input: {
      /** The call's key. Guards a duplicate *call*; each target's own key guards the destination. */
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly draftId: PostDraftId;
      readonly targets: readonly PublishTarget[];
    },
  ): Promise<readonly PublishTargetStatus[]>;

  /** Per-target state. The only source for "did it actually publish" — docs/07: report only verified outcomes. */
  getStatus(
    context: ExecutionContext,
    input: { readonly draftId: PostDraftId },
  ): Promise<readonly PublishTargetStatus[]>;

  /**
   * Retry one failed target.
   *
   * Per target rather than per draft, because a draft that published to three of four destinations
   * must not be re-sent to the three that succeeded — and a draft-level retry makes that the caller's
   * problem to get right every time.
   */
  retry(
    context: ExecutionContext,
    input: { readonly idempotencyKey: ServiceIdempotencyKey; readonly targetId: PublishTargetId },
  ): Promise<PublishTargetStatus>;
}

// ---------------------------------------------------------------------------------------------------


// ---------------------------------------------------------------------------------------------------
// Engagement service — docs/07: "comments, assignment and replies" (#120).
//
// **Assignment is absent, and that is a finding rather than an omission.** `inbox_comments` has no
// assignee column and ShareFlow has no assign function; what exists is triage — `needs_review` →
// `dismissed`. So the port carries `dismiss` and not `assign`. Adding one needs an assignee field and a
// notion of members to assign to, neither of which exists yet.
// ---------------------------------------------------------------------------------------------------

/**
 * Where a comment is in the reply workflow.
 *
 * `needs-review` means a draft reply is waiting for a person. `auto-sent` means a bot rule answered it.
 * Both `sent` states are terminal: `replyToComment` refuses a second reply on either.
 */
export const COMMENT_REPLY_STATES = ["needs-review", "dismissed", "sent", "auto-sent"] as const;
export type CommentReplyState = (typeof COMMENT_REPLY_STATES)[number];

export type InboxComment = {
  readonly id: InboxCommentId;
  readonly platformId: PlatformId;
  readonly authorName: string;
  readonly authorHandle?: string;
  readonly content: string;
  /** Which post or thread this is a comment on, when known. */
  readonly postRef?: string;
  readonly replyState: CommentReplyState;
  /**
   * A reply already drafted and waiting for a person.
   *
   * Surfaced read-only and never approvable from here. `approveComment` sends this draft, and
   * `needs-review` exists so a human looks first — an assistant that could approve its own draft would
   * be routing around the review step rather than passing through it.
   */
  readonly draftedReply?: string;
  readonly createdAt: string;
};

/** What a sent reply records. The comment id is the grounding, not decoration. */
export type CommentReplyReceipt = {
  readonly commentId: InboxCommentId;
  readonly platformId: PlatformId;
  readonly sentAt: string;
};

export interface EngagementService {
  listComments(
    context: ExecutionContext,
    input: {
      readonly replyState?: CommentReplyState;
      readonly platformId?: PlatformId;
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<Page<InboxComment>>;

  /**
   * Send a reply to one comment.
   *
   * Throws `conflict` when the comment has already been answered — which is a real outcome, not a
   * failure to send: `replyToComment` refuses on `sent` or `auto-sent`. Throws
   * `capability_unavailable` when the platform's connector has no `sendReply`, because *"replying is
   * not supported on {platform} yet — reply in the {platform} app instead"* is guidance, not an error.
   *
   * `idempotencyKey` is derived from the **comment**, not the call. A second distinct call to answer one
   * comment must not send a second reply, and a call-derived key would.
   */
  reply(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly commentId: InboxCommentId;
      readonly text: string;
    },
  ): Promise<CommentReplyReceipt>;

  /** Take a comment out of the review queue without answering it. Internal; nothing leaves the tenant. */
  dismiss(
    context: ExecutionContext,
    input: { readonly idempotencyKey: ServiceIdempotencyKey; readonly commentId: InboxCommentId },
  ): Promise<InboxComment>;
}

// ---------------------------------------------------------------------------------------------------
// Lead service — docs/07: "create/update attributed leads" (#120).
// ---------------------------------------------------------------------------------------------------

export const LEAD_STATUSES = ["new", "contacted", "qualified", "rejected"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Why a lead may never be added. Mirrors `LeadSuppressionReason`. */
export const LEAD_SUPPRESSION_REASONS = ["opt-out", "complaint", "existing-customer", "manual"] as const;
export type LeadSuppressionReason = (typeof LEAD_SUPPRESSION_REASONS)[number];

/**
 * Where a lead came from.
 *
 * Structured, not a string. `Lead.capturedFrom` is free text today, and AC-5 of #120 wants the
 * originating post or campaign *"so the analytics attribution has real linkage"* — a string the
 * analytics step has to parse is not linkage. The adapter serialises into `capturedFrom` until ShareFlow
 * has columns for it, which is the schema change this implies.
 */
export type LeadAttribution = {
  readonly postDraftId?: PostDraftId;
  readonly campaignId?: CampaignId;
  readonly platformId?: PlatformId;
  /** A comment or message the lead came out of, when that is the origin. */
  readonly commentId?: InboxCommentId;
};

export type Lead = {
  readonly id: LeadId;
  readonly name: string;
  readonly email?: string;
  readonly status: LeadStatus;
  /** Pipeline value in the tenant's currency, minor units — the same convention as usage accounting. */
  readonly valueMinorUnits?: number;
  readonly attribution: LeadAttribution;
  readonly createdAt: string;
};

/**
 * What happened when a lead was offered.
 *
 * A **discriminated union**, and that is the whole of AC-4. Suppression is enforced inside the insert
 * path — *"checked before every insert, so a re-run of the same search cannot resurrect someone who
 * opted out"* — so the risk is not that a tool bypasses it, but that a tool **misreports** it: telling
 * the user a lead was captured for someone who opted out. There is no success shape to put that in.
 *
 * `existing` is here for the same reason. A dedupe match reported as `created` is the same class of
 * untruth, and ShareFlow normalises domain and email precisely so those matches happen.
 */
export type LeadCreateResult =
  | { readonly outcome: "created"; readonly lead: Lead }
  | { readonly outcome: "existing"; readonly lead: Lead }
  | { readonly outcome: "suppressed"; readonly reason: LeadSuppressionReason };

/** A sparse patch, for the same reason every other patch here is one. No `attribution`: where a lead came from does not change. */
export type LeadPatch = {
  readonly name?: string;
  readonly email?: string;
  readonly status?: LeadStatus;
  readonly valueMinorUnits?: number;
};

export interface LeadService {
  listLeads(
    context: ExecutionContext,
    input: { readonly status?: LeadStatus; readonly limit: number; readonly cursor?: string },
  ): Promise<Page<Lead>>;

  /**
   * Offer a lead. May be refused.
   *
   * Normalisation of the email and domain stays in the service: suppression matching depends on it, and
   * a second normaliser here would eventually disagree about what matches — which for an opt-out means
   * contacting someone who asked not to be.
   */
  createLead(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly name: string;
      readonly email?: string;
      readonly valueMinorUnits?: number;
      readonly attribution: LeadAttribution;
    },
  ): Promise<LeadCreateResult>;

  updateLead(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: LeadId;
      readonly patch: LeadPatch;
    },
  ): Promise<Lead>;
}

/**
 * Everything the integration's tools, context providers and skills are given.
 *
 * One object rather than several constructor arguments, so adding the analytics and research services
 * (#124, #125) stays an additive change here instead of a signature change at every registration site.
 */

// ---------------------------------------------------------------------------------------------------
// Brand service — the context docs/07 lists first: brand, voice, audience, claims, examples (#121).
// ---------------------------------------------------------------------------------------------------

/**
 * The workspace's brand configuration.
 *
 * Exactly the six columns `workspace_ai_profile` has — no more, because there is no more. In particular
 * `audience` is **one free-text field, not segments**: docs/07 asks for "audience segments" and the store
 * holds a paragraph. Promising a structure the store cannot fill would make the adapter invent one.
 */
export type BrandProfile = {
  readonly brandName?: string;
  readonly company?: string;
  readonly website?: string;
  /** Free text. Not a list of segments — see above. */
  readonly audience?: string;
  readonly voice?: string;
  readonly customInstructions?: string;
};

/** A phrase the brand may not use, and why. */
export type ForbiddenClaim = {
  /** The literal phrasing to refuse. Matched case-insensitively on word boundaries. */
  readonly phrase: string;
  /** Why, for the refusal message. "Not cleared by legal" is more useful than "forbidden". */
  readonly reason?: string;
};

/**
 * What the brand may and may not assert.
 *
 * **No record for this exists in ShareFlow.** `workspace_ai_profile` has six columns and none of them is
 * a claims list; today a restriction can only be prose inside `custom_instructions`, which is exactly
 * what #121's AC-2 rules out. This port is the shape the storage needs to take, and until it does an
 * adapter returns empty lists — which the checker treats as "nothing forbidden", not as "nothing
 * checked". That distinction is worth keeping in mind when reading a clean validation result.
 */
export type ClaimPolicy = {
  /** Claims explicitly cleared for use. Advisory: they inform generation, they do not gate it. */
  readonly approved: readonly string[];
  /** Claims that must be refused. Enforced at the tool layer, not only in the prompt. */
  readonly forbidden: readonly ForbiddenClaim[];
};

/**
 * One of the workspace's own posts, as a voice example.
 *
 * Excerpt plus the id, keeping `getVoiceExamples`' proportions — four examples of 400 characters — rather
 * than inventing new ones. The id is there so the assistant can read the whole post if it needs to,
 * which is the reference half of reference-not-inject.
 */
export type VoiceExample = {
  readonly postDraftId?: PostDraftId;
  readonly excerpt: string;
};

export interface BrandService {
  getBrandProfile(context: ExecutionContext): Promise<BrandProfile>;

  getClaimPolicy(context: ExecutionContext): Promise<ClaimPolicy>;

  /** The workspace's own best and flagged posts. Heuristic selection is ShareFlow's, not ours. */
  listVoiceExamples(
    context: ExecutionContext,
    input: { readonly limit: number },
  ): Promise<readonly VoiceExample[]>;

  /**
   * A compact "what is working" brief, or null when there is nothing to say.
   *
   * **Expensive**: ShareFlow's version joins metrics across sixty rows. Never called on a routine
   * request — see the note on `createPerformanceContextProvider`.
   */
  getPerformanceBrief(context: ExecutionContext): Promise<string | null>;
}


// ---------------------------------------------------------------------------------------------------
// Content generation — the one capability with nothing to wrap (#123).
// ---------------------------------------------------------------------------------------------------

/**
 * A strategic angle: one way of approaching the brief.
 *
 * docs/07 Workflow 1 step 4 asks for *distinct* angles, and step 5 leaves the choice to the workflow. So
 * an angle is a proposal, not a decision — the assistant or the user picks one.
 */
export type ContentAngle = {
  /** Short label, for choosing between them. */
  readonly label: string;
  /** What this angle argues and why it might land. */
  readonly rationale: string;
};

/** One channel's version of the content. */
export type GeneratedVariant = {
  readonly platformId: PlatformId;
  readonly caption: string;
};

/**
 * The model-facing port.
 *
 * Declared here and implemented above, because R3 confines the AI SDK to `models/` and R7 keeps I/O out
 * of `tools/`. What #123 builds is the harness around this — validation, repair, and the bound — not the
 * inference.
 *
 * `avoid` is how a repair attempt is communicated: the findings from the previous attempt, so the model
 * is told what to change rather than asked to try again.
 */
export interface ContentGenerator {
  proposeAngles(
    context: ExecutionContext,
    input: { readonly brief: string; readonly count: number },
  ): Promise<readonly ContentAngle[]>;

  generate(
    context: ExecutionContext,
    input: {
      readonly brief: string;
      readonly angle?: ContentAngle;
      readonly platformIds: readonly PlatformId[];
      /** Findings from the previous attempt. Empty on the first. */
      readonly avoid: readonly ValidationIssue[];
    },
  ): Promise<readonly GeneratedVariant[]>;
}


// ---------------------------------------------------------------------------------------------------
// Research — live retrieval, and the other net-new capability (#124).
// ---------------------------------------------------------------------------------------------------

/** One search hit. Matches the existing `Finding` contract: title, snippet, url. */
export type SearchResult = {
  /** Referenceable, so reading a hit does not require the model to echo a URL back. */
  readonly resultId: string;
  readonly title: string;
  readonly snippet: string;
  readonly url: string;
};

/**
 * What a search returned, **and whether it ran**.
 *
 * The distinction is the point. `ai_backend/app/core/websearch.py` is deliberately fail-soft — *"network
 * errors, timeouts, or a missing package yield an empty result list instead of raising, so content
 * generation never depends on search availability"* — which is right for a background enrichment step and
 * wrong for an agent-facing tool, because it makes "found nothing" and "never ran" the same value.
 *
 * "Nothing out there" invites a model to answer from what it already believes. "I could not look" should
 * stop it. AC-6 of #124 is unachievable while those are indistinguishable, so `searched` is separate from
 * `results` and an unavailable search is not an empty success.
 */
export type SearchOutcome =
  | { readonly searched: true; readonly results: readonly SearchResult[] }
  | { readonly searched: false; readonly reason: "unavailable" | "timed-out" | "not-configured" };

/**
 * One passage from a source, with everything a citation needs.
 *
 * Per *passage*, not per document: docs/07 wants a citation to resolve to the specific text that was used,
 * and a document-level citation is an invitation to go and find it.
 */
export type SourcePassage = {
  /**
   * The URL that was **actually read**, after redirects.
   *
   * Not the requested one. A citation must open what was read — and `safefetch.py` exists because the two
   * differ: *"a perfectly public URL can 302 to `http://169.254.169.254/…`"*.
   */
  readonly url: string;
  /** When it was retrieved. A fact from last year and a fact from this morning are different claims. */
  readonly retrievedAt: string;
  /** The exact text used. Bounded — see `ReadSourceResult`. */
  readonly excerpt: string;
};

export type ReadSourceResult = {
  /** For reading further passages without re-fetching. AC-5's reference half. */
  readonly sourceId: string;
  readonly title?: string;
  readonly passages: readonly SourcePassage[];
  /** True when the source has more than the returned passages cover. */
  readonly truncated: boolean;
};

export interface ResearchService {
  /**
   * Search. Must report *whether it searched*, never a fail-soft empty list.
   */
  search(
    context: ExecutionContext,
    input: { readonly query: string; readonly maxResults: number },
  ): Promise<SearchOutcome>;

  /**
   * Fetch and excerpt one source.
   *
   * Three obligations the tool cannot discharge itself, stated here because the implementation is the only
   * place they can hold:
   *
   * 1. **Every redirect hop is re-validated against the egress policy**, not just the first URL.
   *    `validateEndpoint` checks one URL; following a redirect without re-checking is how a public URL
   *    reaches a metadata address.
   * 2. **The response body is capped** and the connection torn down when the cap is hit — not read to the
   *    end and truncated. *"The callers parse whole documents in memory, so an unbounded download is a
   *    denial-of-service vector."*
   * 3. **A timeout applies to the whole fetch**, redirects included, so a chain of slow hops cannot
   *    outlast it.
   *
   * Throws `forbidden` for a disallowed host at any hop, and `timeout` for either limit — both distinct
   * from an empty result, for the same reason `SearchOutcome` separates `searched`.
   */
  readSource(
    context: ExecutionContext,
    input: {
      /** Either a URL, or a `resultId` from a prior search — never both. */
      readonly url?: string;
      readonly resultId?: string;
      readonly maxPassages: number;
    },
  ): Promise<ReadSourceResult>;
}

export type ShareFlowServices = {
  readonly connectors: ConnectorService;
  readonly content: ContentService;
  readonly media: MediaService;
  readonly publishing: PublishingService;
  readonly engagement: EngagementService;
  readonly leads: LeadService;
  readonly brand: BrandService;
  readonly generator: ContentGenerator;
  readonly research: ResearchService;
};
