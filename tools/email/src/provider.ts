/**
 * One send contract, two providers — REQ-056 (#240), task #241, AC-1 and AC-7.
 *
 * The rule `tools-search` and `tools-scrape` already follow: a provider is a **value of a parameter**, not a
 * set of tools. A model offered `smtp_send` and `resend_send` would be choosing a vendor, which is a
 * deployment's decision about cost, deliverability and where the operator's DNS records point.
 *
 * ## Capability differences are reported, never simulated
 *
 * This is the part worth being careful about. SMTP has no notion of "delivery status for a message id" — the
 * protocol hands the message to the next hop and the conversation ends. An HTTP API usually does.
 *
 * The tempting thing is to make `email_get_status` return `"sent"` under SMTP so the shape matches. That is a
 * fabricated answer to a question the provider cannot answer, and it is worse than no answer: a caller reading
 * `"sent"` believes delivery was confirmed when what actually happened is that a relay accepted the message
 * and may have bounced it thirty seconds later.
 *
 * So the contract carries `capabilities`, and a tool asked for something the provider cannot do says so. AC-8
 * is exactly this, and it is the reason the field exists rather than a boolean per tool.
 */

import type { ExecutionContext } from "@retinue/agentkit";

export type SendRequest = {
  /** The composed RFC 5322 message. Identical bytes to what a preview shows. */
  readonly raw: string;
  readonly from: string;
  /** Every envelope recipient — to, cc and bcc combined. SMTP needs them all; the header does not carry bcc. */
  readonly envelopeTo: readonly string[];
  readonly subject: string;
};

export type SendResult = {
  /** A provider's own id when it gives one. SMTP servers usually put a queue id in the reply. */
  readonly messageId?: string;
  /** What the provider actually said, so a person debugging can read it. */
  readonly providerResponse: string;
  readonly recipientsAccepted: readonly string[];
};

export type DeliveryStatus = {
  readonly messageId: string;
  /** `unknown` when the provider does not report — never a fabricated `sent`. */
  readonly status: "queued" | "sent" | "delivered" | "bounced" | "complained" | "unknown";
  readonly detail?: string;
  readonly at?: string;
};

export type SentMessage = {
  readonly messageId: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly at?: string;
  readonly status?: string;
};

/**
 * What a provider can do beyond sending.
 *
 * Declared rather than discovered, so a tool can refuse clearly instead of calling and interpreting a 404.
 */
export type ProviderCapabilities = {
  readonly deliveryStatus: boolean;
  readonly listSent: boolean;
};

export interface EmailProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  send(input: { readonly request: SendRequest; readonly context: ExecutionContext }): Promise<SendResult>;
  getStatus?(input: { readonly messageId: string; readonly context: ExecutionContext }): Promise<DeliveryStatus>;
  listSent?(input: { readonly limit: number; readonly context: ExecutionContext }): Promise<readonly SentMessage[]>;
}

/** Every key a send result carries, asserted in the tests so two providers cannot drift apart. */
export const SEND_RESULT_KEYS = ["messageId", "providerResponse", "recipientsAccepted"] as const;
