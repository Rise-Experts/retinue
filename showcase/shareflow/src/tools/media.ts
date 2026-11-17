/**
 * The Media capabilities — the Retinue integration spec (`social_integgration: docs/retinue-integration-spec.md`): *"list, inspect, attach and convert"*,
 * plus the storage diagnostic (#118).
 *
 * ## No limit is written down here (AC-5)
 *
 * There is not a byte count, a file count, a MIME list or a platform rule anywhere in this file. Every
 * one of them stays in ShareFlow, and the reason is stronger than tidiness: `platform_rules` is
 * *"maintainable data … so the tailor can honor real char limits … and be tuned without a deploy"*, and
 * it is **workspace-overridable**. A limit copied into this package would be silently wrong for any
 * workspace that overrode it, and wrong in the direction that refuses legitimate media.
 *
 * What this file does hold is a *code vocabulary* — `MEDIA_ISSUE_CODES` in the seam. A code for "too
 * large" is true wherever the ceiling sits; the ceiling is the value, and the value is not here.
 *
 * ## Media bytes never enter the conversation (AC-4)
 *
 * Structural: `MediaAsset` carries metadata and no content, and **no URL**. ShareFlow signs media URLs
 * with an expiry, and a signed URL in a tool result is persisted in the run event log — readable by
 * anyone who can read the conversation, long after the permission check that produced it. Attachment is
 * by opaque id, which `sanitizeMediaRefs` argues for better than I can: its workspace-prefix check is
 * *"the ONLY thing standing between a forged path and a signed URL to another tenant's private object."*
 * An id the model can only have received from a tool removes that class of forgery entirely.
 */
import { z } from "zod";
import { withCredit } from "./credits.js";
import { AgentPlatformError, asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import {
  type MediaAsset,
  type MediaAssetId,
  type MediaConversion,
  type MediaConversionJobId,
  type MediaStorageCheck,
  type PlatformId,
  type PostDraftId,
  type ValidationIssue,
} from "../services/index.js";
// The scene bounds, from the adapter that enforces them rather than a second copy.
import { MAX_VIDEO_SCENES, MIN_VIDEO_SCENES, VISION_MODES } from "../adapters/model/generator.js";
// The diagram bounds, from the module that enforces them.
import {
  DIAGRAM_PRESETS,
  MAX_DIAGRAM_SOURCE_CHARS,
  MAX_DIAGRAM_WIDTH,
  MIN_DIAGRAM_WIDTH,
} from "../adapters/web/diagram.js";
import { CODE_FRAMES, DEFAULT_CODE_FRAME } from "../adapters/web/code-snippet.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { cursorOf, httpUrl, idString, optionalIdString, pageInput, plausibleDraftId, shareFlowTool, unattachedNote } from "./factory.js";
import { palettePrompt, picturePrompt, resolveTheme, type ThemeInput } from "../design/theme.js";
import { themeForChat } from "./project-theme.js";

const assetIds = z.array(idString).min(1).max(20);

const platformList = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(20)
  .transform((values) => [...new Set(values.map((v) => v.toLowerCase()))] as PlatformId[]);

/**
 * Metadata, and nothing that could carry content.
 *
 * Exactly what AC-2 asks for — *"dimensions, duration, format and size so per-platform limit checks are
 * decidable"* — and built field by field so a future seam field cannot arrive here by spread. A `url`
 * added to `MediaAsset` tomorrow would not reach a tool result without someone editing this function.
 */
const assetView = (asset: MediaAsset) => ({
  mediaAssetId: asset.id,
  kind: asset.kind,
  mimeType: asset.mimeType,
  bytes: asset.bytes,
  label: asset.label,
  ...(asset.width === undefined ? {} : { width: asset.width }),
  ...(asset.height === undefined ? {} : { height: asset.height }),
  ...(asset.durationSeconds === undefined ? {} : { durationSeconds: asset.durationSeconds }),
});

const issueView = (issue: ValidationIssue) => ({
  code: issue.code,
  message: issue.message,
  repairable: issue.repairable,
  ...(issue.platformId === undefined ? {} : { platformId: issue.platformId }),
  ...(issue.accountId === undefined ? {} : { accountId: issue.accountId }),
});

const storageView = (check: MediaStorageCheck) => ({
  ok: check.ok,
  stage: check.stage,
  ...(check.missing === undefined ? {} : { missingConfiguration: check.missing }),
  ...(check.hint === undefined ? {} : { hint: check.hint }),
});

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

const listMediaSchema = z
  .object({
    limit: z.number().int().min(1).max(25).default(10),
    page: pageInput,
  })
  .strict();

export const listMediaTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "list_media",
    label: "List media",
    description:
      "List the workspace's media files with their kind, format and size. Use it to find the file the user means; attach it by the id returned here rather than by a filename or a path. It is the whole library — uploads and generated images and videos; list_project_assets lists only a project's own files.",
    category: "media",
    effect: "read",
    inputSchema: listMediaSchema,
    delegatesTo: "MediaService.listAssets",
    delegate: async (input: z.infer<typeof listMediaSchema>, context) => {
      const page = await services.media.listAssets(context, {
        limit: input.limit,
        ...(cursorOf(input.page) === undefined ? {} : { cursor: cursorOf(input.page)! }),
      });
      return {
        media: page.items.map(assetView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  }));

const inspectMediaSchema = z.object({ mediaAssetId: idString }).strict();

export const inspectMediaTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "inspect_media",
    label: "Inspect a file",
    description:
      "Read one file's dimensions, duration, format and size. Enough to reason about whether a destination will accept it — but ask `check_media_for_platforms` for the actual answer rather than judging from these numbers, because the limits are per-workspace configuration.",
    category: "media",
    effect: "read",
    inputSchema: inspectMediaSchema,
    delegatesTo: "MediaService.inspect",
    delegate: async (input: z.infer<typeof inspectMediaSchema>, context) =>
      assetView(await services.media.inspect(context, { id: asId<MediaAssetId>(input.mediaAssetId) })),
  }));

