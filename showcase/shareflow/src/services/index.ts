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
import type { RenderFacts } from "../adapters/web/render-facts.js";
import type { ExecutionContext } from "@retinue/agentkit";
import type {
  ArtifactId,
  CampaignId,
  MediaConversionJobId,
  InboxCommentId,
  LeadId,
  LinkId,
  ScheduleId,
  MediaAssetId,
  PlatformId,
  PostDraftId,
  PublishTargetId,
  SocialAccountId,
} from "./ids.js";
/**
 * The auto-reply types come from the reply module rather than being restated here.
 *
 * A second declaration of `AutoReplyResult` would be a second answer to what the ingest cycle reads,
 * and the whole point of that module is that its shape is the one `web/src/lib/ingest.ts` depends on.
 */
import type { AutoReplyResult, ReplyPersona } from "../reply/auto-reply.js";
import type { Theme } from "../design/theme.js";

export type { AutoReplyResult, ReplyPersona } from "../reply/auto-reply.js";

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
   * The authored post text, as stored: what every destination publishes unless it has its own.
   */
  readonly caption: string;
  /**
   * A channel's own caption, where it differs from `caption` — #495.
   *
   * This is the schema change the open question on #123 asked for: `posts.platform_captions`. Only
   * channels that differ appear; `{}` means every channel publishes `caption`. Scheduling copies each
   * entry into that channel's `scheduled_items.tailored_content`, which the worker publishes.
   */
  readonly platformCaptions: Readonly<Partial<Record<PlatformId, string>>>;
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
  /** #495: replaces the per-channel captions; `{}` clears them. Omitted = unchanged. */
  readonly platformCaptions?: Readonly<Partial<Record<PlatformId, string>>>;
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

  /**
   * #497 AC-1: one channel of a post being written finished — recorded on the turn so the post panel can fill
   * that channel's card before the others are done. Optional (a store without it simply fills all cards at
   * the end), and never allowed to fail the write: it is a preview, not the record.
   */
  noteChannelWritten?(
    context: ExecutionContext,
    input: { readonly callKey: string; readonly platformId: string; readonly caption: string | null },
  ): Promise<void>;

  createDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly caption: string;
      readonly targetPlatforms: readonly PlatformId[];
      /** #495: channels whose caption differs from `caption`. Each is validated for its own platform. */
      readonly platformCaptions?: Readonly<Partial<Record<PlatformId, string>>>;
      readonly campaignId?: CampaignId;
      readonly mediaAssetIds?: readonly MediaAssetId[];
    },
  ): Promise<CreatedPostDraft>;

  /**
   * Save a multi-part draft — a thread — #456, REQ-015 AC-2.
   *
   * A separate method rather than an optional `parts` on `createDraft`, and the reason is what each
   * one saves. `createDraft` writes one body that every destination receives; this writes N bodies
   * that publish **in order, each replying to the one before**. A caller that passed `parts` to the
   * wrong one would get a post whose parts were silently ignored, which is the same class of quiet
   * wrong answer as `variants` meaning two things on one route.
   *
   * **Every part is validated, and nothing is saved when any of them fails.** Each part becomes its
   * own post on the platform, so each must fit that platform's limits on its own — a thread whose
   * fourth part is 400 characters over is not a long thread, it is a thread that stops at three.
   * Issues name the ordinal, because "part 4 is too long for x" is actionable and "the post is too
   * long" is not when there are five of them.
   *
   * Post and parts are written in **one statement**, so a thread never exists with some of its parts
   * missing. A half-written thread would publish as a truncated one.
   */
  createThreadDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      /** In order, 1-based by position. At least two — one part is a post, not a thread. */
      readonly parts: readonly { readonly body: string; readonly mediaAssetIds?: readonly MediaAssetId[] }[];
      readonly targetPlatforms: readonly PlatformId[];
      readonly campaignId?: CampaignId;
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
   * The rules `validateContent` will judge a caption by — #287.
   *
   * Exposed so generation can be *driven* by them rather than corrected against them. The generator
   * was told `Platforms: instagram, linkedin, x` and nothing else, wrote blind, and discovered X's
   * 280 characters only by failing validation and being asked again — so every X caption cost at
   * least two model calls, and the first draft a person saw was one the product already knew was
   * wrong.
   *
   * A read rather than a copy, deliberately. #118 and #122 both settled that **"a limit known to the
   * caller is a limit that can be wrong for the workspace"**: `platform_rules` is
   * workspace-overridable, so anything holding its own table drifts from the one that enforces. This
   * returns what the validator's own query returns, for the same tenant, and validation stays the
   * authority — the generator is merely told what it is aiming at.
   */
  platformRules(
    context: ExecutionContext,
    platformIds: readonly PlatformId[],
  ): Promise<readonly PlatformRule[]>;

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

/**
 * A file this runtime produced and stored, as the caller may refer to it.
 *
 * **A reference, never a path or a URL.** `chorus-media:` is the product's own opaque handle — the web
 * app resolves it, an assistant can put it in a reply, and `create_post_draft` accepts it. A path would
 * be the thing the media tools exist not to return: *"a signed URL in a tool result is persisted in the
 * run event log and readable by anyone who can read the conversation."*
 */
export type StoredAsset = {
  readonly reference: string;
  readonly contentType: string;
  readonly byteSize: number;
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
  /**
   * Returns a **conversion**, not an asset — REQ-041 (#190).
   *
   * It used to return `MediaAsset`, which made a queued conversion unrepresentable. ShareFlow's converter is
   * asynchronous for video: `media_conversion_jobs` rows go `queued → running → succeeded | failed`, and the
   * old runtime's `convert_media` returns a `jobId` that `check_conversion` polls. For a long video the
   * queued case is the normal one, not an edge, so a return type that could only describe a finished file
   * meant this adapter could only describe the half that happens to be fast.
   */
  convert(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: MediaAssetId;
      readonly targetFormat: string;
    },
  ): Promise<MediaConversion>;

  /**
   * Poll a conversion — REQ-041 (#190).
   *
   * The other half of `convert`. `not_found` for another workspace's job, as everywhere else.
   */
  getConversion(
    context: ExecutionContext,
    input: { readonly jobId: MediaConversionJobId },
  ): Promise<MediaConversion>;

  /**
   * Start generating an image or video — #496. Returns the job to poll with `getGeneration`.
   *
   * Refuses (`capability_unavailable`) on a deployment that cannot reach the app. The app's own refusals
   * — out of credits, a plan without media, an expired Higgsfield sign-in — come back as `invalid_input`
   * with its message.
   */
  generate(
    context: ExecutionContext,
    input: {
      readonly kind: "image" | "video";
      readonly prompt: string;
      readonly model?: string;
      readonly aspectRatio?: string;
      readonly count?: number;
      readonly postDraftId?: string;
      /** #575: media-bucket paths of images the person gave as references (their chat attachments). */
      readonly referencePaths?: readonly string[];
    },
  ): Promise<{ readonly jobId: string; readonly provider?: string }>;

  /** Read a generation back. `not_found` for another workspace's job. */
  getGeneration(context: ExecutionContext, input: { readonly jobId: string }): Promise<MediaGeneration>;

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
  /** Attach stored files by path (a project's uploads, which have no asset row) — #523. Same checks as `attachToDraft`. */
  attachPathsToDraft(
    context: ExecutionContext,
    input: { readonly draftId: PostDraftId | string; readonly paths: readonly string[] },
  ): Promise<{ readonly draftId: PostDraftId; readonly mediaAssetIds: readonly MediaAssetId[] }>;
  attachToDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly draftId: PostDraftId;
      readonly assetIds: readonly MediaAssetId[];
    },
  ): Promise<{ readonly draftId: PostDraftId; readonly mediaAssetIds: readonly MediaAssetId[] }>;

  /**
   * Remove attachments from a draft — REQ-041 (#190).
   *
   * **The file is not deleted from storage**, only its attachment to this draft, so it can be re-attached or
   * used elsewhere. The old tool says so in its first line and calls itself reversible.
   *
   * The compatibility check runs **on the way out**, which is the part worth stating: removing the only image
   * from an Instagram-targeted post leaves it unpublishable, and ShareFlow refuses that now rather than at
   * publish time. So this raises `invalid_input` with `issues` for the same reason `attachToDraft` does.
   */
  detachFromDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly draftId: PostDraftId;
      readonly assetIds: readonly MediaAssetId[];
    },
  ): Promise<{ readonly draftId: PostDraftId; readonly mediaAssetIds: readonly MediaAssetId[] }>;

  /**
   * Swap one attachment for another, **in place** — REQ-041 (#190).
   *
   * Not detach-then-attach, and the difference is the whole reason it exists: the replacement keeps the
   * file's *position*, and position is the order a platform shows a carousel in. Two calls would put the new
   * file last.
   *
   * `conflict` when the outgoing file is not attached, and when the incoming one already is — a replacement
   * that is already there would silently shorten the carousel.
   */
  replaceOnDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly draftId: PostDraftId;
      readonly remove: MediaAssetId;
      readonly add: MediaAssetId;
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
  /**
   * Store bytes this runtime produced in the workspace's media bucket.
   *
   * The one write in this port that does not start from something already stored, and it exists because
   * three capabilities produce files: a screenshot, a rendered diagram and a generated PDF. Absent the
   * deployment's storage hop it refuses by name, the same as `convert`.
   *
   * Takes bytes and returns a reference. Neither direction carries a path.
   */
  storeAsset(
    context: ExecutionContext,
    input: { readonly contentType: string; readonly bytes: Uint8Array },
  ): Promise<StoredAsset>;

}

/**
 * From `media_conversion_jobs_status_check`. Four values, and the constraint is the authority.
 */
export const MEDIA_CONVERSION_STATES = ["queued", "running", "succeeded", "failed"] as const;
export type MediaConversionState = (typeof MEDIA_CONVERSION_STATES)[number];

/**
 * A conversion, finished or not.
 *
 * **`asset` is present only when `state` is `succeeded`**, and that is the point rather than a detail. The old
 * tool's docstring is explicit: *"Only 'succeeded' means the file exists — until then there is no path to use
 * or show. If it is still queued or running, say so; do not guess a path, and do not attach one to a post."*
 *
 * A shape carrying a path on every state invites exactly that: a model reads `asset.storagePath` off a
 * `running` job, attaches it, and the post fails at publish with a file that was never written. Absent is the
 * only representation of "there is nothing to attach yet" that cannot be misread.
 */
/**
 * An image or video being generated for the workspace — #496.
 *
 * Generation runs in the app (Higgsfield over MCP when the person connected it and made it the
 * default, else the built-in provider; #483), because that is where the provider credentials, the plan
 * gate and the credit ledger live. The agent starts a job and reads it back; it never holds a key.
 */
