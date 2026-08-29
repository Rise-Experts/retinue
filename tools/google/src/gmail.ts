/**
 * Gmail — REQ-054 (#232), task #234.
 *
 * ## Why the draft is the only ungated write
 *
 * Every other write here stops for a person. `gmail_create_draft` does not, and that is a deliberate
 * asymmetry rather than an oversight: **a draft is the safe alternative to sending, and gating it removes the
 * reason to prefer it.**
 *
 * If drafting and sending both cost an approval, a model has no incentive to draft — the cheap path and the
 * irreversible path are equally expensive, so it takes the one that finishes the task. Making the reversible
 * act free is what makes it the default. The draft lands in a person's Gmail, where they read it and press
 * send themselves, which is the outcome an approval gate was trying to produce anyway.
 *
 * It is still `internal-write`, not `read`: it creates something in the user's account, it belongs in an audit
 * trail, and it is not idempotent-free.
 *
 * ## No delete, and no trash
 *
 * Deleting somebody's mail is not a capability this sprint grants. `gmail_modify_labels` can archive and mark
 * read, which covers the triage an agent is actually asked to do; a message can always be found again.
 */

import { confirms, defineTool, type Tool } from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

import { bodyOf, buildMessage, headerOf, toBase64Url, type OutgoingMessage } from "./mime.js";
import type { GoogleTransport } from "./transport.js";

const CATEGORY = "communication";

/** Gmail's own cap per page. Asking for more silently returns this many. */
const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 20;
/** Messages read when expanding a thread. A long thread is not worth a context window. */
const MAX_THREAD_MESSAGES = 20;
/** Characters of body text per message. A newsletter is megabytes and says nothing. */
const MAX_BODY_CHARS = 8_000;

/**
 * Scopes, per tool, on the descriptor — AC-7.
 *
 * Declared here rather than only in the docs so a connection can be checked against what the *enabled* tools
 * actually need, before a tenant is sent through a consent screen. Enabling three Gmail tools should ask for
 * three tools' worth of scopes; asking for `gmail.modify` when only `gmail.readonly` is needed is the
 * difference between a consent a security team approves and one they refuse.
 */
export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

type Json = Record<string, unknown>;

const clamp = (text: string): { text: string; truncated: boolean } =>
  text.length <= MAX_BODY_CHARS
    ? { text, truncated: false }
    : { text: `${text.slice(0, MAX_BODY_CHARS)}…`, truncated: true };

const summarise = (message: Json): Json => {
  const payload = (message.payload ?? {}) as { headers?: { name?: unknown; value?: unknown }[] };
  const headers = payload.headers;
  const body = bodyOf(message.payload as never);
  const clamped = clamp(body.text);
  return {
    id: message.id,
    threadId: message.threadId,
    from: headerOf(headers, "From"),
    to: headerOf(headers, "To"),
    cc: headerOf(headers, "Cc"),
    subject: headerOf(headers, "Subject"),
    date: headerOf(headers, "Date"),
    // Returned because a reply needs it, and because a caller debugging threading has nowhere else to look.
    messageId: headerOf(headers, "Message-ID"),
    labelIds: message.labelIds ?? [],
    snippet: message.snippet,
    body: clamped.text,
    bodyTruncated: clamped.truncated,
    ...(body.hadHtmlOnly ? { bodyWasHtml: true } : {}),
  };
};

