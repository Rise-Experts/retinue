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
 * webhooks and 1 cron job. This package replaces 22 outright, part of 3 more, has **8 signed off as dropped**
 * on 2026-09-07, retains 6 that live in `web/` — and has not replaced 12. The inventory gate is therefore
 * `incomplete`, which is the correct verdict and not a defect in the gate.
 *
 * The eight drops are the six workspace-configuration tools and two platform endpoints, and two of their
 * signatures record a cost rather than a redirection: `update_branding` is the **only writer** of
 * `workspace_ai_profile` in the product, and `workspace_agent_skills` has **no UI** — the Agno tools are its
 * only surface. Neither moves anywhere; both stop being editable. That is written into `droppedBy.reason`
 * rather than a comment beside it, because the record is what somebody reads in a year.
 *
 * The remaining 16 are not dropped for the reason the drops exist: a drop needs a person, and nobody has
 * agreed to remove diagrams, PDFs or the campaign-generation endpoints from a live product.
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

/**
 * One decision covering four tools, so one reason rather than four paraphrases of it.
 *
 * Signed on 2026-09-07 with the cost stated: there is **no UI** for `workspace_agent_skills`. The four Agno
 * tools are the only surface it has, so this is not a capability moving somewhere else — it is per-workspace
 * custom skills ceasing to be editable.
 */
