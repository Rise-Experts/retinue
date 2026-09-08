/**
 * `EngagementService` over `inbox_comments` — REQ-041 (#190).
 *
 * The cleanest mapping of the six adapters: `inbox_comments.reply_status` is
 * `needs_review | auto_sent | sent | dismissed` and the port's `CommentReplyState` is the same four states in
 * kebab-case. Underscore to hyphen, nothing else — and the constraint says so rather than the calling code,
 * which is the lesson the connector adapter learned the hard way.
 *
 * ## Sending a reply is not this package's to do
 *
 * `reply` needs a platform connector, and ShareFlow's live in `web/src/lib/connectors/`. So `send` is
 * injected, and **without it this method refuses** — which the port asks for by name: *"Throws
 * `capability_unavailable` when the platform's connector has no `sendReply`, because 'replying is not
 * supported on {platform} yet — reply in the {platform} app instead' is guidance, not an error."*
 *
 * That refusal is the honest one here for the same reason `checkHealth`'s is: the method's entire purpose is
 * the external effect, so there is no useful subset of it to perform.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import type {
  CommentReplyReceipt,
  CommentReplyState,
  EngagementService,
  InboxComment,
  Page,
} from "../../services/index.js";

/** From `inbox_comments_reply_status_check`. Four values, and the port has the same four. */
export const REPLY_STATE_FROM_DB: Readonly<Record<string, CommentReplyState>> = {
  needs_review: "needs-review",
  auto_sent: "auto-sent",
  sent: "sent",
  dismissed: "dismissed",
};

export const REPLY_STATE_TO_DB: Readonly<Record<CommentReplyState, string>> = {
  "needs-review": "needs_review",
  "auto-sent": "auto_sent",
  sent: "sent",
  dismissed: "dismissed",
};

/**
 * An unrecognised state reads as `needs-review`, which is the reading that invites a person to look.
 *
 * The alternatives are worse in both directions: `sent` would tell an assistant a comment is answered when
 * nobody knows, and `dismissed` would hide it from the queue entirely.
 */
export const replyStateFrom = (value: string | null): CommentReplyState =>
  (value === null ? undefined : REPLY_STATE_FROM_DB[value.toLowerCase()]) ?? "needs-review";

/** Terminal states. `reply` refuses on either, because a second reply is a second public message. */
const ANSWERED: ReadonlySet<CommentReplyState> = new Set<CommentReplyState>(["sent", "auto-sent"]);

