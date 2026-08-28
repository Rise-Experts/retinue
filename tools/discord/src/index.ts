/**
 * Discord — REQ-053 (#227), task #231.
 *
 * Deliberately the same shape as `tools-slack`: list channels, read history, send, reply, react. The work here
 * is mostly *not* new, and the reuse is real rather than claimed — both packages take their request path from
 * `createVendorTransport`, which `check:toolkit-transport` enforces.
 *
 * ## The one genuinely new thing: a bot that has not been invited
 *
 * Discord and Telegram are bot-identity platforms. A perfectly valid token against a guild the bot was never
 * added to fails with `401`/`403` — the same shape as a bad token — and that confusion is the single most
 * common support question on both. So the two are classified apart: Discord answers `50001 Missing Access`
 * for the first and a bare `401 Unauthorized` for the second, and the messages say which remedy applies.
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
  type VendorFailure,
  type VendorTransport,
} from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

const API = "https://discord.com/api/v10";
const DEFAULT_LIMIT = 50;
/** Discord's own cap on a history page. */
const MAX_LIMIT = 100;
/** Discord's message length limit. Counted in code points, which is not `String.length`. */
export const MAX_MESSAGE_LENGTH = 2000;

export type DiscordToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

/** Discord's JSON error code, which carries the meaning the status does not. */
export const discordCodeOf = (reason: string): number | undefined => {
  const start = reason.indexOf("{");
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(reason.slice(start)) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * "The bot was never invited" told apart from "the token is wrong" — AC-3.
 *
 * Both are `401`/`403` shaped, and the remedies could not be more different: one is a click in a server's
 * settings, the other is a new token. Conflating them sends whoever is debugging to regenerate a token that
 * was fine, which is the failure this classifier exists to prevent.
 *
 * Exported so it can be tested directly rather than only through a tool.
 */
export const classifyAccess = (failure: VendorFailure) => {
  const code = discordCodeOf(failure.reason);
  // 50001 Missing Access, 50013 Missing Permissions, 10003 Unknown Channel, 10004 Unknown Guild — all of which
  // are what a bot that is not in the server, or lacks a permission there, actually gets.
  if (code === 50001 || code === 50013 || code === 10003 || code === 10004) {
    return {
      code: "unauthorized" as const,
      message:
        `Discord refused this (code ${code}). The token is being accepted, so this is not a credential problem: ` +
        "the bot is either not a member of that server, or lacks a permission in that channel. Invite it with " +
        "the `bot` scope and grant View Channel, Read Message History and Send Messages where it should work.",
      retryable: false,
    };
  }
  if (failure.status === 401) {
    return {
      code: "unauthorized" as const,
      message:
        `Discord rejected the token (401): ${failure.reason}. This *is* a credential problem — a bot token ` +
        "looks like `Bot <token>` on the wire, and a regenerated token invalidates the old one immediately.",
      retryable: false,
    };
  }
  return undefined;
};

/** Code points, not UTF-16 units — an emoji is one character to Discord and two to `String.length`. */
export const messageLength = (text: string): number => [...text].length;

const summariseMessage = (message: Json): Json => {
  const author = (message.author ?? {}) as Json;
  return {
    id: message.id,
    channelId: message.channel_id,
    author: author.username === undefined ? undefined : `@${String(author.username)}`,
    bot: author.bot === true,
    text: message.content,
    at: message.timestamp,
    editedAt: message.edited_timestamp ?? null,
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).length,
    ...(message.thread === undefined ? {} : { threadId: ((message.thread ?? {}) as Json).id }),
  };
};