export const gmailTools = (transport: GoogleTransport): readonly Tool[] => [
  defineTool({
    name: "gmail_search_messages",
    label: "Search mail",
    description:
      "Search the mailbox with Gmail's own query syntax — for example `from:ana@example.com is:unread newer_than:7d`. Returns each message's id, sender, subject and snippet. Read one with gmail_get_message.",
    category: CATEGORY,
    requiredScopes: [GMAIL_READONLY],
    execute: async (input: { query: string; limit?: number }, context) => {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS);
      const list = (await transport.json(
        context,
        `/gmail/v1/users/me/messages?q=${encodeURIComponent(input.query)}&maxResults=${limit}`,
      )) as Json;
      const ids = ((list.messages as Json[] | undefined) ?? []).map((entry) => String(entry.id));
      // Metadata only: the search result carries no headers, and fetching full bodies for twenty results is
      // both slow and far more text than a caller asked for.
      const messages = await Promise.all(
        ids.map(async (id) =>
          transport.json(
            context,
            `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          ),
        ),
      );
      return {
        messages: (messages as Json[]).map((message) => {
          const headers = ((message.payload ?? {}) as { headers?: { name?: unknown; value?: unknown }[] }).headers;
          return {
            id: message.id,
            threadId: message.threadId,
            from: headerOf(headers, "From"),
            subject: headerOf(headers, "Subject"),
            date: headerOf(headers, "Date"),
            snippet: message.snippet,
          };
        }),
        // Gmail reports an estimate rather than a count, and says so.
        estimatedTotal: list.resultSizeEstimate,
        truncated: list.nextPageToken !== undefined,
      };
    },
  }),
  defineTool({
    name: "gmail_get_message",
    label: "Read a message",
    description:
      "Read one message in full: headers and body. HTML-only mail is reduced to text. Long bodies are truncated and say so.",
    category: CATEGORY,
    requiredScopes: [GMAIL_READONLY],
    execute: async (input: { id: string }, context) => {
      const message = (await transport.json(context, `/gmail/v1/users/me/messages/${encodeURIComponent(input.id)}?format=full`)) as Json;
      return summarise(message);
    },
  }),
  defineTool({
    name: "gmail_get_thread",
    label: "Read a thread",
    description:
      "Read a whole conversation, oldest first. Bounded — a long thread reports `truncated` rather than returning everything.",
    category: CATEGORY,
    requiredScopes: [GMAIL_READONLY],
    execute: async (input: { id: string }, context) => {
      const thread = (await transport.json(context, `/gmail/v1/users/me/threads/${encodeURIComponent(input.id)}?format=full`)) as Json;
      const all = (thread.messages as Json[] | undefined) ?? [];
      return {
        id: thread.id,
        messages: all.slice(0, MAX_THREAD_MESSAGES).map(summarise),
        messageCount: all.length,
        truncated: all.length > MAX_THREAD_MESSAGES,
      };
    },
  }),
  defineTool({
    name: "gmail_list_labels",
    label: "List labels",
    description:
      "List the mailbox's labels with their ids. **Label ids are per account** — `Label_12` means nothing in another mailbox — so read this before modifying labels rather than guessing.",
    category: CATEGORY,
    requiredScopes: [GMAIL_READONLY],
    execute: async (_input: Record<string, never>, context) => {
      const result = (await transport.json(context, "/gmail/v1/users/me/labels")) as Json;
      return {
        labels: ((result.labels as Json[] | undefined) ?? []).map((label) => ({
          id: label.id,
          name: label.name,
          type: label.type,
        })),
      };
    },
  }),
  confirms({
    name: "gmail_send_message",
    label: "Send an email",
    description:
      "Send an email. **This cannot be undone** — it leaves the account immediately and reaches real people. If the intent is to prepare something for a person to review, use gmail_create_draft instead, which needs no approval. Requires approval.",
    category: CATEGORY,
    requiredScopes: [GMAIL_SEND],
    execute: async (
      input: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] },
      context,
    ) => {
      if (input.to === undefined || input.to.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "gmail_send_message needs at least one recipient.",
          retryable: false,
        });
      }
      const raw = toBase64Url(buildMessage(input as OutgoingMessage));
      const sent = (await transport.json(context, "/gmail/v1/users/me/messages/send", {
        method: "POST",
        body: { raw },
      })) as Json;
      return { id: sent.id, threadId: sent.threadId, to: input.to };
    },
  }),
  confirms({
    name: "gmail_reply_message",
    label: "Reply to a message",
    description:
      "Reply to a message, keeping it in the same conversation. **This cannot be undone.** The recipient, subject and threading are taken from the original — only the body is yours. Requires approval.",
    category: CATEGORY,
    requiredScopes: [GMAIL_SEND, GMAIL_READONLY],
    execute: async (input: { messageId: string; body: string; replyAll?: boolean }, context) => {
      /**
       * The original is **fetched**, not reconstructed — AC-4.
       *
       * A reply needs the original's `Message-ID` for `In-Reply-To` and its `References` for the chain. Both
       * live only on the real message. Building them from an id the caller passed, or omitting them, produces
       * a reply that sends perfectly and arrives as a new thread — which looks like success from every angle
       * except the recipient's.
       */
      const original = (await transport.json(
        context,
        `/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}?format=metadata` +
          "&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject" +
          "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Reply-To",
      )) as Json;
      const headers = ((original.payload ?? {}) as { headers?: { name?: unknown; value?: unknown }[] }).headers;
      const messageId = headerOf(headers, "Message-ID");
      if (messageId === undefined) {
        throw new AgentPlatformError({
          code: "provider_error",
          message:
            `Message ${input.messageId} has no Message-ID header, so a reply to it could not be threaded. ` +
            "Sending it anyway would start a new conversation.",
          retryable: false,
        });
      }

      // `Reply-To` wins over `From` where present, which is what a mailing list or a ticketing system sets and
      // what a human's mail client honours.
      const replyTo = headerOf(headers, "Reply-To") ?? headerOf(headers, "From") ?? "";
      const subject = headerOf(headers, "Subject") ?? "";
      const cc = input.replyAll === true ? (headerOf(headers, "Cc") ?? "").split(",").map((a) => a.trim()).filter(Boolean) : [];

      const raw = toBase64Url(
        buildMessage({
          to: [replyTo],
          ...(cc.length === 0 ? {} : { cc }),
          // `Re: ` added only when it is not already there, or a long thread accumulates them.
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          body: input.body,
          inReplyTo: messageId,
          ...(headerOf(headers, "References") === undefined ? {} : { references: headerOf(headers, "References") as string }),
        }),
      );
      const sent = (await transport.json(context, "/gmail/v1/users/me/messages/send", {
        method: "POST",
        // `threadId` as well as the headers: Gmail's own threading uses it, and the headers are for everyone
        // else's mail client. Sending only one threads correctly in exactly one inbox.
        body: { raw, threadId: original.threadId },
      })) as Json;
      return { id: sent.id, threadId: sent.threadId, inReplyTo: messageId, to: replyTo };
    },
  }),
  defineTool({
    name: "gmail_create_draft",
    label: "Draft an email",
    description:
      "Write an email and leave it in Drafts for a person to review and send. Nothing is sent. **Prefer this to gmail_send_message whenever a person could reasonably want to look first** — it needs no approval, because it is the reversible option.",
    category: CATEGORY,
    // See the file header: `internal-write`, not gated, and that asymmetry is the point.
    effect: "internal-write",
    requiredScopes: [GMAIL_COMPOSE],
    execute: async (
      input: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] },
      context,
    ) => {
      const raw = toBase64Url(buildMessage({ ...input, to: input.to ?? [] } as OutgoingMessage));
      const draft = (await transport.json(context, "/gmail/v1/users/me/drafts", {
        method: "POST",
        body: { message: { raw } },
      })) as Json;
      return {
        id: draft.id,
        messageId: ((draft.message ?? {}) as Json).id,
        // Said explicitly, because "created a draft" and "sent an email" are one word apart in a summary.
        sent: false,
      };
    },
  }),
  confirms({
    name: "gmail_modify_labels",
    label: "Change a message's labels",
    description:
      "Add or remove labels on a message. This is also how a message is archived (remove `INBOX`) or marked read (remove `UNREAD`). Label ids come from gmail_list_labels. Requires approval.",
    category: CATEGORY,
    requiredScopes: [GMAIL_MODIFY],
    execute: async (input: { id: string; add?: string[]; remove?: string[] }, context) => {
      const add = input.add ?? [];
      const remove = input.remove ?? [];
      if (add.length === 0 && remove.length === 0) {
        // An empty modify succeeds at Gmail and changes nothing, so the model is told the change worked.
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "gmail_modify_labels was called with no labels to add or remove.",
          retryable: false,
        });
      }
      const message = (await transport.json(context, `/gmail/v1/users/me/messages/${encodeURIComponent(input.id)}/modify`, {
        method: "POST",
        body: { addLabelIds: add, removeLabelIds: remove },
      })) as Json;
      return { id: message.id, labelIds: message.labelIds ?? [], added: add, removed: remove };
    },
  }),
];