const checkMediaSchema = z.object({ mediaAssetIds: assetIds, platformIds: platformList }).strict();

export const checkMediaForPlatformsTool = shareFlowTool(["media"], ({ services, deps, }): Tool =>
  defineDelegatingTool(deps, {
    name: "check_media_for_platforms",
    label: "Check media against destinations",
    description:
      "Ask whether these files can be published to these platforms, before attempting it. Returns one finding per problem, each with a stable code and whether it can be repaired — for example by converting the file. An empty list means every destination accepts them.",
    category: "media",
    effect: "read",
    inputSchema: checkMediaSchema,
    delegatesTo: "MediaService.checkPlatformCompatibility",
    delegate: async (input: z.infer<typeof checkMediaSchema>, context) => {
      const issues = await services.media.checkPlatformCompatibility(context, {
        assetIds: input.mediaAssetIds.map((id) => asId<MediaAssetId>(id)),
        platformIds: input.platformIds,
      });
      return {
        // The same shape `PublishingService.validate` returns, so #119 consumes one contract and the
        // judgement is not made twice. `ok` is derived rather than asked of the service: a caller that
        // has to count the issues itself will eventually forget to.
        ok: issues.length === 0,
        issues: issues.map(issueView),
      };
    },
  }));

// ---------------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------------

const attachMediaSchema = z
  .object({ postDraftId: idString, mediaAssetIds: assetIds })
  .strict();

export const attachMediaTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "attach_media_to_post",
    label: "Attach media",
    description:
      "Add files to a post, by id. This adds to whatever is already attached — it does not replace it, so there is no need to resend the existing files. If the resulting set breaks a destination's rules the attachment is refused and the reasons are returned; if the post has already gone out it cannot be changed, and the answer is to duplicate it and attach to the copy.",
    category: "media",
    effect: "internal-write",
    inputSchema: attachMediaSchema,
    delegatesTo: "MediaService.attachToDraft",
    delegate: async (input: z.infer<typeof attachMediaSchema>, context, { idempotencyKey }) => {
      const result = await services.media.attachToDraft(context, {
        idempotencyKey,
        draftId: asId<PostDraftId>(input.postDraftId),
        assetIds: input.mediaAssetIds.map((id) => asId<MediaAssetId>(id)),
      });
      // Ids only. The resulting attachment set, so the assistant can say what the post now carries
      // without a second read — and still no bytes and no URL.
      return { postDraftId: result.draftId, mediaAssetIds: result.mediaAssetIds };
    },
  }));

/**
 * Files attached in the chat box, onto a draft — #549.
 *
 * A chat upload goes straight to the media bucket with no asset row, so `attach_media_to_post` (by asset
 * id) cannot reach it. The paths arrive in the message's `[attached-media]` block, checked against the
 * workspace by the web, and `attachPathsToDraft` checks them again (the workspace folder, no `..`) under
 * the same platform rules as every attachment.
 */
const attachUploadedSchema = z
  .object({
    postDraftId: idString,
    paths: z
      .array(z.string().trim().regex(/^[0-9a-f-]{36}\/[\w./-]+$/i, "a media path from the message's attached files"))
      .min(1)
      .max(10),
  })
  .strict();

export const attachUploadedMediaTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "attach_uploaded_media",
    label: "Attach files from the chat",
    description:
      "Put files the person attached to their message onto a draft. Pass the paths exactly as the message's attached files list them; this adds to what the post already has. Refused with the reasons when a destination cannot take a file. When a message ends with an [attached-media] block, each line is the storage path of a file they attached: pass those paths VERBATIM — never invent, alter or omit one — and never repeat the block back; name the files instead.",
    category: "media",
    effect: "internal-write",
    inputSchema: attachUploadedSchema,
    delegatesTo: "MediaService.attachPathsToDraft",
    delegate: async (input: z.infer<typeof attachUploadedSchema>, context) => {
      const result = await services.media.attachPathsToDraft(context, { draftId: input.postDraftId, paths: input.paths });
      return { postDraftId: result.draftId, mediaAssetIds: result.mediaAssetIds, attached: input.paths.length };
    },
  }));

/**
 * A format token, deliberately unvalidated against a list.
 *
 * The accepted set (`CONVERT_TARGETS`) is the conversion service's own capability and can grow; a copy
 * here would eventually refuse something the service supports, and the refusal would look like a
 * platform limitation rather than a stale constant. Shape only: a short lowercase token, so obvious
 * nonsense is still rejected without a round trip, and the service names its supported set in the
 * rejection of anything else.
 */
const targetFormat = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{2,8}$/, "expected a short format name such as mp4 or webp");

const convertMediaSchema = z.object({ mediaAssetId: idString, targetFormat }).strict();

export const convertMediaTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "convert_media",
    label: "Convert a file",
    description:
      "Convert a file to another format, producing a new file and leaving the original alone. Ask for a format, not a platform — which format a destination needs comes from `check_media_for_platforms`. If the format is not supported the error names the ones that are. **Video conversion is queued**: you get a `state` of `queued` or `running` and no file. Only `succeeded` means the file exists — poll `check_conversion` with the `jobId`, and never attach or describe a file until then.",
    category: "media",
    effect: "internal-write",
    inputSchema: convertMediaSchema,
    delegatesTo: "MediaService.convert",
    delegate: async (input: z.infer<typeof convertMediaSchema>, context, { idempotencyKey }) =>
      conversionView(
        await services.media.convert(context, {
          idempotencyKey,
          id: asId<MediaAssetId>(input.mediaAssetId),
          targetFormat: input.targetFormat,
        }),
      ),
  }));

const checkStorageSchema = z.object({}).strict();