export type MediaGeneration = {
  readonly jobId: string;
  readonly kind: "image" | "video";
  readonly state: "queued" | "running" | "succeeded" | "failed";
  /** `higgsfield`, or the built-in provider's name, once running. */
  readonly provider?: string;
  /**
   * Present on success: media assets like any upload — the `id` is what `attach_media_to_post` takes.
   * No path and no URL, by the rule every media capability keeps: a signed URL in a tool result is
   * persisted in the run log and outlives the permission check that produced it.
   */
  readonly assets: readonly { readonly id: string; readonly mimeType: string }[];
  /** Present on failure: the app's stored reason, in words. */
  readonly failure?: string;
  /** #524: how many of the project avatar's reference photos went with the job, and why any did not. */
  readonly references?: { readonly sent: number; readonly skipped?: string };
};

export type MediaConversion = {
  readonly jobId: MediaConversionJobId;
  readonly state: MediaConversionState;
  readonly targetFormat: string;
  /** Present only on `succeeded`. */
  readonly asset?: MediaAsset;
  /** Present only on `failed`. The stored reason, never a provider's raw body. */
  readonly failure?: string;
};

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

/** One platform's publishable bounds, as `platform_rules` holds them. `null` means unconstrained. */
export interface PlatformRule {
  readonly platformId: string;
  readonly charLimit: number | null;
  readonly hashtagMin: number | null;
  readonly hashtagMax: number | null;
}

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
  /**
   * A multi-part post that stopped part-way — #456.
   *
   * Its own state because the two it sits between are both wrong. `published` would have the
   * assistant tell someone their thread went out; `failed` would have it offer a retry, and retrying
   * a thread whose first two parts are public posts them to that audience a second time.
   *
   * An assistant reading this should say **how much** is live and not offer to republish.
   */
  "partially-published",
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

  /**
   * Publish a post's content again — REQ-041 (#190).
   *
   * **This duplicates rather than republishes, and that is the platforms' constraint rather than a choice.**
   * The old runtime's docstring is explicit: *"The platform APIs cannot edit or re-publish a live post, so
   * this DUPLICATES the content into a new post and publishes that — the original stays intact with its own
   * history and metrics."* Keeping the original intact is the point: its engagement numbers belong to it.
   *
   * It is also why this is a service method rather than two tool calls. `duplicate_post_draft` followed by
   * `publish_post_now` is the same two writes, but a model doing it in two turns can duplicate and then fail
   * to publish, leaving an orphan draft nobody asked for — and can publish to destinations the original never
   * reached, which is the thing the default below prevents.
   *
   * `accountIds` omitted means **the destinations the original actually published to successfully**, which is
   * narrower than "its destinations": a target that failed the first time is not silently retried under
   * cover of a repost.
   */
  repost(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly draftId: PostDraftId;
      /** Omitted means every destination the original published to successfully. */
      readonly accountIds?: readonly SocialAccountId[];
      /** Omitted means now. An instant in the future schedules the copy instead. */
      readonly scheduledAt?: string;
    },
  ): Promise<RepostReceipt>;

  /**
   * Delete a published post from the platforms **and** from ShareFlow — REQ-041 (#190).
   *
   * Irreversible on both sides, which is why the tool over it is `destructive` and waits for a person.
   *
   * ## Partial deletion is the normal case, not the error case
   *
   * *"Not every platform can delete: TikTok has no delete API, and Instagram refuses ads and single items
   * inside a carousel. Those copies stay live."* So the result is **per platform**, and the record is removed
   * only when every platform confirmed. A leftover with no record is a post nobody can find again, which is
   * worse than a record for a post that is half gone.
   *
   * The instruction that matters is downstream of that: never report the post as deleted unless `stillLive`
   * is empty. The shape makes the honest sentence the easy one to write.
   *
   * Throws `capability_unavailable` when no platform connector is wired, for the reason
   * `EngagementService.reply` does: the method's whole purpose is the external effect, so there is no useful
   * part of it to perform without a way to perform it.
   */
  deletePublished(
    context: ExecutionContext,
    input: { readonly idempotencyKey: ServiceIdempotencyKey; readonly draftId: PostDraftId },
  ): Promise<DeletePublishedResult>;
}

export type RepostReceipt = {
  /** The new post. The original keeps its id, its history and its metrics. */
  readonly draftId: PostDraftId;
  readonly targets: readonly PublishTargetStatus[];
};

/** One platform's answer. `deleted: false` with a reason is a normal outcome, not a failure of the call. */
export type PlatformDeletion = {
  readonly platformId: PlatformId;
  readonly accountId: SocialAccountId;
  readonly deleted: boolean;
  /** Why not, when not. The sentence a user is told, never a provider's raw body. */
  readonly reason?: string;
};

export type DeletePublishedResult = {
  readonly draftId: PostDraftId;
  readonly platforms: readonly PlatformDeletion[];
  /**
   * True only when every platform confirmed.
   *
   * The record is kept otherwise, deliberately: a live post with no row is a post nobody can find again.
   */
  readonly removedFromDatabase: boolean;
  /** Platforms that still have a copy. **Empty is the only state in which the post is gone.** */
  readonly stillLive: readonly PlatformId[];
};

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

  /**
   * Draft a reply and send **nothing** — REQ-041 (#190).
   *
   * The old runtime's `POST /reply` and `reply_to_comment` are two capabilities, not one, and mapping them
   * together would have claimed the review step survived the migration. This drafts into
   * `inbox_comments.reply` and leaves `reply_status = 'needs_review'`, which is the state that exists so a
   * person looks before anything reaches a customer's audience.
   *
   * Deliberately **not** approval-gated, because nothing leaves the tenant — and deliberately unable to send:
   * an assistant that could approve its own draft would be routing around the review step rather than passing
   * through it, which is why `InboxComment.draftedReply` is surfaced read-only and there is no
   * `approveComment`.
   *
   * `conflict` on an answered comment, as `reply` gives: a draft written over a sent reply would make the
   * record read as though nobody had answered.
   */
  draftReply(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly commentId: InboxCommentId;
      readonly text: string;
    },
  ): Promise<InboxComment>;

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

/**
 * A tracked short link, and what it drove — #424.
 *
 * `short_links` and `link_clicks` were live and invisible to the agent: the web app creates links and
 * `/l/{slug}` records a click, and the assistant had no tool against either. So it could answer "how
 * did this post reach" and not "did it drive anything" — and engagement is a proxy for interest where
 * a click is evidence.
 */
export type TrackedLink = {
  readonly id: LinkId;
  /** The short path, not the full URL — the origin belongs to the deployment, not to a row. */
  readonly slug: string;
  /** The full short URL, built from the deployment's own public origin. */
  readonly url: string;
  readonly destinationUrl: string;
  readonly title?: string;
  readonly createdAt: string;
  readonly clicks: number;
  /** What it was made for, when it was attributed to anything. */
  readonly postId?: PostDraftId;
  readonly campaignId?: CampaignId;
};

/** Clicks for one link over a window, with the two dimensions the redirect actually records. */
export type LinkPerformance = {
  readonly linkId: LinkId;
  readonly slug: string;
  readonly title?: string;
  readonly destinationUrl: string;
  readonly postId?: PostDraftId;
  readonly campaignId?: CampaignId;
  readonly clicks: number;
  /** Descending by count. Referrers the redirect saw; `"direct"` when it saw none. */
  readonly referrers: readonly { readonly referrer: string; readonly clicks: number }[];
  /** Descending by count. `"unknown"` where the redirect could not tell. */
  readonly countries: readonly { readonly country: string; readonly clicks: number }[];
};

/** A recurring rule, as the assistant sees it. */
export type RecurringSchedule = {
  readonly id: ScheduleId;
  readonly name: string;
  readonly postId?: PostDraftId;
  readonly frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  readonly interval: number;
  /** 0-6, Sunday first — the column's own convention. Only meaningful for WEEKLY. */
  readonly weekdays?: readonly number[];
  readonly dayOfMonth?: number;
  readonly timeOfDay: string;
  readonly timezone: string;
  readonly status: "ACTIVE" | "PAUSED";
  /** The next occurrence this rule has already materialised, if any is still ahead. */
  readonly nextOccurrenceAt?: string;
  readonly accountIds: readonly string[];
};

/** A slot the workspace configured for itself. */
export type TimeSlot = {
  readonly id: string;
  readonly label: string;
  readonly weekday: number;
  readonly timeOfDay: string;
  readonly timezone: string;
};

/**
 * When to publish, and **why** — #425's second acceptance: it must never invent a time when there is
 * no data, it must say there is none.
 *
 * A discriminated union rather than a time plus a confidence number, so "we measured this" and "this
 * is what you configured" and "we do not know" cannot be collapsed into one sentence by a caller in a
 * hurry. The model is told to report the basis, and the shape is what makes that possible.
 */
export type PublishTimeSuggestion =
  | {
      readonly basis: "measured";
      readonly weekday: number;
      readonly timeOfDay: string;
      readonly timezone: string;
      /** What the suggestion was measured from, so it can be quoted rather than asserted. */
      readonly engagements: number;
      readonly daysObserved: number;
    }
  | {
      readonly basis: "configured-slot";
      readonly slotLabel: string;
      readonly weekday: number;
      readonly timeOfDay: string;
      readonly timezone: string;
    }
  | { readonly basis: "none"; readonly reason: string };

/**
 * A campaign playbook from the shared catalogue — #426.
 *
 * `campaign_templates` has **no `workspace_id`**: it is a global catalogue every workspace reads, so
 * listing one needs no tenant scope and starting from one does.
 */
export type CampaignTemplate = {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly defaultGoal?: string;
  /**
   * The **port's** cadence vocabulary (`3x-week`), not the store's (`3x_week`) — #426.
   *
   * Typed as the union rather than `string` on purpose: this field's whole job is to be handed to
   * `createCampaign`, and while it was a bare `string` the two vocabularies passed for each other
   * silently. Seeding from a `3x_week` template failed the `campaigns.cadence` CHECK, and no type
   * error marked the spot. The adapter maps it once on the way out.
   */
  readonly defaultCadence?: CampaignCadence;
  readonly recommendedChannels: readonly string[];
  /**
   * How many posts the playbook's shape describes — a count, not the plan.
   *
   * The plan itself is deliberately not returned. The web app's own comment says why: *"the template's
   * goal is still read; its `post_plan` is not"*, because the generator has no funnel-stage equivalent
   * and refuses a request carrying one. Returning a plan nothing can act on would invite the model to
   * describe stages the product cannot produce.
   */
  readonly plannedPosts: number;
};

/** One day's rollup for one platform, as `analytics_daily` stores it. */
export type DailyRollup = {
  readonly day: string;
  readonly platform: string;
  readonly impressions: number;
  readonly engagements: number;
  readonly linkClicks: number;
  readonly watchSeconds: number;
  readonly followers: number;
};