/** How many comments one page returns. A tool result enters the context window. */
export const MAX_COMMENT_LIMIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asUuid = (field: string, value: string): string => {
  if (!UUID.test(value.trim())) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${field} must be a UUID — got ${JSON.stringify(value.slice(0, 60))}.`,
      retryable: false,
    });
  }
  return value.trim();
};

const asCursor = (value: string): string => {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        `cursor must be one this endpoint returned — got ${JSON.stringify(value.slice(0, 60))}. ` +
        "Pass `nextCursor` from a previous page, or omit it to start from the beginning.",
      retryable: false,
    });
  }
  return value;
};

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

type CommentRow = {
  id: string;
  platform: string;
  author_name: string;
  author_handle: string | null;
  post_ref: string | null;
  content: string;
  reply: string | null;
  reply_status: string | null;
  created_at: string | Date;
};

const COMMENT_COLUMNS = `select id, platform, author_name, author_handle, post_ref, content, reply,
                                reply_status, created_at
                           from public.inbox_comments`;

/** The comment body, bounded. A hundred comments of unbounded prose is the context budget, not context. */
export const MAX_COMMENT_CHARS = 1_000;

const toComment = (row: CommentRow): InboxComment => ({
  id: row.id as never,
  platformId: row.platform as never,
  authorName: row.author_name,
  ...(row.author_handle === null ? {} : { authorHandle: row.author_handle }),
  content: row.content.slice(0, MAX_COMMENT_CHARS),
  ...(row.post_ref === null ? {} : { postRef: row.post_ref }),
  replyState: replyStateFrom(row.reply_status),
  /**
   * The drafted reply, surfaced **read-only**.
   *
   * `needs-review` exists so a human looks first, and there is deliberately no `approveComment` capability:
   * an assistant that could send its own draft would be routing around the review step rather than passing
   * through it. Knowing a draft exists is what stops it writing a second one.
   */
  ...(row.reply === null || row.reply === "" ? {} : { draftedReply: row.reply }),
  createdAt: iso(row.created_at),
});

export type EngagementDeps = {
  readonly sql: SqlExecutor;
  /**
   * Serialises the read-then-write in `reply` and `dismiss`, so two callers cannot both pass the check.
   *
   * `reply` is an external write to a customer's audience and its terminal-state guard is the only thing
   * stopping a second public message; a guard read on one pooled connection and acted on from another is not
   * a guard. Required for the reason `PublishingService`'s is.
   */
  readonly transaction: TransactionRunner;
  /**
   * Sends the reply on the platform. **Absent means `reply` refuses.**
   *
   * ShareFlow's connectors live in another repository, so this is the seam. The port asks for the refusal by
   * name, and it is the right one: this method's whole purpose is the external effect, so there is no useful
   * part of it to perform without a way to send.
   */
  readonly send?: (input: {
    readonly context: ExecutionContext;
    readonly commentId: string;
    readonly platformId: string;
    readonly text: string;
  }) => Promise<void>;
  readonly now?: () => number;
};

export const createPostgresEngagementService = (deps: EngagementDeps): EngagementService => {
  const now = deps.now ?? Date.now;
  const { sql } = deps;

  const one = async (context: ExecutionContext, id: string): Promise<CommentRow> => {
    const rows = await sql.query<CommentRow>(
      `${COMMENT_COLUMNS} where workspace_id = $1::uuid and id = $2::uuid`,
      [String(context.tenantId), asUuid("commentId", id)],
    );
    const row = rows[0];
    if (row === undefined) {
      // `not_found` for absent and for another tenant's alike — the two must be indistinguishable.
      throw new AgentPlatformError({ code: "not_found", message: `No comment ${id}.`, retryable: false });
    }
    return row;
  };

  return {
    async listComments(context, input): Promise<Page<InboxComment>> {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_COMMENT_LIMIT);
      const rows = await sql.query<CommentRow>(
        `${COMMENT_COLUMNS}
          where workspace_id = $1::uuid
            and ($2::text is null or reply_status = $2::text)
            and ($3::text is null or platform = $3::text)
            and ($4::timestamptz is null or created_at < $4::timestamptz)
          order by created_at desc
          limit $5`,
        [
          String(context.tenantId),
          input.replyState === undefined ? null : REPLY_STATE_TO_DB[input.replyState],
          input.platformId === undefined ? null : String(input.platformId),
          input.cursor === undefined ? null : asCursor(input.cursor),
          limit + 1,
        ],
      );
      const page = rows.slice(0, limit);
      const items = page.map(toComment);
      return rows.length > limit && page.length > 0
        ? { items, nextCursor: iso(page[page.length - 1]!.created_at) }
        : { items };
    },

    async reply(context, input): Promise<CommentReplyReceipt> {
      if (input.text.trim() === "") {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "A reply needs text.",
          retryable: false,
        });
      }
      const send = deps.send;
      if (send === undefined) {
        throw new AgentPlatformError({
          code: "capability_unavailable",
          message:
            "This deployment cannot send replies: no platform connector is wired. Reply in the platform's " +
            "own app instead, or dismiss the comment to take it out of the review queue.",
          retryable: false,
        });
      }

      const comment = await one(context, String(input.commentId));

      /**
       * The terminal-state claim is made **in the update**, before anything is sent.
       *
       * `where reply_status in ('needs_review','dismissed')` and zero rows means somebody else answered it
       * first. Read-then-send-then-write would send the second public reply and only then discover the
       * conflict — and a duplicate reply to a customer cannot be taken back.
       *
       * So the row is claimed as `sent` first and the send happens after. The failure that leaves is a row
       * marked sent whose send failed, which is recoverable by a person reading the thread; the other order
       * leaves two replies on a customer's post, which is not.
       */
      const claimed = await deps.transaction.transaction(async (tx) => {
        const rows = await tx.query<{ id: string }>(
          `update public.inbox_comments
              set reply_status = 'sent', reply = $3, replied_at = $4::timestamptz
            where workspace_id = $1::uuid and id = $2::uuid
              and reply_status in ('needs_review', 'dismissed')
            returning id`,
          [String(context.tenantId), comment.id, input.text, new Date(now()).toISOString()],
        );
        return rows[0];
      });

      if (claimed === undefined) {
        throw new AgentPlatformError({
          code: "conflict",
          message:
            `That comment is already ${replyStateFrom(comment.reply_status)}, so it has been answered. ` +
            "A second reply would appear publicly alongside the first.",
          retryable: false,
        });
      }

      /**
       * Sent after the claim, and a send failure is reported as such.
       *
       * The row stays `sent`: reverting it would invite a retry that might duplicate a reply the platform did
       * accept before the error. "It may have gone out, check the thread" is the truthful report.
       */
      try {
        await send({
          context,
          commentId: comment.id,
          platformId: comment.platform,
          text: input.text,
        });
      } catch (error) {
        throw new AgentPlatformError({
          code: "provider_error",
          message:
            `The reply was recorded but ${comment.platform} did not confirm it. Check the thread before ` +
            "replying again — a second attempt may post twice.",
          retryable: false,
          details: { platform: comment.platform, cause: error instanceof Error ? error.message : String(error) },
        });
      }

      return {
        commentId: comment.id as never,
        platformId: comment.platform as never,
        sentAt: new Date(now()).toISOString(),
      };
    },

    async draftReply(context, input): Promise<InboxComment> {
      if (input.text.trim() === "") {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "A draft needs text.",
          retryable: false,
        });
      }
      const comment = await one(context, String(input.commentId));

      /**
       * The terminal-state guard is in the statement, exactly as `reply`'s is.
       *
       * `where reply_status in ('needs_review','dismissed')` — a draft written over a `sent` or `auto_sent`
       * reply would overwrite the text that actually went out and make the record read as though nobody had
       * answered. A read-then-write would find the conflict after clobbering it.
       *
       * A dismissed comment may be drafted into, and doing so puts it **back** in the queue: drafting a reply
       * to something previously set aside is a decision to look at it again, and leaving it dismissed would
       * hide the draft from the only screen that shows drafts.
       */
      const updated = await deps.transaction.transaction(async (tx) => {
        const rows = await tx.query<CommentRow>(
          `update public.inbox_comments
              set reply = $3, reply_status = 'needs_review'
            where workspace_id = $1::uuid and id = $2::uuid
              and reply_status in ('needs_review', 'dismissed')
            returning id, platform, author_name, author_handle, post_ref, content, reply, reply_status,
                      created_at`,
          [String(context.tenantId), comment.id, input.text],
        );
        return rows[0];
      });

      if (updated === undefined) {
        throw new AgentPlatformError({
          code: "conflict",
          message:
            `That comment is already ${replyStateFrom(comment.reply_status)}, so it has been answered. ` +
            "Drafting over it would hide the reply that was sent.",
          retryable: false,
        });
      }
      return toComment(updated);
    },

    async dismiss(context, input): Promise<InboxComment> {
      const comment = await one(context, String(input.commentId));
      /**
       * An answered comment is not dismissible, and the guard is in the statement.
       *
       * Dismissing something already replied to would take a sent reply out of the queue and make the record
       * read as though nobody answered.
       */
      const updated = await deps.transaction.transaction(async (tx) => {
        const rows = await tx.query<CommentRow>(
          `update public.inbox_comments
              set reply_status = 'dismissed'
            where workspace_id = $1::uuid and id = $2::uuid and reply_status = 'needs_review'
            returning id, platform, author_name, author_handle, post_ref, content, reply, reply_status,
                      created_at`,
          [String(context.tenantId), comment.id],
        );
        return rows[0];
      });

      if (updated === undefined) {
        const state = replyStateFrom(comment.reply_status);
        // Already dismissed is not an error: the caller's intent is satisfied. Answered is.
        if (state === "dismissed") return toComment(comment);
        throw new AgentPlatformError({
          code: "conflict",
          message: `That comment is ${state}, so dismissing it would hide a reply that was sent.`,
          retryable: false,
        });
      }
      return toComment(updated);
    },
  };
};
