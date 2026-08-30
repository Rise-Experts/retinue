/**
 * The four tools — REQ-056 (#240), task #241.
 *
 * ## One send, one rehearsal, and the rehearsal has to be exact
 *
 * A sent message cannot be recalled. Unlike a tweet it cannot even be deleted afterwards — it is in somebody
 * else's mailbox and that is the end of the matter. So the send is gated, and there is a preview.
 *
 * The preview is only worth having if it is **byte-identical** to what the send transmits (AC-3). A preview
 * that differs is worse than none: it invites a caller to approve one message and dispatch another, with the
 * difference precisely in the parts nobody reads carefully — the encoded subject, the multipart ordering, the
 * `Bcc` line. That is why `composeFor` is the single entry point both tools use, and why the composed message
 * carries no `Date` and no `Message-ID`: either would differ between the two calls by construction.
 *
 * ## Why the recipient cap is across the fields, not per field — AC-4
 *
 * Three fields of ten is thirty recipients, and a cap written per field is a cap somebody routes around
 * without meaning to. Mass sending is not a capability this package grants, and a tool that will accept a
 * hundred addresses in one call is a tool that will eventually send to a hundred addresses by mistake.
 */

import { defineTool, confirms, type Tool } from "@retinue/agentkit/tools";
import { buildMessage, headerOf, type Attachment, type OutgoingMessage } from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

import { asPlatformError } from "./providers.js";
import type { EmailProvider } from "./provider.js";

const CATEGORY = "communication";

/**
 * The recipient ceiling, across to + cc + bcc combined.
 *
 * Twenty is enough for every transactional case — a receipt, an alert, a report to a team — and far short of
 * anything resembling a list. The number is deliberately small: this is a send-your-own-mail package, and the
 * moment it can address a hundred people it is a campaign tool with none of a campaign tool's safeguards
 * (consent records, unsubscribe handling, suppression lists).
 */
export const MAX_RECIPIENTS = 20;
export const MAX_SUBJECT_LENGTH = 998;
export const MAX_ATTACHMENT_BYTES = 5_000_000;
export const MAX_BODY_BYTES = 1_000_000;

export type EmailToolsConfig = {
  readonly provider: EmailProvider;
  /** The `From` address. Configuration, never a tool argument — see the note in `composeFor`. */
  readonly from: string;
  readonly replyTo?: string;
};

export type SendInput = {
  readonly to: string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly cc?: string[];
  readonly bcc?: string[];
  readonly attachment?: { filename: string; contentType: string; contentBase64: string };
  readonly inReplyTo?: string;
  readonly references?: string;
};

const refuse = (message: string): never => {
  throw new AgentPlatformError({ code: "invalid_input", message, retryable: false });
};

/**
 * An address that is plausibly an address.
 *
 * Not RFC 5322 validation — that grammar admits things no mail server accepts and rejecting valid-but-strange
 * addresses is its own failure. This catches the cases that matter: no `@`, whitespace, or a line break, the
 * last of which `assertHeaderSafe` would also catch but which deserves a message about the address rather than
 * about a header.
 */
export const checkedAddress = (address: unknown, field: string): string => {
  if (typeof address !== "string" || address.trim() === "") refuse(`A ${field} address is required.`);
  const trimmed = (address as string).trim();
  if (/[\r\n]/.test(trimmed)) refuse(`The ${field} address contains a line break, which is never valid.`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed.replace(/^.*<|>$/g, ""))) {
    refuse(`"${trimmed}" does not look like an email address.`);
  }
  return trimmed;
};

/**
 * Composes the message. **The single entry point for both the preview and the send.**
 *
 * Two call sites for one composition would be two things to keep in step, and the whole value of a preview is
 * that it is not a separate rendering.
 */