/**
 * One metric across two windows — #426's second acceptance.
 *
 * `change` is absent when there is no prior window, and that is the whole point: "no prior window" and
 * "no change" are different facts, and a comparison against a fabricated zero reports the first as a
 * 100% rise. The dashboard already refuses to do that; this is the same rule where the assistant can
 * see it.
 */
export type MetricComparison = {
  readonly metric: "impressions" | "engagements" | "linkClicks" | "watchSeconds" | "followers";
  readonly current: number;
  readonly previous?: number;
  readonly change?: { readonly absolute: number; readonly percent: number | null };
};

export type PeriodComparison = {
  readonly current: { readonly since: string; readonly until: string; readonly daysWithData: number };
  readonly previous?: { readonly since: string; readonly until: string; readonly daysWithData: number };
  /** Why there is nothing to compare against, when there is not. */
  readonly noPriorWindowReason?: string;
  readonly metrics: readonly MetricComparison[];
};

export interface InsightService {
  listCampaignTemplates(context: ExecutionContext): Promise<readonly CampaignTemplate[]>;

  /**
   * Create a campaign seeded from a playbook.
   *
   * Seeds and records, and creates no posts: `create_campaign`'s own description already says a
   * campaign "creates the container its posts belong to", and the assistant has `propose_post_angles`
   * and `create_post_draft` for filling it. The web app's template start works the same way — it
   * applies the goal and records `template_key`, then generates separately.
   */
  startCampaignFromTemplate(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly templateKey: string;
      readonly name: string;
      readonly theme: string;
      readonly startsOn: CalendarDate;
      readonly endsOn: CalendarDate;
      /** Overrides the template's own, when the user asked for something else. */
      readonly cadence?: CampaignCadence;
      readonly channels?: readonly PlatformId[];
    },
  ): Promise<{ readonly campaign: Campaign; readonly template: CampaignTemplate }>;

  getDailyRollup(
    context: ExecutionContext,
    input: { readonly since: string; readonly until?: string; readonly platform?: string },
  ): Promise<readonly DailyRollup[]>;

  comparePeriods(
    context: ExecutionContext,
    input: { readonly since: string; readonly until: string; readonly platform?: string },
  ): Promise<PeriodComparison>;
}

export interface ScheduleService {
  listSchedules(
    context: ExecutionContext,
    input: { readonly limit: number; readonly postId?: PostDraftId },
  ): Promise<readonly RecurringSchedule[]>;

  listTimeSlots(context: ExecutionContext): Promise<readonly TimeSlot[]>;

  /**
   * A slot, chosen from the workspace's own engagement-by-day data.
   *
   * Measured or configured or nothing — never a guess. `analytics_daily` records engagements per day
   * per platform, which is a weekday signal and **not** a time-of-day one: the hour comes from the
   * workspace's configured slots, because nothing here knows what hour anything was posted at.
   */
  suggestPublishTime(
    context: ExecutionContext,
    input: { readonly platform?: string; readonly sinceDays: number },
  ): Promise<PublishTimeSuggestion>;

  /** Create a rule over an existing post. Materialises its first horizon before returning. */
  createRecurringSchedule(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly postId: PostDraftId;
      readonly accountIds: readonly string[];
      readonly name?: string;
      readonly frequency: "DAILY" | "WEEKLY" | "MONTHLY";
      readonly interval?: number;
      readonly weekdays?: readonly number[];
      readonly dayOfMonth?: number;
      readonly timeOfDay: string;
      readonly timezone?: string;
      readonly until?: string;
      readonly count?: number;
    },
  ): Promise<{ readonly schedule: RecurringSchedule; readonly materialised: number }>;

  /** Stop future occurrences. Anything already published is untouched. */
  cancelRecurringSchedule(
    context: ExecutionContext,
    input: { readonly idempotencyKey: ServiceIdempotencyKey; readonly scheduleId: ScheduleId },
  ): Promise<{ readonly cancelled: number | true }>;
}

export interface LinkService {
  listTrackedLinks(
    context: ExecutionContext,
    input: { readonly limit: number; readonly postId?: PostDraftId; readonly campaignId?: CampaignId },
  ): Promise<readonly TrackedLink[]>;

  /**
   * Clicks over a period.
   *
   * The period is required rather than defaulted, because "how many clicks" with no window is a
   * question about all of history and reads as a question about this week.
   */
  getLinkPerformance(
    context: ExecutionContext,
    input: {
      readonly since: string;
      readonly until?: string;
      readonly linkId?: LinkId;
      readonly postId?: PostDraftId;
      readonly campaignId?: CampaignId;
      readonly limit: number;
    },
  ): Promise<readonly LinkPerformance[]>;

  /**
   * Mint a tracked link.
   *
   * `internal-write`: it creates a row the workspace owns and publishes nothing. The slug is the
   * service's to choose — a caller-supplied one is a way to collide with another tenant's and find out
   * their link exists.
   */
  createTrackedLink(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly destinationUrl: string;
      readonly title?: string;
      readonly postId?: PostDraftId;
      readonly campaignId?: CampaignId;
    },
  ): Promise<TrackedLink>;
}

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
 * The columns `workspace_ai_profile` has — no more, because there is no more. In particular
 * `audience` is **one free-text field, not segments**: docs/07 asks for "audience segments" and the store
 * holds a paragraph. Promising a structure the store cannot fill would make the adapter invent one.
 *
 * The brand-kit fields (#634 §4, `logoPath` onwards) come from `20260929200000_workspace_brand_kit.sql`
 * and are read tolerantly: until that migration is applied they are simply absent.
 */
export type BrandProfile = {
  readonly brandName?: string;
  readonly company?: string;
  readonly website?: string;
  /** Free text. Not a list of segments — see above. */
  readonly audience?: string;
  readonly voice?: string;
  readonly customInstructions?: string;
  /** A path in the `media` bucket. The prompt only says a logo exists; the bytes never reach it. */
  readonly logoPath?: string;
  /** Up to four, `#rrggbb` lower-case. */
  readonly colors?: readonly BrandColor[];
  readonly industry?: string;
  /** Tone words chosen in settings, e.g. `["Friendly", "Witty"]`. */
  readonly tone?: readonly string[];
  readonly emojiUse?: EmojiUse;
  readonly hashtagStyle?: HashtagStyle;
  /** `auto`, `en`, `de`, `en+de` — or any other code a later settings page writes. */
  readonly language?: string;
  /** Free text: words and claims the brand does not use. Advisory prompt text, not the claim policy. */
  readonly avoid?: string;
};

export type BrandColor = { readonly hex: string; readonly name?: string };
export type EmojiUse = "none" | "light" | "lots";
export type HashtagStyle = "none" | "few" | "many";

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
  /**
   * Where this example came from — REQ-013 AC-1.
   *
   * The vocabulary is `posts.voice_exemplar_source`'s, minus the value nothing produces. `manual` is a
   * post somebody ticked; `auto_top` is one the workspace's own metrics ranked highly. They are not
   * interchangeable to a reader: "this is how you said you want to sound" and "this is what worked"
   * are different claims, and a caller that renders them identically is making one of them up.
   *
   * Optional, because an implementation with one source has nothing to distinguish.
   */
  readonly source?: "manual" | "auto_top";
};

/**
 * A change to the workspace's brand settings — #641. Absent = leave as it is; `null` = clear it. The same
 * columns Settings → Brand writes, so what the assistant saves is what the page shows.
 */
export type BrandProfilePatch = {
  readonly [K in keyof BrandProfile]?: BrandProfile[K] | null;
};

export interface BrandService {
  getBrandProfile(context: ExecutionContext): Promise<BrandProfile>;

  /**
   * Save a change to the workspace's brand settings — #641, so the assistant can set tone, colours, the logo
   * and the rest when asked. Returns the profile as saved and which fields changed. Optional: a store that
   * cannot write simply does not offer it, and the tool says so.
   */
  updateBrandProfile?(
    context: ExecutionContext,
    patch: BrandProfilePatch,
  ): Promise<{ readonly profile: BrandProfile; readonly changed: readonly (keyof BrandProfile)[] }>;

  getClaimPolicy(context: ExecutionContext): Promise<ClaimPolicy>;

  /**
   * The workspace's own best and flagged posts. Heuristic selection is ShareFlow's, not ours.
   *
   * **`limit` is a ceiling on what is returned, not on what is read** — REQ-013 AC-3, #278. An
   * implementation is free to consider a larger pool and choose within it, and the Postgres one does:
   * it selects for voice representativeness over the most recent flagged posts rather than taking the
   * most recent N. The reasoning and its limits are in `brand/voice-coverage.ts`, from spike #279.
   *
   * That freedom is stated here because the alternative reading — that this is `order by … limit n` —
   * is what the first implementation did, and a caller that assumed it would be surprised to find the
   * same `limit` returning a different set after a post was flagged that it does not see.
   */
  listVoiceExamples(
    context: ExecutionContext,
    input: { readonly limit: number },
  ): Promise<readonly VoiceExample[]>;