/**
 * The storage diagnostic.
 *
 * **Classified `external-write`, which means the approval gate fires on it, and that is awkward on
 * purpose.** The function PUTs a diagnostic object into the tenant's bucket, so by the platform's own
 * classification it is an external write — and #117's `check_account_health` is `read` because it only
 * GETs, which is the line being drawn. Relabelling this to avoid an approval prompt would be choosing
 * convenience over an accurate effect, on a taxonomy the approval gate depends on.
 *
 * The cost is real: the moment someone wants this is the moment a publish has just failed, and a prompt
 * then is friction. That is raised as an open question on #118 rather than papered over — the three
 * effects have no room for "reaches outside, creates nothing anyone would care about".
 *
 * What it buys is the failure that is otherwise invisible until it matters: a private bucket publishes
 * nothing, and *"a bucket that is private fails only at publish time."*
 */
export const checkMediaStorageTool = shareFlowTool(["media"], ({ services, deps, }): Tool =>
  defineDelegatingTool(deps, {
    name: "check_media_storage",
    label: "Test media storage",
    description:
      "Test the media path end to end: credentials, upload, and whether the file can then be read back with no credentials — which is how the platforms will fetch it. Use it when publishing fails with a media error, because a storage bucket that is private looks fine everywhere else and fails only at publish time. Writes a small diagnostic file.",
    category: "media",
    effect: "external-write",
    inputSchema: checkStorageSchema,
    delegatesTo: "MediaService.checkStorage",
    delegate: async (_input: z.infer<typeof checkStorageSchema>, context, { idempotencyKey }) =>
      storageView(await services.media.checkStorage(context, { idempotencyKey })),
  }));

/**
 * A conversion, as the model sees it.
 *
 * `asset` appears **only** when the state is `succeeded`, because the port only carries one then. That is the
 * old tool's rule made structural: *"Only 'succeeded' means the file exists — until then there is no path to
 * use or show. If it is still queued or running, say so; do not guess a path, and do not attach one to a
 * post."* A view that always emitted an asset field, empty or not, would invite exactly the attach it forbids.
 */
/**
 * The attachment set a draft now carries. Ids only — no bytes, no URL — as `attach_media_to_post` returns.
 *
 * Shared by all three writers so a reply can say what the post holds without a second read, and so the three
 * cannot disagree about what that field is.
 */
const draftMediaView = (result: {
  readonly draftId: PostDraftId;
  readonly mediaAssetIds: readonly MediaAssetId[];
}) => ({ postDraftId: result.draftId, mediaAssetIds: result.mediaAssetIds });

const conversionView = (conversion: MediaConversion) => ({
  jobId: String(conversion.jobId),
  state: conversion.state,
  targetFormat: conversion.targetFormat,
  ...(conversion.asset === undefined ? {} : { asset: assetView(conversion.asset) }),
  ...(conversion.failure === undefined ? {} : { failure: conversion.failure }),
});

const checkConversionSchema = z.object({ jobId: idString }).strict();

export const checkConversionTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "check_conversion",
    label: "Check a conversion",
    description:
      "Check a queued conversion started by `convert_media`. `state` is queued, running, succeeded or failed. **Only `succeeded` means the file exists** — until then there is no path to use or show, so say it is still converting rather than guessing one, and do not attach anything to a post. On `failed`, `failure` says why.",
    category: "media",
    effect: "read",
    inputSchema: checkConversionSchema,
    delegatesTo: "MediaService.getConversion",
    delegate: async (input: z.infer<typeof checkConversionSchema>, context) =>
      conversionView(
        await services.media.getConversion(context, { jobId: asId<MediaConversionJobId>(input.jobId) }),
      ),
  }));

const detachMediaSchema = z
  .object({ postDraftId: idString, mediaAssetIds: assetIds })
  .strict();

export const detachMediaTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "detach_media_from_post",
    label: "Remove files from a post",
    description:
      "Remove files from a post that has not published yet. Reversible, and the file itself is **not** deleted from storage — only its attachment to this post — so it can be re-attached or used elsewhere. Refused if none of the files are attached, so a reply saying it was removed always means it was.",
    category: "media",
    effect: "internal-write",
    inputSchema: detachMediaSchema,
    delegatesTo: "MediaService.detachFromDraft",
    delegate: async (input: z.infer<typeof detachMediaSchema>, context, { idempotencyKey }) =>
      draftMediaView(
        await services.media.detachFromDraft(context, {
          idempotencyKey,
          draftId: asId<PostDraftId>(input.postDraftId),
          assetIds: input.mediaAssetIds.map((id) => asId<MediaAssetId>(id)),
        }),
      ),
  }));

const replaceMediaSchema = z
  .object({ postDraftId: idString, remove: idString, add: idString })
  .strict();

export const replaceMediaTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "replace_media_on_post",
    label: "Swap a file on a post",
    description:
      "Swap one attached file for another on a post that has not published yet. It replaces **in place**, so the file keeps its position — which matters because media order is the order a platform shows a carousel in. Use this after `convert_media` to put the converted file where the incompatible original was; removing and re-adding would move it to the end.",
    category: "media",
    effect: "internal-write",
    inputSchema: replaceMediaSchema,
    delegatesTo: "MediaService.replaceOnDraft",
    delegate: async (input: z.infer<typeof replaceMediaSchema>, context, { idempotencyKey }) =>
      draftMediaView(
        await services.media.replaceOnDraft(context, {
          idempotencyKey,
          draftId: asId<PostDraftId>(input.postDraftId),
          remove: asId<MediaAssetId>(input.remove),
          add: asId<MediaAssetId>(input.add),
        }),
      ),
  }));

/** The complete Media catalog, pinned by a test. */

