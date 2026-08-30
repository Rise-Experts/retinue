/**
 * RFC 5322 messages, built once for every toolkit that sends mail — REQ-056 (#240), task #241.
 *
 * This started in `tools-google` for Gmail (#234) and moved here when `tools-email` needed the same thing. The
 * reason is the one that moved `ssrf.ts`: the parts that are silent when wrong must have exactly one
 * implementation, because a second copy is the one that ends up not encoding a header.
 *
 * Three things here are wrong *silently*, which is why they are here rather than per package:
 *
 * **A non-ASCII subject.** Headers are ASCII by the spec. Putting an umlaut in one raw does not throw — it
 * arrives as mojibake and nobody tells you.
 *
 * **A header carrying a line break.** A subject of `Update` + CRLF + `Bcc: attacker@example.com` is two
 * headers, and the second silently copies the message to somebody. Reachable from untrusted content: an agent
 * composing a subject from a page it scraped or a mail it read is exactly the path.
 *
 * **Part ordering in `multipart/alternative`.** The spec orders parts least-faithful first, so `text/plain`
 * precedes `text/html`. Reversed, a client showing the *last* part it understands displays the plain-text
 * fallback and the HTML is never seen — mail that looks broken to the recipient and fine to the sender.
 *
 * ## Determinism, and why there is no `Date` or `Message-ID`
 *
 * `email_compose_preview` has to produce **byte-identical** output to what a send transmits, or the rehearsal
 * is of a different message. A `Date` stamped at compose time makes that impossible by construction, and a
 * `Message-ID` generated per call makes it impossible too. Both are added by the sending MTA or the provider's
 * API, which is where they belong — they describe the act of sending, not the message the caller wrote. The
 * multipart boundary is derived from a hash of the content for the same reason: a random boundary would make
 * two composes of the same message differ.
 */

import { createHash } from "node:crypto";

/** A header value, RFC 2047 encoded when it needs to be — and left alone when it does not. */
export const encodeHeader = (value: string): string => {
  // Only when needed: an ASCII subject must stay readable in the raw message, because half of debugging mail
  // is reading it with your eyes. An encoded-word on everything would be correct and unreadable.
  if (!/[^ -~]/.test(value)) return value;

  // 75 is the RFC limit for an encoded-word *including* its wrapper, so the payload budget is smaller; base64
  // expands by 4/3, hence a multiple of 3.
  const budget = 45;
  const bytes = Buffer.from(value, "utf8");
  const words: string[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    // Never split a multi-byte character across two encoded-words: each word must decode on its own.
    let take = Math.min(budget, bytes.length - offset);
    while (take > 0 && offset + take < bytes.length && (bytes[offset + take]! & 0xc0) === 0x80) take -= 1;
    if (take === 0) take = Math.min(budget, bytes.length - offset);
    words.push(`=?UTF-8?B?${bytes.subarray(offset, offset + take).toString("base64")}?=`);
    offset += take;
  }
  // Folded with a space between words, which is how a decoder is told they are one value.
  return words.join(" ");
};

export class HeaderInjectionError extends Error {}

/**
 * Refuses a header value that would inject another header.
 *
 * Refusing rather than stripping: no legitimate subject or address contains a newline, so nothing correct is
 * lost, and silently removing it would hide an attempt somebody should see.
 */
export const assertHeaderSafe = (field: string, value: string): void => {
  if (/[\r\n]/.test(value)) {
    throw new HeaderInjectionError(
      `The ${field} contains a line break, which would inject a new mail header. Refused rather than sent — ` +
        "this is how a Bcc gets added to a message nobody meant to copy.",
    );
  }
};

export type Attachment = {
  readonly filename: string;
  readonly contentType: string;
  /** Base64. The caller encodes, because the bytes may never have been a string. */
  readonly contentBase64: string;
};

