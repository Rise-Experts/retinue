---
sidebar_position: 11
---

# Discord

Read channels and history, send messages, react and open threads. Deliberately the same shape as
[Slack](./slack.md) — both take their request path from the same shared transport.

```bash
npm i @retinue/tools-discord
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `discord_list_channels` | `read` | never | Text and announcement channels only — the ones these tools can post to |
| `discord_read_messages` | `read` | never | Bounded; reports `truncated` and the id to continue from |
| `discord_get_message` | `read` | never | |
| `discord_send_message` | `external-write` | **always** | Mentions disabled — see below |
| `discord_reply_message` | `external-write` | **always** | Threaded to the message it answers |
| `discord_add_reaction` | `internal-write` | never | Carries no content and is reversible |
| `discord_create_thread` | `external-write` | **always** | From an existing message |

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createDiscordToolkit } from "@retinue/tools-discord";

const agent = createAgent({
  manifest: {
    id: "helper",
    name: "Helper",
    instructions: "Answer questions in the support channel. Open a thread for anything longer than a line.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createDiscordToolkit({
      credentialRef: "discord",
      // `Bot <token>` — the word is part of the value.
      resolver: createStaticCredentialResolver({
        discord: { scheme: "custom-header", header: "Authorization", value: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      }),
    }),
  ],
});
```

## Credentials and scopes

A **bot token** from the Discord developer portal, sent as `Authorization: Bot <token>`. The word `Bot` is part
of the value; omitting it fails with a bare `401` that says nothing useful. That is why this toolkit declares
`schemes: ["custom-header"]` rather than `bearer`.

**Then you must invite the bot**, and this is the step people miss. Generate an invite URL with the `bot` scope
and these permissions, then open it and pick a server:

| To use | Permission |
|---|---|
| `discord_list_channels` | View Channels |
| `discord_read_messages`, `discord_get_message` | View Channels, Read Message History |
| `discord_send_message`, `discord_reply_message` | Send Messages |
| `discord_add_reaction` | Add Reactions, Read Message History |
| `discord_create_thread` | Create Public Threads, Send Messages in Threads |

Permissions are per channel as well as per server: a bot with Send Messages at the server level can still be
denied it in one channel by a channel override, and the failure is the same `50001` as never having been
invited.

**Message Content Intent.** Reading message *text* from channels the bot was not mentioned in requires the
privileged Message Content intent, enabled in the developer portal. Without it, `content` comes back empty and
nothing says why — which reads exactly like an empty channel.

## Behaviour worth knowing

**An uninvited bot fails like a bad token, and this package tells them apart.** Both are `401`/`403` shaped, and
the remedies could not be more different — one is a click in a server's settings, the other is a new token.
Discord's `50001`, `50013`, `10003` and `10004` mean the bot is not there or lacks a permission:

```
Discord refused this (code 50001). The token is being accepted, so this is not a credential problem:
the bot is either not a member of that server, or lacks a permission in that channel. Invite it with
the `bot` scope and grant View Channel, Read Message History and Send Messages where it should work.
```

A bare `401` says the opposite, in as many words. Conflating them is the single most common support question on
this platform.

**Sends cannot `@everyone` by accident.** Discord's default honours every mention in a message's content, so an
agent relaying a user's text is one character away from a mass ping. Every send goes out with
`allowed_mentions: { parse: [] }`, and a reply does not ping the person it answers.

**History pages by snowflake, not a cursor.** A full page means there is probably more, so the result carries
`truncated` and `continueBeforeId` rather than implying it saw everything.

**Messages are counted in code points.** `String.length` counts UTF-16 units, so 2000 emoji would be refused
wrongly.

**Message content is untrusted.** It arrives fenced. A message instructing the model to post something is data,
and the post would still stop for approval.

## Limits

| Not offered | Why |
|---|---|
| Deleting or editing messages | A deletion is irreversible and visible; editing someone's context after the fact is not an agent's call |
| Kick, ban, timeout, role changes | Moderator powers over people, where a wrong call cannot be walked back by another call |
| Voice channels and stage events | An entirely different protocol — a gateway connection, not a REST call |
| Slash commands and interactions | These are how a bot *receives* work, which is a deployment's HTTP endpoint rather than a tool |
| File and image upload | Multipart to a second host — the same deferral as Slack's `upload_file` |
| Embeds | The embed object has twenty fields and a nesting limit Discord enforces silently; worth its own design pass rather than a half version |
| Direct messages | A separate consent expectation from a public channel, and worth its own task |
| `@everyone` and role mentions | Deliberately unreachable, per the mention rule above. A mass ping should be a person's decision |
