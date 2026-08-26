/**
 * The inventory itself — #194 AC-1.
 *
 * One entry per old-runtime capability, version-controlled so that adding a replacement and claiming coverage
 * are the same commit and the same review.
 *
 * ## Read this before trusting a status
 *
 * The `status` values here describe **this repository's** replacements, not a measured comparison against a
 * running Agno deployment. No deployment runs both runtimes yet — docs/README lists removing Agno before parity
 * as an explicit non-goal — so what `implemented` claims is "a replacement exists and has a behavioural test
 * against the old contract", and what the *gate* adds is "and shadow traffic exercised it". Those are different
 * facts and the file deliberately cannot assert the second: `shadowRuns` is counted from shadow data by
 * `coverageOf`, never written here.
 *
 * The old-runtime paths reference `social_integgration`, which is a separate repository. They are recorded as
 * strings rather than resolved, because a reviewer needs to know *which* thing is being replaced and this package
 * cannot import it.
 */

import type { CapabilityEntry } from "./index.js";

/**
 * Filled in when someone actually agrees. Deliberately not a placeholder that looks signed.
 *
 * Every `dropped` entry needs a real name and date, and a constant reading `TBD` would sail through
 * `validateInventory`'s emptiness check while telling a later reviewer nothing. So there are **no dropped
 * entries yet** — a capability gets dropped when a person decides to drop it, and that decision has not been
 * made for any of these.
 */