export const composeFor = (config: EmailToolsConfig, input: SendInput): { raw: string; envelopeTo: string[] } => {
  const to = (input.to ?? []).map((address) => checkedAddress(address, "recipient"));
  const cc = (input.cc ?? []).map((address) => checkedAddress(address, "cc"));
  const bcc = (input.bcc ?? []).map((address) => checkedAddress(address, "bcc"));

  if (to.length === 0) refuse("A message needs at least one recipient.");
  const total = to.length + cc.length + bcc.length;
  if (total > MAX_RECIPIENTS) {
    refuse(
      `That is ${total} recipients across to, cc and bcc, and the limit is ${MAX_RECIPIENTS} combined. ` +
        "Sending to a list is not something this tool does — it has none of the consent, unsubscribe or " +
        "suppression handling that requires.",
    );
  }
  if (typeof input.subject !== "string" || input.subject.trim() === "") refuse("A message needs a subject.");
  if (input.subject.length > MAX_SUBJECT_LENGTH) {
    refuse(`The subject is ${input.subject.length} characters and the line limit is ${MAX_SUBJECT_LENGTH}.`);
  }
  const hasText = typeof input.text === "string" && input.text !== "";
  const hasHtml = typeof input.html === "string" && input.html !== "";
  if (!hasText && !hasHtml) refuse("A message needs a text body, an HTML body, or both.");
  for (const [name, value] of [["text", input.text], ["html", input.html]] as const) {
    if (value !== undefined && Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
      refuse(`The ${name} body is larger than the ${MAX_BODY_BYTES}-byte limit.`);
    }
  }

  let attachments: Attachment[] | undefined;
  if (input.attachment !== undefined) {
    const { filename, contentType, contentBase64 } = input.attachment;
    if (typeof filename !== "string" || filename.trim() === "") refuse("An attachment needs a filename.");
    if (typeof contentBase64 !== "string" || contentBase64 === "") refuse("An attachment needs base64 content.");
    // Decoded size, not the base64 length — a caller reasoning about "5MB" means the file.
    const bytes = Math.floor((contentBase64.replace(/\s+/g, "").length * 3) / 4);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      refuse(`That attachment is about ${Math.round(bytes / 1000)}KB and the limit is ${MAX_ATTACHMENT_BYTES / 1_000_000}MB.`);
    }
    attachments = [{ filename: filename.trim(), contentType: contentType || "application/octet-stream", contentBase64 }];
  }

  const message: OutgoingMessage = {
    to,
    subject: input.subject,
    /**
     * `From` comes from configuration, never from the tool input.
     *
     * A model that could choose the sender could send as anyone the domain permits — and the whole point of
     * this package is mail from a deployment's *own* verified domain. It is also the field SPF and DKIM are
     * aligned against, so a caller-supplied one is the fastest route to mail that silently lands in spam.
     */
    from: config.from,
    ...(config.replyTo === undefined ? {} : { replyTo: config.replyTo }),
    ...(cc.length === 0 ? {} : { cc }),
    ...(bcc.length === 0 ? {} : { bcc }),
    ...(hasText ? { text: input.text } : {}),
    ...(hasHtml ? { html: input.html } : {}),
    ...(attachments === undefined ? {} : { attachments }),
    ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
    ...(input.references === undefined ? {} : { references: input.references }),
  };

  try {
    return { raw: buildMessage(message), envelopeTo: [...to, ...cc, ...bcc] };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
};

