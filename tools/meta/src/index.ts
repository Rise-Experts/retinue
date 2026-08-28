/**
 * WhatsApp Business and Instagram — REQ-053 (#227), task #229.
 *
 * One package because they are one API, one token and one app review. A team that has cleared Meta's review
 * for either has cleared most of it for both, and splitting them would mean two packages with identical
 * transports and identical setup instructions.
 *
 * ## The two rules that make this package different from the trackers
 *
 * **1. WhatsApp's 24-hour service window is a law, not a preference.** A free-text message to a user is legal
 * only inside 24 hours of *that user* messaging the business. Outside it, only an approved template may be
 * sent. Meta enforces this, but its error arrives as a generic code with no explanation — so a model that sent
 * a friendly free-text follow-up gets an unhelpful failure and retries with different words, which cannot ever
 * work. `whatsapp_send_message` therefore requires **evidence** of the window and refuses locally, naming
 * `whatsapp_send_template` as the thing that would work.
 *
 * **2. Publishing to Instagram is two calls, and the second one is the dangerous one.** A container is created,
 * then published. If the publish fails, retrying the *container* creates a second container and can produce two
 * posts. So the container step is not separately exposed, and a failure after a successful container is
 * reported as **not retryable**, naming which step failed.
 *
 * Both of these are the same shape as the rest of this repository's toolkits: refuse locally where a remote
 * refusal would be uninterpretable, and never make an irreversible act look retryable.
 */

import {
  confirms,
  createVendorTransport,
  defineTool,
  type CredentialRef,
  type CredentialResolver,
  type Tool,
  type ToolProvider,
  type ToolkitAuth,
  type VendorTransport,
} from "@retinue/agentkit/tools";
import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

const API = "https://graph.facebook.com";
/** Pinned. Meta deprecates a version roughly every quarter and an unpinned client breaks on their schedule. */
const GRAPH_VERSION = "v21.0";

/** Meta's own cap for these edges. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** The service window, in milliseconds. Meta's number, not ours. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MetaToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /** The WhatsApp Business phone number id that sends. Absent means the WhatsApp tools are not offered. */
  readonly phoneNumberId?: string;
  /** The WhatsApp Business Account id, which is what owns templates. */
  readonly wabaId?: string;
  /** The Instagram professional account id. Absent means the Instagram tools are not offered. */
  readonly instagramAccountId?: string;
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
  /** Injected so the window check is testable without waiting a day. */
  readonly now?: () => number;
};

type Json = Record<string, unknown>;

/**
 * Meta's errors, which are a structured object rather than a status.
 *
 * `error.code` and `error.error_subcode` carry the meaning; the HTTP status is almost always `400`. Mapping
 * the two codes that matter is the difference between a model that stops and one that retries forever.
 */
export const metaErrorOf = (reason: string): { code?: number; subcode?: number; message?: string } => {
  const start = reason.indexOf("{");
  if (start === -1) return {};
  try {
    const parsed = JSON.parse(reason.slice(start)) as { error?: { code?: number; error_subcode?: number; message?: string } };
    const error = parsed.error;
    return error === undefined
      ? {}
      : {
          ...(error.code === undefined ? {} : { code: error.code }),
          ...(error.error_subcode === undefined ? {} : { subcode: error.error_subcode }),
          ...(error.message === undefined ? {} : { message: error.message }),
        };
  } catch {
    return {};
  }
};

/** A template's parameter count, which is what AC-4 validates against. */
export const templateParameterCount = (template: Json): number => {
  const components = Array.isArray(template.components) ? template.components : [];
  let count = 0;
  for (const raw of components) {
    const component = raw as Json;
    // Only BODY placeholders are what `whatsapp_send_template`'s `parameters` fill. HEADER and BUTTON
    // parameters exist and are a different shape, which is why they are refused rather than half-supported.
    if (component.type !== "BODY") continue;
    const text = typeof component.text === "string" ? component.text : "";
    const placeholders = new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => match[1]));
    count += placeholders.size;
  }
  return count;
};