  /**
   * A compact "what is working" brief, or null when there is nothing to say.
   *
   * **Expensive**: ShareFlow's version joins metrics across sixty rows.
   *
   * **Nothing calls this.** Its only consumer was `createPerformanceContextProvider`, removed in #428
   * because the capability already existed as tools the model can call on intent — `get_post_metrics`,
   * `get_campaign_metrics`, `get_attribution` — and a context provider pays on every turn for
   * something a routine request never needs. The Postgres adapter answers `null` and declares itself
   * unimplemented for it.
   *
   * Left on the port rather than removed: a port is what an adapter may implement, and this one is a
   * reasonable thing for a future adapter to answer. But it is unreferenced today, and a reader
   * should not have to discover that by grepping.
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
/**
 * One advisory idea for a campaign — REQ-041, `route:POST /campaign/suggest`.
 *
 * Advisory is the whole point: *"the human writes the posts; this suggests distinct angles/hooks with a
 * recommended format and best-fit channels"*. Nothing here is a caption, and nothing is saved.
 */
/**
 * One post derived from a source.
 *
 * `platformId` is the destination this piece was written for, and it is always one the caller asked
 * for — see the adapter's clamp. The old engine took the model's own `platform` field when it sent
 * one (`str(item.get("platform") or assigned[i])`), which lets a drifting model retarget a piece at a
 * platform the workspace never named.
 */
export type RepurposedPiece = {
  /** The takeaway this piece is built on. What makes two pieces different rather than reworded. */
  readonly angle: string;
  readonly platformId: PlatformId;
  readonly caption: string;
};

/**
 * One beat of a script — a shot in a reel, a slide in a carousel. #458.
 *
 * The shape and every field's reason are in `docs/specs/458-script-shape.md`, written **before** the
 * prompt that asks for it, because a schema invented inside a prompt is a schema nobody agreed to.
 *
 * `onScreen` is required and `voiceover` is not: silent autoplay is the default on every feed these
 * platforms run, so a beat whose meaning lives only in audio is not a beat somebody can shoot.
 */
export type ScriptBeat = {
  readonly onScreen: string;
  /** What is said over it. Reel only — a carousel has no audio. */
  readonly voiceover?: string;
  /** Shot direction, not prose. "Close on the grinder burrs" rather than "we show craftsmanship". */
  readonly visual?: string;
  /** Roughly how long this beat runs. Reel only — a carousel has no time axis. */
  readonly seconds?: number;
};

/**
 * A set drawn from one source — REQ-015 AC-2, #458.
 *
 * A **tagged union**, not one widened type, for the reason `generate_alternatives` is a separate tool
 * from `generate_content` (#266): a caller that reads `caption` off a script gets an empty string and
 * publishes it, where a union makes that a compile error. The tag is what each arm is *for*, and the
 * three arms have three different destinations:
 *
 * | arm | goes to | publishable |
 * |---|---|---|
 * | `post` | `create_post_draft` | yes |
 * | `thread` | `create_thread_draft` (#456) | yes |
 * | `script` | `create_artifact` | **no** — it is a document |
 *
 * `angle` is on every arm because it is what makes two items different rather than reworded, and that
 * property is the whole point of drawing several things from one source.
 */
export type RepurposedItem =
  | {
      readonly format: "post";
      readonly angle: string;
      readonly platformId: PlatformId;
      readonly caption: string;
    }
  | {
      readonly format: "thread";
      readonly angle: string;
      readonly platformId: PlatformId;
      /** In order. Two or more — one part is a post, and `createThreadDraft` refuses fewer. */
      readonly parts: readonly string[];
    }
  | {
      readonly format: "script";
      readonly angle: string;
      readonly kind: "reel" | "carousel";
      readonly title: string;
      /**
       * The first line, separate from `beats[0]` deliberately.
       *
       * In short-form video the first two seconds decide whether the rest is watched, and a script
       * that buries the hook in a list of equal beats invites a model to write five equal beats.
       */
      readonly hook: string;
      readonly beats: readonly ScriptBeat[];
      readonly cta: string;
      /**
       * The same script as markdown, for `create_artifact`.
       *
       * Rendered by the adapter from the fields above rather than asked of the model. A model asked
       * for a document *and* a structure will eventually return a document that does not match its own
       * structure, and the artifact is the half a person reads.
       */
      readonly markdown: string;
    };

export type CampaignIdea = {
  readonly angle: string;
  /** The opening line, which is what makes two ideas actually distinct. */
  readonly hook: string;
  readonly cta: string;
  /** Clamped by the adapter to what the product can render. */
  readonly format: "text" | "image" | "video";
  /**
   * Destinations this idea suits, **filtered to what the workspace has**.
   *
   * The old runtime clamped this for a stated reason — "so a drifting model can't suggest platforms the
   * workspace doesn't have" — and it is the safety-relevant field: an idea recommending a channel nobody
   * is connected to sends a person to set one up on the strength of a model's guess.
   */
  readonly channels: readonly string[];
  /** One practical note. Optional, because a model with nothing useful to add should say nothing. */
  readonly tip?: string;
};

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
/**
 * Where a post sits in the journey it is part of — REQ-018 AC-2, `posts.funnel_stage`.
 *
 * Four values, not the three the requirement names. The column's CHECK constraint admits
 * `retention` as well, and a tool that refused it would reject a stage the store accepts and the
 * shipped templates could start using tomorrow. The database is the authority on the vocabulary;
 * this is a transcription of it.
 */
export type FunnelStage = "awareness" | "consideration" | "conversion" | "retention";

/**
 * One slot in a campaign's funnel plan: what the post in this position is *for* — REQ-018.
 *
 * This is the shape `campaign_templates.post_plan` stores, which is why `angle` and `cta` are here
 * and optional: a playbook names them ("Tease the problem you solve" / "Follow for the reveal") and
 * a persona-and-goal campaign with no template does not.
 *
 * `angle` is **guidance, not the angle**. The playbook's wording is generic by construction — it has
 * to fit any theme — so it steers the proposal rather than replacing it, and the angle a reader ends
 * up seeing is still written for this campaign's subject.
 */
export interface FunnelStep {
  readonly stage: FunnelStage;
  /** The playbook's own angle for this slot, when a template names one. */
  readonly angle?: string;
  /** What this post asks the reader to do. */
  readonly cta?: string;
}

/**
 * The four things a caption is scored on — REQ-014 AC-1.
 *
 * Transcribed from the acceptance rather than invented: *"N candidates scored against a rubric
 * (hook/on-brand/CTA/platform-fit)"*. Four separate numbers rather than one, because they disagree in
 * useful ways — a caption can open brilliantly and ask for nothing — and because a single score gives
 * a refinement pass nothing to act on.
 */
export type DraftScores = {
  /** Does the first line earn the second? */
  readonly hook: number;
  /** Does it sound like this workspace, given the brand and its own posts? */
  readonly onBrand: number;
  /** Does it ask for something, and is the ask the right size? */
  readonly cta: number;
  /** Is it written for this platform's conventions rather than translated into them? */
  readonly platformFit: number;
};

/** One candidate caption and what the rubric made of it. */
export type ScoredDraft = {
  readonly caption: string;
  readonly scores: DraftScores;
  /** The mean of the four, 0-10. What the picker ranks by. */
  readonly overall: number;
  /** Whether this one went through the refinement pass — REQ-014 AC-2. */
  readonly refined: boolean;
  /**
   * Why the rubric scored it that way, in one line.
   *
   * Kept because it is what makes a score actionable to a person choosing between three captions — a
   * bare 6.8 says which to pick and nothing about why the others lost.
   */
  readonly critique: string;
};

/**
 * One hashtag, and why it is on the list — REQ-016 AC-2.
 *
 * The rationale is not decoration. *"Researched, relevance-ranked, not invented"* is unverifiable from
 * a bare list of tags: `#coffee` looks identical whether it came from a live search or from the
 * model's idea of what coffee people write. The rationale is what a person checks the claim against,
 * and what makes an ungrounded run visibly different from a grounded one.
 */
export type ResearchedHashtag = {
  /** Normalised: a single `#`, no whitespace. `#SpringLot`, never `# spring lot`. */
  readonly tag: string;
  /** One line — what this tag is for, and where it came from when the run was grounded. */
  readonly rationale: string;
};

export interface ContentGenerator {
  proposeAngles(
    context: ExecutionContext,
    input: {
      readonly brief: string;
      readonly count: number;
      /**
       * Live findings to ground the angles in, when the caller searched.
       *
       * Separate from `brief` rather than appended to it, for the same reason `suggestIdeas` takes them
       * separately: the brief is the *user's* words, and findings come with an instruction attached
       * ("do not fabricate specifics beyond these") that belongs next to the prompt, not in a caller's
       * string concatenation.
       */
      readonly trends?: readonly { readonly title: string; readonly snippet: string }[];
      /**
       * The funnel slot each proposed angle is for, positionally — REQ-018 AC-3.
       *
       * `steps[i]` belongs to the i-th angle asked for. This is what makes a campaign a *sequence*
       * rather than N posts on one theme: the first angle is asked to earn attention and the last to
       * ask for the sale, and they are different jobs even when the theme is identical.
       *
       * Positional rather than a count per stage, because order carries the meaning. A plan of
       * awareness → consideration → conversion is not the same plan as its reverse, and a caller
       * handing over `{awareness: 1, conversion: 2}` could not express the difference.
       *
       * Omitted entirely by a campaign with no funnel plan, which is the common case and still gets
       * distinct angles — it just does not get a shaped sequence.
       */
      readonly steps?: readonly FunnelStep[];
    },
  ): Promise<readonly ContentAngle[]>;

  /**
   * Advisory campaign ideas, grounded in whatever the caller found.
   *
   * `trends` is passed in rather than fetched here, because searching is `ResearchService`'s job and a
   * generator that reached for the web would be a second place the egress policy lived. An empty list
   * means the ideas are not trend-grounded, which the caller is expected to say out loud rather than
   * imply.
   */
  suggestIdeas(
    context: ExecutionContext,
    input: {
      readonly theme: string;
      readonly goal?: string;
      readonly count: number;
      /** Platform ids the workspace actually has. Empty means no restriction. */
      readonly channels: readonly string[];
      readonly mediaType?: string;
      readonly trends: readonly { readonly title: string; readonly snippet: string }[];
    },
  ): Promise<readonly CampaignIdea[]>;

  /**
   * What is in an image, in words — replacing `route:POST /vision/describe`.
   *
   * Three modes, and they are not three tones of the same answer: `alt_text` is an accessibility
   * description with a hard rule and a 125-character ceiling, `caption` is copy, and `competitor` is
   * analysis of a screenshot. The mode decides the whole instruction.
   *
   * Takes **bytes**, not a URL or a path. Fetching is the caller's, which keeps the egress policy in one
   * place, and a path is not something this runtime can produce — see `PdfSource`.
   */
  describeImage(
    context: ExecutionContext,
    input: {
      readonly image: { readonly bytes: Uint8Array; readonly mime: string };
      readonly mode: "alt_text" | "caption" | "competitor";
    },
  ): Promise<string>;

  /**
   * A short media brief expanded into a generation prompt — replacing `route:POST /enhance-media-prompt`.
   *
   * On this port for the same reason `evaluateCampaign` is: it is the model-backed one. The prompt it
   * writes is for an *image or video* model, not for this one, which is why the result is a string the
   * caller passes on rather than anything this package renders.
   *
   * **It does not swallow a failure.** The old route returned the user's original prompt on any model
   * error — *"enhancement must never block generation"* — and its caller
   * (`web/src/app/api/ai/generate-media/route.ts`) *also* keeps the raw prompt when the call fails. The
   * guarantee already lives on the caller's side, so swallowing it here as well would only cost the
   * ability to tell a degraded run from a working one.
   */
  enhanceMediaPrompt(
    context: ExecutionContext,
    input: { readonly brief: string; readonly kind: "image" | "video" },
  ): Promise<string>;

  /**
   * Classify an inbound comment against the workspace's reply rules and draft a reply — replacing
   * `route:POST /reply`, the last endpoint keeping `ai_backend` alive.
   *
   * Everything except the reply text is decided by `src/reply/auto-reply.ts`, which is a transcription
   * of the Python's keyword heuristics and is checked against it by a differential test. The reason for
   * that split is what this method returns: `confidence` gates auto-send in the ingest cycle, and a
   * reply above the threshold reaches a customer's public audience with no human in the loop.
   *
   * The model is called for the prose only, and a failure **propagates** rather than resolving to an
   * empty draft — the worker treats a null result as "leave it in `needs_review`", so an exception is
   * the honest outcome and a blank success would be a silent one.
   */
  draftAutoReply(
    context: ExecutionContext,
    input: {
      readonly comment: string;
      readonly rules: readonly { readonly title: string; readonly description?: string | null }[];
      readonly tone?: string | null;
      readonly accountName?: string | null;
      readonly persona?: Partial<ReplyPersona>;
      readonly threadContext?: readonly { readonly role: "commenter" | "account"; readonly content: string }[];
    },
  ): Promise<AutoReplyResult>;

