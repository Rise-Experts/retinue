# @retinue/tools-telegram

Telegram Bot API tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: send, edit, pin and
delete messages.

```bash
npm i @retinue/tools-telegram
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createTelegramToolkit } from "@retinue/tools-telegram";

const toolkit = createTelegramToolkit({
  credentialRef: "telegram",
  resolver: createStaticCredentialResolver({ telegram: process.env.TELEGRAM_BOT_TOKEN ?? "" }),
});
```

## Tools

One read — `telegram_get_chat` — and five writes: `telegram_send_message`, `telegram_send_media`,
`telegram_edit_message`, `telegram_pin_message` and `telegram_delete_message` (`destroys`). Every write requires
approval.

There is no `getUpdates` tool. Inbound delivery is a deployment's webhook, not a tool call — a polling tool
would compete with it for the same updates, and Telegram delivers each one once.

## Three things worth knowing

**Sends are paced, not retried.** Telegram's limits are per chat — roughly one message a second — and the
remedy for exceeding them is not to wait and retry but to not have sent that fast. Sends to one chat are
spaced by construction; sends to different chats do not wait for each other.

**An uninvited bot fails like a bad token.** `403 Forbidden: bot is not a member` and `401 Unauthorized` are
told apart, with different remedies named. A bot also cannot message a user who has never messaged it.

**Pinning is silent by default.** A pin notifies every member of a group, and a notification to a thousand
people is not a side effect an agent should cause by omission.

Full documentation: <https://docs.retinue.riseexperts.de/integrations/telegram>

MIT.
