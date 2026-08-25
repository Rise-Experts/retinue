/**
 * The Posts capabilities — `docs/07-shareflow-integration.md`, first tool category: *"read, create,
 * update and duplicate drafts"* (#115).
 *
 * Every one is a `defineDelegatingTool` over a `ContentService` method. **No draft logic is
 * reimplemented here** (AC-6): the tools add the argument schema, the effect classification and the
 * result shaping, and the service does the work. `delegatesTo` names the method on the descriptor so
 * that is checkable from a catalog dump rather than by reading this file.
 *
 * Three things drove the shapes below, all of them read out of ShareFlow's own code rather than
 * guessed:
 *
 * 1. **`.strict()` on every schema.** A model that passes `status: "approved"` must get
 *    `invalid_input`, not have the field quietly ignored. A post's status is where ShareFlow's review
 *    policy lives, and an assistant able to set it would be approving its own content for publishing.
 *    Silent ignoring is the dangerous outcome here, because the model then reports success.
 * 2. **Absent and empty are different instructions.** `EditPostPatch` touches only the fields present.
 *    So `mediaAssetIds: []` clears the attachments and omitting it leaves them alone, and nothing in
 *    the update schema may carry a default — a default would wipe media on a caption-only edit.
 * 3. **The stored caption length is compared here, not by the model.** ShareFlow returns
 *    `captionLength` so a truncated caption is *checkable*; its tool docstring asks the model to
 *    compare two numbers. Models are unreliable at exactly that, so the comparison is done in code and
 *    reported as a boolean the model cannot get wrong.
 */
import { z } from "zod";
import { asId, defineDelegatingTool, type Tool } from "@retinue/agentkit";
import {
  POST_DRAFT_STATUSES,
  type CampaignId,
  type MediaAssetId,
  type PlatformId,
  type PostDraft,
  type PostDraftId,
  type PostDraftSummary,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

/**
 * Platform ids, normalised.
 *
 * `social_accounts.platform` and `PlatformId` are lowercase, and — ShareFlow's own note — *"an LLM tool
 * call routinely passes 'LinkedIn'"*. Normalising in the schema means the seam's contract is canonical,
 * and it means the envelope's fallback idempotency key is derived from the canonical form: without it,
 * `"LinkedIn"` and `"linkedin"` are one logical call with two different keys.
 *
 * Deduplicated as well, because `["x", "X"]` would otherwise become two targets for one destination.
 */
const platformList = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(20)
  .transform((values) => [...new Set(values.map((v) => v.toLowerCase()))] as PlatformId[]);

/**
 * A generous ceiling, not a platform limit.
 *
 * Per-platform limits are `PublishingService.validate`'s job (docs/07 step 7) and differ by
 * destination, so enforcing one here would reject a caption that is legal for its actual target. This
 * exists only to reject obvious garbage before it reaches the store.
 */
const CAPTION_MAX = 20_000;

const caption = z.string().min(1).max(CAPTION_MAX);
const assetIds = z.array(z.string().min(1)).max(20);
const idString = z.string().min(1);

/** What a read returns. The caption is included — see the note on `PostDraftSummary`. */
const draftView = (draft: PostDraft) => ({
  postDraftId: draft.id,
  status: draft.status,
  caption: draft.caption,
  captionLength: draft.caption.length,
  targetPlatforms: draft.targetPlatforms,
  mediaAssetIds: draft.mediaAssetIds,
  ...(draft.campaignId === undefined ? {} : { campaignId: draft.campaignId }),
  updatedAt: draft.updatedAt,
});

const summaryView = (summary: PostDraftSummary) => ({
  postDraftId: summary.id,
  status: summary.status,
  excerpt: summary.excerpt,
  captionLength: summary.captionLength,
  targetPlatforms: summary.targetPlatforms,
  mediaCount: summary.mediaCount,
  updatedAt: summary.updatedAt,
});

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

const getPostDraftSchema = z.object({ postDraftId: idString }).strict();

export const getPostDraftTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_post_draft",
    label: "Read a post",
    description:
      "Read one post back: its text, destinations, attachments and review status. Use this when the user asks about a specific post instead of answering from an earlier turn — the record is the truth and your earlier message may be stale.",
    category: "posts",
    effect: "read",
    inputSchema: getPostDraftSchema,
    delegatesTo: "ContentService.getDraft",
    delegate: async (input: z.infer<typeof getPostDraftSchema>, context) =>
      draftView(await services.content.getDraft(context, { id: asId<PostDraftId>(input.postDraftId) })),
  });

