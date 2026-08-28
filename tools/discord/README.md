# @retinue/tools-discord

Discord tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: read channels and history, send
messages, react and open threads.

```bash
npm i @retinue/tools-discord
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createDiscordToolkit } from "@retinue/tools-discord";

const toolkit = createDiscordToolkit({
  credentialRef: "discord",
  // `Bot <token>` — the word `Bot` is part of the value, and omitting it fails with a bare 401.
  resolver: createStaticCredentialResolver({
    discord: { scheme: "custom-header", header: "Authorization", value: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
  }),
});
```

## Tools

Three reads — `discord_list_channels`, `discord_read_messages`, `discord_get_message` — three gated writes —
`discord_send_message`, `discord_reply_message`, `discord_create_thread` — and `discord_add_reaction`, which is
`internal-write` and ungated, the same as Slack's reaction.

## Worth knowing

**An uninvited bot fails like a bad token.** Discord answers `50001 Missing Access` for a bot that is not in
the server and a bare `401` for a bad token — both `401`/`403` shaped. This package tells them apart and names
different remedies, because conflating them sends you off to regenerate a token that was fine.

**It cannot `@everyone` by accident.** Discord's default honours every mention in a message's content, so an
agent relaying a user's text is one character away from a mass ping. Sends go out with mentions disabled.

Messages are counted in code points, so 2000 emoji is a valid message.

Full documentation: <https://docs.retinue.riseexperts.de/integrations/discord>

MIT.