export const createDiscordToolkit = (config: DiscordToolkitConfig): ToolProvider => {
  const transport: VendorTransport = createVendorTransport({
    vendor: "Discord",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.baseUrl ?? API,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify: classifyAccess,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  const tools: readonly Tool[] = [
    defineTool({
      name: "discord_list_channels",
      label: "List channels",
      description:
        "List a server's text channels, with the id every other tool takes. If this comes back empty or refused, the bot is probably not in that server.",
      category: "communication",
      execute: async (input: { guildId: string }, context) => {
        const channels = (await transport.json(context, `/guilds/${encodeURIComponent(input.guildId)}/channels`)) as unknown;
        const rows = (Array.isArray(channels) ? channels : []) as Json[];
        return {
          channels: rows
            // 0 is a guild text channel and 5 is an announcement channel; the rest are voice, categories and
            // forums, which none of these tools can post to.
            .filter((channel) => channel.type === 0 || channel.type === 5)
            .map((channel) => ({ id: channel.id, name: channel.name, topic: channel.topic ?? null, nsfw: channel.nsfw === true })),
        };
      },
    }),
    defineTool({
      name: "discord_read_messages",
      label: "Read channel history",
      description:
        "Read a channel's recent messages, newest first. Bounded, and reports `truncated` when there was more rather than implying it saw everything.",
      category: "communication",
      execute: async (input: { channelId: string; limit?: number; beforeId?: string }, context) => {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        const before = input.beforeId === undefined ? "" : `&before=${encodeURIComponent(input.beforeId)}`;
        const messages = (await transport.json(
          context,
          `/channels/${encodeURIComponent(input.channelId)}/messages?limit=${limit}${before}`,
        )) as unknown;
        const rows = (Array.isArray(messages) ? messages : []) as Json[];
        return {
          messages: rows.map(summariseMessage),
          // Discord pages by snowflake rather than a cursor: a full page means there is probably more, and the
          // id to continue from is the last one. Stating both beats implying completeness.
          truncated: rows.length === limit,
          ...(rows.length === limit ? { continueBeforeId: rows[rows.length - 1]?.id } : {}),
        };
      },
    }),
    defineTool({
      name: "discord_get_message",
      label: "Read a message",
      description: "Read one message by its channel and message id.",
      category: "communication",
      execute: async (input: { channelId: string; messageId: string }, context) => {
        const message = (await transport.json(
          context,
          `/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(input.messageId)}`,
        )) as Json | undefined;
        return summariseMessage(message ?? {});
      },
    }),
    confirms({
      name: "discord_send_message",
      label: "Send a message",
      description:
        "Send a message to a Discord channel. Visible to everyone who can see that channel. Requires approval.",
      category: "communication",
      execute: async (input: { channelId: string; text: string }, context) => {
        assertLength(input.text);
        const message = (await transport.json(context, `/channels/${encodeURIComponent(input.channelId)}/messages`, {
          method: "POST",
          // `allowed_mentions` empty by default, so an agent cannot @everyone by quoting text that contains it.
          // Discord's default is to honour every mention in the content, which makes accidental mass-pings a
          // one-character mistake.
          body: { content: input.text, allowed_mentions: { parse: [] } },
        })) as Json | undefined;
        return { id: message?.id, channelId: input.channelId };
      },
    }),
    confirms({
      name: "discord_reply_message",
      label: "Reply to a message",
      description: "Reply to a specific Discord message, so the reply is threaded to it. Requires approval.",
      category: "communication",
      execute: async (input: { channelId: string; messageId: string; text: string }, context) => {
        assertLength(input.text);
        const message = (await transport.json(context, `/channels/${encodeURIComponent(input.channelId)}/messages`, {
          method: "POST",
          body: {
            content: input.text,
            message_reference: { message_id: input.messageId, channel_id: input.channelId },
            allowed_mentions: { parse: [], replied_user: false },
          },
        })) as Json | undefined;
        return { id: message?.id, replyTo: input.messageId };
      },
    }),
    /**
     * `internal-write` and ungated — consistent with `tools-slack`'s reaction, and for the same reason.
     *
     * A reaction is a single glyph on somebody else's message. It carries no content, is trivially reversible,
     * and gating it would train operators to approve everything.
     */
    defineTool({
      name: "discord_add_reaction",
      label: "React to a message",
      description:
        "Add an emoji reaction to a message. This carries no content and is reversible, so it does not require approval.",
      category: "communication",
      effect: "internal-write",
      execute: async (input: { channelId: string; messageId: string; emoji: string }, context) => {
        // `@me` is Discord's word for the authenticated bot. The emoji must be URL-encoded whole — a custom
        // emoji is `name:id` and encoding the colon breaks it.
        await transport.json(
          context,
          `/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(input.emoji)}/@me`,
          { method: "PUT" },
        );
        return { messageId: input.messageId, emoji: input.emoji, reacted: true };
      },
    }),
    confirms({
      name: "discord_create_thread",
      label: "Open a thread",
      description:
        "Open a thread from an existing message, so a side conversation does not fill the channel. Requires approval.",
      category: "communication",
      execute: async (input: { channelId: string; messageId: string; name: string; autoArchiveMinutes?: number }, context) => {
        if (input.name.trim() === "" || input.name.length > 100) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `A Discord thread name must be between 1 and 100 characters, and this one is ${input.name.length}.`,
            retryable: false,
          });
        }
        const thread = (await transport.json(
          context,
          `/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(input.messageId)}/threads`,
          {
            method: "POST",
            // Discord accepts only these four values and rejects anything else with a validation error naming
            // no field, so an unexpected number is snapped to the nearest legal one.
            body: {
              name: input.name,
              auto_archive_duration: nearestArchive(input.autoArchiveMinutes ?? 1440),
            },
          },
        )) as Json | undefined;
        return { id: thread?.id, name: thread?.name, from: input.messageId };
      },
    }),
  ];

  return {
    id: "discord",
    async listTools() {
      return tools;
    },
  };
};

const ARCHIVE_CHOICES = [60, 1440, 4320, 10080] as const;
export const nearestArchive = (minutes: number): number =>
  ARCHIVE_CHOICES.reduce((best, choice) => (Math.abs(choice - minutes) < Math.abs(best - minutes) ? choice : best), ARCHIVE_CHOICES[1]);

const assertLength = (text: string): void => {
  const length = messageLength(text);
  if (length === 0) {
    throw new AgentPlatformError({ code: "invalid_input", message: "A Discord message cannot be empty.", retryable: false });
  }
  if (length > MAX_MESSAGE_LENGTH) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `A Discord message may be at most ${MAX_MESSAGE_LENGTH} characters and this one is ${length}. Split it, or open a thread.`,
      retryable: false,
    });
  }
};

/**
 * What Discord accepts — #260 AC-2.
 *
 * `custom-header`, because a bot token is presented as `Authorization: Bot <token>` — the word `Bot` is part
 * of the value and omitting it fails with a bare `401`. That is the same reason Linear needs `custom-header`:
 * the header name is standard and the format is not.
 */
export const DISCORD_AUTH: ToolkitAuth = { modes: ["token"], schemes: ["custom-header"] };

export const DISCORD_TOOL_NAMES = [
  "discord_list_channels",
  "discord_read_messages",
  "discord_get_message",
  "discord_send_message",
  "discord_reply_message",
  "discord_add_reaction",
  "discord_create_thread",
] as const;