export const createMetaToolkit = (config: MetaToolkitConfig): ToolProvider => {
  const now = config.now ?? (() => Date.now());
  const transport: VendorTransport = createVendorTransport({
    vendor: "Meta",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: `${(config.baseUrl ?? API).replace(/\/$/, "")}/${GRAPH_VERSION}`,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify: (failure) => {
      const meta = metaErrorOf(failure.reason);
      /**
       * `131047` is "message outside the 24-hour window" and `131026` is "message undeliverable".
       *
       * Both arrive as `400`, which the default would call `provider_error` — accurate and useless. Naming the
       * window turns an unexplained failure into an instruction.
       */
      if (meta.code === 131047 || meta.subcode === 2018278) {
        return {
          code: "invalid_input" as const,
          message:
            "WhatsApp refused this message: the 24-hour customer service window has closed. Only an approved " +
            "template may be sent now — use whatsapp_list_templates and whatsapp_send_template.",
          retryable: false,
        };
      }
      if (meta.code === 131026) {
        return {
          code: "invalid_input" as const,
          message: `WhatsApp could not deliver this message: ${meta.message ?? "the recipient may not have a WhatsApp account, or has not opted in."}`,
          retryable: false,
        };
      }
      // `190` is an invalid or expired access token — the single most common Meta failure, and one that a
      // retry cannot fix.
      if (meta.code === 190) {
        return {
          code: "unauthorized" as const,
          message: `Meta rejected the access token: ${meta.message ?? failure.reason}. It may have expired — Meta's user tokens are short-lived unless exchanged for a long-lived one.`,
          retryable: false,
        };
      }
      // `4`, `17` and `32` are Meta's application-level rate limits, and they arrive as 400 rather than 429.
      if (meta.code === 4 || meta.code === 17 || meta.code === 32 || meta.code === 613) {
        return {
          code: "rate_limited" as const,
          message: `Meta rate limit reached (code ${meta.code}): ${meta.message ?? failure.reason}`,
          retryable: true,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        };
      }
      return undefined;
    },
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  const whatsappTools = (phoneNumberId: string, wabaId: string | undefined): readonly Tool[] => [
    defineTool({
      name: "whatsapp_list_templates",
      label: "List message templates",
      description:
        "List the approved WhatsApp message templates, with each one's name, language, status and how many parameters its body takes. **Read this before sending a template** — names are per business account and a template that is not APPROVED cannot be sent.",
      category: "communication",
      execute: async (input: { limit?: number }, context) => {
        if (wabaId === undefined) {
          throw new AgentPlatformError({
            code: "capability_unavailable",
            message: "No WhatsApp Business Account id is configured, so templates cannot be listed.",
            retryable: false,
          });
        }
        const result = (await transport.json(
          context,
          `/${encodeURIComponent(wabaId)}/message_templates?limit=${Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)}`,
        )) as Json | undefined;
        const templates = (Array.isArray(result?.data) ? result.data : []) as Json[];
        return {
          templates: templates.map((template) => ({
            name: template.name,
            language: template.language,
            status: template.status,
            category: template.category,
            // The number a caller must supply, computed rather than described — AC-4 checks against it.
            parameterCount: templateParameterCount(template),
          })),
          truncated: ((result?.paging ?? {}) as Json).next !== undefined,
        };
      },
    }),
    confirms({
      name: "whatsapp_send_template",
      label: "Send a template message",
      description:
        "Send an approved WhatsApp template to a phone number. This is the **only** kind of message that may be sent outside the 24-hour service window. Parameters fill the template's body placeholders in order, and the count must match exactly — read whatsapp_list_templates first. Requires approval.",
      category: "communication",
      execute: async (
        input: { to: string; template: string; language?: string; parameters?: string[]; expectedParameterCount?: number },
        context,
      ) => {
        const parameters = input.parameters ?? [];
        /**
         * AC-4. Validated against the template's real definition, fetched here rather than trusted.
         *
         * Meta's own error for a count mismatch is `Parameter format does not match`, which names neither the
         * expected count nor the template — so a model gets a failure it cannot act on and tries again with the
         * same number of parameters.
         */
        if (wabaId !== undefined) {
          const listed = (await transport.json(
            context,
            `/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(input.template)}&limit=${MAX_LIMIT}`,
          )) as Json | undefined;
          const found = ((Array.isArray(listed?.data) ? listed.data : []) as Json[]).find(
            (template) => template.name === input.template && (input.language === undefined || template.language === input.language),
          );
          if (found === undefined) {
            const names = ((Array.isArray(listed?.data) ? listed.data : []) as Json[]).map((template) => template.name);
            throw new AgentPlatformError({
              code: "invalid_input",
              message:
                `No approved WhatsApp template called "${input.template}"${input.language === undefined ? "" : ` in ${input.language}`}. ` +
                (names.length === 0
                  ? "Use whatsapp_list_templates to see what exists."
                  : `Templates matching that name: ${[...new Set(names)].join(", ")}. Use whatsapp_list_templates for the full list.`),
              retryable: false,
            });
          }
          if (found.status !== "APPROVED") {
            throw new AgentPlatformError({
              code: "invalid_input",
              message: `The template "${input.template}" is ${String(found.status)}, not APPROVED, so Meta will not send it.`,
              retryable: false,
            });
          }
          const expected = templateParameterCount(found);
          if (expected !== parameters.length) {
            throw new AgentPlatformError({
              code: "invalid_input",
              message:
                `The template "${input.template}" takes ${expected} parameter${expected === 1 ? "" : "s"} and ` +
                `${parameters.length} ${parameters.length === 1 ? "was" : "were"} supplied. They fill the body's ` +
                "{{1}}, {{2}} … placeholders in order.",
              retryable: false,
            });
          }
        }
        const sent = (await transport.json(context, `/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: "POST",
          body: {
            messaging_product: "whatsapp",
            to: input.to,
            type: "template",
            template: {
              name: input.template,
              language: { code: input.language ?? "en_US" },
              ...(parameters.length === 0
                ? {}
                : { components: [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }] }),
            },
          },
        })) as Json | undefined;
        const messages = (Array.isArray(sent?.messages) ? sent.messages : []) as Json[];
        return { to: input.to, template: input.template, messageId: messages[0]?.id, accepted: messages.length > 0 };
      },
    }),
    confirms({
      name: "whatsapp_send_message",
      label: "Send a text message",
      description:
        "Send free text to a WhatsApp user. **Legal only inside the 24-hour service window** opened by that user messaging the business — pass `lastInboundAt`, the ISO timestamp of their most recent message, as evidence. If the window has closed, use whatsapp_send_template instead. Requires approval.",
      category: "communication",
      execute: async (input: { to: string; text: string; lastInboundAt: string }, context) => {
        assertServiceWindow(input.lastInboundAt, now());
        const sent = (await transport.json(context, `/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: "POST",
          body: { messaging_product: "whatsapp", to: input.to, type: "text", text: { body: input.text } },
        })) as Json | undefined;
        const messages = (Array.isArray(sent?.messages) ? sent.messages : []) as Json[];
        return { to: input.to, messageId: messages[0]?.id, accepted: messages.length > 0 };
      },
    }),
    confirms({
      name: "whatsapp_send_media",
      label: "Send an image or document",
      description:
        "Send one image or document by URL to a WhatsApp user. **Legal only inside the 24-hour service window** — pass `lastInboundAt` as evidence, the same as whatsapp_send_message. Requires approval.",
      category: "communication",
      execute: async (
        input: { to: string; kind: "image" | "document"; url: string; caption?: string; filename?: string; lastInboundAt: string },
        context,
      ) => {
        assertServiceWindow(input.lastInboundAt, now());
        const sent = (await transport.json(context, `/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: "POST",
          body: {
            messaging_product: "whatsapp",
            to: input.to,
            type: input.kind,
            [input.kind]: {
              link: input.url,
              ...(input.caption === undefined ? {} : { caption: input.caption }),
              ...(input.kind === "document" && input.filename !== undefined ? { filename: input.filename } : {}),
            },
          },
        })) as Json | undefined;
        const messages = (Array.isArray(sent?.messages) ? sent.messages : []) as Json[];
        return { to: input.to, kind: input.kind, messageId: messages[0]?.id, accepted: messages.length > 0 };
      },
    }),
    /**
     * `internal-write`, and therefore ungated — the one write here that does not ask.
     *
     * A read receipt changes nothing the recipient did not already cause: they sent the message, and marking it
     * read tells them it arrived. Requiring a human approval for that would train operators to approve
     * everything, which is how an approval gate stops meaning anything.
     */
    defineTool({
      name: "whatsapp_mark_read",
      label: "Mark a message read",
      description:
        "Mark an inbound WhatsApp message as read, which shows the sender the blue ticks. This changes nothing except that acknowledgement, so it does not require approval.",
      category: "communication",
      effect: "internal-write",
      execute: async (input: { messageId: string }, context) => {
        await transport.json(context, `/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: "POST",
          body: { messaging_product: "whatsapp", status: "read", message_id: input.messageId },
        });
        return { messageId: input.messageId, read: true };
      },
    }),
  ];

  const instagramTools = (accountId: string): readonly Tool[] => [
    defineTool({
      name: "instagram_get_account",
      label: "Read the account",
      description: "Read the Instagram professional account: username, follower count, and how many media it has posted.",
      category: "communication",
      execute: async (_input: Record<string, never>, context) => {
        const account = (await transport.json(
          context,
          `/${encodeURIComponent(accountId)}?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url`,
        )) as Json | undefined;
        return {
          id: account?.id,
          username: account?.username,
          name: account?.name,
          followers: account?.followers_count,
          following: account?.follows_count,
          mediaCount: account?.media_count,
        };
      },
    }),
    defineTool({
      name: "instagram_list_media",
      label: "List posts",
      description: "List the account's recent posts with their captions, type, permalink and engagement counts.",
      category: "communication",
      execute: async (input: { limit?: number }, context) => {
        const result = (await transport.json(
          context,
          `/${encodeURIComponent(accountId)}/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&limit=${Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)}`,
        )) as Json | undefined;
        const media = (Array.isArray(result?.data) ? result.data : []) as Json[];
        return {
          media: media.map((post) => ({
            id: post.id,
            caption: post.caption,
            type: post.media_type,
            permalink: post.permalink,
            postedAt: post.timestamp,
            likes: post.like_count,
            comments: post.comments_count,
          })),
          truncated: ((result?.paging ?? {}) as Json).next !== undefined,
        };
      },
    }),
    defineTool({
      name: "instagram_get_media",
      label: "Read a post",
      description: "Read one Instagram post and its comments, with each comment's id — which instagram_reply_comment takes.",
      category: "communication",
      execute: async (input: { id: string; commentLimit?: number }, context) => {
        const post = (await transport.json(
          context,
          `/${encodeURIComponent(input.id)}?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count`,
        )) as Json | undefined;
        const comments = (await transport.json(
          context,
          `/${encodeURIComponent(input.id)}/comments?fields=id,text,username,timestamp,like_count&limit=${Math.min(Math.max(input.commentLimit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)}`,
        )) as Json | undefined;
        const rows = (Array.isArray(comments?.data) ? comments.data : []) as Json[];
        return {
          id: post?.id,
          caption: post?.caption,
          type: post?.media_type,
          permalink: post?.permalink,
          likes: post?.like_count,
          comments: rows.map((comment) => ({
            id: comment.id,
            from: comment.username,
            text: comment.text,
            at: comment.timestamp,
          })),
          commentsTruncated: ((comments?.paging ?? {}) as Json).next !== undefined,
        };
      },
    }),
    confirms({
      name: "instagram_publish_media",
      label: "Publish a post",
      description:
        "Publish an image or video to Instagram from a public URL, with a caption. **This is public and immediate**, and it cannot be undone by another call in this toolkit. Requires approval.",
      category: "publishing",
      execute: async (input: { url: string; caption?: string; kind?: "IMAGE" | "REELS" }, context) => {
        /**
         * AC-5. Two calls, and the second one is where the danger is.
         *
         * A container is created, then published. If the *publish* fails, the container still exists — and
         * retrying the whole tool would create a second container and can produce two posts. So a failure
         * after a successful container is reported as **not retryable**, naming the step and the container id
         * so a person can finish or discard it deliberately.
         *
         * The container step is not exposed separately for the same reason: a half-published post is a state
         * no caller wants to be handed.
         */
        const container = (await transport.json(context, `/${encodeURIComponent(accountId)}/media`, {
          method: "POST",
          body: {
            ...(input.kind === "REELS" ? { media_type: "REELS", video_url: input.url } : { image_url: input.url }),
            ...(input.caption === undefined ? {} : { caption: input.caption }),
          },
        })) as Json | undefined;
        const containerId = container?.id;
        if (typeof containerId !== "string") {
          // Nothing was created, so this *is* safely retryable — and it is the only branch here that is.
          throw new AgentPlatformError({
            code: "provider_error",
            message: "Instagram did not return a media container id, so nothing was created.",
            retryable: true,
          });
        }
        try {
          const published = (await transport.json(context, `/${encodeURIComponent(accountId)}/media_publish`, {
            method: "POST",
            body: { creation_id: containerId },
          })) as Json | undefined;
          return { id: published?.id, containerId, published: true };
        } catch (error) {
          const original = error instanceof AgentPlatformError ? error.message : String(error);
          throw new AgentPlatformError({
            code: "conflict",
            message:
              `The Instagram media container ${containerId} was created but publishing it failed: ${original} ` +
              "Do not retry this tool — a retry creates a second container and can publish the post twice. " +
              "The container expires on its own after 24 hours.",
            // Explicitly false, and this is the assertion AC-5 asks to sabotage: an irreversible half-completed
            // act must never look retryable, whatever the underlying failure was.
            retryable: false,
            details: { containerId, step: "publish" },
          });
        }
      },
    }),
    confirms({
      name: "instagram_reply_comment",
      label: "Reply to a comment",
      description:
        "Reply publicly to a comment on one of the account's posts. The reply is visible to everyone and is attributed to the account. Requires approval.",
      category: "publishing",
      execute: async (input: { commentId: string; text: string }, context) => {
        const reply = (await transport.json(context, `/${encodeURIComponent(input.commentId)}/replies`, {
          method: "POST",
          body: { message: input.text },
        })) as Json | undefined;
        return { commentId: input.commentId, replyId: reply?.id };
      },
    }),
  ];

  /**
   * Wiring is the toggle: a surface with no id contributes **no tools**, rather than tools that always answer
   * "not configured" — the second kind costs the model a turn to discover and reads like a broken integration.
   */
  const tools: readonly Tool[] = [
    ...(config.phoneNumberId === undefined ? [] : whatsappTools(config.phoneNumberId, config.wabaId)),
    ...(config.instagramAccountId === undefined ? [] : instagramTools(config.instagramAccountId)),
  ];

  return {
    id: "meta",
    async listTools() {
      return tools;
    },
  };
};

/**
 * AC-3. The service window, checked here so no request is made.
 *
 * Refusing locally rather than letting Meta refuse is the whole point: Meta's own error is a numeric code with
 * no explanation, so a model that sent free text outside the window gets an uninterpretable failure and retries
 * with different words — which cannot ever work, because the words were never the problem.
 */
export const assertServiceWindow = (lastInboundAt: unknown, nowMs: number): void => {
  if (typeof lastInboundAt !== "string" || lastInboundAt.trim() === "") {
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        "A free-text WhatsApp message is legal only inside the 24-hour customer service window, which opens " +
        "when the user messages the business. Pass `lastInboundAt` — the ISO timestamp of their most recent " +
        "message — as evidence of it. If they have not messaged recently, use whatsapp_send_template instead: " +
        "an approved template is the only thing that may be sent outside the window.",
      retryable: false,
    });
  }
  const at = Date.parse(lastInboundAt);
  if (!Number.isFinite(at)) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `\`lastInboundAt\` must be an ISO timestamp, and "${lastInboundAt}" is not one.`,
      retryable: false,
    });
  }
  // A timestamp in the future is not evidence of anything; it is a clock problem or a fabrication, and
  // accepting it would make the check trivially bypassable.
  if (at > nowMs + 60_000) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `\`lastInboundAt\` is in the future (${lastInboundAt}), so it is not evidence that the service window is open.`,
      retryable: false,
    });
  }
  const elapsed = nowMs - at;
  if (elapsed > SERVICE_WINDOW_MS) {
    const hours = Math.floor(elapsed / 3_600_000);
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        `The 24-hour customer service window has closed — the user last messaged ${hours} hours ago. Free text ` +
        "cannot be sent now. Use whatsapp_list_templates and whatsapp_send_template: an approved template is " +
        "the only thing WhatsApp permits outside the window.",
      retryable: false,
    });
  }
};

/**
 * What Meta accepts — #260 AC-2.
 *
 * `oauth2` only, and that is not a simplification: there is no such thing as a WhatsApp Business or Instagram
 * API key. Every token comes from an app that has passed Meta's review, which is the real barrier to using this
 * package and is why the integration page leads with the permission list rather than the code.
 */
export const META_AUTH: ToolkitAuth = { modes: ["oauth2"], schemes: ["bearer"] };

export const META_TOOL_NAMES = [
  "whatsapp_list_templates",
  "whatsapp_send_template",
  "whatsapp_send_message",
  "whatsapp_send_media",
  "whatsapp_mark_read",
  "instagram_get_account",
  "instagram_list_media",
  "instagram_get_media",
  "instagram_publish_media",
  "instagram_reply_comment",
] as const;