/**
 * The two media-*prompt* capabilities — REQ-019, replacing `route:POST /enhance-media-prompt` and
 * `route:POST /plan-video-scenes`.
 *
 * Category `media` and not `posts`, because that is what they are about: neither writes a caption and
 * neither touches `MediaService`. What they produce is a prompt for an **image or video** model, which
 * the caller then queues a generation job with — `generation_jobs` in ShareFlow, and this package does
 * not run that pipeline.
 *
 * ## Neither one generates any media
 *
 * Worth stating in the description as well as here, because "enhance media" reads like it makes a
 * picture. They are `read`: a model call that returns text and changes nothing.
 */
const enhancePromptSchema = z
  .object({
    brief: z.string().trim().min(1).max(4_000),
    kind: z.enum(["image", "video"]),
  })
  .strict();

export const enhanceMediaPromptTool = shareFlowTool(["generator"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "enhance_media_prompt",
    label: "Expand a media brief",
    description:
      "Rewrite a short image or video brief into one rich generation prompt — subject, action, setting, style, camera, lighting, and for video the motion and audio cues. Returns the prompt only: it generates no media and saves nothing. Pass `kind` because the instructions for a still and for a clip are genuinely different. Use it when the user's brief is short; a long, detailed brief is usually better left alone.",
    category: "media",
    effect: "read",
    inputSchema: enhancePromptSchema,
    delegatesTo: "ContentGenerator.enhanceMediaPrompt",
    delegate: async (input: z.infer<typeof enhancePromptSchema>, context) => {
      const prompt = await services.generator.enhanceMediaPrompt(context, {
        brief: input.brief,
        kind: input.kind,
      });
      return {
        prompt,
        kind: input.kind,
        /**
         * Whether it actually changed anything.
         *
         * A model handed an already-detailed brief can legitimately return it nearly verbatim, and a UI
         * showing "enhanced" over unchanged text is a small lie. Compared on the trimmed text rather
         * than on length, so a whitespace-only difference is not a change.
         */
        changed: prompt !== input.brief.trim(),
      };
    },
  }));

const planScenesSchema = z
  .object({
    concept: z.string().trim().min(1).max(4_000),
    sceneCount: z.number().int().min(MIN_VIDEO_SCENES).max(MAX_VIDEO_SCENES),
  })
  .strict();

export const planVideoScenesTool = shareFlowTool(["generator"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "plan_video_scenes",
    label: "Plan a video's scenes",
    description:
      "Split one video concept into sequential scene prompts that cut together as a single film — the same subject, style and palette restated in every scene, because the video model has no memory between them. Returns the prompts in order and generates nothing. Either every scene is planned or none is: a film missing its middle is not a shorter film.",
    category: "media",
    effect: "read",
    inputSchema: planScenesSchema,
    delegatesTo: "ContentGenerator.planVideoScenes",
    delegate: async (input: z.infer<typeof planScenesSchema>, context) => {
      const scenes = await services.generator.planVideoScenes(context, {
        concept: input.concept,
        sceneCount: input.sceneCount,
      });
      // Numbered, because the order is the film and a caller queueing jobs needs to preserve it.
      return { scenes: scenes.map((prompt, index) => ({ scene: index + 1, prompt })), sceneCount: scenes.length };
    },
  }));


/**
 * `describe_image` — REQ-019 (#295), replacing `route:POST /vision/describe`.
 *
 * A vision model over one image, in one of three modes. They are not three tones of one answer:
 * `alt_text` is an accessibility description with a hard rule and a 125-character ceiling, `caption` is
 * copy, `competitor` is analysis of a screenshot.
 *
 * ## Two sources, and no base64
 *
 * The old MCP tool took `data` (base64 bytes), `url` or `storagePath`. Base64 is gone: a model cannot
 * produce image bytes, and a schema field for them is an invitation to hallucinate a payload. A storage
 * path is gone for the reason `read_pdf` records — nothing here can produce one. What is left is an
 * asset id and a URL, and the asset branch needs the deployment's byte resolver.
 */
/**
 * Plan a campaign's visuals before making any — #587 follow-up.
 *
 * `enhance_media_prompt` (one brief → one prompt) and `plan_video_scenes` (one video → scenes) were
 * preloaded and named by a clause, and still production answered "plan the visuals for a 3-post campaign
 * and a Reel" with prose every time: neither tool matches how a person asks. This one does — the posts'
 * images as distinct concepts, each already a generation prompt in its channel's shape, and the Reel as
 * scenes — and generates nothing, so the person approves the plan before any credits are spent.
 */
const planVisualsSchema = z
  .object({
    brief: z.string().trim().min(1).max(4_000),
    images: z.number().int().min(0).max(6).default(3),
    channel: z.string().trim().max(40).optional(),
    reelScenes: z.number().int().min(0).max(MAX_VIDEO_SCENES).default(0),
  })
  .strict();

/** The shape for where a still is going; a Reel is always 9:16. */
export const stillShapeFor = (channel: string | undefined): string => {
  const c = (channel ?? "").toLowerCase();
  if (c.includes("instagram")) return "4:5";
  if (c.includes("tiktok") || c.includes("story") || c.includes("reel")) return "9:16";
  if (c === "x" || c.includes("twitter") || c.includes("youtube")) return "16:9";
  return "1:1";
};

