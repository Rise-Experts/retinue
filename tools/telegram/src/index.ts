/**
 * Telegram Bot API — REQ-053 (#227), task #231.
 *
 * ## Why this package paces itself — AC-5
 *
 * Telegram's limits are **per chat** and strict: roughly one message per second to a single chat, and about
 * twenty per minute to a group. Exceeding them earns a `429` with a `retry_after`, and — unlike a quota — the
 * remedy is not to wait and try again but to *not have sent that fast in the first place*. A client that
 * retries into the limit spends its budget bouncing off it, and Telegram escalates repeat offenders to longer
 * cooldowns.
 *
 * So the send path is **paced by construction**: a per-chat queue that spaces sends, rather than a retry loop
 * that discovers the limit each time. Respecting a rate limit you already know is cheaper than being told.
 *
 * ## The bot-identity problem, shared with Discord
 *
 * A valid token against a chat the bot was never added to fails the same way a bad token does. Telegram's
 * `403 Forbidden: bot is not a member` is distinguishable from `401 Unauthorized` only if
 * you read the description, so the two are classified apart and the messages name different remedies.
 *
 * ## No `getUpdates`
 *
 * Inbound delivery is REQ-042's territory (#191), not a tool call. A tool that polls would hold a request open
 * and compete with the deployment's own webhook for the same updates — Telegram delivers each update once.
 */

import {
  confirms,
  createVendorTransport,
  defineTool,
  destroys,
  type CredentialRef,
  type CredentialResolver,
  type Tool,
  type ToolProvider,
  type ToolkitAuth,
  type VendorFailure,
  type VendorTransport,
} from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

const API = "https://api.telegram.org";

/** Telegram's documented per-chat floor: about one message a second. */
export const MIN_SEND_GAP_MS = 1000;
/** Telegram's message length limit, in code points. */
export const MAX_MESSAGE_LENGTH = 4096;

export type TelegramToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
  /** Injected so the pacer is testable without spending real seconds. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override the per-chat gap. Lowering it below Telegram's floor is a way to get rate limited. */
  readonly minSendGapMs?: number;
};

type Json = Record<string, unknown>;

/**
 * A per-chat pacer — AC-5.
 *
 * One promise chain per chat id, so sends to *different* chats do not wait for each other while sends to the
 * same chat are spaced. A single global queue would be simpler and wrong: a bot serving fifty conversations
 * would serialise all of them behind the slowest.
 *
 * Exported for its own test, because "respected by construction" is a claim that has to be demonstrated.
 */
export const createPacer = (options: { gapMs: number; now: () => number; sleep: (ms: number) => Promise<void> }) => {
  const lastSend = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();

  const run = async <T>(chatId: string, task: () => Promise<T>): Promise<T> => {
    const previous = lastSend.get(chatId);
    if (previous !== undefined) {
      const wait = previous + options.gapMs - options.now();
      if (wait > 0) await options.sleep(wait);
    }
    // Stamped *before* the request, not after: the limit is on send rate, and a slow response should not earn
    // a burst on the next call.
    lastSend.set(chatId, options.now());
    return task();
  };

  return {
    /** Chains onto this chat's queue so two concurrent sends to one chat cannot both see an empty gap. */
    send<T>(chatId: string, task: () => Promise<T>): Promise<T> {
      const queued = (queues.get(chatId) ?? Promise.resolve()).then(
        () => run(chatId, task),
        () => run(chatId, task),
      );
      // The stored chain swallows rejection so one failed send does not poison the chat's queue forever.
      queues.set(chatId, queued.catch(() => undefined));
      return queued;
    },
    lastSentAt: (chatId: string) => lastSend.get(chatId),
  };
};

/** Code points, not UTF-16 units. */
export const messageLength = (text: string): number => [...text].length;

/**
 * "The bot is not in this chat" told apart from "the token is wrong" — AC-3.
 *
 * Both are `401`/`403` shaped; Telegram's `description` is the only thing that distinguishes them, and the
 * remedies are entirely different — one is adding the bot to a group, the other is a new token.
 */