export const emailTools = (config: EmailToolsConfig): readonly Tool[] => [
  confirms({
    name: "email_send",
    label: "Send an email",
    description:
      "Send an email from this deployment's own address. **This cannot be undone** — a sent message cannot be recalled or deleted, unlike a post. Call email_compose_preview first to see exactly what will be transmitted. At most 20 recipients across to, cc and bcc combined. Requires approval.",
    category: CATEGORY,
    execute: async (input: SendInput, context) => {
      const { raw, envelopeTo } = composeFor(config, input);
      try {
        const result = await config.provider.send({
          request: { raw, from: config.from, envelopeTo, subject: input.subject },
          context,
        });
        return {
          sent: true,
          ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
          recipients: result.recipientsAccepted,
          provider: config.provider.name,
          providerResponse: result.providerResponse,
          // Stated in the result as well as the description. A summary of what happened should not have to
          // infer that this is the irreversible one.
          recoverable: false,
          ...(config.provider.capabilities.deliveryStatus
            ? {}
            : {
                note:
                  `${config.provider.name} accepted the message for delivery. It does not report what happened ` +
                  "afterwards, so a bounce would not be visible to email_get_status.",
              }),
        };
      } catch (error) {
        // Never a partial success. Anything that is not an accepted send is a failure that says so.
        throw asPlatformError(error, config.provider.name);
      }
    },
  }),
  defineTool({
    name: "email_compose_preview",
    label: "Preview a message without sending",
    description:
      "Compose a message and return the exact bytes that email_send would transmit, **without sending it**. Use this before sending anything that matters: the encoded subject, the multipart structure and the bcc list are the parts that are hardest to check any other way.",
    category: CATEGORY,
    execute: async (input: SendInput, _context) => {
      const { raw, envelopeTo } = composeFor(config, input);
      return {
        // The same string the provider is handed. Not a rendering of it.
        raw,
        bytes: Buffer.byteLength(raw, "utf8"),
        envelopeRecipients: envelopeTo,
        recipientCount: envelopeTo.length,
        from: config.from,
        // Pulled back out of the composed message, so a caller sees the *encoded* form rather than what they
        // typed — which is the thing worth checking.
        encodedSubject: headerOf(raw, "Subject"),
        contentType: headerOf(raw, "Content-Type"),
        sent: false,
        note:
          config.provider.name === "smtp"
            ? "Bcc appears here so you can check it; it is stripped before transmission, because the SMTP envelope carries the recipients and the header would reveal the blind list."
            : "These are the exact bytes that would be transmitted.",
      };
    },
  }),
  defineTool({
    name: "email_get_status",
    label: "Check delivery status",
    description:
      "Ask what happened to a message this deployment sent, by its id. Not every provider can answer — SMTP has no notion of a message after it is handed on, and the tool says so rather than guessing.",
    category: CATEGORY,
    execute: async (input: { messageId: string }, context) => {
      if (typeof input.messageId !== "string" || input.messageId.trim() === "") {
        refuse("email_get_status needs the message id returned by email_send.");
      }
      /**
       * AC-8. An explicit refusal, not a default value.
       *
       * Returning `"sent"` here would be a fabricated answer to a question SMTP cannot answer: what happened
       * is that a relay accepted the message, and it may have bounced thirty seconds later. A caller reading
       * `"sent"` would believe delivery was confirmed.
       */
      if (!config.provider.capabilities.deliveryStatus || config.provider.getStatus === undefined) {
        return {
          messageId: input.messageId,
          status: "unknown" as const,
          supported: false,
          reason:
            `${config.provider.name} does not report delivery status. SMTP hands a message to the next hop and ` +
            "the conversation ends — there is no message to ask about afterwards, and a bounce arrives later " +
            "as mail to the envelope sender. Check that mailbox, or configure an HTTP provider that tracks " +
            "delivery.",
        };
      }
      try {
        const status = await config.provider.getStatus({ messageId: input.messageId.trim(), context });
        return { ...status, supported: true, provider: config.provider.name };
      } catch (error) {
        throw asPlatformError(error, config.provider.name);
      }
    },
  }),
  defineTool({
    name: "email_list_sent",
    label: "List sent messages",
    description:
      "List messages this deployment has recently sent, where the provider keeps a record. SMTP does not, and the tool says so rather than returning an empty list that would read as 'nothing was sent'.",
    category: CATEGORY,
    execute: async (input: { limit?: number }, context) => {
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), 100);
      if (!config.provider.capabilities.listSent || config.provider.listSent === undefined) {
        return {
          messages: [],
          supported: false,
          // An empty list without this reads as "nothing has been sent", which is a different and wrong answer.
          reason: `${config.provider.name} keeps no record of sent messages. This is not an empty mailbox — it is a provider that cannot answer the question.`,
        };
      }
      try {
        const messages = await config.provider.listSent({ limit, context });
        return { messages, supported: true, count: messages.length, provider: config.provider.name };
      } catch (error) {
        throw asPlatformError(error, config.provider.name);
      }
    },
  }),
];
