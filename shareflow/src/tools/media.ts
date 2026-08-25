/**
 * The Media capabilities — `docs/07-shareflow-integration.md`: *"list, inspect, attach and convert"*,
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
import { asId, defineDelegatingTool, type Tool } from "@retinue/agentkit";
import {
  type MediaAsset,
  type MediaAssetId,
  type MediaStorageCheck,
  type PlatformId,
  type PostDraftId,
  type ValidationIssue,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

const idString = z.string().min(1);
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
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const listMediaTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "list_media",
    label: "List media",
    description:
      "List the workspace's media files with their kind, format and size. Use it to find the file the user means; attach it by the id returned here rather than by a filename or a path.",
    category: "media",
    effect: "read",
    inputSchema: listMediaSchema,
    delegatesTo: "MediaService.listAssets",
    delegate: async (input: z.infer<typeof listMediaSchema>, context) => {
      const page = await services.media.listAssets(context, {
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        media: page.items.map(assetView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });

const inspectMediaSchema = z.object({ mediaAssetId: idString }).strict();

export const inspectMediaTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
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
  });

const checkMediaSchema = z.object({ mediaAssetIds: assetIds, platformIds: platformList }).strict();

export const checkMediaForPlatformsTool: ShareFlowToolFactory = ({
  services,
  deps,
}: ShareFlowToolContext): Tool =>
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
  });

// ---------------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------------

const attachMediaSchema = z
  .object({ postDraftId: idString, mediaAssetIds: assetIds })
  .strict();

export const attachMediaTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
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
  });

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

export const convertMediaTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "convert_media",
    label: "Convert a file",
    description:
      "Convert a file to another format, producing a new file and leaving the original alone. Ask for a format, not a platform — which format a destination needs comes from `check_media_for_platforms`. If the format is not supported the error names the ones that are.",
    category: "media",
    effect: "internal-write",
    inputSchema: convertMediaSchema,
    delegatesTo: "MediaService.convert",
    delegate: async (input: z.infer<typeof convertMediaSchema>, context, { idempotencyKey }) =>
      assetView(
        await services.media.convert(context, {
          idempotencyKey,
          id: asId<MediaAssetId>(input.mediaAssetId),
          targetFormat: input.targetFormat,
        }),
      ),
  });

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
export const checkMediaStorageTool: ShareFlowToolFactory = ({
  services,
  deps,
}: ShareFlowToolContext): Tool =>
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
  });

/** The complete Media catalog, pinned by a test. */
export const MEDIA_TOOL_NAMES = [
  "list_media",
  "inspect_media",
  "check_media_for_platforms",
  "attach_media_to_post",
  "convert_media",
  "check_media_storage",
] as const;

export const MEDIA_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listMediaTool,
  inspectMediaTool,
  checkMediaForPlatformsTool,
  attachMediaTool,
  convertMediaTool,
  checkMediaStorageTool,
];