  /**
   * One concept into N sequential scene prompts — replacing `route:POST /plan-video-scenes`.
   *
   * All or nothing, which is the old planner's decision: it raised when fewer scenes came back than
   * were asked for. A three-scene film delivered as two scenes is not a shorter film, it is a film
   * missing its middle.
   */
  planVideoScenes(
    context: ExecutionContext,
    input: { readonly concept: string; readonly sceneCount: number },
  ): Promise<readonly string[]>;

  /**
   * One source into several posts — replacing `route:POST /repurpose`.
   *
   * One model call, not N: the old engine's shape, and the reason is in its own docstring — *"one call
   * extracts N distinct angles from the source and drafts a native caption per target platform"*. A
   * per-piece call would see one angle at a time and could not tell that two of them are the same
   * takeaway reworded, which is the whole property being asked for.
   *
   * `platformIds` are assigned **round-robin** across the pieces, which is also the old behaviour
   * ("platforms cycle across the N pieces"). The assignment is the adapter's, because it is what the
   * prompt tells the model and what the answer is keyed to.
   */
  repurpose(
    context: ExecutionContext,
    input: {
      /** The source text. Already extracted — this port does not fetch. */
      readonly source: string;
      readonly count: number;
      readonly platformIds: readonly PlatformId[];
    },
  ): Promise<readonly RepurposedPiece[]>;

  /**
   * One source into a set of **different kinds** of thing — REQ-015 AC-2, #458.
   *
   * `repurpose` returns N captions. That is "several posts", not "a multi-format set": every piece it
   * can produce is a post body, so the acceptance's *"carousel + reel script + thread"* had no way to
   * be expressed at all.
   *
   * **One model call, like `repurpose` and for a sharper version of its reason.** Its docstring says a
   * per-piece call *"could not tell that two of them are the same takeaway reworded"*. Across formats
   * that matters more, not less: the thread and the reel script drawn from one article should not be
   * the same argument twice, and only a call that writes both can see it.
   *
   * Counts are per format and bounded by the implementation. A caller asking for zero of something
   * gets none of it, which is how a set of one kind is requested without a second method.
   */
  repurposeToFormats(
    context: ExecutionContext,
    input: {
      readonly source: string;
      readonly platformIds: readonly PlatformId[];
      readonly posts: number;
      readonly threads: number;
      readonly scripts: number;
    },
  ): Promise<readonly RepurposedItem[]>;

  /**
   * A campaign's performance, in prose — replacing `route:POST /campaign/evaluate`.
   *
   * **On this port rather than `AnalyticsService`, and that is a deliberate choice.** `MetricsReport` has
   * no `interpretation` field on purpose: *"not 'facts and interpretations are kept apart' but 'an
   * interpretation cannot be in here'"*. An evaluation is precisely an interpretation, so it cannot come
   * out of that port without breaking the guarantee its header states. This is the model-backed port, and
   * a twelfth service for one method would be filing rather than design.
   *
   * The numbers arrive as `Fact`s, not as a formatted string, for the reason the old shape made
   * unenforceable: `evaluate_campaign(stats: str)` was told *"use only the numbers provided — never invent
   * metrics"*, which is worth nothing when the model is what provides them. The tool reads them from the
   * store and hands them over, and the adapter is the only place they become prose.
   *
   * The `Fact` union survives the trip. A metric that is `unavailable` must render as *not measured* and
   * never as zero — an assistant handed `0` reports "engagement was 0%" when the truth is "nothing was
   * collected", which is the defect `analytics.ts` exists to avoid.
   */
  evaluateCampaign(
    context: ExecutionContext,
    input: {
      readonly theme: string;
      readonly goal?: string;
      readonly totals: readonly Fact[];
      readonly posts: readonly CampaignPostFacts[];
    },
  ): Promise<string>;

  generate(
    context: ExecutionContext,
    input: {
      readonly brief: string;
      readonly angle?: ContentAngle;
      readonly platformIds: readonly PlatformId[];
      /** Findings from the previous attempt. Empty on the first. */
      readonly avoid: readonly ValidationIssue[];
      /**
       * Hooks already used by sibling posts in the same campaign — REQ-041, `route:POST /campaign`.
       *
       * Separate from `avoid`, and it has to be. `avoid` renders as *"The previous attempt was
       * rejected. Do not repeat these"*, which is true of a repair and false of a sibling: telling a
       * model its work was rejected when it was not is a misleading prompt, and the old runtime kept
       * the two apart for the same reason — its sibling block reads "Do NOT reuse these hooks from
       * sibling posts".
       *
       * Optional, because a single post has no siblings.
       */
      readonly avoidHooks?: readonly string[];
      /**
       * The funnel slot this one post occupies — REQ-018 AC-3.
       *
       * Separate from `angle`, and it has to be: an angle is *what the post argues* and a stage is
       * *what it asks for*. The same angle written for awareness opens a question and written for
       * conversion names a price, so a caption told the angle and not the stage writes the wrong
       * ending to the right argument.
       *
       * Optional — a one-off post has no funnel position, and a campaign without a plan does not
       * invent one.
       */
      readonly step?: FunnelStep;
    },
  ): Promise<readonly GeneratedVariant[]>;

  /**
   * N alternatives for **one** destination, scored and ranked — REQ-014.
   *
   * Deliberately a separate method from `generate`, which returns one caption per *destination*. The
   * two look similar and mean opposite things: #115 found the store holds one caption plus
   * `target_platforms`, so per-destination versions are what gets saved, and per-destination versions
   * rendered in a variant picker would offer the user captions for platforms they did not choose.
   * That confusion is why `/api/ai/generate`'s `variants: N` was refused outright rather than mapped.
   *
   * The order is the ranking, best first. `count` is a ceiling on candidates, not a promise: a model
   * that returns three usable drafts for a request for five is a smaller choice, not a failure.
   *
   * **Bounded by the implementation, not by the caller** (AC-5). Scoring and refinement are model
   * calls, and an unbounded quality loop is how one click becomes a bill.
   */
  draftAlternatives(
    context: ExecutionContext,
    input: {
      readonly brief: string;
      readonly platformId: PlatformId;
      readonly count: number;
      readonly angle?: ContentAngle;
    },
  ): Promise<readonly ScoredDraft[]>;

  /**
   * Hashtags for a topic, ranked by relevance — REQ-016 AC-2.
   *
   * **`findings` are passed in rather than fetched**, the same division `suggestIdeas` and
   * `proposeAngles` make: searching is `ResearchService`'s job, and a generator that reached for the
   * web would be a second place the egress policy lived. An empty list means the answer is *not*
   * search-backed, which the caller is expected to say out loud rather than imply — REQ-016 AC-5's
   * graceful fallback is a sentence to the user, not a silent degradation.
   *
   * Ordered best-first; the order **is** the ranking. `count` is a ceiling.
   */
  deriveHashtags(
    context: ExecutionContext,
    input: {
      readonly topic: string;
      readonly count: number;
      readonly platformId?: PlatformId;
      readonly findings: readonly { readonly title: string; readonly snippet: string }[];
    },
  ): Promise<readonly ResearchedHashtag[]>;
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

/**
 * Where a PDF is being read from. A union, so exactly one is sayable.
 *
 * Two fields with "never both" in a comment is the shape `create_post_draft`'s campaign field started
 * as, and the lesson there was the same: a model given two optional fields sends both or neither.
 */
export type PdfSource =
  | { readonly kind: "url"; readonly url: string }
  /**
   * An asset in the workspace's own media.
   *
   * The old tool took a **stored path** here (`<workspace-id>/<file>.pdf`) because its caller could see
   * one. Nothing in this runtime can: the media tools deliberately never return a path or a URL, since
   * *"a signed URL in a tool result is persisted in the run event log and readable by anyone who can
   * read the conversation"*. So the reference is an asset id, and resolving it to bytes is the
   * deployment's job — see `ResearchDeps.readAssetBytes`.
   */
  | { readonly kind: "asset"; readonly assetId: MediaAssetId };

/**
 * A PDF's text, and enough about the read to describe it honestly.
 *
 * `truncated` is the field that matters and the old tool's own docstring says why: *"`truncated` means
 * the document was longer than the read limit, so do not describe it as complete."*
 */
export type PdfDocument = {
  /**
   * The document's `/Title`, when it has one worth having.
   *
   * Passed through rather than cleaned. Measured on a real browser-printed PDF, this field came back as
   * `"about:blank"` — junk, but inventing a filter for the ways a title can be junk is worse than
   * letting the model see what the document actually claims.
   */
  readonly title?: string;
  readonly text: string;
  readonly pages: number;
  readonly pagesRead: number;
  readonly truncated: boolean;
  /**
   * How many headings were recovered from the document's own type sizes — #321.
   *
   * **Zero means the text is flat prose, and that is worth saying rather than leaving to be inferred
   * from the absence of `#`.** A scanned page, a document with no headings, and a structure pass that
   * failed all produce the same flat text; only this number tells them apart from a document whose
   * structure came through.
   *
   * Optional because an implementation without a layout model has no answer, and inventing `0` there
   * would claim it looked and found none.
   */
  readonly headingsFound?: number;
};

export type ReadSourceResult = {
  /** For reading further passages without re-fetching. AC-5's reference half. */
  readonly sourceId: string;
  readonly title?: string;
  readonly passages: readonly SourcePassage[];
  /** True when the source has more than the returned passages cover. */
  readonly truncated: boolean;
};

/** #667: what an injection check concluded about one piece of fetched text. */
export type InjectionVerdict = {
  readonly flagged: boolean;
  /** Short and human-readable: the phrasing matched, or the classifier's label and score. */
  readonly reasons: readonly string[];
  readonly checkedBy: "phrases" | "classifier";
};

/** #667: the optional guardrails for fetched pages and search results — see `adapters/web/web-guard.ts`. */
export type WebContentGuard = {
  /** Present when datamarking is on: returns the text with its whitespace marked. */
  readonly mark?: (text: string) => string;
  /** Checks one piece of fetched text. Never throws. */
  readonly check: (text: string) => Promise<InjectionVerdict>;
};

export interface ResearchService {
  /** #667: the deployment's web-content guard, when it has one. Applied by `search_web` and `read_source` only. */
  readonly guard?: WebContentGuard;
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

