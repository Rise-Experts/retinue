<img src="https://raw.githubusercontent.com/Rise-Experts/retinue/main/brand/retinue-mark.svg" alt="Retinue" width="72" />

# @retinue/tools-slack

[![npm](https://img.shields.io/npm/v/@retinue/tools-slack)](https://www.npmjs.com/package/@retinue/tools-slack)
[![licence](https://img.shields.io/npm/l/@retinue/tools-slack)](https://github.com/Rise-Experts/retinue/blob/main/LICENSE)

**Slack tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent.** Read channels and history, post
messages and thread replies — with every write gated behind human approval and carrying an idempotency key.

## Install

```bash
npm i @retinue/tools-slack
```

## Use

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createSlackToolkit } from "@retinue/tools-slack";

const agent = createAgent({
  manifest: { id: "helper", name: "Helper", instructions: "Answer in the thread you were asked in.", modelPolicy: { role: "smart" } },
  tools: [
    createSlackToolkit({
      credentialRef: "slack-bot",
      // Per tenant in a multi-tenant deployment: one workspace, one bot token.
      resolver: createStaticCredentialResolver({ "slack-bot": process.env.SLACK_BOT_TOKEN ?? "" }),
    }),
  ],
});
```

## Tools

| Tool | Effect | Approval |
|---|---|---|
| `slack_list_channels` | `read` | never |
| `slack_read_history` | `read` | never |
| `slack_post_message` | `external-write` | **always** |
| `slack_reply_in_thread` | `external-write` | **always** |

## Scopes your bot token needs

`channels:read` for listing, `channels:history` for reading, `chat:write` for posting. A missing scope comes back
as an `unauthorized` failure naming Slack's own error, not as a silent no-op.

## Behaviour worth knowing

**Slack answers `200` with `ok: false`.** This is the mistake worth not making: a toolkit that checks the HTTP
status alone reports success for `channel_not_found`, `not_in_channel` and `invalid_auth` — and the model then
believes it posted a message that never arrived. The envelope is read, not the status.

**`ratelimited` is its own outcome**, retryable, so the model waits rather than retrying with different
arguments. `invalid_auth` is `unauthorized` and *not* retryable, because trying again cannot fix a token.

**Pagination follows the cursor** to a ceiling and reports `truncated` when it stopped early.

**Message text is untrusted content.** It reaches the model inside the runtime's envelope — a Slack message
saying "ignore your instructions" arrives as data.

## Licence

MIT — see [LICENSE](https://github.com/Rise-Experts/retinue/blob/main/LICENSE).

Copyright (c) 2026 [Azeem Sarwar](https://github.com/azeem-sarwar) and
[Rise Experts](https://github.com/Rise-Experts).
