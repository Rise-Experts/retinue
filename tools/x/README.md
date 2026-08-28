# @retinue/tools-x

X (Twitter) tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: search and read posts,
publish and delete.

```bash
npm i @retinue/tools-x
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createXToolkit } from "@retinue/tools-x";

const toolkit = createXToolkit({
  credentialRef: "x",
  resolver: createStaticCredentialResolver({ x: process.env.X_BEARER_TOKEN ?? "" }),
  // What you pay for. Reads report it, so an empty answer is interpretable.
  tier: "basic",
});
```

## Tools

Four reads — `x_search_posts`, `x_get_post`, `x_get_user`, `x_list_user_posts` — and two writes: `x_post`
(`confirms`) and `x_delete_post` (`destroys`). Both writes require approval; both are `publishing`.

## Two things worth knowing

**X has two rate limits and reports both as `429`.** A 15-minute burst limit is retryable; a **24-hour cap is
not**, and treating it as retryable makes a run sit in backoff against a limit that resets tomorrow, burning its
entire budget. This package reads the headers and classifies them differently.

**The access tier decides what a read can see.** The free tier cannot search at all, Basic reaches 7 days, Pro
the full archive. Search results say which window was searched, so an empty answer is not mistaken for "nobody
discussed this" — and a search on the free tier is refused locally, saying it is a subscription rather than a
permission.

Posts are counted in code points, so 280 emoji is a valid post.

Full documentation: <https://docs.retinue.riseexperts.de/integrations/x>

MIT.