  /**
   * Read a PDF's text — replacing `tool:read_pdf`.
   *
   * On this port and not a new one: it is the third member of the read-a-source family, and the old
   * runtime said so itself — *"third member alongside `capture.py` (render a page to PNG for a human)
   * and `readpage.py` (pull a page's text for the model)"*. `read_source` cannot do it, and the reason
   * is not a missing feature: Chromium renders a PDF in a plugin viewer whose contents `innerText`
   * cannot see.
   *
   * Every obligation `readSource` carries applies here **and one more**: the whole file has to be
   * resident to parse it, so the byte cap is not a context-window courtesy but the thing standing
   * between a link and the container's memory.
   *
   * Throws rather than returning a reason, unlike `search`. A PDF that cannot be read is not a
   * degraded answer with a usable half — there is no text — and the caller needs the *reason* to say
   * anything useful: "that one is password-protected" and "that one is a scan with no text layer" send
   * a person to different next steps.
   */
  readPdf(context: ExecutionContext, input: { readonly source: PdfSource }): Promise<PdfDocument>;

  /**
   * An image's bytes, from a link or from the workspace's own media.
   *
   * Here rather than on `MediaService` for the same reason `readPdf` is: guarded fetching and the
   * deployment's byte resolver already live in this adapter, and a second copy of either is a second
   * egress policy. `MediaService` deliberately never returns content — the media tools hand back
   * references so bytes cannot land in a tool result.
   *
   * The mime type comes back because a vision call needs it: a PNG sent as `image/jpeg` is a decode
   * error inside the provider, which reads as the model failing.
   */
  readImage(
    context: ExecutionContext,
    input: { readonly source: PdfSource },
  ): Promise<{ readonly bytes: Uint8Array; readonly mime: string }>;

  /**
   * Search a stock library (Pexels) — #615. Nothing is stored; the result is candidates to pick from.
   *
   * Optional on the port so a partial deployment (or a test stub) need not implement it; the tools refuse
   * by name when it is absent, and the web implementation refuses by name when no key is configured.
   */
  searchStockMedia?(context: ExecutionContext, input: StockMediaSearchInput): Promise<StockMediaSearch>;

  /**
   * One stock item's bytes, downloaded under a byte cap, plus the attribution the licence asks for.
   * Storing them is the caller's, through `MediaService.storeAsset`, as for every other produced file.
   */
  fetchStockMedia?(context: ExecutionContext, input: StockMediaFetchInput): Promise<StockMediaDownload>;
}

/** #615: what a stock search can return. */
export const STOCK_MEDIA_KINDS = ["photo", "video"] as const;
export type StockMediaKind = (typeof STOCK_MEDIA_KINDS)[number];
export const STOCK_MEDIA_ORIENTATIONS = ["landscape", "portrait", "square"] as const;
export type StockMediaOrientation = (typeof STOCK_MEDIA_ORIENTATIONS)[number];
/** Download sizes. Photos: `large` (~940 px wide), `large2x` (~1880 px, the default), `original` (capped by bytes). Videos: `sd` (≤ 960 px), `hd` (≤ 1920 px, the default). */
export const STOCK_MEDIA_SIZES = ["large", "large2x", "original", "sd", "hd"] as const;
export type StockMediaSize = (typeof STOCK_MEDIA_SIZES)[number];

export type StockMediaSearchInput = {
  readonly query: string;
  readonly kind: StockMediaKind;
  readonly orientation?: StockMediaOrientation;
  readonly count: number;
};

/**
 * One candidate. The URLs are the library's own public CDN links (not signed, not workspace storage), so
 * they are safe to show; the photographer and page are what attribution needs.
 */
export type StockMediaItem = {
  readonly id: string;
  readonly kind: StockMediaKind;
  readonly width: number;
  readonly height: number;
  readonly thumbnailUrl: string;
  readonly previewUrl: string;
  readonly photographer: string;
  readonly photographerUrl: string;
  readonly pageUrl: string;
  readonly avgColor?: string;
  readonly alt?: string;
  /** Seconds, videos only. */
  readonly duration?: number;
};

export type StockMediaSearch = {
  readonly provider: "Pexels";
  readonly items: readonly StockMediaItem[];
  readonly totalResults: number;
  /** Requests left in the provider's current window, when it said. */
  readonly rateLimitRemaining?: number;
};

export type StockMediaFetchInput = {
  readonly id: string;
  readonly kind: StockMediaKind;
  readonly size?: StockMediaSize;
};

export type StockMediaDownload = {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly item: StockMediaItem;
};


// ---------------------------------------------------------------------------------------------------
// Analytics — measured facts, and nothing that interprets them (#125).
// ---------------------------------------------------------------------------------------------------

/** What a number is. Named so the assistant does not have to infer it from the metric's name. */
export const METRIC_UNITS = ["count", "seconds", "fraction", "minor-units"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** The window a fact covers. A number without one is not a fact, it is a rumour. */
export type MetricWindow = {
  /** Inclusive, `YYYY-MM-DD`. */
  readonly fromDay: CalendarDate;
  readonly toDay: CalendarDate;
};

/**
 * Where a number came from.
 *
 * **Not the rows themselves.** An aggregate over 500 records carries 500 references, which is a context
 * bomb and 500 ids the model will never read. "Traceable" means an auditor can find the rows, not that the
 * rows are inlined — so the record type and count always, and the ids only when the set is small enough to
 * be worth reading.
 */
export type FactDerivation = {
  readonly recordType: "post_metrics" | "analytics_daily" | "scheduled_items" | "leads";
  readonly recordCount: number;
  /** Present only for a small set. Absent does not mean untraceable — `recordType` plus the window is. */
  readonly recordIds?: readonly string[];
};

/**
 * One measured number, or an explicit statement that it was not measured.
 *
 * **A discriminated union, and this is the third time that has been the right answer** — after #120's
 * suppressed lead and #124's unavailable search. The specific bug it avoids here:
 * `computeAnalyticsKpis` guards divide-by-zero by returning **0** for engagement rate when impressions are
 * zero. Correct for a dashboard tile, wrong as a fact — *no impressions* is undefined, not zero, and an
 * assistant handed `0` will report "engagement was 0%" when the truth is "nothing was measured".
 *
 * `analytics-reporting` already says *"if a platform is not covered, say we cannot see its comments — not
 * that the post has none."* This makes the data shape agree with the skill instead of relying on the model
 * to remember it.
 */
export type Fact =
  | {
      readonly metric: string;
      readonly unit: MetricUnit;
      readonly window: MetricWindow;
      readonly value: number;
      readonly derivedFrom: FactDerivation;
    }
  | {
      readonly metric: string;
      readonly unit: MetricUnit;
      readonly window: MetricWindow;
      /** `no-data`: nothing collected yet. `not-collected`: this platform is not covered at all. */
      readonly unavailable: "no-data" | "not-collected";
    };

/**
 * How fresh the numbers are.
 *
 * Analytics are stored and refreshed periodically, not read live — so a fact without an age invites
 * "this post has 412 likes", which implies a live number nobody has.
 */
export type MetricFreshness = {
  readonly lastRefreshedAt?: string;
  /** True past ShareFlow's own staleness threshold. The judgement is the service's, not a computed age. */
  readonly stale: boolean;
};

/**
 * The envelope. **Facts only.**
 *
 * There is deliberately no `interpretation` field, and that is AC-2 in its strongest form: not "facts and
 * interpretations are kept apart" but "an interpretation cannot be in here". Who would fill it? The model,
 * after reading the facts — so a tool that emitted one would be doing what AC-1 forbids.
 */
export type MetricsReport = {
  readonly facts: readonly Fact[];
  readonly freshness: MetricFreshness;
  /**
   * True when the caller may not see every record the aggregate would otherwise cover.
   *
   * **A boolean, and only a boolean.** The obvious way to admit a partial aggregate — an excluded count —
   * *is itself the leak*: it reveals the existence and volume of data the caller may not see, which is the
   * classic aggregate attack arrived at by trying to be helpful. This says the number is partial without
   * quantifying what is hidden.
   *
   * And it must be said. A permission-scoped aggregate that does not admit it is a wrong number presented
   * as a right one.
   */
  readonly scoped: boolean;
};

/**
 * One post's numbers inside a campaign.
 *
 * The identity fields are here rather than left to the caller to join, because the alternative is a tool
 * pairing `listDrafts` output with a metrics report by id — a second assembly to keep in step with, and the
 * port already says aggregation is the service's job.
 */
export type CampaignPostFacts = {
  readonly draftId: PostDraftId;
  /** The recognition excerpt, same rule as `PostDraftSummary` — never the body. */
  readonly excerpt: string;
  readonly platforms: readonly PlatformId[];
  /**
   * Destinations that actually published.
   *
   * Separate from the facts because it answers a different question: a post with zero published
   * destinations has no numbers *because it never went out*, which is not the same as a platform whose
   * metrics this deployment cannot see.
   */
  readonly publishedDestinations: number;
  readonly facts: readonly Fact[];
};

/**
 * A campaign's numbers, per post **and** in total.
 *
 * Exists because "which post did best" is unanswerable from `campaignMetrics` — that method aggregates, by
 * design. An evaluation that cannot name the best post is not the capability the old runtime had, and
 * shipping it without this would be a partial dressed as a replacement.
 *
 * `totals` is the same aggregate `campaignMetrics` reports for the same window, computed from the same rows
 * rather than by summing `posts` — a caller summing per-post facts would get the engagement rate wrong,
 * since a mean of rates is not the rate of the totals.
 */
export type CampaignBreakdown = {
  /** Oldest post first, which is the order a campaign reads in. */
  readonly posts: readonly CampaignPostFacts[];
  readonly totals: readonly Fact[];
  readonly freshness: MetricFreshness;
  readonly scoped: boolean;
};

export interface AnalyticsService {
  /** Metrics for one post, across its destinations. */
  postMetrics(
    context: ExecutionContext,
    input: { readonly draftId: PostDraftId; readonly window?: MetricWindow },
  ): Promise<MetricsReport>;

  /** Metrics for a campaign's posts, aggregated by the service — never by the caller. */
  campaignMetrics(
    context: ExecutionContext,
    input: { readonly campaignId: CampaignId; readonly window?: MetricWindow },
  ): Promise<MetricsReport>;

  /**
   * The same campaign, broken down per post.
   *
   * Still facts only — this is a second shape of the same measurement, not a softer envelope. `Fact`'s
   * union carries per post, so a destination nobody collected stays `not-collected` here too.
   */
  campaignBreakdown(
    context: ExecutionContext,
    input: { readonly campaignId: CampaignId; readonly window?: MetricWindow },
  ): Promise<CampaignBreakdown>;

  /**
   * Leads attributed to a post or campaign, using the linkage #120 stores.
   *
   * Traceable by construction: the attribution was recorded when the lead was created, so a number here
   * resolves to lead records rather than to a join someone hopes is right.
   */
  attribution(
    context: ExecutionContext,
    input: {
      readonly draftId?: PostDraftId;
      readonly campaignId?: CampaignId;
      readonly window?: MetricWindow;
    },
  ): Promise<MetricsReport>;
}

// ---------------------------------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------------------------------

/**
 * From `assistant_artifacts_kind_check`, which is the authority — not the calling code.
 *
 * The lesson `ConnectorService` learned the hard way: `social_accounts.status` was mapped from the app's
 * switch statement and the database refused the fixture, because the constraint admitted a value the code
 * never wrote. Read the constraint.
 *
 * `slides` since #607 (`20260928120000_artifact_slides_kind.sql`): a deck as markdown split at `---`.
 * `react` and `svg` since #607 part 3 (`20260929090000_artifact_react_svg_kinds.sql`): a single-file React
 * component run in the panel's sandbox, and a vector drawing sanitized on write (`design/svg.ts`).
 */
export const ARTIFACT_KINDS = ["markdown", "html", "mermaid", "slides", "react", "svg"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The size limits, transcribed from `web/src/lib/internal/artifacts.ts` — and in the **port**, not the adapter.
 *
 * Both the adapter and the tool schema need them, and the first version had the tool importing them from
 * `adapters/postgres/artifacts.ts`. That compiles and passes the boundary check, because a constant is not
 * I/O — but it makes the model-facing contract depend on one storage backend, so a second adapter would
 * either import Postgres' numbers or quietly disagree with the schema that validates its input.
 *
 * Transcribed rather than chosen: a runtime that accepted a 400,000-character artifact would write a row the
 * app's own editor refuses to save back, and that surfaces as a broken document rather than a rejected call.
 */
export const ARTIFACT_MAX_CHARS = 200_000;
export const ARTIFACT_MAX_TITLE = 200;

export type Artifact = {
  readonly id: ArtifactId;
  readonly title: string;
  /** Fixed at creation. `revise` cannot change it — see `ArtifactService.revise`. */
  readonly kind: ArtifactKind;
  readonly content: string;
  /** 1 on creation, and one higher on every revision. Every prior version is kept. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * A `chorus-artifact:<uuid>` href for the assistant to put in its reply as a markdown link.
   *
   * Optional because the app's own formatter returns null for anything that is not a uuid, and it does that
   * for a reason worth preserving: a reply streams token by token, so a half-written reference exists for a
   * frame, and a client that rendered a card for it would fetch an artifact that cannot be found. Absent
   * means "do not link to this", which is a different instruction from an empty string.
   */
  readonly reference?: string;
};

/**
 * Documents the user opens beside the chat — REQ-041 (#190).
 *
 * The capability the old runtime's Documents agent owned, and the one place in this package where the point is
 * that a thing is **edited**: "make the intro shorter" has to produce version 2 of the same document, not a
 * second file with a similar name. That is why artifacts are rows and not media — a generated PDF is binary
 * and immutable, an artifact is neither.
 *
 * There is no `list` and no `delete`, because the old runtime has neither. A tool the old product did not have
 * is not parity, it is scope: `create_artifact`, `update_artifact` and `get_artifact` are the three that
 * exist, and a fourth would be a capability with nothing to compare against.
 */
export type ArtifactService = {
  create(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly title: string;
      readonly kind: ArtifactKind;
      readonly content: string;
    },
  ): Promise<Artifact>;

  /**
   * Replace an artifact's body, keeping the previous version.
   *
   * `content` is the **whole** new document, not a patch — the old tool says so explicitly, and the reason is
   * that a model asked for a diff produces one that does not apply. `title` is optional and omitting it keeps
   * the current one.
   *
   * `kind` is deliberately absent. The old runtime validates a revision against the *stored* kind, so markdown
   * cannot become html by revision, and a caller who wants a different kind creates a different artifact. The
   * id is stable across revisions so a reference shown ten edits ago still resolves.
   */
  revise(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: ArtifactId;
      readonly content: string;
      readonly title?: string;
    },
  ): Promise<Artifact>;

  get(context: ExecutionContext, input: { readonly id: ArtifactId }): Promise<Artifact>;
};

/**
 * What a browser render produced. Bytes, never a stored location.
 *
 * The caller stores it — `MediaService.storeAsset` — for the same reason every reader here takes bytes:
 * this package holds no storage credential, and the credential is the whole reason for the hop.
 */
/**
 * A drawn diagram, with the size it came out at.
 *
 * The dimensions are the *element's*, not the viewport's — the screenshot is clipped to the drawing, so
 * a short diagram has no dead whitespace under it and the caller knows what it is attaching.
 */
/**
 * A printed document.
 *
 * `pages` is read out of the PDF's own structure and is a nicety for the reply text — *"never something
 * to fail a successful render over."*
 */
export type RenderedDocument = {
  readonly bytes: Uint8Array;
  readonly mime: "application/pdf";
  readonly pages: number;
  /** #660: what the print actually looks like — page size, overflow, missing fonts. Best-effort; absent when unmeasured. */
  readonly facts?: RenderFacts;
};

export type RenderedDiagram = {
  readonly bytes: Uint8Array;
  readonly mime: "image/png";
  readonly width: number;
  readonly height: number;
};

/** #620: a slide deck recorded as a video, with the timing it was recorded at. */
export type RenderedVideo = {
  readonly bytes: Uint8Array;
  readonly mime: "video/mp4";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly secondsPerSlide: number;
  /** True when the seconds per slide asked for were shortened to keep the video within its limit. */
  readonly shortened: boolean;
};

export type RenderedImage = {
  readonly bytes: Uint8Array;
  readonly mime: "image/png";
  /** The page's `<title>`, when it had one. Empty rather than absent: a page with no title is normal. */
  readonly title: string;
  /** The URL that was rendered. Echoed because the caller may have supplied a search query instead. */
  readonly url: string;
};

/**
 * The capabilities that need a headless browser — REQ-010 (#234) and the diagram/PDF pair.
 *
 * One service because all three share one dependency and one operational constraint: Chromium, and the
 * single slot it runs in. The old runtime had that constraint in two files and was OOM-killed for it.
 */
export interface RenderService {
  /**
   * Render a URL and return a screenshot.
   *
   * *"Used as a reference asset for the human planning a campaign — the model never 'sees' the image."*
   * That is worth keeping in mind about the result: it is a picture for a person, and a tool returning
   * it hands back a reference rather than the bytes.
   */
  captureWebsite(context: ExecutionContext, input: { readonly url: string }): Promise<RenderedImage>;