export const classifyAccess = (failure: VendorFailure) => {
  const reason = failure.reason.toLowerCase();
  if (failure.status === 403 || reason.includes("forbidden")) {
    return {
      code: "unauthorized" as const,
      message:
        `Telegram refused this (403): ${failure.reason}. The token is being accepted, so this is not a ` +
        "credential problem: the bot is not a member of that chat, was removed from it, or the user has never " +
        "started a conversation with it. A bot cannot message a user who has not messaged it first.",
      retryable: false,
    };
  }
  if (failure.status === 401 || reason.includes("unauthorized")) {
    return {
      code: "unauthorized" as const,
      message:
        `Telegram rejected the token (401): ${failure.reason}. This *is* a credential problem — the token goes ` +
        "in the URL path as `/bot<token>/method`, and revoking it in BotFather invalidates it immediately.",
      retryable: false,
    };
  }
  return undefined;
};

export const createTelegramToolkit = (config: TelegramToolkitConfig): ToolProvider => {
  const now = config.now ?? (() => Date.now());
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const pacer = createPacer({ gapMs: config.minSendGapMs ?? MIN_SEND_GAP_MS, now, sleep });

  /**
   * The token lives in the **path**, not a header — `/bot<token>/sendMessage`.
   *
   * So `credentialHeader` cannot carry it, and the shared transport's host-pinned header does nothing useful
   * here. The credential is still resolved per call by the resolver; what changes is where it goes. This is
   * the one vendor so far whose auth is not a header, and it is worth saying rather than hiding.
   */
  const base = (config.baseUrl ?? API).replace(/\/$/, "");
  const transport: VendorTransport = createVendorTransport({
    vendor: "Telegram",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: base,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify: classifyAccess,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  /**
   * Telegram answers `200` with `{ ok: false, description }` — the same envelope lesson as Slack's `ok: false`,
   * and the fourth vendor in this repository to do it.
   */
  const call = async (context: Parameters<VendorTransport["json"]>[0], method: string, body: Json): Promise<Json> => {
    const credential = await Promise.resolve(config.resolver.resolve({ ref: config.credentialRef, context }));
    const token = "token" in credential ? credential.token : "value" in credential ? credential.value : "";
    const payload = ((await transport.json(context, `/bot${token}/${method}`, { method: "POST", body })) ?? {}) as Json;
    if (payload.ok === true) return (payload.result ?? {}) as Json;
    const description = typeof payload.description === "string" ? payload.description : "no description given";
    const retryAfter = ((payload.parameters ?? {}) as Json).retry_after;
    throw new AgentPlatformError({
      code: typeof retryAfter === "number" ? "rate_limited" : "provider_error",
      message: `Telegram refused ${method}: ${description}`,
      retryable: typeof retryAfter === "number",
      ...(typeof retryAfter === "number" ? { retryAfterMs: retryAfter * 1000 } : {}),
    });
  };

  const assertLength = (text: string): void => {
    const length = messageLength(text);
    if (length === 0) {
      throw new AgentPlatformError({ code: "invalid_input", message: "A Telegram message cannot be empty.", retryable: false });
    }
    if (length > MAX_MESSAGE_LENGTH) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `A Telegram message may be at most ${MAX_MESSAGE_LENGTH} characters and this one is ${length}.`,
        retryable: false,
      });
    }
  };

  const tools: readonly Tool[] = [
    defineTool({
      name: "telegram_get_chat",
      label: "Read a chat",
      description:
        "Read a chat by id or @username: its title, type, and description. Use this to confirm the bot can see a chat before sending to it.",
      category: "communication",
      execute: async (input: { chatId: string }, context) => {
        const chat = await call(context, "getChat", { chat_id: input.chatId });
        return {
          id: chat.id,
          type: chat.type,
          title: chat.title ?? chat.username ?? null,
          description: chat.description ?? null,
          memberCount: chat.member_count ?? null,
        };
      },
    }),
    confirms({
      name: "telegram_send_message",
      label: "Send a message",
      description:
        "Send a message to a Telegram chat. Sends to the same chat are paced to Telegram's per-chat limit automatically. Requires approval.",
      category: "communication",
      execute: async (input: { chatId: string; text: string; markdown?: boolean; replyToMessageId?: number }, context) => {
        assertLength(input.text);
        const message = await pacer.send(input.chatId, () =>
          call(context, "sendMessage", {
            chat_id: input.chatId,
            text: input.text,
            // `MarkdownV2` is opt-in: it requires escaping a dozen characters, and an unescaped `.` or `-`
            // makes Telegram reject the whole message. Plain text is the safe default.
            ...(input.markdown === true ? { parse_mode: "MarkdownV2" } : {}),
            ...(input.replyToMessageId === undefined ? {} : { reply_to_message_id: input.replyToMessageId }),
          }),
        );
        return { chatId: input.chatId, messageId: message.message_id };
      },
    }),
    confirms({
      name: "telegram_send_media",
      label: "Send a photo or document",
      description: "Send one photo or document to a Telegram chat by URL, with an optional caption. Requires approval.",
      category: "communication",
      execute: async (input: { chatId: string; kind: "photo" | "document"; url: string; caption?: string }, context) => {
        const method = input.kind === "photo" ? "sendPhoto" : "sendDocument";
        const message = await pacer.send(input.chatId, () =>
          call(context, method, {
            chat_id: input.chatId,
            [input.kind]: input.url,
            ...(input.caption === undefined ? {} : { caption: input.caption }),
          }),
        );
        return { chatId: input.chatId, messageId: message.message_id, kind: input.kind };
      },
    }),
    confirms({
      name: "telegram_edit_message",
      label: "Edit a message",
      description:
        "Edit one of the bot's **own** messages. Telegram does not allow editing anyone else's, and an edit leaves a visible 'edited' marker. Requires approval.",
      category: "communication",
      execute: async (input: { chatId: string; messageId: number; text: string; markdown?: boolean }, context) => {
        assertLength(input.text);
        // Not paced: an edit is not a send, and Telegram's per-chat send limit does not apply to it.
        const message = await call(context, "editMessageText", {
          chat_id: input.chatId,
          message_id: input.messageId,
          text: input.text,
          ...(input.markdown === true ? { parse_mode: "MarkdownV2" } : {}),
        });
        return { chatId: input.chatId, messageId: message.message_id ?? input.messageId, edited: true };
      },
    }),
    /**
     * `destroys()` — irreversible, and in a group it is visible that something was removed.
     *
     * Telegram also only permits deleting a message less than 48 hours old, which the description says so a
     * model does not treat a refusal as a permission problem.
     */
    destroys({
      name: "telegram_delete_message",
      label: "Delete a message",
      description:
        "Delete a message from a Telegram chat. **This cannot be undone.** Telegram only allows deleting messages less than 48 hours old, and in a group the bot must be an administrator. Requires approval.",
      category: "communication",
      execute: async (input: { chatId: string; messageId: number }, context) => {
        await call(context, "deleteMessage", { chat_id: input.chatId, message_id: input.messageId });
        return { chatId: input.chatId, messageId: input.messageId, deleted: true };
      },
    }),
    confirms({
      name: "telegram_pin_message",
      label: "Pin a message",
      description:
        "Pin a message in a Telegram chat, which shows it at the top for **every member** and, unless silenced, notifies them all. Requires approval.",
      category: "communication",
      execute: async (input: { chatId: string; messageId: number; silent?: boolean }, context) => {
        await call(context, "pinChatMessage", {
          chat_id: input.chatId,
          message_id: input.messageId,
          // Silent by default: pinning notifies every member of a group, and a notification to a thousand
          // people is not a side effect an agent should cause by omission.
          disable_notification: input.silent ?? true,
        });
        return { chatId: input.chatId, messageId: input.messageId, pinned: true, notified: input.silent === false };
      },
    }),
  ];

  return {
    id: "telegram",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Telegram accepts — #260 AC-2.
 *
 * A bot token from BotFather, and it goes in the **URL path** rather than a header, which is why this package
 * reads the credential itself rather than letting `credentialHeader` place it. `bearer` records that the
 * credential is a single opaque token; where it is put is this package's business.
 */
export const TELEGRAM_AUTH: ToolkitAuth = { modes: ["token"], schemes: ["bearer"] };

export const TELEGRAM_TOOL_NAMES = [
  "telegram_get_chat",
  "telegram_send_message",
  "telegram_send_media",
  "telegram_edit_message",
  "telegram_delete_message",
  "telegram_pin_message",
] as const;
