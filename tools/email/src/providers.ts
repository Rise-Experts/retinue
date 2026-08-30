/**
 * The two providers — REQ-056 (#240), task #241, AC-1, AC-6, AC-9.
 *
 * SMTP and an HTTP API, behind the one contract in `provider.ts`. Both resolve their credential **per call**
 * through the resolver, so neither reads the environment and a rotated secret takes effect without a restart.
 * AC-9 asserts the first half by scanning this package's source for `process.env`; the second is a property of
 * asking the resolver inside `send` rather than at construction.
 */

import { credentialMissing, type Credential, type CredentialRef, type CredentialResolver } from "@retinue/agentkit/tools";
import { stripBcc } from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

import { smtpSend, SmtpError, type SmtpConfig, type SmtpDialer } from "./smtp.js";
import type { DeliveryStatus, EmailProvider, SendResult, SentMessage } from "./provider.js";

export type SmtpProviderConfig = SmtpConfig & {
  /** Resolved per call. A `basic` credential: username and password. */
  readonly credentialRef?: CredentialRef;
  readonly resolver?: CredentialResolver;
  /** Injected by the tests, which run against an in-process sink. */
  readonly dialer?: SmtpDialer;
};

/**
 * SMTP.
 *
 * `deliveryStatus` and `listSent` are **false**, and that is the honest answer rather than a gap. The protocol
 * hands a message to the next hop and the conversation ends; there is no message to ask about afterwards. A
 * provider that claimed otherwise would be reporting a relay's acceptance as a delivery.
 */
export const smtpProvider = (config: SmtpProviderConfig): EmailProvider => ({
  name: "smtp",
  capabilities: { deliveryStatus: false, listSent: false },
  async send({ request, context }) {
    let username: string | undefined;
    let password: string | undefined;
    if (config.credentialRef !== undefined && config.resolver !== undefined) {
      const credential: Credential = await config.resolver.resolve({ ref: config.credentialRef, context });
      if (credential.scheme !== "basic") {
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            `SMTP needs a username and a password, so credential "${config.credentialRef}" must be a basic ` +
            `credential; it is ${credential.scheme}.`,
          retryable: false,
        });
      }
      username = credential.username;
      password = credential.password;
      if (username === "" || password === "") throw credentialMissing(config.credentialRef);
    }

    /**
     * `Bcc` is stripped here and nowhere else.
     *
     * The envelope already carries every recipient, so the header adds nothing except the ability for each
     * blind recipient to read the whole blind list. The composed message keeps it so a preview can show who is
     * on the mail; this is the one place it must not travel.
     */
    const raw = stripBcc(request.raw);

    try {
      const result = await smtpSend(
        config,
        {
          from: request.from,
          to: request.envelopeTo,
          raw,
          ...(username === undefined ? {} : { username }),
          ...(password === undefined ? {} : { password }),
        },
        config.dialer,
      );
      return {
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
        providerResponse: `${result.code} ${result.reply}`,
        recipientsAccepted: result.recipientsAccepted,
      } satisfies SendResult;
    } catch (error) {
      throw asPlatformError(error, "smtp");
    }
  },
});

/**
 * Turns a provider failure into the platform's vocabulary — AC-5 of the parent, AC-6 here.
 *
 * The distinction that matters is `retryable`, and it is not cosmetic. A 4xx is a server saying "not now" —
 * greylisting is *designed* around a real sender trying again — while a 5xx is "no", and retrying it hammers a
 * server that has already refused and damages the sender's reputation with it.
 */
