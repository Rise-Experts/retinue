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
import { withCredit } from "./credits.js";
import { asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import {
  COMMENT_REPLY_STATES,
  type CommentReplyReceipt,
  type InboxComment,
  type InboxCommentId,
} from "../services/index.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { cursorOf, idString, pageInput, shareFlowTool } from "./factory.js";


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
    page: pageInput,
  })
  .strict();

export const listCommentsTool = shareFlowTool(["engagement"], ({ services, deps }): Tool =>
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
        ...(cursorOf(input.page) === undefined ? {} : { cursor: cursorOf(input.page)! }),
      });
      return {
        comments: page.items.map(commentView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  }));

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

export const replyToCommentTool = shareFlowTool(["engagement"], ({ services, deps }): Tool =>
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
  }));

const dismissSchema = z.object({ commentId: idString }).strict();

export const dismissCommentTool = shareFlowTool(["engagement"], ({ services, deps }): Tool =>
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
  }));

/** The complete Engagement catalog, pinned by a test. */
const draftReplySchema = z.object({ commentId: idString, text: z.string().trim().min(1).max(4_000) }).strict();

export const draftCommentReplyTool = shareFlowTool(["engagement", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "draft_comment_reply",
    label: "Draft a reply",
    description:
      "Write a reply and leave it for a person to approve — this sends nothing. The comment goes back to `needs-review`, which is the queue someone checks before anything appears publicly. Use this when the user asks you to draft, suggest or prepare a reply, and `reply_to_comment` only when they have asked for it to go out now. You cannot approve your own draft; a person does that in the app.",
    category: "engagement",
    /**
     * `internal-write`, so no approval gate — nothing leaves the tenant.
     *
     * The contrast with `reply_to_comment` is the point of having both: that one is `external-write` and
     * waits for a person because it reaches a customer's audience. This one *creates* the thing a person
     * approves, so gating it would ask for approval to prepare something for approval.
     */
    effect: "internal-write",
    inputSchema: draftReplySchema,
    delegatesTo: "EngagementService.draftReply",
    delegate: withCredit(() => services.credits, "draft_comment_reply", async (input: z.infer<typeof draftReplySchema>, context, { idempotencyKey }) =>
      commentView(
        await services.engagement.draftReply(context, {
          idempotencyKey,
          commentId: asId<InboxCommentId>(input.commentId),
          text: input.text,
        }),
      )),
  }));

/**
 * The auto-reply classifier's input, transcribed from `ReplyRequest`.
 *
 * The bounds are the Python's: 6 thread messages, 2,000 characters each, and the persona's own field
 * limits. They are kept because the ingest worker already respects them, and because this is the one
 * tool whose input is largely written by **members of the public** — a comment and a thread of
 * comments. An unbounded thread is an unbounded prompt.
 */
const autoReplySchema = z
  .object({
    comment: z.string().trim().min(1).max(4_000),
    rules: z
      .array(z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2_000).nullish() }).strict())
      .max(50)
      .default([]),
    tone: z.string().trim().max(80).nullish(),
    accountName: z.string().trim().max(160).nullish(),
    persona: z
      .object({
        replyName: z.string().trim().max(160).nullish(),
        accountType: z.enum(["personal", "brand", "business"]).optional(),
        tone: z.enum(["natural", "friendly", "professional", "casual", "witty"]).optional(),
        replyLength: z.enum(["short", "balanced", "detailed"]).optional(),
        emojiPreference: z.enum(["off", "light", "mirror"]).optional(),
        mirrorCommenterLanguage: z.boolean().optional(),
        mirrorCommenterStyle: z.boolean().optional(),
        allowBrandMentions: z.boolean().optional(),
        customInstructions: z.string().max(2_000).nullish(),
      })
      .strict()
      .optional(),
    threadContext: z
      .array(z.object({ role: z.enum(["commenter", "account"]), content: z.string().min(1).max(2_000) }).strict())
      .max(6)
      .optional(),
  })
  .strict();

/**
 * `["generator"]` only — it reads no engagement service.
 *
 * It sits in this file because it is an engagement capability, and it *requires* only the generator:
 * classifying a comment touches no inbox row. Declaring `engagement` as well compiled fine and was
 * caught by the source scan in `layout.test.ts`, whose comment says why it matters — an unread
 * declaration makes the provider refuse a deployment it could have served, which reads as the
 * capability being unavailable rather than as a wrong list.
 */
export const draftAutoReplyTool = shareFlowTool(["generator", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "draft_auto_reply",
    label: "Classify and draft a reply",
    description:
      "Classify an inbound comment against the workspace's reply rules and draft a reply, returning the matched rule, a confidence score, whether it must be escalated to a person, and any buying intent detected. Stores nothing and sends nothing — the caller decides what to do with the draft. This is the ingest cycle's classifier; to leave a draft on a comment already in the inbox use `draft_comment_reply`, and to send a reply now use `reply_to_comment`.",
    category: "engagement",
    /**
     * `read` — it writes nothing at all.
     *
     * Not `internal-write`, unlike `draft_comment_reply`: that one stores a draft against a comment
     * row, and this one hands the draft back for the caller to store. The distinction matters because
     * effect derives approval, and asking for approval to *classify* a comment would gate the ingest
     * cycle behind a human on every comment — which is the thing the cycle exists to avoid.
     */
    effect: "read",
    inputSchema: autoReplySchema,
    delegatesTo: "ContentGenerator.draftAutoReply",
    delegate: withCredit(() => services.credits, "draft_auto_reply", async (input: z.infer<typeof autoReplySchema>, context) =>
      services.generator.draftAutoReply(context, {
        comment: input.comment,
        rules: input.rules,
        ...(input.tone === undefined || input.tone === null ? {} : { tone: input.tone }),
        ...(input.accountName === undefined || input.accountName === null ? {} : { accountName: input.accountName }),
        ...(input.persona === undefined ? {} : { persona: input.persona }),
        ...(input.threadContext === undefined ? {} : { threadContext: input.threadContext }),
      })),
  }));

export const ENGAGEMENT_TOOL_NAMES = [
  "list_comments",
  "draft_comment_reply",
  "reply_to_comment",
  "dismiss_comment",
  "draft_auto_reply",
] as const;

export const ENGAGEMENT_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listCommentsTool,
  draftCommentReplyTool,
  replyToCommentTool,
  dismissCommentTool,
  draftAutoReplyTool,
];
