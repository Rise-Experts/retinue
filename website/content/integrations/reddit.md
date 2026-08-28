---
sidebar_position: 10
---

# Reddit

Search, read bounded comment trees, submit and comment. Read-heavy in practice, and the writes come with a
caveat this page states plainly.

```bash
npm i @retinue/tools-reddit
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `reddit_search` | `read` | never | Across the site or within one subreddit |
| `reddit_get_post` | `read` | never | Post plus a **bounded** comment tree, with the limit that stopped it |
| `reddit_list_subreddit` | `read` | never | hot / new / top / rising |
| `reddit_get_user` | `read` | never | Karma and account age — what subreddit gates are set against |
| `reddit_submit_post` | `external-write` | **always** | Link or self post. **Subreddit rules are yours** |
| `reddit_comment` | `external-write` | **always** | Reply to a post (`t3_…`) or a comment (`t1_…`) |

Both writes are category `publishing`.

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createRedditToolkit } from "@retinue/tools-reddit";

const agent = createAgent({
  manifest: {
    id: "researcher",
    name: "Researcher",
    instructions: "Find what people are saying about our product on Reddit. Read the subreddit's rules before proposing a post.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createRedditToolkit({
      credentialRef: "reddit",
      resolver: createStaticCredentialResolver({ reddit: process.env.REDDIT_ACCESS_TOKEN ?? "" }),
      userAgent: { appId: "my-app", version: "1.0.0", contact: "my_reddit_username" },
    }),
  ],
});
```

## Credentials and scopes

Every Reddit API call needs an **OAuth bearer** — there is no API key, and even the app-only "client
credentials" flow produces one. Register an app at `reddit.com/prefs/apps`.

| What the agent should do | Scopes |
|---|---|
| Search, read posts and subreddits | `read` |
| Read a user's profile | `read`, and `identity` for your own |
| Submit a post | `submit` |
| Comment | `submit` |
| Read comment trees | `read` |

**Token refresh belongs to your resolver, not to this package.** A module-level token cache here would be
shared by every tenant in the process, so one tenant's token would serve another's request — and the failure
would be invisible until an audit asked whose account posted. The resolver is called per request, so a
refreshing resolver is the whole mechanism.

**The `User-Agent` is required and this package will not build without it.** Pass `appId`, `version` and
`contact`; it becomes `retinue:<appId>:<version> (by /u/<contact>)`. A shared default would make every
deployment of this package look like one client to Reddit's rate limiter, which is exactly what the requirement
exists to prevent.

## Behaviour worth knowing

**Subreddit rules are the operator's responsibility, and this is not a disclaimer — it is the main
operational fact.** Flair requirements, minimum karma, minimum account age, self-promotion ratios and posting
cooldowns are set per subreddit and **none of them is exposed by the API**. A submission that breaks one is
accepted with a `200` and removed by a moderator or an automod minutes later. This package cannot check them,
so it does not pretend to: the tool's own description says so, because the model reads that rather than this
page.

What you can do before posting: `reddit_get_user` returns karma and account age, and reading a subreddit's
rules is a human step. Treat an agent's submission as a draft a person approves — which the approval gate
already enforces.

**A missing `User-Agent` looks exactly like a rate limit.** Reddit answers one with a `429`, so a client backs
off, retries, is refused again, and concludes the API is overloaded. Because this package always sends one, its
`429` message names the string it sent — so whoever is debugging does not spend an hour on the wrong hypothesis.

**Comment trees are bounded, and say which bound stopped them.** A thread can hold tens of thousands of
comments as nested `Listing` objects with `more` placeholders that need further requests. Reads stop at 4 levels
of depth or 200 comments and report `truncatedBy`. A `more` placeholder counts as truncation too: it means
Reddit withheld a whole branch, and a walker that skipped it silently would return a plausible tree missing the
busiest sub-thread.

**Reddit answers `200` with its errors inside the body.** `json.errors` carries `SUBREDDIT_NOTALLOWED`,
`NO_TEXT` and the rest — the same envelope lesson as Slack's `ok: false`. Those are treated as failures, and
the message says a subreddit rule is the usual cause.

**A comment parent must be a fullname.** `t3_` is a post and `t1_` is a comment; a bare id would comment on
whichever object that prefix names, which is a silent way to reply to the wrong thing. It is refused.

**Post and comment content is untrusted.** It arrives fenced.

## Limits

| Not offered | Why |
|---|---|
| Voting | A vote is an endorsement, and Reddit's rules on automated voting are strict enough that offering it invites an account ban |
| Deleting or editing posts and comments | Deletion is irreversible and visible; editing leaves a public marker. Neither is an agent's call |
| Moderation — remove, approve, ban, flair others | Moderator powers over other people, where a wrong call cannot be walked back by another call |
| Private messages and modmail | A separate surface with its own consent expectations |
| Multireddits, saved, subscriptions | Account-shaping changes with no read-back worth the name |
| Media upload | Reddit's upload is a signed-S3 dance — the same deferral as Slack's `upload_file` |
| Checking subreddit rules before submitting | The API exposes a `rules` endpoint, but it returns prose written for humans. Parsing it into a machine check would produce confident wrong answers, which is worse than the honest gap |
