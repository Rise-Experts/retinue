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
  /** Human label for the destination, e.g. a Page or channel name. Safe to show a user. */
  readonly displayName: string;
  readonly health: AccountHealth;
  /**
   * Set when `health` is not `active`, phrased for a person: what is wrong and what fixes it.
   * Never a provider error body.
   */
  readonly healthDetail?: string;
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
}

// ---------------------------------------------------------------------------------------------------
// Content service — the "database services": drafts and campaigns.
// ---------------------------------------------------------------------------------------------------

export type PostDraftVariant = {
  readonly platformId: PlatformId;
  readonly content: string;
  readonly title?: string;
  readonly mediaAssetIds?: readonly MediaAssetId[];
  /** Platform-specific toggles. Opaque here; validated by `PublishingService.validate`. */
  readonly options?: Readonly<Record<string, unknown>>;
};

export type PostDraft = {
  readonly id: PostDraftId;
  readonly campaignId?: CampaignId;
  readonly title: string;
  readonly variants: readonly PostDraftVariant[];
  readonly updatedAt: string;
};

export type Campaign = {
  readonly id: CampaignId;
  readonly name: string;
  readonly goal?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
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
  getDraft(context: ExecutionContext, input: { readonly id: PostDraftId }): Promise<PostDraft>;

  listDrafts(
    context: ExecutionContext,
    input: { readonly campaignId?: CampaignId; readonly limit: number; readonly cursor?: string },
  ): Promise<Page<PostDraft>>;

  createDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly title: string;
      readonly campaignId?: CampaignId;
      readonly variants: readonly PostDraftVariant[];
    },
  ): Promise<PostDraft>;

  updateDraft(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: PostDraftId;
      readonly title?: string;
      readonly variants?: readonly PostDraftVariant[];
    },
  ): Promise<PostDraft>;

  getCampaign(context: ExecutionContext, input: { readonly id: CampaignId }): Promise<Campaign>;

  listCampaigns(
    context: ExecutionContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<Campaign>>;

  upsertCampaign(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id?: CampaignId;
      readonly name: string;
      readonly goal?: string;
      readonly startsAt?: string;
      readonly endsAt?: string;
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
   * Convert to a platform's accepted format. Long-running in ShareFlow (a queued job), hence the
   * returned asset may differ in id from the source.
   */
  convert(
    context: ExecutionContext,
    input: {
      readonly idempotencyKey: ServiceIdempotencyKey;
      readonly id: MediaAssetId;
      readonly targetPlatformId: PlatformId;
    },
  ): Promise<MediaAsset>;
}

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
  /** Stable, so the frontend can localize it and a repair step can branch on it (docs/07 step 8). */
  readonly code: string;
  /** Which destination, when the issue is destination-specific. */
  readonly accountId?: SocialAccountId;
  readonly message: string;
  /** Whether the assistant may attempt an automatic repair, or must ask. */
  readonly repairable: boolean;
};

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