export type OutgoingMessage = {
  readonly to: readonly string[];
  readonly subject: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly from?: string;
  readonly replyTo?: string;
  /** Plain text. At least one of `text` and `html` is required. */
  readonly text?: string;
  readonly html?: string;
  /**
   * The single-body form, kept because `tools-google` was written against it.
   *
   * Equivalent to `text`. Both exist rather than one being renamed, so moving this module did not change the
   * bytes any existing caller produces — which is the property that made the move safe to make.
   */
  readonly body?: string;
  readonly attachments?: readonly Attachment[];
  /** The `Message-ID` of the message being replied to. Both threading headers derive from it. */
  readonly inReplyTo?: string;
  /** The original's `References`, so a long thread keeps its whole chain rather than just the last hop. */
  readonly references?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

const CRLF = "\r\n";

/** Base64, folded at 76 characters — an unfolded base64 body is non-conformant and some servers reject it. */
const foldedBase64 = (value: string): string => {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join(CRLF) ?? "";
};

/**
 * A boundary that depends only on the message.
 *
 * Deterministic so `email_compose_preview` and `email_send` produce the same bytes, and content-derived so two
 * different messages do not share one. The loop rules out the remaining case where the chosen boundary appears
 * inside a part — astronomically unlikely with a hash, and cheaper to exclude than to reason about.
 */
export const boundaryFor = (parts: readonly string[]): string => {
  const digest = createHash("sha256").update(parts.join(" "), "utf8").digest("hex");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `=_retinue_${digest.slice(attempt * 4, attempt * 4 + 32)}`;
    if (!parts.some((part) => part.includes(candidate))) return candidate;
  }
  return `=_retinue_${digest}`;
};

const renderPart = (headers: readonly string[], content: string): string =>
  `${headers.join(CRLF)}${CRLF}${CRLF}${content}`;

