/**
 * The inventory itself — REQ-041 AC-1 (#190).
 *
 * One entry per old-runtime capability, version-controlled so that adding a replacement and claiming coverage
 * are the same commit and the same review.
 *
 * ## This file was rewritten, and why matters more than what it now says
 *
 * The previous version had 27 entries whose `oldRuntimePath` strings were written from memory. When
 * `scripts/scan-old-runtime-capabilities.mjs` first read the real `social_integgration`, **almost none of them
 * resolved**: there is no `post_writer`, no `ideation`, no `copywriter`, no `publish_guard`, no
 * `publisher.publish`, no `scheduler.enqueue`, no `campaigns.create`, no `engagement.inbox`, no
 * `analytics.attribution`, no `accounts.health`, no `leads.*`, no cron `publish_due_posts`, no cron
 * `refresh_metrics`, and no `POST /webhooks/:platform/comments`. Two thirds of the surface that *does* exist —
 * artifacts, diagrams, PDFs, `read_pdf`, `delete_post`, `repost_post`, branding writes, the four agent-skill
 * tools, fourteen HTTP endpoints, five webhooks — had no entry at all.
 *
 * That inventory passed `validateInventory` cleanly. It is the exact failure this REQ exists to prevent, one
 * level up: **a document that reads as coverage and describes a runtime that is not there.** Every entry below
 * now carries an `oldRuntimeRef` that has to resolve against the committed scan, and the scan fails when a
 * capability has no entry — so the omission that mattered more is the one that is now impossible.
 *
 * ## What the honest picture is
 *
 * The old runtime is 31 Agno tools across 9 components, 14 purpose-built HTTP endpoints, 7 skills, 5 inbound
 * webhooks and 1 cron job. This package replaces 13 of the tools outright and part of 4 more. **The rest is
 * unreplaced**, and the inventory gate is therefore `incomplete` — which is the correct verdict and not a
 * defect in the gate. Nothing here is `dropped`: a drop needs a person, and nobody has agreed to remove
 * artifacts, diagrams, PDFs or the studio agent's branding tools from a live product.
 *
 * The old-runtime paths are not written here at all — they come from `OLD_RUNTIME_MANIFEST`, which the scan
 * generates. A reviewer who wants the file and line reads it from there rather than trusting a string typed by
 * whoever last edited this file.
 */

import type { CapabilityEntry } from "./index.js";

/**
 * Filled in when someone actually agrees. Deliberately not a placeholder that looks signed.
 *
 * Every `dropped` entry needs a real name and date, and a constant reading `TBD` would sail through
 * `validateInventory`'s emptiness check while telling a later reviewer nothing. So there are **no dropped
 * entries** — a capability gets dropped when a person decides to drop it, and that decision has not been made
 * for any of these.
 */

/** Every non-interactive entry needs its own evidence, and "none yet" is the truthful value for most. */
const NO_TRIGGER_YET =
  "none — the entry point is not replaced, and no shadow run reaches it. #128's cutover runbook has to carry it";

