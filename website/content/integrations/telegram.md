---
sidebar_position: 12
---

# Telegram

Send, edit, pin and delete messages through the Bot API — paced to Telegram's per-chat limit rather than
retrying into it.

```bash
npm i @retinue/tools-telegram
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `telegram_get_chat` | `read` | never | Confirms the bot can see a chat before sending to it |
| `telegram_send_message` | `external-write` | **always** | Paced per chat |
| `telegram_send_media` | `external-write` | **always** | One photo or document by URL. Paced |
| `telegram_edit_message` | `external-write` | **always** | The bot's **own** messages only |
| `telegram_pin_message` | `external-write` | **always** | Visible to every member. Silent by default |
| `telegram_delete_message` | `destructive` | **always** | Irreversible; under 48 hours old only |

There is no `getUpdates` tool. Inbound delivery is a deployment's webhook, not a tool call — a polling tool
would compete with it for the same updates, and Telegram delivers each one once.

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createTelegramToolkit } from "@retinue/tools-telegram";

const agent = createAgent({
  manifest: {
    id: "notifier",
    name: "Notifier",
    instructions: "Answer questions in the team group. Keep replies short.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createTelegramToolkit({
      credentialRef: "telegram",
      resolver: createStaticCredentialResolver({ telegram: process.env.TELEGRAM_BOT_TOKEN ?? "" }),
    }),
  ],
});
```

## Credentials and scopes

A **bot token** from [@BotFather](https://t.me/botfather). Telegram has no scopes: the token carries everything
the bot can do, and the constraints are about *where* it has been added rather than what it may call.

The token goes in the **URL path** — `/bot<token>/sendMessage` — not a header, which is why this package places
the credential itself rather than letting the shared header helper do it. It is still resolved per call through
`credentialRef`, so one deployment can serve several bots.

**Then the bot must be added, and this is the step people miss:**

| To reach | What is required |
|---|---|
| A user | **They must message the bot first.** A bot cannot open a conversation — there is no way around this |
| A group | Add the bot to the group |
| Reading group messages | Disable Privacy Mode in BotFather, or the bot sees only messages that mention it or reply to it |
| `telegram_delete_message` in a group | The bot must be an administrator |
| `telegram_pin_message` in a group | Administrator with Pin Messages |

Privacy Mode is on by default and is the usual explanation for a bot that "sees nothing" in a group.

## Behaviour worth knowing

**Sends are paced by construction, not by retrying into the limit.** Telegram allows roughly one message a
second to a chat and about twenty a minute to a group. Exceeding that earns a `429` with a `retry_after`, and —
unlike a quota — the remedy is not to wait and try again but to *not have sent that fast*: Telegram escalates
repeat offenders to longer cooldowns.

So sends to the same chat are spaced automatically, and sends to *different* chats do not wait for each other —
a bot serving fifty conversations would otherwise serialise all of them behind the slowest. Concurrent sends to
one chat are queued rather than both reading the same stale timestamp. An edit is not paced, because Telegram's
send limit does not apply to it.

**An uninvited bot fails like a bad token.** `403 Forbidden: bot is not a member` and
`401 Unauthorized` are both permission-shaped, and only the description distinguishes them. They are classified
apart and name different remedies — one is adding the bot to a chat, the other is a new token from BotFather.

**Telegram answers `200` with `ok: false`.** The envelope is read rather than the status — the fourth vendor in
this project to do this, after Slack, GraphQL and Reddit. A `retry_after` inside it becomes a real
`retryAfterMs` rather than a guess.

**Plain text is the default; `MarkdownV2` is opt-in.** It requires escaping a dozen characters, and one
unescaped `.` or `-` makes Telegram reject the whole message.

**Pinning is silent by default.** A pin notifies every member of a group, and a notification to a thousand
people is not a side effect an agent should cause by omission. Pass `silent: false` to mean it.

**Message content is untrusted.** It arrives fenced.

## Limits

| Not offered | Why |
|---|---|
| `getUpdates` polling | Inbound delivery is a webhook the deployment owns; a polling tool would steal updates from it |
| Inline keyboards and callback buttons | A button implies handling its callback, which is inbound work and not a tool call |
| Chat administration — promote, restrict, ban | Powers over people, where a wrong call cannot be walked back |
| Setting the bot's commands, name or description | Standing configuration, which is a deployment decision |
| Polls, dice, locations, contacts | Each is a distinct message type with its own semantics; naming them as declined rather than forgotten |
| Media upload from bytes | Sends take a URL. Accepting bytes would mean this package hosting a file, which is a storage decision a toolkit should not make |
| Editing anyone else's message | Telegram does not permit it, and pretending otherwise would produce a tool that always fails |
