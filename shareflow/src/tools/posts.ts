/**
 * The Posts capabilities — the Retinue integration spec (`social_integgration: docs/retinue-integration-spec.md`), first tool category: *"read, create,
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
import { asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import {
  POST_DRAFT_STATUSES,
  type CampaignId,
  type MediaAssetId,
  type PlatformId,
  type PostDraft,
  type PostDraftId,
  type PostDraftSummary,
} from "../services/index.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { cursorOf, idString, pageInput, shareFlowTool } from "./factory.js";

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

export const getPostDraftTool = shareFlowTool(["content"], ({ services, deps }): Tool =>
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
  }));

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
    page: pageInput,
  })
  .strict();

export const listPostDraftsTool = shareFlowTool(["content"], ({ services, deps }): Tool =>
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
        ...(cursorOf(input.page) === undefined ? {} : { cursor: cursorOf(input.page)! }),
      });
      return {
        posts: page.items.map(summaryView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  }));

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
    /**
     * **A choice, not an optional field** — and the shape is empirical.
     *
     * It was `campaignId: idString.optional()`, and a real gpt-4o turn defeated the workflow with it. Told in
     * the user message not to attach a campaign, it called `create_post_draft` seven times in one turn,
     * inventing an id each time: the all-zeros UUID, `12345678-1234-1234-1234-123456789abc`, then random
     * ones. Every call was correctly refused and no draft was ever saved.
     *
     * Two weaker fixes were tried and measured. Adding a field description saying "omit this field entirely
     * for a standalone post — that is the usual case" changed nothing. Removing the field entirely made the
     * workflow complete on the first attempt, which is what identified it as the whole blocker.
     *
     * So the field stays and the affordance changes: the model has to *say* something, and "none" is now
     * sayable. Omitting is what it could not do; choosing it can.
     *
     * A fabricated id is still refused — `createDraft` checks the campaign is this workspace's, because
     * `posts_campaign_id_fkey` references `campaigns(id)` alone and would otherwise attach a draft to another
     * tenant's campaign.
     */
    campaign: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).strict(),
        z.object({ kind: z.literal("existing"), id: idString }).strict(),
      ])
      .describe('Use {"kind":"none"} for a standalone post. Only use "existing" with an id from `list_campaigns`.'),
  })
  .strict();

export const createPostDraftTool = shareFlowTool(["content"], ({ services, deps }): Tool =>
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
        ...(input.campaign.kind === "none" ? {} : { campaignId: asId<CampaignId>(input.campaign.id) }),
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
  }));

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

export const updatePostDraftTool = shareFlowTool(["content"], ({ services, deps }): Tool =>
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
  }));

const duplicatePostDraftSchema = z
  .object({ postDraftId: idString, targetPlatforms: platformList.optional() })
  .strict();

export const duplicatePostDraftTool = shareFlowTool(["content"], ({ services, deps }): Tool =>
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
  }));

/** The complete Posts catalog. The nine other categories each pin theirs; this one did not. */
export const POSTS_TOOL_NAMES = [
  "list_post_drafts",
  "get_post_draft",
  "create_post_draft",
  "update_post_draft",
  "duplicate_post_draft",
] as const;

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