export const planVisualsTool = shareFlowTool(["generator"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "plan_visuals",
    label: "Plan the visuals",
    description:
      "Plan visuals before making any: one distinct image concept per post, each already a generation prompt in the channel's shape, and optionally a Reel/short video as numbered scenes. Use it whenever the person asks to plan visuals, a campaign's look, images for several posts or a storyboard — and in Plan mode before any media. Generates nothing and saves nothing: show the plan, and only once the person accepts call generate_media with each prompt and shape (and the post's postDraftId).",
    category: "media",
    effect: "read",
    inputSchema: planVisualsSchema,
    delegatesTo: "ContentGenerator.proposeAngles",
    delegate: async (input: z.infer<typeof planVisualsSchema>, context) => {
      const shape = stillShapeFor(input.channel);
      // Distinct angles first, so three concepts are not three rewordings of one image.
      const angles =
        input.images >= 2
          ? (await services.generator.proposeAngles(context, { brief: input.brief, count: Math.min(input.images, 5) })).slice(0, input.images)
          : [];
      while (angles.length < input.images) angles.push({ label: `Image ${angles.length + 1}`, rationale: input.brief });
      const images = [];
      for (const [index, angle] of angles.entries()) {
        const prompt = await services.generator.enhanceMediaPrompt(context, {
          brief: `${input.brief}\n\nImage ${index + 1} of ${angles.length} — ${angle.label}: ${angle.rationale}`,
          kind: "image",
        });
        images.push({ image: index + 1, concept: angle.label, why: angle.rationale, prompt, aspectRatio: shape });
      }
      const reel =
        input.reelScenes >= MIN_VIDEO_SCENES
          ? {
              aspectRatio: "9:16",
              scenes: (await services.generator.planVideoScenes(context, { concept: input.brief, sceneCount: input.reelScenes })).map(
                (prompt, index) => ({ scene: index + 1, prompt }),
              ),
            }
          : undefined;
      return {
        images,
        ...(reel === undefined ? {} : { reel }),
        note: "A plan only — nothing was generated. Show it; once the person accepts, call generate_media with each prompt and aspectRatio.",
      };
    },
  }));

const describeImageSchema = z
  .object({
    source: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("asset"), assetId: idString }).strict(),
        z.object({ kind: z.literal("url"), url: httpUrl }).strict(),
      ])
      .describe('Use {"kind":"asset"} with an id from `list_media` or a chorus-media: reference a tool returned (an imported stock photo, a render), or {"kind":"url"} for a link the user gave you.'),
    mode: z.enum(VISION_MODES).default("alt_text"),
  })
  .strict();

export const describeImageTool = shareFlowTool(["research", "generator", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "describe_image",
    label: "Describe an image",
    description:
      "Run a vision model over one image. `alt_text` (default) writes a short factual accessibility description of what is visibly present — never marketing language; `caption` writes a post caption from what is in the picture; `competitor` analyses a screenshot of someone else's post. Saves nothing. Only describe an image the user asked you to look at.",
    category: "media",
    effect: "read",
    inputSchema: describeImageSchema,
    delegatesTo: "ContentGenerator.describeImage",
    delegate: withCredit(() => services.credits, (input: z.infer<typeof describeImageSchema>) => (input.mode === "alt_text" ? "describe_image_alt_text" : "describe_image"), async (input: z.infer<typeof describeImageSchema>, context) => {
      /**
       * The bytes come from `ResearchService`, which is where guarded fetching and the asset resolver
       * already live — rather than a second copy of either in the media tools.
       */
      const image = await services.research.readImage(context, {
        source:
          input.source.kind === "url"
            ? { kind: "url", url: input.source.url }
            : { kind: "asset", assetId: asId<MediaAssetId>(input.source.assetId) },
      });

      const text = await services.generator.describeImage(context, { image, mode: input.mode });
      return {
        text,
        mode: input.mode,
        /**
         * The byte count, not the bytes.
         *
         * A media tool never returns content — *"a signed URL in a tool result is persisted in the run
         * event log"* applies to inlined bytes twice over. The size is what makes the answer checkable:
         * a description of a 200-byte image is a description of nothing.
         */
        imageBytes: image.bytes.byteLength,
      };
    }),
  }));


/**
 * `render_diagram` — replacing `tool:render_diagram`.
 *
 * Mermaid source to a stored PNG. The old tool's docstring carries the one instruction that decides
 * *when* to call it, and it is transcribed into the description because it is the difference between a
 * useful tool and a costly habit: *"Use this when the user wants the diagram as an IMAGE: to attach to a
 * post, to download, or to reuse. For simply SHOWING a diagram in the conversation, put a ```mermaid
 * block in your reply instead — that renders directly and costs nothing."*
 *
 * `transparent` is not a flourish either: *"drops the white background, which is what you want when the
 * image will sit on a platform's own card styling."*
 */
const renderDiagramSchema = z
  .object({
    diagram: z.string().trim().min(1).max(MAX_DIAGRAM_SOURCE_CHARS),
    width: z.number().int().min(MIN_DIAGRAM_WIDTH).max(MAX_DIAGRAM_WIDTH).optional(),
    transparent: z.boolean().optional(),
    /** #595: a layout preset over the theme. */
    preset: z.enum(DIAGRAM_PRESETS).optional(),
    /** #587: attach the drawing to this draft, as render_code_snippet does. */
    postDraftId: optionalIdString,
  })
  .strict();

