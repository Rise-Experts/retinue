/**
 * A deployment's own mail — REQ-056 (#240), task #241.
 *
 * After #234 an agent can send mail, but only as a Google Workspace end user, after an OAuth consent and — for
 * restricted scopes — Google's app verification. That is the wrong shape for the ordinary case: a deployment
 * sending its *own* transactional mail, from its own domain, with no user grant at all.
 *
 * The smallest package in the sprint, and the one with the least recoverable single action in it. A sent
 * message cannot be recalled; unlike a post it cannot even be deleted afterwards. So there is one gated send,
 * and a preview that produces **byte-identical** output to it — a rehearsal of a different message would be
 * worse than none.
 *
 * ## What this does not do
 *
 * No lists, no campaigns, no unsubscribe handling, no suppression, no inbound processing. The recipient cap is
 * twenty across to, cc and bcc combined, and it is low on purpose: the moment this can address a hundred
 * people it is a campaign tool with none of a campaign tool's safeguards.
 */

import type { Tool, ToolProvider } from "@retinue/agentkit/tools";

import { emailTools, type EmailToolsConfig } from "./tools.js";
import type { EmailProvider } from "./provider.js";

export { emailTools, composeFor, checkedAddress, MAX_RECIPIENTS, MAX_ATTACHMENT_BYTES, MAX_SUBJECT_LENGTH } from "./tools.js";
export type { EmailToolsConfig, SendInput } from "./tools.js";
export { httpProvider, smtpProvider, asPlatformError } from "./providers.js";
export type { HttpProviderConfig, SmtpProviderConfig } from "./providers.js";
export { dotStuff, smtpSend, SmtpError } from "./smtp.js";
export type { SmtpConfig, SmtpDialer, SmtpSendInput, SmtpSendResult } from "./smtp.js";
export { SEND_RESULT_KEYS } from "./provider.js";
export type {
  DeliveryStatus,
  EmailProvider,
  ProviderCapabilities,
  SendRequest,
  SendResult,
  SentMessage,
} from "./provider.js";

export type EmailToolkitConfig = {
  /** SMTP or an HTTP API. Required — there is no default, because the sender's domain is a deployment fact. */
  readonly provider: EmailProvider;
  /**
   * The `From` address. Configuration, and never a tool argument.
   *
   * A model that could choose the sender could send as anyone the domain permits. It is also the field SPF and
   * DKIM align against, so a caller-supplied one is the fastest route to mail that silently lands in spam.
   */
  readonly from: string;
  readonly replyTo?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};

export const select = (
  all: readonly Tool[],
  config: Pick<EmailToolkitConfig, "include" | "exclude">,
): readonly Tool[] => {
  if (config.include !== undefined && config.exclude !== undefined) {
    throw new Error(
      "createEmailToolkit was given both include and exclude. Pick one: include names what ships, exclude names what does not.",
    );
  }
  const known = new Set(all.map((tool) => tool.descriptor.name));
  const requested = config.include ?? config.exclude ?? [];
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `createEmailToolkit was given ${config.include === undefined ? "exclude" : "include"} names this toolkit ` +
        `does not have: ${unknown.join(", ")}. It has: ${[...known].join(", ")}.`,
    );
  }
  if (config.include !== undefined) {
    const wanted = new Set(config.include);
    return all.filter((tool) => wanted.has(tool.descriptor.name));
  }
  if (config.exclude !== undefined) {
    const unwanted = new Set(config.exclude);
    return all.filter((tool) => !unwanted.has(tool.descriptor.name));
  }
  return all;
};

export const createEmailToolkit = (config: EmailToolkitConfig): ToolProvider => {
  const toolConfig: EmailToolsConfig = {
    provider: config.provider,
    from: config.from,
    ...(config.replyTo === undefined ? {} : { replyTo: config.replyTo }),
  };
  const tools = select(emailTools(toolConfig), config);
  return {
    id: "email",
    async listTools() {
      return tools;
    },
  };
};

/**
 * The one tool that is not a read — AC-2.
 *
 * Exported so the exact-list test is *exact*: every tool not named here must be `read`. A second sending tool
 * added later without touching this constant fails the test, which is the only thing that keeps a package with
 * an unrecallable action from acquiring a second one by omission.
 */
export const EMAIL_GATED: Readonly<Record<string, "external-write">> = {
  email_send: "external-write",
};

/**
 * What this accepts — #260 AC-2.
 *
 * SMTP takes a `basic` credential (username and password); an HTTP provider takes a `bearer`. Both are
 * deployment credentials rather than per-user grants, which is the entire point of the package — no consent
 * flow, no verification, no end user.
 */
export const EMAIL_AUTH = { modes: ["token"] as const, schemes: ["basic", "bearer"] as const };

export const EMAIL_TOOL_NAMES = [
  "email_send",
  "email_compose_preview",
  "email_get_status",
  "email_list_sent",
] as const;
