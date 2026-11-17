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
    status: "implemented",
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
    status: "implemented",
    invocation: "triggered",
    instructions: "skills/post-composition",
    sideEffects: "none — an alias of POST /generate, kept for callers on the old path",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    coverageEvidence: "same as POST /generate: the tool is covered and POST /api/tools/generate_content is the entry point",
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
    replacement: "read_pdf",
    status: "implemented",
    invocation: "interactive",
    /**
     * The third member of the read-a-source family, and `read_source` genuinely cannot cover it: Chromium
     * renders a PDF in a plugin viewer whose contents `innerText` cannot see. Its caps are all four
     * transcribed — 25 MB, 30 pages, 12,000 characters, a 20-second fetch — along with the reasons, and
     * the byte cap is the one that is not a courtesy: *"the whole PDF must be resident to parse it"*.
     *
     * `unpdf` does the extraction. Its API was verified against real documents before the adapter was
     * written, which also turned up two things worth recording: a browser-printed PDF's `/Title` came
     * back as `"about:blank"` (passed through rather than filtered — inventing a filter for the ways a
     * title can be junk is worse), and a single `Tj` operator saturates at 92 extracted characters,
     * which is why the test generator draws one line at a time.
     *
     * **The second source changed shape.** The old tool took a storage path
     * (`<workspace-id>/<file>.pdf`) and the web app signed it — *"the workspace-prefix check there is
     * what stops another tenant's object being read"*. Nothing in this runtime can produce a path: the
     * media tools return ids and never a path or a URL. So it takes an asset id, the adapter refuses
     * anything that is not a uuid before it reaches a signer, and resolving an id to bytes is a
     * deployment dependency — absent, that source refuses by name and a linked PDF still reads.
     *
     * That dependency is now wired: `mediaBytesFrom` reads the asset's path from `generated_assets`
     * under the caller's tenant scope, the web app signs it (checking the workspace prefix again on its
     * side), and the signed URL goes through the same guarded reader a linked file does. The hop exists
     * because this container has **no Supabase key at all** — `store-media`'s own header gives the
     * reason: *"giving it one would widen its blast radius considerably for the sake of one upload."*
     *
     * The egress policy is the platform's `validateHttpEgress`, imported rather than rewritten, and
     * **redirects are refused rather than followed**: the old runtime followed them by hand and
     * re-validated each hop, which is the same defence spelled differently, but one rule beats two.
     */
    instructions:
      "the `research-pdf` clause, which moved out of DEFERRED_CLAUSES when this shipped — it carries the " +
      "rule about *when* to call it: never to inspect a PDF the user only asked to attach and publish",
    sideEffects: "none — a read",
    contractTest: "shareflow/src/adapters/web/__tests__/pdf.test.ts",
    coverageEvidence:
      "pdf.test.ts exercises the parser against **real generated PDFs** and the fetch against a fake " +
      "one, because everything interesting here is I/O and a third-party library — where a stub agrees " +
      "with the bug. It covers the page cap and both truncation reasons, a non-PDF, a PDF with no text " +
      "layer, the refusal of a private host *before any request*, a refused redirect naming its target, " +
      "and the byte cap stopping the read early. research.test.ts covers the tool: the source union, " +
      "the fence around the text, and the uuid check that keeps a path away from the resolver. The HTTP " +
      "entry point is POST /api/tools/read_pdf",
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
    capability: "classify an inbound comment against the workspace's rules and draft an auto-reply",
    oldRuntimeRef: "route:POST /reply",
    workflows: ["engagement-reply"],
    replacement: "draft_auto_reply",
    status: "implemented",
    invocation: "triggered",
    /**
     * **This entry was wrong until now, and the way it was wrong is the point.**
     *
     * It named `draft_comment_reply` as the replacement for `route:POST /reply` and read `implemented`,
     * which made the inventory say `/reply` had a successor. It did not. `draft_comment_reply` stores a
     * draft against a comment **already in the inbox** for a person to approve; `/reply` *classifies* an
     * inbound comment against `bot_rules` and answers `{reply, confidence, ruleTitle, escalate, lead}`
     * for the ingest cycle to act on. The confidence is what gates auto-send, and no tool produced one.
     *
     * So the tally was right and the mapping was not, which is the harder failure to see: the count of
     * unreplaced capabilities was correct while one of the replacements named a different capability.
     * It surfaced only when removing `ai_backend` required reading what each remaining endpoint did.
     */
    instructions:
      "none — this is the ingest cycle's classifier rather than a conversational capability; the rule text is the instruction, and it comes from bot_rules",
    /**
     * Nothing, and that is unusual enough to state.
     *
     * It writes no row: the classification comes back to the caller, which decides whether to store a
     * draft, send it, or escalate. That is why its effect is `read` rather than `internal-write` — and
     * it matters, because effect derives approval, and gating a *classification* would put a human in
     * front of every comment the cycle exists to triage.
     */
    sideEffects: "none — it stores nothing and sends nothing; the caller decides what to do with the draft",
    /**
     * `draft_comment_reply` has **no entry of its own**, and that is correct rather than an omission.
     *
     * This inventory maps *old runtime capabilities* to their replacements, and that tool replaces
     * nothing in `ai_backend` — the inbox's own draft action is a web route, and the manifest scan
     * refused the ref when I tried to invent one for it. It is a new conversational capability, pinned
     * by `engagement-leads.test.ts` like every other tool, and the parity question does not apply to
     * it. What the old entry got wrong was pointing *this* endpoint at it.
     */
    contractTest: "shareflow/src/reply/__tests__/auto-reply.test.ts",
    /**
     * A **differential** test, which is stronger than the usual evidence here and deliberately so.
     *
     * The deterministic half is a transcription of `ai_backend/app/agents/reply.py`, and a transcription
     * that is merely "reasonable" is not good enough: `web/src/lib/ingest.ts` auto-sends when
     * `confidence >= threshold`, so a score drifting by 0.1 either sends what a person should have read
     * or silently stops sending. `scratchpad/pyparity.py` imports the real Python module and both are
     * run over the same 638 values — topics, rule match, confidence, lead, language and style signals —
     * with zero differences.
     */
    coverageEvidence:
      "45 parity tests ported from ai_backend/tests/test_reply_agent.py, plus a differential run against the real Python source over 638 values with 0 differences; the adapter's degraded-answer paths are covered by web/src/lib/assistant/__tests__/autoReplyViaAgentkit.test.ts",
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
    /**
     * Attached to the two workflows that generate media, and it had to be: an `implemented` capability
     * with no workflow is one **no gate measures**, which `manifest.test.ts` refuses by name — *"it
     * would be a replaced capability that no gate measures, which is the position this whole REQ exists
     * to make visible"*.
     *
     * Both are real. `/api/ai/generate-media` is called from the composer (`create-post`), and a
     * campaign with a media type enqueues one generation job per post (`campaign-planning`).
     */
    workflows: ["create-post", "campaign-planning"],
    replacement: "enhance_media_prompt",
    status: "implemented",
    invocation: "triggered",
    /**
     * The *prompt director*: a short brief expanded into one rich generation prompt. Despite the
     * capability name this endpoint inspects no file — it rewrites text, and the name in the scanned
     * manifest is the old route's own summary rather than what it does.
     *
     * **It no longer swallows a model failure**, and that is the one behavioural change. The old route
     * returned the user's original prompt on any error — *"enhancement must never block generation"* —
     * but its caller (`web/src/app/api/ai/generate-media/route.ts`) already keeps the raw prompt when
     * the call fails, in a `try`/`catch` around it. The guarantee lives on the caller's side either
     * way, and swallowing it here as well costs the ability to tell a degraded run from a working one.
     *
     * `changed` is the other addition: a model handed an already-detailed brief legitimately returns it
     * nearly verbatim, and a UI showing "enhanced" over unchanged text is a small lie.
     */
    instructions: "none — the instruction is the prompt itself, transcribed into the adapter",
    sideEffects: "none — returns text; it generates no media",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
    coverageEvidence:
      "media.test.ts asserts the `kind` reaches the generator (the adapter branches on it, and one " +
      "instruction for both produces still-image language for a clip), the `changed` flag in both " +
      "directions, and the refusals. The per-kind prompt branch and *\"Output ONLY the rewritten " +
      "prompt\"* are pinned against the real adapter in services.test.ts. The HTTP entry point is POST " +
      "/api/tools/enhance_media_prompt",
  },
  {
    capability: "plan a video's scenes",
    oldRuntimeRef: "route:POST /plan-video-scenes",
    // The same two, for the same reason as `enhance_media_prompt` above.
    workflows: ["create-post", "campaign-planning"],
    replacement: "plan_video_scenes",
    status: "implemented",
    invocation: "triggered",
    /**
     * N sequential scene prompts that cut together as one film. The clause the whole planner rests on is
     * transcribed verbatim, because it is the only thing standing between a film and three unrelated
     * clips: *"restate them explicitly in every scene prompt — the video model has no memory between
     * scenes"*.
     *
     * All or nothing, which is the old planner's decision (it raised on a short plan). The caller queues
     * one generation job per scene, so two scenes for a three-scene film is a video that does not make
     * sense rather than a shorter one — and a blank string does not count as a scene, or the check
     * passes and a job is queued with an empty prompt.
     */
    instructions: "none — the direction is the prompt itself, transcribed into the adapter",
    sideEffects: "none — returns prompts; the caller queues the generation jobs",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
    coverageEvidence:
      "media.test.ts asserts the scenes come back numbered (a caller queueing per scene needs the " +
      "order) and that a count outside 2-4 is refused. The continuity clause, the short-plan refusal " +
      "and the blank-scene case are pinned against the real adapter in services.test.ts. The HTTP " +
      "entry point is POST /api/tools/plan_video_scenes",
  },
  {
    capability: "describe an image",
    oldRuntimeRef: "route:POST /vision/describe",
    /**
     * `create-post`: alt text and a caption seeded from a picture both belong to composing a post, and
     * an `implemented` capability with no workflow is one no gate measures — which `manifest.test.ts`
     * refuses by name.
     */
    workflows: ["create-post"],
    replacement: "describe_image",
    status: "implemented",
    invocation: "triggered",
    /**
     * Three modes, and they are not three tones of one answer: `alt_text` is an accessibility
     * description with a hard rule and a 125-character ceiling, `caption` is copy, `competitor` is
     * analysis of a screenshot. All three prompts are transcribed.
     *
     * **Two deliberate departures.** The brand voice reaches `caption` and `competitor` but *not*
     * `alt_text` — the old runtime passed it to all three, and alt text is an accessibility description
     * rather than copy: a brand voice is how "a tabby cat on a windowsill" becomes "the cosy moment your
     * morning deserves", which its own instruction forbids. And the 125-character ceiling is *enforced*,
     * not merely asked for, because an `<img alt>` that runs to a paragraph is read out in full before
     * the page can continue.
     *
     * `data` (base64) is gone from the input: a model cannot produce image bytes, and a schema field for
     * them invites a hallucinated payload. A storage path is gone for the reason `read_pdf` records. What
     * is left is an asset id and a URL, both read through `ResearchService` — where the guarded fetch and
     * the byte resolver already live, rather than a second egress policy in the media tools.
     *
     * Verified against a real Gemini call, which is also where the content-part spelling was settled:
     * `{ type: "image", image: bytes }` works **and logs a deprecation warning**, so the wiring uses
     * `{ type: "file", data: bytes, mediaType }`. The fourth time on this project that a deprecated
     * spelling worked well enough to ship silently.
     */
    instructions: "none — the mode's prompt is the instruction, transcribed into the adapter",
    sideEffects: "none — a read plus one vision call",
    contractTest: "shareflow/src/tools/__tests__/media.test.ts",
    coverageEvidence:
      "media.test.ts covers the tool — the bytes read through `ResearchService` rather than a second " +
      "fetch, the resolved mime travelling to the model, the byte count reported *and* matching what the " +
      "model was given, and `.strict()` refusing both a base64 payload and a storage path. The three " +
      "prompts, the brand-in-caption-only rule and the enforced alt-text ceiling are pinned against the " +
      "real adapter in services.test.ts; the mime sniffer and the guarded fetch in " +
      "adapters/web/__tests__/pdf.test.ts. All three modes were run against a live vision model. The " +
      "HTTP entry point is POST /api/tools/describe_image",
  },
  {
    capability: "screenshot a website",
    oldRuntimeRef: "route:POST /capture",
    /**
     * `campaign-planning`: the competitor reference a person looks at while planning. An `implemented`
     * capability with no workflow is one no gate measures, which `manifest.test.ts` refuses.
     */
    workflows: ["campaign-planning"],
    replacement: "capture_website",
    status: "implemented",
    invocation: "triggered",
    /**
     * A screenshot stored as a reference asset, and the old module's framing decides the shape: *"used
     * as a reference asset for the human planning a campaign — the model never 'sees' the image; capture
     * is decide-which-site + screenshot."* So the tool returns a reference and a title, and
     * `describe_image` is how a model looks at one. Two steps, deliberately: it keeps the vision call
     * opt-in rather than implied by every screenshot.
     *
     * **It closes an SSRF hole the old one had**, and getting there required measuring what Playwright
     * intercepts rather than assuming. `capture.py` validated the URL and handed it to `page.goto`;
     * Chromium follows redirects itself, so a public URL that 302s to `169.254.169.254` was
     * screenshotted, and subresources were never checked at all.
     *
     * Three defences now, because one does not cover it: `guardRequests` refuses every **subresource**
     * the page requests (measured — two off-host requests aborted); `assertNoRedirect` pre-flights the
     * URL with `redirect: "manual"` so a server-side redirect never becomes a request; and the
     * **landed** URL is re-checked before the screenshot, which catches a meta refresh or a script
     * navigation. Playwright's route handler does *not* see a navigation redirect — measured, and a
     * comment claiming it did would have been wrong.
     *
     * The residual limit is stated in `browser.ts`: for a client-side redirect the request to the final
     * address has been made by the time it is caught. Nothing is returned or captured, so no content
     * leaks — but a bare GET happened, and preventing that would mean not running a browser.
     *
     * `find_and_capture` (search, then screenshot the top hit) is deliberately not carried over: the
     * assistant has `search_web` and can pick the result itself, visibly.
     */
    instructions: "none — the tool's description carries the rule that the model cannot see the image",
    sideEffects: "stores one image in the workspace's media; nothing leaves the workspace",
    contractTest: "shareflow/src/adapters/web/__tests__/browser.test.ts",
    coverageEvidence:
      "browser.test.ts covers the slot (one browser at a time, in order, and surviving a render that " +
      "throws — a rejected promise left in the chain would take the capability down for the life of the " +
      "process), the request guard, the redirect pre-flight and the landed-URL refusal, and that the " +
      "browser is closed even when the body throws. research.test.ts covers the tool: a reference and " +
      "never a path, the page title, and the `internal-write` classification. A real page was captured " +
      "against a real Chromium (17 KB PNG of example.com with its title), and a loopback URL refused. " +
      "The HTTP entry point is POST /api/tools/capture_website",
  },

  // ---- Documents, diagrams and artifacts ------------------------------------------------------------------
  //
  // The three artifact tools are built (REQ-041, #190): the rows, the versioning and the `chorus-artifact:`
  // scheme were already in ShareFlow, so what was missing was a service and three tools. `render_diagram` and
  // `generate_pdf` are not, and they are the reason `skills/mermaid-diagrams` is still `draft`.
  {
    capability: "render a diagram as an image",
    oldRuntimeRef: "tool:render_diagram",
    /** Attached to a post, or put in a document — both are real, and both are gated workflows. */
    workflows: ["create-post", "documents"],
    replacement: "render_diagram",
    status: "implemented",
    invocation: "interactive",
    /**
     * Mermaid rendered **in the page**, which is the old runtime's decision and the right one: *"mermaid
     * is a browser library — the same one the chat uses, so a diagram looks identical whether it is read
     * in the conversation or attached to a post."*
     *
     * Three things transcribed because each is load-bearing. `securityLevel: 'strict'`, since *"diagram
     * source is model-generated text, and mermaid can otherwise emit raw HTML and clickable callbacks
     * from a definition"* — and sabotage found that loosening it broke no test, so it is pinned now.
     * `parse()` before `run()` with the error **returned**, because *"Playwright surfaced a bare
     * `Page.evaluate: Object` for a parse failure, which told the agent nothing — it apologised and
     * re-sent the same broken syntax."* And the wait for `#wrap svg`, without which *"the screenshot
     * catches the raw `<pre>` source instead of the diagram"* — a picture of the code that looks enough
     * like a result to ship.
     *
     * `repairMermaidLabels` is the **third copy** of a function that exists in the chat renderer and in
     * `makepdf.py`, and the Python one records why the second was needed: *"a diagram that displayed
     * fine in the conversation failed to export as an image — which is exactly what happened in
     * production."* This package cannot import from `web/`, the same boundary that made `postCountFor` a
     * replica.
     *
     * `mermaid` is a **devDependency** whose one bundled file the image copies: the file is injected into
     * a page and never imported by Node, and the installed package is 83 MB against a 3.4 MB bundle.
     */
    instructions:
      "the `diagram-files` clause, which moved out of DEFERRED_CLAUSES when this shipped — it points at " +
      "the `mermaid-diagrams` skill, and the tool's own description says to use a ```mermaid block " +
      "instead when the diagram is only being shown",
    sideEffects: "stores one image in the workspace's media; nothing leaves the workspace",
    contractTest: "shareflow/src/adapters/web/__tests__/diagram.test.ts",
    coverageEvidence:
      "diagram.test.ts covers the label repair in both directions (including the round-node and " +
      "already-quoted cases the naive rule would corrupt), the background allow-list — CSS injection " +
      "into a page this package builds — the HTML escaping, and the mermaid script's own clauses. " +
      "media.test.ts covers the tool. Four diagram kinds were drawn against a real Chromium and real " +
      "mermaid, including the `A[Mobile App (Client)]` case that was the production bug, and a real " +
      "syntax error came back as *\"Parse error on line 2: …\"*. The HTTP entry point is POST " +
      "/api/tools/render_diagram",
  },
  {
    capability: "generate a PDF",
    oldRuntimeRef: "tool:generate_pdf",
    /** A document a person keeps. `documents` is the workflow; `create-post` is not involved. */
    workflows: ["documents"],
    replacement: "generate_pdf",
    status: "implemented",
    invocation: "interactive",
    /**
     * **One HTML pipeline for every input**, which is the old renderer's own decision: *"a second code
     * path per input type would mean four sets of pagination and font bugs instead of one."* Markdown is
     * converted, text is wrapped in a `<pre>`, HTML passes through as the *body* so the print setup
     * always applies, and images become a page each.
     *
     * The feature the pipeline exists for is diagrams **inside** the document: a ```mermaid fence
     * becomes `<pre class="mermaid">` and mermaid renders it to inline SVG in the print page, so *"the
     * vector survives — sharp at any zoom, text selectable, and far smaller than a PNG. Before this, a
     * fence printed as literal source and the only workaround was exporting a PNG and passing it as
     * kind='media', one image per page with the surrounding prose thrown away."*
     *
     * One departure: `kind: "media"` inlines the images as `data:` URLs rather than passing signed URLs
     * for the page to fetch. The page then makes no request at all — no expiry, no question about
     * whether the container can reach storage, and nothing for the request guard to weigh.
     *
     * A document with a diagram and no bundle is **refused, not degraded**: *"printing the diagram's raw
     * source into the document is the exact bug this path exists to fix, and a silently ugly PDF is
     * worse than a clear error — the bundle is baked into the image, so its absence is a deployment
     * fault, not a user one."*
     */
    instructions:
      "the `pdf-documents` clause, the last one out of DEFERRED_CLAUSES — and the tool's description " +
      "carries the two rules that destroy the answer when they are got wrong: put the ```mermaid fence " +
      "in the markdown rather than exporting a PNG first, and do not use a PDF for something meant for " +
      "a feed",
    sideEffects: "stores one PDF in the workspace's media; nothing leaves the workspace",
    contractTest: "shareflow/src/adapters/web/__tests__/document.test.ts",
    coverageEvidence:
      "document.test.ts covers what HTML is built — *\"the part most likely to be wrong\"* — including " +
      "the fence rule, the empty fence left as content, the html-as-body rule, one page per image, and " +
      "the absence of any webfont. browser.test.ts covers the print sequence: the bundle injected only " +
      "when a diagram is present, every SVG waited for (dropping that wait passed every test until " +
      "there was one), the refusal when the bundle is absent, which diagram failed, and A4 with the " +
      "margins the stylesheet assumes. A real PDF with a real diagram in the middle of real prose was " +
      "printed against Chromium — 70 KB, one page — and a broken fence came back as *\"Diagram 1 in " +
      "that document has a syntax error\"*. The HTTP entry point is POST /api/tools/generate_pdf",
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
    replacement: "generate_campaign",
    status: "implemented",
    invocation: "triggered",
    /**
     * Not `create_campaign`, which was the note here while this was `missing` and is still right: that tool
     * inserts a campaign row, and this generates a plan's worth of posts. `generate_campaign` is the
     * generative half — one `proposeAngles` call, then `generate` per angle with the siblings' hooks named.
     *
     * Two of the old runtime's decisions came with it, and both are the *opposite* of `generate_content`'s:
     * the campaign is **all or nothing** ("partial campaigns are more confusing than a clean retry"), and a
     * planner offering fewer angles than posts asked for is a refusal rather than a shorter campaign.
     */
    instructions: "skills/post-composition — a campaign is composition at a larger scale",
    sideEffects: "none — returns a campaign plan; the caller persists it with create_post_draft per post",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    coverageEvidence:
      "the tool is exercised by generate.test.ts — one post per planned angle, siblings named in each " +
      "call, the avoid-list growing with what earlier posts actually wrote, and both refusals. The prompt " +
      "wording is pinned separately in services.test.ts, because `avoidHooks` must read as a constraint " +
      "and not as `avoid`'s rejection. The HTTP entry point is POST /api/tools/generate_campaign",
  },
  {
    capability: "suggest a campaign",
    oldRuntimeRef: "route:POST /campaign/suggest",
    workflows: ["campaign-planning"],
    replacement: "suggest_campaign_ideas",
    status: "implemented",
    invocation: "triggered",
    /**
     * The advisory sibling of `generate_campaign`, and the pair is the point: this proposes distinct
     * angles for a person to write, that one writes the posts. A single tool doing both would decide on
     * the caller's behalf which of the two they wanted.
     *
     * One thing the old route did **not** do came with the port: it reported nothing about whether its
     * trend search had actually run. `search_web(f"{theme} social media trends", 5)` is fail-soft in
     * `websearch.py` — *"network errors, timeouts, or a missing package yield an empty result list
     * instead of raising"* — so its trends block was simply absent when the search failed, and an idea
     * invented from the model's own priors was indistinguishable from one grounded in this morning's
     * findings. `trendGrounded` (with `trendReason` when it is false) is that distinction, carried to
     * the caller rather than swallowed.
     *
     * Its two safety rules are transcribed and both live in the adapter: `format` clamped to
     * text/image/video, and `channels` filtered to the workspace's own ids — *"so a drifting model
     * can't suggest platforms the workspace doesn't have"*. The filter is case-insensitive, which the
     * old one was not: the ids arrive lower-cased and a model answering "LinkedIn" would have had a
     * correct channel filtered away, which reads as the workspace not having it.
     */
    instructions: "skills/post-composition — the ideas must sit in the brand's voice to be worth using",
    sideEffects: "none — advisory; nothing is drafted or saved, and the tool is `read`",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    coverageEvidence:
      "the tool is exercised by generate.test.ts — the old runtime's search query, the findings handed " +
      "to the generator, and all three grounding states (searched with hits, searched with none, never " +
      "searched, the middle one being the case a flag echoing `searched` would get wrong). The clamping " +
      "and the channel filter are pinned against the real adapter in services.test.ts, because the tool " +
      "test's stub stands in for the adapter and asserting them there would test the stub. The HTTP " +
      "entry point is POST /api/tools/suggest_campaign_ideas",
  },
  {
    capability: "evaluate a campaign",
    oldRuntimeRef: "route:POST /campaign/evaluate",
    workflows: ["campaign-planning"],
    replacement: "evaluate_campaign",
    status: "implemented",
    invocation: "triggered",
    /**
     * The port took the guarantee the old *route* had and the old *function* did not.
     *
     * `evaluate_campaign(theme, goal, stats: str)` was told *"use only the numbers provided — never invent
     * metrics"*, which is worth nothing once the caller is a model: it provides the numbers it is then told
     * to stick to. The web route knew this and re-read everything server-side — *"RLS-scoped, so the
     * summary always reflects true data, never client-supplied numbers"* — so the tool takes **only a
     * campaign id**. `.strict()` is what makes that more than a convention: a `stats` field passed
     * alongside is refused rather than ignored.
     *
     * Two departures from the old behaviour, both deliberate. A metric nobody collected renders as
     * `not measured` and never as `0` — the defect `analytics.ts` exists to avoid, now on the prompt side.
     * And the posts that never went out are **counted** rather than filtered away, because dropping them
     * makes the totals read as the whole campaign: an evaluation of three published posts out of eight
     * looks like an evaluation of the campaign, and "what to change next time" then misses the largest
     * thing that went wrong.
     *
     * It needed a port method (`AnalyticsService.campaignBreakdown`), because "which post did best" is
     * unanswerable from `campaignMetrics` — that one aggregates, by design. The prose lives on
     * `ContentGenerator` and not on `AnalyticsService`: `MetricsReport` has no `interpretation` field on
     * purpose, and an evaluation is exactly an interpretation.
     */
    instructions:
      "skills/analytics-reporting — AC-1's rule that a cause it cannot see in the numbers is a hypothesis " +
      "applies to this prose as much as to the assistant's own reply",
    sideEffects: "none — a read plus one generation; `evaluation` is returned with the facts it was written from",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    coverageEvidence:
      "the tool is exercised by generate.test.ts — the campaign's own date range as the default window " +
      "(the seven-day refresh window would report an August campaign as unpublished), the refusal when " +
      "nothing published and nothing was measured, the *non*-refusal when it published but nobody has " +
      "reported yet, and `.strict()` refusing a supplied `stats`. The prompt rules are pinned against the " +
      "real adapter in services.test.ts. `campaignBreakdown`'s SQL has its own database-backed block " +
      "there, which exists because sabotage keying published destinations on the metric id passed every " +
      "unit test and reported 1 destination instead of 3. The HTTP entry point is POST " +
      "/api/tools/evaluate_campaign",
  },
  {
    capability: "plan a campaign agentically",
    oldRuntimeRef: "route:POST /campaign/agent",
    workflows: ["campaign-planning"],
    replacement: "generate_campaign",
    status: "implemented",
    invocation: "triggered",
    /**
     * **The autonomy is the runtime's, and the tool carries the grounding.** This is the one entry where
     * the replacement is deliberately not shaped like the thing it replaces, so the reasoning is here
     * rather than in a commit message.
     *
     * The old route ran an autonomous Agno agent with `web_search` and `capture_website` under a 15-call
     * limit, and its own docstring says the web layer *"falls back to POST /campaign if this fails"*. A
     * faithful port would be a sub-agent inside a tool, and that is worse here in three specific ways: it
     * runs a second tool budget the caller cannot see (this deployment's is `maxToolCalls: 18`), its
     * searches never appear in the transcript the user is watching, and it sits outside the approval gate
     * the platform applies per tool call.
     *
     * This runtime *is* the agent the route was emulating. An assistant asked to plan a campaign with
     * research calls `search_web` and then `generate_campaign`, visibly and under one budget — which is
     * the capability, delivered by the conversation rather than by an endpoint.
     *
     * What a form-shaped caller cannot do is hold a conversation, so `generate_campaign` gained
     * `researchFirst`: one deterministic search of the theme, its findings passed to the planner with the
     * old runtime's own anti-fabrication clause, and `trendGrounded` reporting whether it actually
     * happened. Off by default, because the old runtime also kept the grounded path on its own endpoint.
     *
     * **Not covered:** `capture_website`. The screenshots the agent could take as reference material are
     * tracked as their own capability (`route:POST /capture`) and are still missing; nothing here claims
     * them. Token and tool-call metering is the platform's per run, so the route's `usage` field has no
     * equivalent to build.
     */
    instructions: "skills/post-composition, plus research-and-citation when the caller asks for grounding",
    sideEffects: "none — returns a plan; one web search when researchFirst is set",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    coverageEvidence:
      "the grounded path is exercised by generate.test.ts — no search unless asked, the theme alone as " +
      "the query (a 4,000-character brief makes a useless one), the findings reaching the planner, and a " +
      "search that could not run still producing a campaign while reporting `trendGrounded: false`. The " +
      "planner's own anti-fabrication clause is pinned against the real adapter in services.test.ts, " +
      "because deleting it broke nothing while the tool went on reporting the plan as grounded. The HTTP " +
      "entry point is POST /api/tools/generate_campaign with researchFirst",
  },
  {
    capability: "repurpose one source into several posts",
    oldRuntimeRef: "route:POST /repurpose",
    workflows: ["repurpose"],
    replacement: "repurpose_source",
    status: "implemented",
    invocation: "triggered",
    /**
     * One model call producing N pieces, which is the old engine's shape and not an economy: *"one call
     * extracts N distinct angles from the source"*. A per-piece call sees one angle at a time and cannot
     * tell that two of them are the same takeaway reworded — the property the whole feature is about.
     *
     * Two of the old behaviours are deliberately not carried over. It **degraded** on a parse failure to
     * a single post labelled `angle: "primary takeaway"`; that existed because its model call returned
     * free text that might not be JSON, which `StructuredGenerate` and the platform's retry make
     * impossible — and one post where five were asked for looks like a result rather than a failure. And
     * `_split_hashtags` has no equivalent: hashtags live in the caption, the same decision
     * `generate_content` records.
     *
     * One thing the old engine did not do: report that the source was truncated. It cut at 6,000
     * characters silently, so posts drawn from the first fifth of a transcript were indistinguishable
     * from posts drawn from all of it. `truncatedSource` is that, and the wording is `read_pdf`'s: *"do
     * not describe it as complete."*
     *
     * **Its caller is the web app's MCP server, not a page.** `/repurpose` has no Next.js route — the
     * live caller is the `repurpose` tool in `web/src/lib/mcp/server.ts`, a `retained` surface that
     * outlives the cutover. That tool now calls this one, which is what makes the capability
     * reachable; `ai_backend` is removed, so there is nothing else it could call.
     */
    instructions: "skills/post-composition — a repurposed post is composition with the source as the brief",
    sideEffects: "none — returns pieces; the caller keeps them with create_post_draft",
    contractTest: "shareflow/src/tools/__tests__/generate.test.ts",
    coverageEvidence:
      "the tool is exercised by generate.test.ts — the default of three, the truncation report at the " +
      "boundary, a shortfall reported rather than hidden, and the refusal when nothing usable came " +
      "back. Round-robin assignment and the destination clamp are pinned against the real adapter in " +
      "services.test.ts: the old engine took the model's own platform when it sent one, so a piece " +
      "assigned to LinkedIn could come back for Instagram. The HTTP entry point is POST " +
      "/api/tools/repurpose_source",
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
      by: "Jane Doe",
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
      by: "Jane Doe",
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
      by: "Jane Doe",
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
      by: "Jane Doe",
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
      by: "Jane Doe",
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
      by: "Jane Doe",
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
      by: "Jane Doe",
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
      by: "Jane Doe",
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