export const renderDiagramTool = shareFlowTool(["render", "media", "projects"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "render_diagram",
    label: "Draw a diagram",
    description:
      "Draw a mermaid diagram as a PNG stored in this workspace — flowchart, sequenceDiagram, pie, mindmap, gantt, the same syntax as a ```mermaid block. Use it when the user wants the diagram as an IMAGE — they say image, picture, PNG, or want it on a post, to download, or to reuse; a ```mermaid block in the reply is not an image. To simply SHOW a diagram in the conversation, put a ```mermaid block in your reply instead — that renders directly and costs nothing. Leave transparent off for a post image — feeds show a transparent background as black or white, not as the design; set it only when the person asks for a transparent background. In a project, the diagram uses the project's theme. preset shapes it: flow (the default — a process or decision flowchart), timeline (milestones left to right; mark nodes :::milestone or :::done, or use mermaid's own timeline diagram), org (a top-down hierarchy with right-angled lines; :::lead for the head, :::team for groups) or comparison (options side by side: a subgraph per option with direction TB, :::option for its title node, :::pro and :::con for its points). A preset sets the direction only when the flowchart line names none. Pass postDraftId (an id a save tool returned in this chat) ONLY when the person asks to put the diagram on a post or attach it — a draft being open in the chat is not that request; otherwise leave it out and just show the image. Returns a reference; put it in your reply so the user can see it.",
    category: "media",
    // It stores a file in the workspace and nothing leaves it — the same classification as a capture.
    effect: "internal-write",
    inputSchema: renderDiagramSchema,
    delegatesTo: "RenderService.renderDiagram",
    delegate: async (input: z.infer<typeof renderDiagramSchema>, context) => {
      // #595: in a project, the diagram is drawn in its theme's colours and font.
      const theme = await themeForChat(services.projects, context);
      const drawn = await services.render.renderDiagram(context, {
        source: input.diagram,
        ...(input.width === undefined ? {} : { width: input.width }),
        ...(input.transparent === undefined ? {} : { transparent: input.transparent }),
        ...(theme === undefined ? {} : { theme }),
        ...(input.preset === undefined ? {} : { preset: input.preset }),
      });
      const stored = await services.media.storeAsset(context, { contentType: drawn.mime, bytes: drawn.bytes });
      // #587: it said "attach like any other picture" and offered no way to — now it attaches, like a code image.
      const attached =
        input.postDraftId === undefined || !plausibleDraftId(input.postDraftId)
          ? null
          : await services.media.attachPathsToDraft(context, { draftId: input.postDraftId, paths: [stored.reference.replace(/^chorus-media:/, "")] });
      return {
        reference: stored.reference,
        /**
         * The dimensions, because the caller is about to attach this somewhere with its own rules.
         *
         * `check_media_for_platforms` answers whether it fits; these are what make the question askable
         * without a second round trip to inspect what was just created.
         */
        width: drawn.width,
        height: drawn.height,
        byteSize: stored.byteSize,
        ...(input.preset === undefined ? {} : { preset: input.preset }),
        ...(attached === null
          ? input.postDraftId === undefined ? {} : { attached: false, note: unattachedNote(input.postDraftId) }
          : { attached: true, postDraftId: attached.draftId, note: "Already attached to the draft — do not attach it again." }),
      };
    },
  }));

/**
 * Generate an image or video for a post — #496.
 *
 * The Assistant's route to what compose's "Generate media" drawer does, through the same decisions in
 * the app (`startMediaJob`): Higgsfield over MCP when the person connected it and made it the default
 * (#483), otherwise the built-in provider behind the plan gate and Chorus credits. `internal-write` and
 * ungated like drafting: it spends credits, but makes nothing public — attaching and publishing are
 * separate steps.
 */
const renderCodeSnippetSchema = z
  .object({
    code: z.string().min(1).max(6_000),
    language: z.string().trim().max(30).optional(),
    title: z.string().trim().max(80).optional(),
    theme: z.enum(["dark", "light", "brand"]).optional(),
    /** #595: the window style. */
    frame: z.enum(CODE_FRAMES).optional(),
    lineNumbers: z.boolean().optional(),
    postDraftId: optionalIdString,
  })
  .strict();

/**
 * Code as a picture — #574. Posts with code (a release, a tip, a snippet) read better as an image: a
 * feed strips indentation and monospace, and LinkedIn and Instagram cannot show code at all.
 */
export const renderCodeSnippetTool = shareFlowTool(["render", "media", "projects"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "render_code_snippet",
    label: "Make a code image",
    description:
      "Draw code in a macOS-style window (traffic lights, optional title such as the file name, syntax colours) as a PNG — for posts that share code, where a feed would strip the formatting. Pass the code exactly, at most 80 lines; frame mac (the default: a window with traffic lights), minimal (no title bar, a soft border — the title becomes a small caption), terminal (a dark bar with a prompt, the title as the command) or none (just the code on a plain backdrop); theme brand (the project's theme — the default in a project chat), dark (the default elsewhere) or light. Pass postDraftId (an id a save tool returned in this chat) ONLY when the person asks to put the image on a post or attach it — a draft being open in the chat is not that request; otherwise leave it out and just show the image. Returns a reference to show in the reply. Code goes on an image only through this — never generate_media, which cannot render readable text.",
    category: "media",
    effect: "internal-write",
    inputSchema: renderCodeSnippetSchema,
    delegatesTo: "RenderService.renderCodeSnippet",
    delegate: async (input: z.infer<typeof renderCodeSnippetSchema>, context) => {
      if (services.render.renderCodeSnippet === undefined) {
        throw new AgentPlatformError({ code: "provider_unavailable", message: "Code images are not available on this deployment.", retryable: false });
      }
      /*
       * #595: "brand" is the default when the project has a theme; asked for outside one, there is no brand
       * to draw, so it is the dark window and the answer says so rather than pretending.
       */
      const brand = await themeForChat(services.projects, context);
      const requested = input.theme ?? (brand === undefined ? undefined : "brand");
      const theme = requested === "brand" && brand === undefined ? "dark" : requested;
      const drawn = await services.render.renderCodeSnippet(context, {
        code: input.code,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(theme === undefined ? {} : { theme }),
        ...(theme === "brand" && brand !== undefined ? { brand } : {}),
        ...(input.lineNumbers === undefined ? {} : { lineNumbers: input.lineNumbers }),
        ...(input.frame === undefined ? {} : { frame: input.frame }),
      });
      const stored = await services.media.storeAsset(context, { contentType: drawn.mime, bytes: drawn.bytes });
      const path = stored.reference.replace(/^chorus-media:/, "");
      const attached =
        input.postDraftId === undefined || !plausibleDraftId(input.postDraftId)
          ? null
          : await services.media.attachPathsToDraft(context, { draftId: input.postDraftId, paths: [path] });
      return {
        reference: stored.reference,
        width: drawn.width,
        height: drawn.height,
        theme: theme ?? "dark",
        frame: input.frame ?? DEFAULT_CODE_FRAME,
        ...(requested === "brand" && brand === undefined ? { themeNote: "This chat's project has no theme, so the dark window was used." } : {}),
        /*
         * A plain yes, not the attachment ids. Production: given `mediaAssetIds` back, the model called
         * attach_media_to_post with them, got refused, and told the person the attach had failed — when
         * the image was already on the draft.
         */
        ...(attached === null
          ? { attached: false, ...(input.postDraftId === undefined ? {} : { note: unattachedNote(input.postDraftId) }) }
          : { attached: true, postDraftId: attached.draftId, note: "Already attached to the draft — do not attach it again." }),
      };
    },
  }));