export const asPlatformError = (error: unknown, provider: string): AgentPlatformError => {
  if (error instanceof AgentPlatformError) return error;
  if (error instanceof SmtpError) {
    return new AgentPlatformError({
      code: error.retryable ? "provider_unavailable" : "provider_error",
      message:
        `The message was NOT sent. ${error.message}` +
        (error.retryable
          ? " This is a temporary refusal — trying again later is the right response."
          : " This is a permanent rejection; trying again will not help and may harm the sending domain's reputation."),
      retryable: error.retryable,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AgentPlatformError({
    code: "provider_unavailable",
    message: `The message was NOT sent. ${provider} could not be reached: ${message}`,
    retryable: true,
  });
};

export type HttpProviderConfig = {
  readonly name: string;
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * A Resend/Postmark/SES-shaped HTTP API.
 *
 * Modelled on Resend, which is the simplest of the three and the one whose shape the others resemble: a POST
 * that takes the message, and a GET that reports what happened to it.
 *
 * It sends the **composed MIME** rather than structured fields, and that is deliberate. Sending `{to, subject,
 * html}` would mean the provider composes the message, which makes `email_compose_preview` a rehearsal of
 * something nobody transmits — the preview would show our MIME and the recipient would receive theirs. AC-3
 * asks for byte-identical, and this is what makes it true for both providers rather than only for SMTP.
 */
export const httpProvider = (config: HttpProviderConfig): EmailProvider => {
  const base = (config.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
  const send = config.fetchImpl ?? fetch;

  const authorised = async (context: Parameters<EmailProvider["send"]>[0]["context"]): Promise<string> => {
    const credential = await config.resolver.resolve({ ref: config.credentialRef, context });
    if (credential.scheme !== "bearer") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `${config.name} needs a bearer token; credential "${config.credentialRef}" is ${credential.scheme}.`,
        retryable: false,
      });
    }
    return credential.token;
  };

  const failed = async (response: Response, what: string): Promise<never> => {
    const body = await response.text();
    /**
     * The same 4xx/5xx split as SMTP, with `429` called out.
     *
     * A rate limit is the HTTP equivalent of greylisting: the server will accept this message, just not yet.
     * `4xx` otherwise means the request was wrong — a bad address, an unverified domain — and no amount of
     * retrying fixes either.
     */
    const retryable = response.status === 429 || response.status >= 500;
    throw new AgentPlatformError({
      code: retryable ? "provider_unavailable" : "provider_error",
      message:
        `The message was NOT sent. ${config.name} refused ${what} with ${response.status}: ${body.slice(0, 300)}` +
        (retryable ? " Trying again later is the right response." : " Trying again will not help."),
      retryable,
    });
  };

  return {
    name: config.name,
    capabilities: { deliveryStatus: true, listSent: true },
    async send({ request, context }) {
      const token = await authorised(context);
      let response: Response;
      try {
        response = await send(`${base}/emails`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          // The composed MIME, so the preview and the send are the same bytes — see the note above.
          body: JSON.stringify({ raw: Buffer.from(request.raw, "utf8").toString("base64"), from: request.from, to: request.envelopeTo }),
        });
      } catch (error) {
        throw asPlatformError(error, config.name);
      }
      if (!response.ok) await failed(response, "the send");
      const payload = record(await response.json().catch(() => ({})));
      const id = str(payload.id) || str(record(payload.data).id);
      return {
        ...(id === "" ? {} : { messageId: id }),
        providerResponse: `${response.status} ${config.name} accepted the message`,
        recipientsAccepted: request.envelopeTo,
      } satisfies SendResult;
    },
    async getStatus({ messageId, context }) {
      const token = await authorised(context);
      const response = await send(`${base}/emails/${encodeURIComponent(messageId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) await failed(response, "the status request");
      const payload = record(await response.json().catch(() => ({})));
      const raw = str(payload.last_event) || str(payload.status);
      const known = ["queued", "sent", "delivered", "bounced", "complained"] as const;
      const status = (known as readonly string[]).includes(raw) ? (raw as DeliveryStatus["status"]) : "unknown";
      return {
        messageId,
        status,
        ...(raw === "" ? {} : { detail: raw }),
        ...(str(payload.created_at) === "" ? {} : { at: str(payload.created_at) }),
      };
    },
    async listSent({ limit, context }) {
      const token = await authorised(context);
      const response = await send(`${base}/emails?limit=${limit}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) await failed(response, "the list request");
      const payload = record(await response.json().catch(() => ({})));
      const rows = Array.isArray(payload.data) ? payload.data : [];
      return rows.map((row): SentMessage => {
        const entry = record(row);
        return {
          messageId: str(entry.id),
          to: Array.isArray(entry.to) ? entry.to.map(str) : [],
          subject: str(entry.subject),
          ...(str(entry.created_at) === "" ? {} : { at: str(entry.created_at) }),
          ...(str(entry.last_event) === "" ? {} : { status: str(entry.last_event) }),
        };
      });
    },
  };
};
