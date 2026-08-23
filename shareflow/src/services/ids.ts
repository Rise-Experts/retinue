/**
 * ShareFlow-side identifiers.
 *
 * Minted with the platform's own `Branded`/`asId` mechanism rather than a second one, so a
 * `PostDraftId` cannot be passed where a `CampaignId` is expected — the same guarantee the platform's
 * IDs already have, and the reason these are not bare strings. Every one of them is an opaque handle
 * to a row ShareFlow owns; this package never parses or constructs them.
 */
import type { Branded } from "@agentkit/backend";

export type SocialAccountId = Branded<string, "SocialAccountId">;
export type PostDraftId = Branded<string, "PostDraftId">;
export type CampaignId = Branded<string, "CampaignId">;
export type MediaAssetId = Branded<string, "MediaAssetId">;
export type PublishTargetId = Branded<string, "PublishTargetId">;

/**
 * Platform id as a plain string, deliberately.
 *
 * ShareFlow's connector registry is keyed by strings and grows a platform per release; a closed union
 * here would make adding one a change in two repositories, and a tool that rejected a platform the app
 * supports would look like a platform outage.
 */
export type PlatformId = string;
