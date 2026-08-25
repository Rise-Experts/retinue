/**
 * The Engagement capabilities — docs/07 Workflow 6 (#120).
 *
 * ## Assignment is absent, and that is a finding
 *
 * docs/07 lists this category as *"comments, assignment and replies"*, and AC-6 asks for assignment to
 * need no approval. **There is no assignment anywhere in ShareFlow** — `inbox_comments` has no assignee
 * column and there is no assign function. What exists is triage: `needs_review` → `dismissed`.
 *
 * So the no-approval internal change here is `dismiss_comment`, which is real. A tool called
 * `assign_comment` that did nothing would be worse than an absent one; what it would need is an assignee
 * field and a notion of workspace members to assign to, and neither exists yet.
 *
 * ## `approve_comment` is deliberately not here, and this one is sharp
 *
 * `/api/inbox/approve` sends the reply already **drafted** in `inbox_comments.reply`. The `needs_review`
 * state exists precisely so a person looks at that draft first.
 *
 * An assistant with an approve capability could draft a reply and then approve its own draft. The review
 * step exists to stop exactly that, and the tool would route around it rather than pass through it.
 * Excluded for the same reason `connect_test_account` is (#117).
 */
import { z } from "zod";
import { asId, defineDelegatingTool, type Tool } from "@retinue/agentkit";
import {
  COMMENT_REPLY_STATES,
  type CommentReplyReceipt,
  type InboxComment,
  type InboxCommentId,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

const idString = z.string().min(1);

/**
 * The key that makes one comment answerable once.
 *
 * From the **comment**, not the call — the same reasoning as `publishTargetIdempotencyKey`. ShareFlow
 * already refuses a second reply on `reply_status` of `sent` or `auto_sent`, so the comment is the
 * natural unit; derived from the call, a second distinct call would send a second reply.
 */
export const commentReplyIdempotencyKey = (commentId: InboxCommentId): string =>
  `reply:${commentId.replace(/%/g, "%25").replace(/:/g, "%3A")}`;

/**
 * What the assistant sees about a comment.
 *
 * `draftedReply` is included read-only, because knowing a draft is already waiting is exactly what stops
 * the assistant writing a second one. It is not approvable from here — see the note at the top.
 */
const commentView = (comment: InboxComment) => ({
  commentId: comment.id,
  platformId: comment.platformId,
  authorName: comment.authorName,
  content: comment.content,
  replyState: comment.replyState,
  createdAt: comment.createdAt,
  ...(comment.authorHandle === undefined ? {} : { authorHandle: comment.authorHandle }),
  ...(comment.postRef === undefined ? {} : { postRef: comment.postRef }),
  ...(comment.draftedReply === undefined ? {} : { draftedReply: comment.draftedReply }),
});

const listCommentsSchema = z
  .object({
    replyState: z.enum(COMMENT_REPLY_STATES).optional(),
    platformId: z.string().trim().min(1).max(64).toLowerCase().optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const listCommentsTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "list_comments",
    label: "Read the inbox",
    description:
      "Read comments and mentions on the workspace's posts, newest first. `replyState` filters them: `needs-review` is what is waiting for an answer. A comment that already carries a `draftedReply` has one written and waiting for a person — do not write another.",
    category: "engagement",
    effect: "read",
    inputSchema: listCommentsSchema,
    delegatesTo: "EngagementService.listComments",
    delegate: async (input: z.infer<typeof listCommentsSchema>, context) => {
      const page = await services.engagement.listComments(context, {
        limit: input.limit,
        ...(input.replyState === undefined ? {} : { replyState: input.replyState }),
        ...(input.platformId === undefined ? {} : { platformId: input.platformId }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        comments: page.items.map(commentView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });

/**
 * `commentId` is required, and that is AC-3 rather than bookkeeping.
 *
 * A reply tool taking only `text` and inferring its target from conversation context would be ungrounded
 * by construction. The audit linkage — `recordAudit(action: 'inbox.replied', targetId: comment.id)` — is
 * written by the service *from this id*, so there is no way to send a reply that is not recorded against
 * what it answers.
 */
const replySchema = z
  .object({ commentId: idString, text: z.string().trim().min(1).max(4_000) })
  .strict();

export const replyToCommentTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "reply_to_comment",
    label: "Reply to a comment",
    description:
      "Send a reply to one comment. This is public and requires the user's approval. Reply only to the comment you name — the reply is recorded against it. A comment that has already been answered cannot be answered again; say so rather than trying a second time.",
    category: "engagement",
    effect: "external-write",
    inputSchema: replySchema,
    delegatesTo: "EngagementService.reply",
    delegate: async (input: z.infer<typeof replySchema>, context) => {
      const commentId = asId<InboxCommentId>(input.commentId);
      const receipt: CommentReplyReceipt = await services.engagement.reply(context, {
        // The comment's key, not the envelope's — see `commentReplyIdempotencyKey`.
        idempotencyKey: commentReplyIdempotencyKey(commentId),
        commentId,
        text: input.text,
      });
      // The linkage travels back out too, so the assistant reports what it answered rather than that it
      // answered something.
      return { commentId: receipt.commentId, platformId: receipt.platformId, sentAt: receipt.sentAt };
    },
  });

const dismissSchema = z.object({ commentId: idString }).strict();

export const dismissCommentTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "dismiss_comment",
    label: "Dismiss a comment",
    description:
      "Take a comment out of the review queue without answering it — for spam, or anything that needs no reply. Nothing is sent and nothing is published; the comment stays readable.",
    category: "engagement",
    effect: "internal-write",
    inputSchema: dismissSchema,
    delegatesTo: "EngagementService.dismiss",
    delegate: async (input: z.infer<typeof dismissSchema>, context, { idempotencyKey }) =>
      commentView(
        await services.engagement.dismiss(context, {
          // The envelope's key is right here: dismissing is internal and idempotent by nature, so the
          // only thing worth guarding is a duplicate call.
          idempotencyKey,
          commentId: asId<InboxCommentId>(input.commentId),
        }),
      ),
  });

/** The complete Engagement catalog, pinned by a test. */
export const ENGAGEMENT_TOOL_NAMES = ["list_comments", "reply_to_comment", "dismiss_comment"] as const;

export const ENGAGEMENT_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listCommentsTool,
  replyToCommentTool,
  dismissCommentTool,
];