export const CAPABILITY_INVENTORY: readonly CapabilityEntry[] = [
  // ---- Drafting and content -------------------------------------------------------------------------------
  {
    capability: "draft a post",
    oldRuntimePath: "social_integgration: agno agent `post_writer`",
    replacement: "create_post_draft",
    status: "implemented",
    invocation: "interactive",
    instructions: "shareflow/src/skills — the drafting skill, which carries the tone and platform rules",
    contractTest: "shareflow/src/tools/__tests__/posts.test.ts",
  },
  {
    capability: "revise a draft",
    oldRuntimePath: "social_integgration: agno agent `post_writer` (revision turn)",
    replacement: "update_post_draft",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/posts.test.ts",
  },
  {
    capability: "propose angles for a topic",
    oldRuntimePath: "social_integgration: agno agent `ideation`",
    replacement: "propose_post_angles",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
  },
  {
    capability: "generate copy from a brief",
    oldRuntimePath: "social_integgration: agno agent `copywriter`",
    replacement: "generate_content",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
  },
  {
    capability: "duplicate a draft for another platform",
    oldRuntimePath: "social_integgration: `repurpose` flow",
    replacement: "duplicate_post_draft",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/posts.test.ts",
  },

  // ---- Publishing -----------------------------------------------------------------------------------------
  {
    capability: "validate before publishing",
    oldRuntimePath: "social_integgration: `publish_guard`",
    replacement: "validate_publish",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },
  {
    capability: "publish now",
    oldRuntimePath: "social_integgration: `publisher.publish`",
    replacement: "publish_post_now",
    status: "implemented",
    invocation: "interactive",
    // The one where the behavioural test matters most: a runtime that asks for fewer approvals looks like an
    // improvement in every metric anyone plots.
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },
  {
    capability: "schedule a post",
    oldRuntimePath: "social_integgration: `scheduler.enqueue`",
    replacement: "schedule_post",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },
  {
    capability: "the scheduled publish itself",
    oldRuntimePath: "social_integgration: cron `publish_due_posts`",
    replacement: "schedule_post + the platform run queue",
    status: "partial",
    invocation: "scheduled",
    /**
     * `partial`, and this is exactly the entry the inventory exists for.
     *
     * `schedule_post` records the intent. What fires at 03:00 and calls the platform is not in this repository:
     * it is a job in `social_integgration`, and nothing here replaces it yet. Under the old gate this workflow
     * would have compared "no writes" against "no writes" and reported 100% agreement, forever, because no
     * shadow run happens at 03:00 either.
     */
    coverageEvidence: "none yet — the trigger is not replaced; #128's cutover runbook has to carry it",
  },
  {
    capability: "retry a failed publish target",
    oldRuntimePath: "social_integgration: `publisher.retry`",
    replacement: "retry_publish_target",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },
  {
    capability: "publish status",
    oldRuntimePath: "social_integgration: `publisher.status`",
    replacement: "get_publish_status",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },

  // ---- Engagement -----------------------------------------------------------------------------------------
  {
    capability: "list comments",
    oldRuntimePath: "social_integgration: `engagement.inbox`",
    replacement: "list_comments",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/engagement-leads.test.ts",
  },
  {
    capability: "reply to a comment",
    oldRuntimePath: "social_integgration: `engagement.reply`",
    replacement: "reply_to_comment",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/engagement-leads.test.ts",
  },
  {
    capability: "dismiss a comment",
    oldRuntimePath: "social_integgration: `engagement.dismiss`",
    replacement: "dismiss_comment",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/engagement-leads.test.ts",
  },
  {
    capability: "inbound comment webhook",
    oldRuntimePath: "social_integgration: `POST /webhooks/:platform/comments`",
    replacement: null,
    status: "missing",
    invocation: "webhook",
    /**
     * `missing`, and the reason it is worth a whole entry.
     *
     * A comment arrives when a third party decides, so no shadow run ever produces one. The old gate would have
     * scored this workflow on the runs that *did* happen and said nothing about the path that carries most of
     * its volume.
     */
    coverageEvidence: "none — no replacement exists; the inbound path is still the old runtime's",
  },

  // ---- Campaigns ------------------------------------------------------------------------------------------
  {
    capability: "create a campaign",
    oldRuntimePath: "social_integgration: `campaigns.create`",
    replacement: "create_campaign",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/campaigns.test.ts",
  },
  {
    capability: "update a campaign",
    oldRuntimePath: "social_integgration: `campaigns.update`",
    replacement: "update_campaign",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/campaigns.test.ts",
  },
  {
    capability: "campaign calendar",
    oldRuntimePath: "social_integgration: `campaigns.calendar`",
    replacement: "get_campaign_calendar",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/campaigns.test.ts",
  },

  // ---- Analytics ------------------------------------------------------------------------------------------
  {
    capability: "post metrics",
    oldRuntimePath: "social_integgration: `analytics.post`",
    replacement: "get_post_metrics",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/analytics.test.ts",
  },
  {
    capability: "campaign metrics",
    oldRuntimePath: "social_integgration: `analytics.campaign`",
    replacement: "get_campaign_metrics",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/analytics.test.ts",
  },
  {
    capability: "attribution",
    oldRuntimePath: "social_integgration: `analytics.attribution`",
    replacement: "get_attribution",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/analytics.test.ts",
  },
  {
    capability: "nightly metrics refresh",
    oldRuntimePath: "social_integgration: cron `refresh_metrics`",
    replacement: null,
    status: "missing",
    invocation: "scheduled",
    coverageEvidence: "none — the refresh job is not replaced, and no shadow run happens overnight",
  },

  // ---- Accounts, media, leads ------------------------------------------------------------------------------
  {
    capability: "list connected accounts",
    oldRuntimePath: "social_integgration: `accounts.list`",
    replacement: "list_accounts",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/accounts.test.ts",
  },
  {
    capability: "account health",
    oldRuntimePath: "social_integgration: `accounts.health`",
    replacement: "check_account_health",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/accounts.test.ts",
  },
  {
    capability: "media inspection and conversion",
    oldRuntimePath: "social_integgration: `media.*`",
    replacement: "inspect_media",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
  },
  {
    capability: "leads",
    oldRuntimePath: "social_integgration: `leads.*`",
    replacement: "list_leads",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/engagement-leads.test.ts",
  },

  // ---- Research -------------------------------------------------------------------------------------------
  {
    capability: "web research",
    oldRuntimePath: "social_integgration: agno agent `researcher`",
    replacement: "search_web",
    status: "implemented",
    invocation: "interactive",
    contractTest: "shareflow/src/tools/__tests__/research.test.ts",
  },
];