export const CAPABILITY_INVENTORY: readonly CapabilityEntry[] = [
  // ---- Drafting and content -------------------------------------------------------------------------------
  {
    capability: "generate copy from a brief",
    oldRuntimeRef: "tool:generate_content",
    workflows: ["create-post", "campaign-planning"],
    replacement: "generate_content",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/post-composition, plus skills/research-and-citation when the brief needs a source",
    sideEffects: "none — calls the model and returns text; nothing is persisted until a draft is written",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
  },
  {
    capability: "create a draft",
    oldRuntimeRef: "tool:create_draft",
    workflows: ["create-post", "campaign-planning"],
    replacement: "create_post_draft",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/post-composition — tone, hooks, hashtags and per-platform adaptation",
    sideEffects: "inserts a post row in the tenant's workspace; nothing leaves the system",
    contractTest: "shareflow/src/tools/__tests__/posts.test.ts",
  },
  {
    capability: "read a post",
    oldRuntimeRef: "tool:get_post",
    workflows: ["create-post", "publish"],
    replacement: "get_post_draft",
    status: "implemented",
    invocation: "interactive",
    instructions: "none — a deterministic read; the model reports what the tool returned",
    sideEffects: "none — a read",
    contractTest: "shareflow/src/tools/__tests__/posts.test.ts",
  },
  {
    capability: "duplicate a post",
    oldRuntimeRef: "tool:duplicate_post",
    workflows: ["create-post", "repurpose"],
    replacement: "duplicate_post_draft",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/post-composition — adapting one idea across platforms is the skill's second half",
    sideEffects: "inserts a second post row; the original is untouched",
    contractTest: "shareflow/src/tools/__tests__/posts.test.ts",
  },
  {
    capability: "propose angles for a topic",
    oldRuntimeRef: "route:POST /generate",
    workflows: ["create-post"],
    replacement: "propose_post_angles",
    status: "partial",
    invocation: "triggered",
    instructions: "skills/post-composition — angles are composition, and the skill is what keeps them on-brand",
    sideEffects: "none — returns content; the caller persists it",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    /**
     * `partial` because the tool exists and the **entry point does not**, and the distinction is the whole
     * reason routes are in this inventory.
     *
     * The Next app calls `POST /generate` directly, from a form, with no conversation involved. The new
     * runtime's shell serves `/api/message` and `/api/events` — a conversational surface. So a user who types
     * into a chat is covered and a user who presses a button in the composer is not, and no shadow run would
     * ever show it, because shadow runs are conversations.
     */
    coverageEvidence:
      "the tool is exercised by generate.test.ts; the HTTP entry point has no replacement — the new shell serves /api/message and /api/events only",
  },
  {
    capability: "generate a post (legacy path)",
    oldRuntimeRef: "route:POST /api/ai/generate",
    workflows: ["create-post"],
    replacement: "generate_content",
    status: "partial",
    invocation: "triggered",
    instructions: "skills/post-composition",
    sideEffects: "none — an alias of POST /generate, kept for callers on the old path",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    coverageEvidence: "same as POST /generate: the tool is covered, the HTTP path is not",
  },

  // ---- Research -------------------------------------------------------------------------------------------
  {
    capability: "search the web",
    oldRuntimeRef: "tool:search_web",
    workflows: ["create-post", "campaign-planning"],
    replacement: "search_web",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/research-and-citation — cite only what a tool returned, never invent a URL",
    sideEffects: "outbound HTTP to a search provider; nothing is written",
    contractTest: "shareflow/src/adapters/web/__tests__/research.test.ts",
  },
  {
    capability: "read a web page",
    oldRuntimeRef: "tool:read_url",
    workflows: ["create-post", "campaign-planning"],
    replacement: "read_source",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/research-and-citation — a citation resolves to the passage that was used",
    sideEffects: "outbound HTTP under the platform's egress policy; nothing is written",
    contractTest: "shareflow/src/adapters/web/__tests__/research.test.ts",
  },
  {
    capability: "read a PDF",
    oldRuntimeRef: "tool:read_pdf",
    workflows: ["create-post", "campaign-planning"],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "outbound HTTP or a storage read; nothing is written",
  },

  // ---- Publishing -----------------------------------------------------------------------------------------
  {
    capability: "publish now",
    oldRuntimeRef: "tool:publish_now",
    workflows: ["publish"],
    replacement: "publish_post_now",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/publishing-safety — and the approval gate, which is platform behaviour rather than instruction",
    // The one where the behavioural test matters most: a runtime that asks for fewer approvals looks like an
    // improvement in every metric anyone plots. `approvalParity` checks it for every entry, mechanically.
    sideEffects: "publishes to a customer's audience on one or more platforms. Not reversible from here",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },
  {
    capability: "schedule a post",
    oldRuntimeRef: "tool:schedule_post",
    workflows: ["publish"],
    replacement: "schedule_post",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/publishing-safety — never guessing a date is the clause that matters here",
    sideEffects:
      "inserts a scheduled_items row that chorus-schedule-sweep later publishes from — so the eventual effect is external, on a delay of up to SWEEP_WORST_CASE_MS",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },
  {
    capability: "repost a published post",
    oldRuntimeRef: "tool:repost_post",
    workflows: ["publish"],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    /**
     * Unreplaced **and** confirmation-gated in the old runtime, which makes it the most consequential gap in
     * this file: a customer can repost today and cannot after the cutover.
     */
    sideEffects: "publishes to a customer's audience. Confirmation-gated in the old runtime",
  },
  {
    capability: "delete a published post",
    oldRuntimeRef: "tool:delete_post",
    workflows: ["publish"],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects:
      "deletes a post from a customer's platform account. Confirmation-gated in the old runtime, and irreversible",
  },

  // ---- Engagement -----------------------------------------------------------------------------------------
  {
    capability: "list comments",
    oldRuntimeRef: "tool:get_comments",
    workflows: ["engagement-read"],
    replacement: "list_comments",
    status: "implemented",
    invocation: "interactive",
    instructions: "none — a deterministic read",
    sideEffects: "none — a read",
    contractTest: "shareflow/src/tools/__tests__/engagement-leads.test.ts",
  },
  {
    capability: "reply to a comment",
    oldRuntimeRef: "tool:reply_to_comment",
    workflows: ["engagement-reply"],
    replacement: "reply_to_comment",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/post-composition for tone, skills/publishing-safety for the approval it needs",
    sideEffects:
      "posts a public reply on a customer's post. A second attempt is a second public message, which is why the adapter claims the row before sending",
    contractTest: "shareflow/src/tools/__tests__/engagement-leads.test.ts",
  },
  {
    capability: "draft a reply without sending it",
    oldRuntimeRef: "route:POST /reply",
    workflows: ["engagement-reply"],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    /**
     * Not the same capability as `reply_to_comment`, and mapping the two would be the most tempting wrong
     * entry in this file. `POST /reply` **drafts** text for the inbox review queue and sends nothing; the new
     * tool sends. A reviewer reading "replaced by reply_to_comment" would conclude the review step survived
     * the migration, and it did not.
     */
    sideEffects: "none — returns suggested text for a person to approve",
    coverageEvidence: NO_TRIGGER_YET,
  },

  // ---- Media ----------------------------------------------------------------------------------------------
  {
    capability: "check media compatibility",
    oldRuntimeRef: "tool:check_media_compatibility",
    workflows: ["create-post", "publish"],
    replacement: "check_media_for_platforms",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/platform-media-rules — what each destination accepts and how to repair a file",
    sideEffects: "none — a read; the same check the publish worker runs",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
  },
  {
    capability: "convert a file to another format",
    oldRuntimeRef: "tool:convert_media",
    workflows: ["create-post"],
    replacement: "convert_media",
    status: "partial",
    invocation: "interactive",
    instructions: "skills/platform-media-rules — ask for a format, not a platform",
    /**
     * `partial`, and the missing half is video.
     *
     * The old tool queues: video conversion returns a `jobId` and the caller polls `check_conversion` until
     * `succeeded`, and its docstring is explicit that *only* succeeded means a file exists. The new
     * `MediaService.convert` returns a finished `MediaAsset`, so there is no representation for a conversion
     * still running — which for a long video is the normal case, not an edge one.
     */
    sideEffects: "writes a new file to the tenant's media storage; the original is left alone",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
  },
  {
    capability: "check a queued conversion",
    oldRuntimeRef: "tool:check_conversion",
    workflows: ["create-post"],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "none — a read of job state",
  },
  {
    capability: "attach files to a post",
    oldRuntimeRef: "tool:add_post_media",
    workflows: ["create-post"],
    replacement: "attach_media_to_post",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/platform-media-rules — an attachment that fails compatibility fails at publish time",
    sideEffects: "appends attachments to a draft; nothing leaves the system",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
  },
  {
    capability: "detach files from a post",
    oldRuntimeRef: "tool:remove_post_media",
    workflows: ["create-post"],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "removes attachments from a draft",
  },
  {
    capability: "swap one attached file for another, in place",
    oldRuntimeRef: "tool:replace_post_media",
    workflows: ["create-post"],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    /**
     * Not covered by attach-then-detach, which is why it is its own entry rather than folded into
     * `attach_media_to_post`. The old tool replaces **in place** so the file keeps its position, and position
     * is the order a platform shows a carousel in.
     */
    sideEffects: "replaces one attachment with another, preserving carousel order",
  },
  {
    capability: "inspect a file",
    oldRuntimeRef: "route:POST /enhance-media-prompt",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "none — rewrites a media prompt and returns it",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "plan a video's scenes",
    oldRuntimeRef: "route:POST /plan-video-scenes",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "none — returns a scene plan",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "describe an image",
    oldRuntimeRef: "route:POST /vision/describe",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "none — reads an image and returns alt text, a caption seed or a description",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "screenshot a website",
    oldRuntimeRef: "route:POST /capture",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "drives a headless browser to a third-party URL; returns the capture rather than storing it",
    coverageEvidence: NO_TRIGGER_YET,
  },

  // ---- Documents, diagrams and artifacts ------------------------------------------------------------------
  {
    capability: "render a diagram as an image",
    oldRuntimeRef: "tool:render_diagram",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "writes an image to the tenant's media storage",
  },
  {
    capability: "generate a PDF",
    oldRuntimeRef: "tool:generate_pdf",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "writes a PDF to the tenant's media storage",
  },
  {
    capability: "create an artifact",
    oldRuntimeRef: "tool:create_artifact",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "inserts an artifact row — a long document the user then edits",
  },
  {
    capability: "revise an artifact",
    oldRuntimeRef: "tool:update_artifact",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "overwrites an artifact's content",
  },
  {
    capability: "read an artifact",
    oldRuntimeRef: "tool:get_artifact",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "none — a read",
  },

  // ---- Campaigns ------------------------------------------------------------------------------------------
  {
    capability: "generate a campaign",
    oldRuntimeRef: "route:POST /campaign",
    workflows: ["campaign-planning"],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    /**
     * Not `create_campaign`. The new tool inserts a campaign row; this endpoint generates a whole plan's worth
     * of posts from a brief in one call. Mapping them would claim the generative half survived.
     */
    sideEffects: "none — returns a campaign plan; the caller persists it",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "suggest a campaign",
    oldRuntimeRef: "route:POST /campaign/suggest",
    workflows: ["campaign-planning"],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "none — returns suggestions",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "evaluate a campaign",
    oldRuntimeRef: "route:POST /campaign/evaluate",
    workflows: ["campaign-planning"],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "none — returns a critique",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "plan a campaign agentically",
    oldRuntimeRef: "route:POST /campaign/agent",
    workflows: ["campaign-planning"],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "none of its own — the model plans autonomously and the plan is returned for the caller to persist",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "repurpose one source into several posts",
    oldRuntimeRef: "route:POST /repurpose",
    workflows: ["repurpose"],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    /**
     * `duplicate_post_draft` is not this. Duplication copies one draft for another platform; the repurpose
     * engine turns one long-form source into N posts. The overlap is superficial and mapping them would hide a
     * whole feature.
     */
    sideEffects: "none — returns the derived posts",
    coverageEvidence: NO_TRIGGER_YET,
  },

  // ---- Analytics ------------------------------------------------------------------------------------------
  {
    capability: "post statistics",
    oldRuntimeRef: "tool:get_post_stats",
    workflows: ["analytics"],
    replacement: "get_post_metrics",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/analytics-reporting — how fresh stored stats are, and why missing data is not a zero",
    sideEffects: "none — a read of stored metrics, not a live platform call",
    contractTest: "shareflow/src/tools/__tests__/analytics.test.ts",
  },

  // ---- Brand and workspace configuration -----------------------------------------------------------------
  {
    capability: "read the brand profile",
    oldRuntimeRef: "tool:get_branding",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    /**
     * `missing` although `BrandService` exists, and the reason is worth stating rather than rounding off.
     *
     * The brand reaches the new runtime as **context**, injected by `createBrandContextProvider` — so a model
     * that needs the brand has it. What no longer exists is the *capability*: the studio agent asking for the
     * brand profile on purpose, which its instructions require before a change ("READ it with get_branding and
     * show the user"). Context is not a tool call, and a `partial` here would claim a tool that is not there.
     */
    sideEffects: "none — a read",
  },
  {
    capability: "change the brand profile",
    oldRuntimeRef: "tool:update_branding",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects:
      "overwrites the workspace's brand profile, which every later generation reads. Confirmation-gated in the old runtime",
  },
  {
    capability: "list the agent's skills",
    oldRuntimeRef: "tool:list_agent_skills",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "none — a read",
  },
  {
    capability: "write an agent skill",
    oldRuntimeRef: "tool:save_agent_skill",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    /**
     * The old runtime's own docstring is the reason this one is confirmation-gated: `save_agent_skill` "writes
     * instructions the model will later load". A tool that edits its own future instructions is the highest-
     * consequence write in the old surface, and the new runtime ships skills as code instead — which is a
     * deliberate difference, but nobody has signed it as a drop.
     */
    sideEffects: "writes an instruction the model loads on later turns. Changes future behaviour, not a row",
  },
  {
    capability: "delete an agent skill",
    oldRuntimeRef: "tool:delete_agent_skill",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "removes an instruction the model loads. Confirmation-gated in the old runtime",
  },
  {
    capability: "enable or disable an agent skill",
    oldRuntimeRef: "tool:set_agent_skill_enabled",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "interactive",
    sideEffects: "changes which instructions load on later turns. Confirmation-gated in the old runtime",
  },

  // ---- Platform plumbing ----------------------------------------------------------------------------------
  {
    capability: "validate a workspace's model configuration",
    oldRuntimeRef: "route:POST /llm/validate",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    /**
     * A platform concern rather than a ShareFlow one — the new runtime has its own provider registry — but it
     * is listed because the endpoint is what the settings screen calls today, and "the platform has something
     * like it" is not the same as "this call has a replacement".
     */
    sideEffects: "outbound call to the configured provider with the workspace's credentials, to see if they work",
    coverageEvidence: NO_TRIGGER_YET,
  },
  {
    capability: "name a session from its messages",
    oldRuntimeRef: "route:POST /assistant/session-name",
    workflows: [],
    replacement: null,
    status: "missing",
    invocation: "triggered",
    sideEffects: "none — returns a short name for the caller to store",
    coverageEvidence: NO_TRIGGER_YET,
  },

  // ---- Retained: the web app keeps these, and the cutover does not touch them ------------------------------
  /**
   * Six capabilities whose source is in `web/`, not `ai_backend`, and which call the AI backend not at all —
   * verified by grep, not assumed. Removing Agno leaves every one of them running.
   *
   * They are here because #194's spec asks for webhooks and scheduled work by name, and because leaving them
   * out is how an inventory comes to describe less than the product. `validateInventory` refuses `retained` for
   * anything under `ai_backend/`, so this status cannot be borrowed by a capability that really does have to
   * move.
   */
  {
    capability: "the scheduled publish sweep",
    oldRuntimeRef: "cron:chorus-schedule-sweep",
    workflows: ["publish"],
    replacement: null,
    status: "retained",
    invocation: "scheduled",
    retainedBecause:
      "a pg_cron job in the web app's database that POSTs /api/internal/sweep-schedule every five minutes. It reads scheduled_items and publishes; it never calls the AI backend, and the Agno cutover does not remove it",
    sideEffects:
      "publishes due posts to customers' platforms. The reason schedule_post's effect is external on a delay",
    coverageEvidence:
      "web/src/app/api/internal/sweep-schedule/route.ts and lib/schedule-sweep.ts are tested in social_integgration; SWEEP_GRACE_MS and SWEEP_ALERT_MS are mirrored in adapters/postgres/publishing.ts so this package's timing claims match the job's",
  },
  {
    capability: "inbound Meta events",
    oldRuntimeRef: "webhook:/api/webhooks/meta/events",
    workflows: [],
    replacement: null,
    status: "retained",
    invocation: "webhook",
    retainedBecause: "a Next route in the web app; verifies a hub signature and ingests events. No AI backend involvement",
    sideEffects: "writes ingested comments and events into the workspace's tables",
    coverageEvidence: "web/src/app/api/webhooks/meta/events/__tests__ in social_integgration",
  },
  {
    capability: "Meta data-deletion callback",
    oldRuntimeRef: "webhook:/api/webhooks/meta/data-deletion",
    workflows: [],
    replacement: null,
    status: "retained",
    invocation: "webhook",
    retainedBecause: "a Next route; a platform compliance obligation that has nothing to do with the agent runtime",
    sideEffects: "deletes a user's stored data on request",
    coverageEvidence: "web/src/app/api/webhooks/meta/data-deletion/__tests__ in social_integgration",
  },
  {
    capability: "Stripe billing events",
    oldRuntimeRef: "webhook:/api/webhooks/stripe",
    workflows: [],
    replacement: null,
    status: "retained",
    invocation: "webhook",
    retainedBecause: "a Next route; billing state, unrelated to the agent runtime",
    sideEffects: "changes a workspace's subscription state",
    coverageEvidence: "web/src/app/api/webhooks/stripe/__tests__ in social_integgration",
  },
  {
    capability: "TikTok callbacks",
    oldRuntimeRef: "webhook:/api/webhooks/tiktok",
    workflows: [],
    replacement: null,
    status: "retained",
    invocation: "webhook",
    retainedBecause: "a Next route; a platform callback handled entirely in the web app",
    sideEffects: "updates connection state for a TikTok account",
    coverageEvidence: "no dedicated test in social_integgration — recorded as un-evidenced rather than as covered",
  },
  {
    capability: "the lead-capture webhook's configuration",
    oldRuntimeRef: "webhook:/api/leads/webhook",
    workflows: [],
    replacement: null,
    status: "retained",
    invocation: "webhook",
    /**
     * Named carefully: GET and PUT, no POST. It is where a workspace reads and sets its capture URL, not where
     * leads arrive. An entry calling this "inbound leads" would be describing a receiver that is not there.
     */
    retainedBecause: "a Next route exposing GET and PUT only — it manages the capture URL rather than receiving leads",
    sideEffects: "rotates or sets the workspace's lead-capture endpoint",
    coverageEvidence: "no dedicated test in social_integgration — recorded as un-evidenced rather than as covered",
  },
];