const textPart = (text: string): string =>
  renderPart(['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"], foldedBase64(text));

const htmlPart = (html: string): string =>
  renderPart(['Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64"], foldedBase64(html));

const attachmentPart = (attachment: Attachment): string => {
  assertHeaderSafe("attachment filename", attachment.filename);
  assertHeaderSafe("attachment content type", attachment.contentType);
  return renderPart(
    [
      `Content-Type: ${attachment.contentType}; name="${encodeHeader(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodeHeader(attachment.filename)}"`,
    ],
    attachment.contentBase64.replace(/\s+/g, "").match(/.{1,76}/g)?.join(CRLF) ?? "",
  );
};

const multipart = (subtype: string, parts: readonly string[]): { contentType: string; body: string } => {
  const boundary = boundaryFor(parts);
  return {
    contentType: `multipart/${subtype}; boundary="${boundary}"`,
    body: [
      // A preamble, for clients that show nothing when they cannot parse the structure. Never displayed by one
      // that can.
      "This is a message in MIME format.",
      ...parts.map((body) => `--${boundary}${CRLF}${body}`),
      `--${boundary}--`,
      "",
    ].join(CRLF),
  };
};

/** Splits a rendered part into its header lines and its content. */
const splitPart = (rendered: string): [string[], string] => {
  const separator = rendered.indexOf(`${CRLF}${CRLF}`);
  if (separator === -1) return [[], rendered];
  return [rendered.slice(0, separator).split(CRLF), rendered.slice(separator + 4)];
};

/**
 * An RFC 5322 message.
 *
 * CRLF line endings, not bare newlines: the spec says CRLF and some servers are strict. Getting it wrong
 * produces a message that works with most providers and is rejected by one, which is the worst kind of bug to
 * find in production.
 */
export const buildMessage = (message: OutgoingMessage): string => {
  const text = message.text ?? message.body;
  const hasText = text !== undefined && text !== "";
  const hasHtml = message.html !== undefined && message.html !== "";
  if (!hasText && !hasHtml) {
    throw new Error("A message needs a text body, an HTML body, or both.");
  }

  // Every header value, before any of them is written.
  for (const [field, value] of [
    ["subject", message.subject],
    ["from", message.from ?? ""],
    ["reply-to", message.replyTo ?? ""],
    ...message.to.map((address) => ["recipient", address] as const),
    ...(message.cc ?? []).map((address) => ["cc recipient", address] as const),
    ...(message.bcc ?? []).map((address) => ["bcc recipient", address] as const),
    ...Object.entries(message.headers ?? {}).map(([name, value]) => [`${name} header`, value] as const),
  ] as readonly (readonly [string, string])[]) {
    assertHeaderSafe(field, value);
  }

  const headers: string[] = [];
  if (message.from !== undefined) headers.push(`From: ${message.from}`);
  headers.push(`To: ${message.to.join(", ")}`);
  if (message.cc !== undefined && message.cc.length > 0) headers.push(`Cc: ${message.cc.join(", ")}`);
  /**
   * `Bcc` **is** written into the message this function returns.
   *
   * Correct for an API that takes a composed message and reads the recipients out of it, and wrong for SMTP,
   * where the envelope carries the recipients and a `Bcc` header would show every blind recipient to all of
   * them. The SMTP transport strips it — see `stripBcc` — rather than this function guessing which kind of
   * caller it has. A preview shows it, because somebody inspecting a rehearsal should see who is on it.
   */
  if (message.bcc !== undefined && message.bcc.length > 0) headers.push(`Bcc: ${message.bcc.join(", ")}`);
  if (message.replyTo !== undefined) headers.push(`Reply-To: ${message.replyTo}`);
  headers.push(`Subject: ${encodeHeader(message.subject)}`);

  /**
   * Both threading headers, from the original's `Message-ID`.
   *
   * `In-Reply-To` is what most clients thread on and `References` is what the rest use, so sending one without
   * the other threads correctly in some inboxes and starts a new conversation in others.
   */
  if (message.inReplyTo !== undefined) {
    headers.push(`In-Reply-To: ${message.inReplyTo}`);
    const chain =
      message.references === undefined || message.references.trim() === ""
        ? message.inReplyTo
        : `${message.references.trim()} ${message.inReplyTo}`;
    headers.push(`References: ${chain}`);
  }
  for (const [name, value] of Object.entries(message.headers ?? {})) headers.push(`${name}: ${encodeHeader(value)}`);

  headers.push("MIME-Version: 1.0");

  const bodyParts: string[] = [];
  if (hasText) bodyParts.push(textPart(text as string));
  // Plain text first. The spec orders parts least-faithful first, and a client showing the last part it
  // understands would otherwise display the fallback and never the HTML.
  if (hasHtml) bodyParts.push(htmlPart(message.html as string));

  const attachments = message.attachments ?? [];

  if (bodyParts.length === 1 && attachments.length === 0) {
    // The single-body case, byte-identical to what this produced before multipart existed.
    const [partHeaders, content] = splitPart(bodyParts[0] as string);
    return `${[...headers, ...partHeaders].join(CRLF)}${CRLF}${CRLF}${content}`;
  }

  const alternative = bodyParts.length > 1 ? multipart("alternative", bodyParts) : undefined;
  const bodySection =
    alternative === undefined
      ? (bodyParts[0] as string)
      : renderPart([`Content-Type: ${alternative.contentType}`], alternative.body);

  if (attachments.length === 0) {
    const only = alternative as { contentType: string; body: string };
    return `${headers.join(CRLF)}${CRLF}Content-Type: ${only.contentType}${CRLF}${CRLF}${only.body}`;
  }

  const mixed = multipart("mixed", [bodySection, ...attachments.map(attachmentPart)]);
  return `${headers.join(CRLF)}${CRLF}Content-Type: ${mixed.contentType}${CRLF}${CRLF}${mixed.body}`;
};

/**
 * Removes the `Bcc` header from a composed message.
 *
 * For SMTP the envelope carries every recipient and the header must not, or each blind recipient can read the
 * whole blind list — the single most embarrassing mail bug there is. The header is kept in the composed form
 * so a preview can show it, and stripped at the transport that would otherwise leak it.
 */
export const stripBcc = (raw: string): string => {
  const separator = raw.indexOf(`${CRLF}${CRLF}`);
  if (separator === -1) return raw;
  const kept = raw
    .slice(0, separator)
    .split(CRLF)
    .filter((line) => !/^bcc:/i.test(line));
  return `${kept.join(CRLF)}${raw.slice(separator)}`;
};

/** The value of a header in a composed message, for tests and for reading a provider's echo. */
export const headerOf = (raw: string, name: string): string | undefined => {
  const separator = raw.indexOf(`${CRLF}${CRLF}`);
  const head = separator === -1 ? raw : raw.slice(0, separator);
  const match = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head);
  return match?.[1]?.trim();
};