const SHOT_IDS = ["product-hero", "lifestyle", "flat-lay", "talking-head", "b-roll", "quote-card-bg"] as const;

const generateMediaSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    prompt: z.string().trim().min(1).max(2_000),
    /** A model id from the person's Higgsfield catalogue. Omitted = the plan-appropriate default. */
    model: z.string().trim().min(1).max(80).regex(/^[a-z0-9_.-]+$/i).optional(),
    aspectRatio: z.string().trim().regex(/^(auto|\d{1,2}:\d{1,2})$/).optional(),
    count: z.number().int().min(1).max(4).optional(),
    /** Attach the result to this draft when it is ready. */
    postDraftId: optionalIdString,
    /** #595 part 2: a shot template — composition, camera and light — added to the prompt. */
    shot: z.enum(SHOT_IDS).optional(),
    /** #575: images from the message's attached files to use as references. */
    referencePaths: z
      .array(z.string().trim().regex(/^[0-9a-f-]{36}\/[\w./-]+$/i, "a media path from the message's attached files"))
      .max(4)
      .optional(),
  })
  .strict();

/**
 * The avatar's look added to a media prompt in a project chat — #524. Added when the project has a
 * look and the prompt does not already carry it, so the same character comes out whether or not the
 * model remembered to describe it. Outside a project the prompt is untouched.
 */
export const withAvatarLook = (prompt: string, avatar: { readonly name?: string; readonly look?: string } | undefined): string => {
  if (avatar?.look === undefined || prompt.includes(avatar.look)) return prompt;
  return `${prompt}\n\nCharacter${avatar.name === undefined ? "" : ` (${avatar.name})`}, keep consistent: ${avatar.look}`;
};

/**
 * The project's style kit added to a media prompt — #525, read as a theme since #595: the picture look
 * (style preset, mood, the person's own notes) and the palette by role, instead of a loose style line.
 * Only what the person chose is added — a legacy kit's image-style sentence is not joined by the base
 * preset's look — and nothing the prompt already carries. Outside a project, or with no kit, untouched.
 */
export const withDesignKit = (prompt: string, design: ThemeInput | undefined): string => {
  if (design === undefined) return prompt;
  const theme = resolveTheme(design);
  const carries = (text: string) => prompt.toLowerCase().includes(text.toLowerCase());
  const notes = theme.picture.notes !== undefined && !carries(theme.picture.notes) ? theme.picture.notes : undefined;
  const extra: string[] = [];
  if (theme.chosen.picture) {
    const picture = { style: theme.picture.style, mood: theme.picture.mood, ...(notes === undefined ? {} : { notes }) };
    extra.push(`Picture look: ${picturePrompt({ ...theme, picture })}`);
  } else if (notes !== undefined) {
    extra.push(`Picture look: ${notes}`);
  }
  const palette = palettePrompt(theme)
    .split(", ")
    .filter((part) => part !== "" && !carries(part.split(" ")[1] ?? ""));
  if (palette.length > 0) extra.push(`Brand palette: ${palette.join(", ")}`);
  return extra.length === 0 ? prompt : `${prompt}\n\n${extra.join("\n")}`;
};

/**
 * Shot templates — #595 part 2. Each is the composition, camera and lighting of a kind of picture a
 * marketer asks for, as the phrase the generator receives. The project's picture look (`withDesignKit`)
 * still follows it, so a product hero in a playful project is a playful product hero.
 */
export const SHOT_PRESETS = {
  "product-hero": "product hero shot: the product alone and centred, eye-level three-quarter angle, clean seamless backdrop, soft key light with a gentle rim light, crisp focus, generous negative space",
  lifestyle: "lifestyle shot: the product in real use by people in a natural setting, candid moment, 35mm lens at eye level, soft natural window light, shallow depth of field",
  "flat-lay": "flat-lay: objects arranged neatly on a flat surface shot from directly overhead, even diffused light, minimal shadows, balanced grid composition with breathing room",
  "talking-head": "talking-head framing: one person facing the camera, chest-up medium close-up, eyes on the upper third, soft key light with fill, softly blurred uncluttered background",
  "b-roll": "b-roll: short cinematic cutaway of details and hands at work, slow steady camera movement, shallow depth of field, natural motivated light, no one addressing the camera",
  "quote-card-bg": "background for a quote card: calm abstract texture or softly blurred scene with a large empty area in the centre for text, low contrast and low detail, no words, letters or logos",
} as const;
export type ShotId = keyof typeof SHOT_PRESETS;

/** The shot's phrase after the prompt, unless the prompt already carries it. Untouched without a shot. */
export const withShot = (prompt: string, shot: ShotId | undefined): string => {
  if (shot === undefined) return prompt;
  const phrase = SHOT_PRESETS[shot];
  return prompt.toLowerCase().includes(phrase.toLowerCase()) ? prompt : `${prompt}\n\nShot: ${phrase}`;
};

/**
 * The prompt `generate_media` sends, in order: what the model asked for, the shot's composition, the
 * avatar's look, then the project's picture look and palette — the style last, so it dresses the shot.
 */
export const composeMediaPrompt = (
  prompt: string,
  options: { readonly shot?: ShotId; readonly avatar?: { readonly name?: string; readonly look?: string }; readonly design?: ThemeInput },
): string => withDesignKit(withAvatarLook(withShot(prompt, options.shot), options.avatar), options.design);