  /**
   * Load a page in the browser, under `captureWebsite`'s guards, and return its readable text — #621.
   *
   * The fallback `read_source` uses when the plain fetch is refused (401, 403, 429, or a bot wall on a 200):
   * a documentation site that answers a bare HTTP client with 403 usually serves a browser. Optional, so a
   * deployment without Chromium keeps the fetch's clear refusal. The text is the page's, and so untrusted —
   * the caller fences it exactly as it fences fetched text.
   */
  readPageText?(context: ExecutionContext, input: { readonly url: string }): Promise<{ readonly url: string; readonly title: string; readonly text: string; readonly truncated: boolean }>;

  /**
   * Draw a mermaid diagram as a PNG — replacing `tool:render_diagram`.
   *
   * Rendered by mermaid *in the page*, because it is a browser library and *"the same one the chat uses,
   * so a diagram looks identical whether it is read in the conversation or attached to a post."*
   *
   * A syntax error comes back as a **message**, not a thrown object. The old runtime learned why:
   * *"Playwright surfaced a bare `Page.evaluate: Object` for a parse failure, which told the agent
   * nothing — it apologised and re-sent the same broken syntax."*
   */
  renderDiagram(
    context: ExecutionContext,
    input: {
      readonly source: string;
      readonly width?: number;
      /** `transparent` is what makes a diagram usable over a platform's own card styling. */
      readonly transparent?: boolean;
      /** #595: the project's theme, as mermaid `themeVariables`. Absent = mermaid's default look. */
      readonly theme?: Theme;
      /** #595: a layout preset — flow (default), timeline, org or comparison. */
      readonly preset?: "flow" | "timeline" | "org" | "comparison";
    },
  ): Promise<RenderedDiagram>;

  /**
   * Print a document to PDF — replacing `tool:generate_pdf`.
   *
   * One HTML pipeline for every input, which is the old renderer's decision: *"a second code path per
   * input type would mean four sets of pagination and font bugs instead of one."* A ```mermaid fence
   * becomes a diagram **inside** the document rather than an image on its own page, and because the
   * path is already HTML → Chromium the vector survives.
   *
   * Takes built HTML rather than the raw kinds, so the conversion rules are testable without a browser
   * — `buildDocumentHtml` is that half.
   */
  // #595: a theme is applied when the HTML is built (`buildDocumentHtml`), so the printed page needs nothing more.
  renderDocument(
    context: ExecutionContext,
    input: {
      readonly html: string;
      /**
       * #607: a page of exactly this many CSS pixels with no margin — one slide per page. Absent, A4 with the
       * document margins, as every document before slides printed.
       */
      readonly page?: { readonly width: number; readonly height: number };
      /**
       * #661: the width a document's content is laid out in when `generate_pdf` was given a page setup — the
       * page less its margins, in CSS pixels — so the overflow measurement (#660) matches the paper. The paper
       * itself comes from the document's `@page` rules (`pageSetupCss`), which the print always prefers.
       */
      readonly layoutWidth?: number;
    },
  ): Promise<RenderedDocument>;

  /**
   * #607: each `section.slide` of a built deck as its own PNG at the slide's exact size, in order — a
   * carousel. Optional like `renderHtmlImage`: a deployment without a browser leaves it out and the tool
   * refuses by name.
   */
  renderSlideImages?(
    context: ExecutionContext,
    input: { readonly html: string; readonly width: number; readonly height: number },
  ): Promise<readonly RenderedDiagram[]>;

  /**
   * #620: a deck built in `play` mode, recorded as an MP4 — each slide held `secondsPerSlide` (1 to 8, default
   * 3) with its transition and build-ins, at most 20 slides and 60 seconds. `transitions` is the deck's, one per
   * slide, in order. Optional like `renderSlideImages`: a deployment without a browser (or without ffmpeg)
   * leaves it out or refuses by name.
   */
  renderSlidesVideo?(
    context: ExecutionContext,
    input: {
      readonly html: string;
      readonly width: number;
      readonly height: number;
      readonly transitions: readonly string[];
      readonly secondsPerSlide?: number;
    },
  ): Promise<RenderedVideo>;

  /**
   * Code in a macOS-style window, as a PNG — #574. Optional: a deployment without a browser leaves it
   * out and `render_code_snippet` refuses by name.
   */
  /**
   * A built document page as one PNG, for putting an artifact on a post as an image — #589. Optional like
   * `renderCodeSnippet`: a deployment without a browser leaves it out and the tool refuses by name.
   */
  renderHtmlImage?(
    context: ExecutionContext,
    // #595: the theme sets the page around the document — its background — as `buildDocumentHtml` set the rest.
    input: { readonly html: string; readonly width?: number; readonly theme?: Theme },
  ): Promise<RenderedDiagram>;

