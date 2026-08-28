# @retinue/tools-reddit

Reddit tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: search, read bounded comment
trees, submit and comment.

```bash
npm i @retinue/tools-reddit
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createRedditToolkit } from "@retinue/tools-reddit";

const toolkit = createRedditToolkit({
  credentialRef: "reddit",
  resolver: createStaticCredentialResolver({ reddit: process.env.REDDIT_ACCESS_TOKEN ?? "" }),
  // Required, not defaulted — see below.
  userAgent: { appId: "my-app", version: "1.0.0", contact: "my_reddit_username" },
});
```

## Tools

Four reads — `reddit_search`, `reddit_get_post`, `reddit_list_subreddit`, `reddit_get_user` — and two writes:
`reddit_submit_post` and `reddit_comment`. Both writes require approval and are `publishing`.

## Three things worth knowing

**The `User-Agent` is required, not defaulted.** Reddit answers a missing or generic one with a `429` that looks
exactly like a rate limit and is not — so a client backs off, retries, is refused again, and concludes the API
is overloaded. A shared default would also make every deployment of this package look like one client to
Reddit's limiter, which is what the requirement exists to prevent.

**Subreddit rules are not machine-readable and are not checked.** Flair requirements, karma thresholds,
account-age gates and self-promotion limits are invisible to the API: a submission that breaks one is accepted
and removed by a moderator minutes later. That is the operator's responsibility, and both the tool description
and the docs say so rather than implying otherwise.

**Comment trees are bounded.** A thread can hold tens of thousands of comments across nested listings with
`more` placeholders. Reads stop at 4 levels or 200 comments and report which limit stopped them — including
when a `more` placeholder means Reddit withheld a branch.

Token refresh belongs to the resolver, not this package: a module-level cache would be shared by every tenant
in the process.

Full documentation: <https://docs.retinue.riseexperts.de/integrations/reddit>

MIT.
