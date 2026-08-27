---
sidebar_position: 3
---

# Slack

List channels, read history, post a message, reply in a thread. Both writes stop and ask a human.

```bash
npm i @retinue/tools-slack
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `slack_list_channels` | `read` | never | Cursor-paginated; reports `truncated` |
| `slack_read_history` | `read` | never | One channel, newest first |
| `slack_post_message` | `external-write` | **always** | Idempotency key required |
| `slack_reply_in_thread` | `external-write` | **always** | Needs the parent message's `thread_ts` |

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createSlackToolkit } from "@retinue/tools-slack";

const agent = createAgent({
  manifest: {
    id: "helper",
    name: "Helper",
    instructions: "Answer in the thread you were asked in. Be brief.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createSlackToolkit({
      credentialRef: "slack-bot",
      resolver: createStaticCredentialResolver({ "slack-bot": process.env.SLACK_BOT_TOKEN ?? "" }),
    }),
  ],
});
```

## Credentials and scopes

A bot token (`xoxb-…`) from your app's **OAuth & Permissions** page. The bot must be invited to a channel before
it can read or post there — a missing invitation is `not_in_channel`, not a permissions error.

| What the agent should do | Scope |
|---|---|
| List channels | `channels:read` |
| Read history | `channels:history` |
| Post and reply | `chat:write` |

## Behaviour worth knowing

**Slack answers `200` with `ok: false`.** This is the mistake this package exists to not make. An integration
that checks the HTTP status alone treats `channel_not_found`, `not_in_channel` and `invalid_auth` as *successes* —
and the model then reports that it posted a message which never arrived. The envelope is read, not the status.

**`ratelimited` is separated from the rest**, and is retryable, so the model waits rather than retrying with
different arguments. `invalid_auth` is `unauthorized` and not retryable: trying again cannot fix a token.

**Message text is untrusted.** It arrives fenced. Slack is the most likely place for a prompt-injection attempt
to reach an agent, because anyone in the channel can type one.

## Limits

No file upload (multipart to a second host), no reactions, no user lookup, no channel creation, no direct
messages. Reading and answering in a channel is the useful core; the rest is additive.

An agent that only answers when asked needs a **trigger** — an event subscription that starts a run. That is not
part of this package: it is a deployment's own HTTP endpoint, and it needs Slack's request signature verified
before it starts anything.