  renderCodeSnippet?(
    context: ExecutionContext,
    input: {
      readonly code: string;
      readonly title?: string;
      /** #595: "brand" draws the window in the project's theme; it needs `brand` to be set. */
      readonly theme?: "dark" | "light" | "brand";
      readonly brand?: Theme;
      readonly lineNumbers?: boolean;
      /** #595: the window style — mac (default), minimal, terminal or none. */
      readonly frame?: "mac" | "minimal" | "terminal" | "none";
    },
  ): Promise<RenderedDiagram>;
}

/**
 * Chorus credits for what a tool generates — #499, "keep today's prices per action".
 *
 * `reserve` answers before anything is spent: it refuses, with the plan's own upgrade message, when
 * the credits are not there, and says whether the workspace's own text key (BYO) pays instead.
 * `charge` records what a finished tool actually spent — per channel written, not per model call, so
 * a repair attempt is not billed twice. Both are the app's decisions (`/api/internal/credits`).
 */
export type CreditService = {
  reserve(context: ExecutionContext, input: { readonly credits: number; readonly tool: string }): Promise<{ readonly byo: boolean; readonly metered: boolean }>;
  charge(context: ExecutionContext, input: { readonly credits: number; readonly tool: string }): Promise<{ readonly charged: number }>;
};

/**
 * The Compose project a conversation belongs to — #522. Its instructions and defaults go into every
 * turn and every caption written in that conversation.
 */
export type ActiveProject = {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly defaults: { readonly channels?: readonly string[]; readonly hashtags?: string; readonly cta?: string };
  /** #524: the project's AI avatar — a voice for captions and a look for images and video. */
  readonly avatar?: { readonly name?: string; readonly persona?: string; readonly look?: string; readonly referenceCount?: number };
  /** #525: the project's style kit — how its images look and what shape they take. */
  readonly design?: ProjectDesignKit;
  /** #554: rules the project's chats taught — newest first, bounded. */
  readonly memories?: readonly ProjectMemory[];
};

/** One learned rule — #554. */
export type ProjectMemory = { readonly id: string; readonly text: string };

/**
 * A change to the chat's project, in the app's own shape (`web/src/lib/projects/model.ts`) — #553.
 * Sections replace as a whole, the same way the project page saves them.
 */
export type ProjectPatch = {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly avatar?: { readonly name?: string; readonly persona?: string; readonly look?: string; readonly referenceAssetIds?: readonly string[] };
  readonly design?: ProjectThemeKeys & {
    readonly colors?: readonly string[];
    readonly fonts?: string;
    readonly logoAssetId?: string;
    readonly imageStyle?: string;
    readonly aspectRatios?: readonly string[];
    readonly facebookBackground?: string;
  };
  readonly defaults?: { readonly channels?: readonly string[]; readonly hashtags?: string; readonly cta?: string };
};

/** What a website says about its brand — #553 `extract_brand_kit`, read by the app from the page's own HTML. */
export type BrandKit = {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly colors: readonly string[];
  readonly fonts: readonly string[];
  readonly logoUrl?: string;
  readonly imageUrl?: string;
  readonly language?: string;
};

/**
 * #595: the theme keys, additive to the jsonb `projects.design`. Stored as given and validated by
 * `resolveTheme` (design/theme.ts) on read, so an old or hand-edited kit still renders.
 */
export type ProjectThemeKeys = {
  /** The preset the kit started from — one of `THEME_IDS`. */
  readonly themeId?: string;
  /** Colours by role (background, surface, primary, accent, text, muted); any subset. */
  readonly palette?: Readonly<Partial<Record<"background" | "surface" | "primary" | "accent" | "text" | "muted", string>>>;
  /** One of `CURATED_FONT_NAMES` — the fonts the render container has. */
  readonly headingFont?: string;
  readonly bodyFont?: string;
  /** Corner radius in px, 0–48. */
  readonly radius?: number;
  readonly picture?: { readonly style?: string; readonly mood?: string };
  readonly logoPlacement?: string;
};

export type ProjectDesignKit = ProjectThemeKeys & {
  readonly colors?: readonly string[];
  readonly fonts?: string;
  readonly imageStyle?: string;
  readonly aspectRatios?: readonly string[];
  readonly facebookBackground?: string;
  /** Whether a logo is chosen. The file itself is a project asset, attached like any other. */
  readonly hasLogo?: boolean;
};

/** A file or link in the conversation's project — #523. Files are named by id only, never by path or URL. */
export type ProjectAsset = {
  readonly id: string;
  readonly kind: "image" | "video" | "document" | "link";
  readonly label: string;
  /** Links only: the page it points to. A file's location is never returned. */
  readonly url?: string;
};

export type ProjectService = {
  /** The conversation's project, or null outside one (or for a personal project that is not the caller's). */
  current(context: ExecutionContext): Promise<ActiveProject | null>;
  /** The project's assets — #523. Empty outside a project. */
  listAssets(context: ExecutionContext): Promise<readonly ProjectAsset[]>;
  /** Attach one of the project's files to a draft, without re-uploading it — #523. */
  attachAsset(context: ExecutionContext, input: { readonly postDraftId: string; readonly projectAssetId: string }): Promise<{ readonly postDraftId: string; readonly attached: number }>;
  /** Change the chat's project — #553. Through the app, which validates and checks who may write. */
  update(context: ExecutionContext, patch: ProjectPatch): Promise<{ readonly projectId: string; readonly changed: readonly string[] }>;
  /** Store a rule the person taught, for every chat of the project — #554. */
  remember(context: ExecutionContext, input: { readonly text: string }): Promise<{ readonly memoryId: string; readonly duplicate: boolean }>;
  /** Read a website's brand signals (colours, fonts, logo, title) — #553. */
  extractBrandKit(context: ExecutionContext, input: { readonly url: string }): Promise<BrandKit>;
  /** Draw a template in the project's style kit and save it to the project's files — #525. */
  renderTemplate(context: ExecutionContext, input: TemplateRenderInput): Promise<{ readonly assets: readonly { readonly id: string; readonly label: string }[] }>;
  /**
   * #615/#595: the project's logo as a `chorus-media:` reference for the renderers to read and inline — slides,
   * the themed document header and a template's header. Undefined outside a project, without a logo, or when it is
   * not one of the workspace's own stored images. Optional, so a stub or a partial wiring simply draws no logo; and
   * never returned to the model — the id stays out of the context (`hasLogo` is what it sees).
   */
  logoReference?(context: ExecutionContext): Promise<string | undefined>;
};

/**
 * One thing the assistant remembers about a person — #621. Their own, across all their chats in the workspace.
 *
 * Backed by agentkit's `principal_memory` table, keyed `(tenant, principal, id)`: the workspace and the signed-in
 * user of the turn or request. There is no argument that names a principal — every method reads it from the
 * context — so no call can reach another person's memory.
 */
export type PersonalMemory = {
  readonly id: string;
  readonly text: string;
  /** False when the person switched it off in settings; a disabled memory never reaches a prompt. */
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PersonalMemoryService = {
  /** Every memory of the context's principal, oldest first, enabled or not. */
  list(context: ExecutionContext): Promise<readonly PersonalMemory[]>;
  /**
   * Store a short preference or fact about the person. Validated and deduplicated (`commitExtractedMemories`):
   * the same text twice is one memory. Refuses text that looks like a secret — a password, an API key, a card
   * number — and refuses past the cap, asking the person to forget one first.
   */
  remember(context: ExecutionContext, input: { readonly text: string }): Promise<{ readonly memory: PersonalMemory; readonly duplicate: boolean }>;
  /**
   * Forget by id, or by text. Text matches case- and space-insensitively as a substring; more than one match
   * forgets nothing and returns the candidates, so the model asks which one rather than guessing.
   */
  forget(
    context: ExecutionContext,
    input: { readonly id?: string; readonly text?: string },
  ): Promise<{ readonly forgotten: readonly PersonalMemory[]; readonly matches?: readonly PersonalMemory[] }>;
  /** Switch a memory on or off — Settings → Memory. */
  setEnabled(context: ExecutionContext, input: { readonly id: string; readonly enabled: boolean }): Promise<PersonalMemory>;
  /** Hard delete — Settings → Memory. False when the context's principal has no such memory. */
  remove(context: ExecutionContext, input: { readonly id: string }): Promise<{ readonly deleted: boolean }>;
};

/** One page of a tool result an earlier reply stored — #630. */
export type RecalledToolResult = {
  readonly ref: string;
  readonly toolName: string;
  /** The result as JSON text, from `offset`. */
  readonly content: string;
  readonly offset: number;
  readonly totalChars: number;
  /** Where the next page starts; absent on the last page. */
  readonly nextOffset?: number;
};

/**
 * Re-reading what a tool returned earlier in **this** conversation — #630.
 *
 * History carries earlier tool results only as previews and references, so a long thread stays inside the
 * model's window; this is how the model gets the full output back when it needs it. Scoped to the turn's own
 * tenant and conversation: a reference from another chat is refused as not found.
 */
export type ToolResultRecallService = {
  recall(context: ExecutionContext, input: { readonly ref: string; readonly offset?: number }): Promise<RecalledToolResult>;
};

/**
 * The post templates the app draws — #525, #595. The app's `web/src/lib/projects/templates.tsx` holds the
 * same list (its template tests read this one) and is what refuses an id it does not know.
 */
export const POST_TEMPLATE_IDS = ["quote", "carousel", "frame", "announcement", "event", "tip", "stat", "testimonial"] as const;
export type PostTemplateId = (typeof POST_TEMPLATE_IDS)[number];

export type TemplateRenderInput = {
  readonly template: PostTemplateId;
  readonly text: string;
  readonly slides?: readonly string[];
  /** A branded frame's photo: one of the project's images. */
  readonly imageAssetId?: string;
};

export type ShareFlowServices = {
  readonly artifacts: ArtifactService;
  readonly connectors: ConnectorService;
  readonly content: ContentService;
  readonly media: MediaService;
  readonly publishing: PublishingService;
  readonly engagement: EngagementService;
  readonly leads: LeadService;
  /** Tracked short links and their clicks — #424. */
  readonly links: LinkService;
  /** Recurring schedules and time slots — #425. */
  readonly schedules: ScheduleService;
  /** Campaign playbooks and daily rollups — #426. */
  readonly insights: InsightService;
  readonly brand: BrandService;
  readonly generator: ContentGenerator;
  readonly research: ResearchService;
  readonly analytics: AnalyticsService;
  readonly render: RenderService;
  /** Chorus credits for generations inside tools — #499. */
  readonly credits: CreditService;
  /** The conversation's Compose project — #522. */
  readonly projects: ProjectService;
  /** What the assistant remembers about the person, across their chats — #621. */
  readonly personalMemory: PersonalMemoryService;
  /** Earlier tool results in this conversation, in full — #630. */
  readonly toolResults: ToolResultRecallService;
};