const listPostDraftsSchema = z
  .object({
    // Derived from the one definition, not restated. A second copy of a union is a second copy to keep
    // in step, and the drift would be invisible: a status this tool rejected but the store accepts.
    status: z.enum(POST_DRAFT_STATUSES).optional(),
    campaignId: idString.optional(),
    /**
     * Capped low and defaulted low on purpose. Every returned row costs context, and a list is for
     * choosing one — the caller fetches the body of the one it picked.
     */
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const listPostDraftsTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "list_post_drafts",
    label: "List posts",
    description:
      "List the workspace's posts as short summaries — id, status, an excerpt, destinations and attachment count. Use it to find the post the user means, then read that one for its full text.",
    category: "posts",
    effect: "read",
    inputSchema: listPostDraftsSchema,
    delegatesTo: "ContentService.listDrafts",
    delegate: async (input: z.infer<typeof listPostDraftsSchema>, context) => {
      const page = await services.content.listDrafts(context, {
        limit: input.limit,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.campaignId === undefined ? {} : { campaignId: asId<CampaignId>(input.campaignId) }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        posts: page.items.map(summaryView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });

// ---------------------------------------------------------------------------------------------------
// Draft writes — `internal-write`, so no approval gate fires and nothing here can publish.
//
// The guarantee is conditional and worth naming: ShareFlow creates an assistant-authored post
// **APPROVED**, deliberately, because *"nothing the assistant creates can reach a platform without the
// user answering a human-in-the-loop confirmation card first."* So the only gate between a post these
// tools create and a live platform is the approval on the publishing tools (#119). If one of those were
// ever classified `internal-write`, this chain would have no gate left in it.
// ---------------------------------------------------------------------------------------------------

const createPostDraftSchema = z
  .object({
    caption,
    targetPlatforms: platformList,
    mediaAssetIds: assetIds.optional(),
    campaignId: idString.optional(),
  })
  .strict();

export const createPostDraftTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "create_post_draft",
    label: "Save a post",
    description:
      "Save a post in the workspace, ready to publish. `caption` must be the complete post text, character for character — whatever is passed here is what gets published, so do not summarise or abbreviate it. Publishing is a separate, confirmed step. Check `captionStoredInFull` and `droppedMedia` in the result before telling the user what was saved.",
    category: "posts",
    effect: "internal-write",
    inputSchema: createPostDraftSchema,
    delegatesTo: "ContentService.createDraft",
    delegate: async (input: z.infer<typeof createPostDraftSchema>, context, { idempotencyKey }) => {
      const created = await services.content.createDraft(context, {
        // The envelope's own key, threaded through. The store here stops a second *agent call*; this
        // key stops a second *delivery* of one accepted call inside ShareFlow. Either alone leaves a
        // way to save the post twice.
        idempotencyKey,
        caption: input.caption,
        targetPlatforms: input.targetPlatforms,
        ...(input.mediaAssetIds === undefined
          ? {}
          : { mediaAssetIds: input.mediaAssetIds as MediaAssetId[] }),
        ...(input.campaignId === undefined ? {} : { campaignId: asId<CampaignId>(input.campaignId) }),
      });
      return {
        ...draftView(created),
        captionLength: created.captionLength,
        /**
         * The comparison ShareFlow's tool asks the model to make, made here instead.
         *
         * A model told to check `captionLength` against the text it intended is being asked to do
         * arithmetic on a number it has to remember — which is how a fragment gets published while the
         * assistant reports success. A boolean cannot be got wrong.
         */
        captionStoredInFull: created.captionLength === input.caption.length,
        droppedMedia: created.droppedMedia,
      };
    },
  });

const updatePostDraftSchema = z
  .object({
    postDraftId: idString,
    // Every field optional and **no defaults**: absent means "leave alone", and an explicit empty
    // array means "remove them all". A default here would clear media on a caption-only edit.
    caption: caption.optional(),
    targetPlatforms: platformList.optional(),
    mediaAssetIds: assetIds.optional(),
  })
  .strict()
  .refine(
    (v) => v.caption !== undefined || v.targetPlatforms !== undefined || v.mediaAssetIds !== undefined,
    { message: "supply at least one of caption, targetPlatforms or mediaAssetIds" },
  );

export const updatePostDraftTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "update_post_draft",
    label: "Edit a post",
    description:
      "Change a post that has not gone out yet. Only the fields you supply are touched — omit a field to leave it alone, and pass an empty `mediaAssetIds` list only if you mean to remove every attachment. A post that is already public, even on one destination, cannot be edited; duplicate it and edit the copy instead. The review status cannot be changed here.",
    category: "posts",
    effect: "internal-write",
    inputSchema: updatePostDraftSchema,
    delegatesTo: "ContentService.updateDraft",
    delegate: async (input: z.infer<typeof updatePostDraftSchema>, context, { idempotencyKey }) =>
      draftView(
        await services.content.updateDraft(context, {
          idempotencyKey,
          id: asId<PostDraftId>(input.postDraftId),
          patch: {
            // Rebuilt field by field rather than spread, so a future schema field cannot reach the
            // patch without someone deciding it should — `status` in particular.
            ...(input.caption === undefined ? {} : { caption: input.caption }),
            ...(input.targetPlatforms === undefined ? {} : { targetPlatforms: input.targetPlatforms }),
            ...(input.mediaAssetIds === undefined
              ? {}
              : { mediaAssetIds: input.mediaAssetIds as MediaAssetId[] }),
          },
        }),
      ),
  });

const duplicatePostDraftSchema = z
  .object({ postDraftId: idString, targetPlatforms: platformList.optional() })
  .strict();

export const duplicatePostDraftTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "duplicate_post_draft",
    label: "Duplicate a post",
    description:
      "Copy a post into a new, editable, unpublished one, optionally to different destinations. The original is untouched, and nothing is published or scheduled. This is how to 'change' a post that has already gone out: duplicate it, edit the copy, then publish the copy.",
    category: "posts",
    effect: "internal-write",
    inputSchema: duplicatePostDraftSchema,
    delegatesTo: "ContentService.duplicateDraft",
    delegate: async (input: z.infer<typeof duplicatePostDraftSchema>, context, { idempotencyKey }) =>
      draftView(
        await services.content.duplicateDraft(context, {
          idempotencyKey,
          id: asId<PostDraftId>(input.postDraftId),
          ...(input.targetPlatforms === undefined ? {} : { targetPlatforms: input.targetPlatforms }),
        }),
      ),
  });

/**
 * The Posts category, in the order a conversation uses them: find one, read it, write one, change it,
 * copy it.
 */
export const POSTS_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listPostDraftsTool,
  getPostDraftTool,
  createPostDraftTool,
  updatePostDraftTool,
  duplicatePostDraftTool,
];