const AGENT_SKILLS_DROP =
  "The new runtime ships skills as versioned code — SHAREFLOW_BUILT_IN_SKILLS, reviewed and deployed rather " +
  "than written in a chat turn. Dropped knowing there is no UI for workspace_agent_skills: these four tools " +
  "are its only surface, so per-workspace custom skills stop being editable at all rather than moving " +
  "elsewhere. Accepted deliberately, because a tool that writes instructions the model later loads is the " +
  "highest-consequence write in the old surface — the old runtime's own docstring for save_agent_skill says " +
  'it "writes instructions the model will later load".';

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
    replacement: "repost_post",
    status: "implemented",
    invocation: "interactive",
    instructions:
      "skills/publishing-safety — a repost is a publish and reads the same rules; the approval gate is platform behaviour rather than instruction",
    /**
     * The default is narrower than the old tool's *stated* default and matches its actual one: the old
     * runtime targets "the platforms the original actually published to **successfully**". A target that
     * failed the first time is not silently retried under cover of a repost — `retry_publish_target` is the
     * tool for that, per target.
     */
    sideEffects:
      "duplicates the post and publishes the copy to a customer's audience. The original is untouched and keeps its own metrics, because the platforms cannot re-publish a live post",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
  },
  {
    capability: "delete a published post",
    oldRuntimeRef: "tool:delete_post",
    workflows: ["publish"],
    replacement: "delete_post",
    status: "implemented",
    invocation: "interactive",
    instructions:
      "skills/publishing-safety — and the tool's own description, which carries the clause that matters: never report the post as deleted unless `stillLive` is empty",
    /**
     * The only `destructive` tool in the package, and the only one that destroys on two systems at once.
     *
     * Partial deletion is the normal case rather than the error case: TikTok has no delete API and Instagram
     * refuses ads and carousel items. The record is kept whenever any platform still has a copy, because a
     * live post with no row is a post nobody can find again.
     */
    sideEffects:
      "deletes the live posts from a customer's platform accounts, then removes the Chorus record — but only when every platform confirmed. Cascades to scheduled_items and post_comments. Irreversible",
    contractTest: "shareflow/src/tools/__tests__/publishing.test.ts",
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
    replacement: "draft_comment_reply",
    /**
     * `partial`, on the same reading as the two generation endpoints: the **capability** is replaced and the
     * **entry point** is not. A user asking the assistant to draft a reply is covered; the inbox screen
     * posting to `/reply` from a form is not, because the new shell serves `/api/message` and `/api/events`.
     */
    status: "partial",
    invocation: "triggered",
    instructions:
      "skills/post-composition for tone; the review step itself is the tool's own description — you cannot approve your own draft",
    /**
     * Two capabilities, not one, which is why this entry exists separately from `reply_to_comment`.
     *
     * `/reply` drafts into the review queue and sends nothing; `reply_to_comment` sends. Mapping them
     * together would have claimed the step where a person looks before a public reply survived the
     * migration, and it would not have.
     */
    sideEffects:
      "writes a drafted reply and puts the comment back into needs-review. Nothing leaves the tenant, which is why it is not approval-gated",
    contractTest: "shareflow/src/tools/__tests__/engagement-leads.test.ts",
    coverageEvidence:
      "the tool is exercised by engagement-leads.test.ts and by the live-DB suite; the HTTP entry point has no replacement — the new shell serves /api/message and /api/events only",
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
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/platform-media-rules — ask for a format, not a platform",
    /**
     * `partial` no longer: `MediaService.convert` returns a **conversion** rather than an asset, so the
     * queued case — which is the normal one for video — is representable, and `check_conversion` polls it.
     * The asset is attached only on `succeeded`, which makes the old docstring's rule structural rather than
     * advisory: there is no path to read off an unfinished job.
     */
    sideEffects:
      "queues a conversion and writes a new file to the tenant's media storage when it finishes; the original is left alone",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
  },
  {
    capability: "check a queued conversion",
    oldRuntimeRef: "tool:check_conversion",
    workflows: ["create-post"],
    replacement: "check_conversion",
    status: "implemented",
    invocation: "interactive",
    instructions:
      "skills/platform-media-rules — and the clause that matters is the tool's own: only `succeeded` means the file exists",
    sideEffects: "none — a read of media_conversion_jobs",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
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
    replacement: "detach_media_from_post",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/platform-media-rules",
    /**
     * One documented difference from the old tool, and it is a *gap* rather than a choice.
     *
     * ShareFlow refuses a removal that would leave the post incompatible with its destinations — removing the
     * only image from an Instagram post. This adapter cannot: `platform_rules` holds `char_limit`,
     * `hashtag_min` and `hashtag_max` and **nothing about media**, which is the same absence
     * `checkPlatformCompatibility` reports as `media-unchecked`. So this is more permissive than the old tool,
     * and the failure it lets through arrives at publish time.
     */
    sideEffects:
      "removes attachments from a draft; the file stays in storage. More permissive than the old tool: the outgoing compatibility check has no rules to run against in this deployment",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
  },
  {
    capability: "swap one attached file for another, in place",
    oldRuntimeRef: "tool:replace_post_media",
    workflows: ["create-post"],
    replacement: "replace_media_on_post",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/platform-media-rules — the repair after a conversion is this tool, not remove-then-add",
    sideEffects:
      "replaces one attachment with another at the same index, so carousel order is preserved. Refuses when the outgoing file is not attached or the incoming one already is",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
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
  //
  // The three artifact tools are built (REQ-041, #190): the rows, the versioning and the `chorus-artifact:`
  // scheme were already in ShareFlow, so what was missing was a service and three tools. `render_diagram` and
  // `generate_pdf` are not, and they are the reason `skills/mermaid-diagrams` is still `draft`.
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
    workflows: ["documents"],
    replacement: "create_artifact",
    status: "implemented",
    invocation: "interactive",
    instructions:
      "skills/document-generation — choosing a document over a reply, and reporting what was made rather than handing over a bare link. Held at `draft` until these three tools existed; active now, because three replaced tools running without the instructions the old runtime ran them under is the AC-5 defect exactly",
    sideEffects:
      "inserts an assistant_artifacts row and an audit_log row. Nothing leaves the system, and the returned chorus-artifact: reference resolves in the app's own panel",
    contractTest: "shareflow/src/tools/__tests__/artifacts.test.ts",
  },
  {
    capability: "revise an artifact",
    oldRuntimeRef: "tool:update_artifact",
    workflows: ["documents"],
    replacement: "update_artifact",
    status: "implemented",
    invocation: "interactive",
    instructions: "skills/document-generation — same rules; a revision is a document",
    /**
     * One deliberate difference from the old contract, recorded here rather than smoothed over.
     *
     * The old path reads, archives and updates on separate connections, so two concurrent revisions both read
     * version 1 and both try to insert version 1 into `assistant_artifact_versions`. The unique index refuses
     * the second — which is why the old code cannot lose a version, and it means the safety is the index
     * rather than the sequencing — and that caller gets a 500 for what is a queueing problem.
     *
     * The adapter takes `for update` on the artifact row instead, so the second writer waits, sees version 2
     * and produces version 3. The guarantee the old code actually made — no version is ever lost or
     * overwritten — is preserved; the spurious error is not. A behavioural test pins both halves.
     */
    sideEffects:
      "archives the current version into assistant_artifact_versions, then replaces the body and bumps the version. Never destructive: the archive is written first, so a failure leaves the previous version intact. Plus an audit_log row",
    contractTest: "shareflow/src/tools/__tests__/artifacts.test.ts",
  },
  {
    capability: "read an artifact",
    oldRuntimeRef: "tool:get_artifact",
    workflows: ["documents"],
    replacement: "get_artifact",
    status: "implemented",
    invocation: "interactive",
    instructions:
      "none — a deterministic read. The instruction that matters is in skills/document-generation and belongs to the revision, not to this",
    sideEffects: "none — a read",
    contractTest: "shareflow/src/tools/__tests__/artifacts.test.ts",
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
    status: "dropped",
    invocation: "interactive",
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason:
        "The brand profile reaches the new runtime as context, injected by createBrandContextProvider, so a " +
        "model that needs it has it. What is dropped is the model asking for it on purpose — the studio " +
        "agent's instructions require reading it before a change — and nothing a user does today stops " +
        "working as a result.",
    },
    sideEffects: "none — a read",
  },
  {
    capability: "change the brand profile",
    oldRuntimeRef: "tool:update_branding",
    workflows: [],
    replacement: null,
    status: "dropped",
    invocation: "interactive",
    /**
     * The one drop whose cost is larger than it looks, so the reason carries it rather than a comment.
     *
     * This tool is the **only writer** of `workspace_ai_profile` anywhere in the product. The white-label
     * settings screen writes `workspace_branding` — a different table, holding a brand name, a logo and an
     * accent colour — and `web/src/lib/mcp/server.ts` only reads the AI profile. Six generation routes read
     * `brand_voice`, `audience` and `custom_instructions` from it.
     */
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason:
        "Dropped knowing the cost: this tool is the only writer of workspace_ai_profile in the product. The " +
        "white-label settings screen writes workspace_branding, a different table, and the MCP server only " +
        "reads the AI profile — so after the cutover brand_voice, audience and custom_instructions can be " +
        "changed only in the database until the web app grows an editor, while six generation routes go on " +
        "reading them. Accepted because a chat turn rewriting the instructions every later generation obeys " +
        "is not a capability this design has.",
    },
    sideEffects:
      "overwrites the workspace's brand profile, which every later generation reads. Confirmation-gated in the old runtime",
  },
  {
    capability: "list the agent's skills",
    oldRuntimeRef: "tool:list_agent_skills",
    workflows: [],
    replacement: null,
    status: "dropped",
    invocation: "interactive",
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason: AGENT_SKILLS_DROP,
    },
    sideEffects: "none — a read",
  },
  {
    capability: "write an agent skill",
    oldRuntimeRef: "tool:save_agent_skill",
    workflows: [],
    replacement: null,
    status: "dropped",
    invocation: "interactive",
    /**
     * The old runtime's own docstring is why this is the highest-consequence write in its surface:
     * `save_agent_skill` "writes instructions the model will later load". A tool that edits its own future
     * instructions is deliberately absent from the new design, and that is the decision being signed.
     */
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason: AGENT_SKILLS_DROP,
    },
    sideEffects: "writes an instruction the model loads on later turns. Changes future behaviour, not a row",
  },
  {
    capability: "delete an agent skill",
    oldRuntimeRef: "tool:delete_agent_skill",
    workflows: [],
    replacement: null,
    status: "dropped",
    invocation: "interactive",
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason: AGENT_SKILLS_DROP,
    },
    sideEffects: "removes an instruction the model loads. Confirmation-gated in the old runtime",
  },
  {
    capability: "enable or disable an agent skill",
    oldRuntimeRef: "tool:set_agent_skill_enabled",
    workflows: [],
    replacement: null,
    status: "dropped",
    invocation: "interactive",
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason: AGENT_SKILLS_DROP,
    },
    sideEffects: "changes which instructions load on later turns. Confirmation-gated in the old runtime",
  },

  // ---- Platform plumbing ----------------------------------------------------------------------------------
  {
    capability: "validate a workspace's model configuration",
    oldRuntimeRef: "route:POST /llm/validate",
    workflows: [],
    replacement: null,
    status: "dropped",
    invocation: "triggered",
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason:
        "Not a ShareFlow agent capability — it is the settings screen testing a workspace's provider " +
        "credentials. Dropped from this inventory rather than claimed as covered: retinue ships no " +
        "credential validation today, so this moves the work to the platform or the web app instead of " +
        "replacing it, and the settings screen loses its check until one of them carries it.",
    },
    sideEffects: "outbound call to the configured provider with the workspace's credentials, to see if they work",
  },
  {
    capability: "name a session from its messages",
    oldRuntimeRef: "route:POST /assistant/session-name",
    workflows: [],
    replacement: null,
    status: "dropped",
    invocation: "triggered",
    droppedBy: {
      by: "Azeem Sarwar",
      at: "2026-09-07",
      reason:
        "Not a ShareFlow agent capability. Retinue has no session naming today either, so the web app keeps " +
        "or reimplements it; sessions will show whatever the client titles them until it does.",
    },
    sideEffects: "none — returns a short name for the caller to store",
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