export const generateMediaTool = shareFlowTool(["media", "projects"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "generate_media",
    label: "Make an image or video",
    description:
      "Generate an image or video for a post (/image, /video). Uses the person's Higgsfield account when they connected it, otherwise the built-in generator. The answer's `sent` is what was actually requested (the person's chat-box settings can override your shape and model) — tell them that, not what you passed. Returns a job id immediately — generation takes about 20 seconds for an image and a few minutes for video; when the person asks later, check_media_job shows the result — not in the same turn. To base it on a picture the person attached (a reference image), pass that file's path as referencePaths. Leave model out to use the default for the kind; for a video never pass an image model (z_image, soul_2, gpt_image_*). Pick a feed shape: 4:5 or 3:4 for Instagram images, 9:16 for Reels, TikTok and Shorts, 16:9 for YouTube and X. shot adds a composition to the prompt, styled by the project's picture look: product-hero (the product alone on a clean backdrop), lifestyle (in use, natural light), flat-lay (overhead arrangement), talking-head (one person to camera, for video), b-roll (cinematic cutaways, for video) or quote-card-bg (a quiet background with room for text) — describe the subject in prompt, not the camera. Pass postDraftId to attach the result to that draft when it is ready — a postDraftId a save tool returned in this chat, so save the draft first and never call both at once. In a project with an AI avatar, its reference photos go with a Higgsfield job when the model takes a reference image (soul_2 does; z_image, the free plan's default, does not) — check_media_job's `references` says how many were used and why any were not.",
    category: "media",
    effect: "internal-write",
    inputSchema: generateMediaSchema,
    delegatesTo: "MediaService.generate",
    delegate: async (input: z.infer<typeof generateMediaSchema>, context) => {
      const project = await services.projects.current(context);
      /*
       * A draft id that is plainly not one — production sent "/create_post_draft_result_id_placeholder" and
       * "/tmp/draft_autumn_falling_video_01" in a call made alongside create_post_draft. The media is still
       * made, unattached, and the result says how to attach it; refusing the whole call made the model give
       * up and ask the person for an id.
       */
      const looksLikeId = input.postDraftId !== undefined && plausibleDraftId(input.postDraftId);
      const attachTo = looksLikeId ? input.postDraftId : undefined;
      const unattached =
        input.postDraftId !== undefined && !looksLikeId
          ? `"${input.postDraftId.slice(0, 60)}" is not a draft id, so the result is not attached. When the job succeeds, attach it with attach_media_to_post using the postDraftId the save returned.`
          : undefined;
      const started = await services.media.generate(context, {
        kind: input.kind,
        prompt: composeMediaPrompt(input.prompt, {
          ...(input.shot === undefined ? {} : { shot: input.shot }),
          ...(project?.avatar === undefined ? {} : { avatar: project.avatar }),
          ...(project?.design === undefined ? {} : { design: project.design }),
        }),
        ...(input.model === undefined ? {} : { model: input.model }),
        // #525: an unasked-for shape falls back to the kit's first preferred ratio.
        ...((input.aspectRatio ?? project?.design?.aspectRatios?.[0]) === undefined
          ? {}
          : { aspectRatio: input.aspectRatio ?? project!.design!.aspectRatios![0] }),
        ...(input.count === undefined ? {} : { count: input.count }),
        ...(attachTo === undefined ? {} : { postDraftId: attachTo }),
        ...(input.referencePaths === undefined ? {} : { referencePaths: input.referencePaths }),
      });
      return {
        jobId: started.jobId,
        ...(input.shot === undefined ? {} : { shot: input.shot }),
        ...(unattached === undefined ? {} : { notAttached: unattached }),
        ...(started.provider === undefined ? {} : { provider: started.provider }),
        state: "queued",
      };
    },
  }));

const checkMediaJobSchema = z.object({ jobId: idString }).strict();

export const checkMediaJobTool = shareFlowTool(["media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "check_media_job",
    label: "Check a media job",
    description:
      "See whether an image or video from generate_media is ready. `succeeded` returns the new media assets (their `id` is what attach_media_to_post takes); `failed` returns the reason in words; `queued` or `running` means it is not ready yet: tell the person to ask you again in a moment — do not check again in the same turn.",
    category: "media",
    effect: "read",
    inputSchema: checkMediaJobSchema,
    delegatesTo: "MediaService.getGeneration",
    delegate: async (input: z.infer<typeof checkMediaJobSchema>, context) => services.media.getGeneration(context, { jobId: input.jobId }),
  }));

export const MEDIA_TOOL_NAMES = [
  "list_media",
  "inspect_media",
  "check_media_for_platforms",
  "attach_media_to_post",
  "attach_uploaded_media",
  "detach_media_from_post",
  "replace_media_on_post",
  "convert_media",
  "check_conversion",
  "check_media_storage",
  "enhance_media_prompt",
  "plan_video_scenes",
  "describe_image",
  "plan_visuals",
  "render_diagram",
  "render_code_snippet",
  "generate_media",
  "check_media_job",
] as const;

/** In the order a conversation uses them: find, read, check, attach, change, convert, poll, diagnose. */
export const MEDIA_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listMediaTool,
  inspectMediaTool,
  checkMediaForPlatformsTool,
  attachMediaTool,
  attachUploadedMediaTool,
  detachMediaTool,
  replaceMediaTool,
  convertMediaTool,
  checkConversionTool,
  checkMediaStorageTool,
  // The prompt-writing pair, last: they are about media and touch none of it.
  enhanceMediaPromptTool,
  planVideoScenesTool,
  describeImageTool,
  // #587: planning a campaign's visuals, beside the two single-purpose planners it is built from.
  planVisualsTool,
  renderDiagramTool,
  renderCodeSnippetTool,
  // #496: generation through the app (Higgsfield or built-in), then its result.
  generateMediaTool,
  checkMediaJobTool,
];
