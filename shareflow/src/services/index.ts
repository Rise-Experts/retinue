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

export type PublishTargetStatus = {
  readonly id: PublishTargetId;
  readonly accountId: SocialAccountId;
  readonly state: "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  readonly scheduledAt?: string;
  readonly publishedAt?: string;
  /** The live post, when there is one. Public by definition, so safe to surface. */
  readonly externalUrl?: string;
  /** Stable failure code and a sentence. Never the provider's raw body. */
  readonly failure?: { readonly code: string; readonly message: string };
};

export interface PublishingService {
  /**
   * Read-only. Claims, duplication, platform limits and media, per docs/07 step 7 — the check the
   * assistant runs *before* asking for approval, so a human is never asked to approve something that
   * cannot succeed.
   */
  validate(
    context: ExecutionContext,
    input: { readonly draftId: PostDraftId; readonly targets: readonly PublishTarget[] },
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

/**
 * Everything the integration's tools, context providers and skills are given.
 *
 * One object rather than four constructor arguments, so adding the analytics, engagement, leads and
 * research services (#120, #125) is an additive change here instead of a signature change at every
 * registration site.
 */
export type ShareFlowServices = {
  readonly connectors: ConnectorService;
  readonly content: ContentService;
  readonly media: MediaService;
  readonly publishing: PublishingService;
};
