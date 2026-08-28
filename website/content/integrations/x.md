---
sidebar_position: 9
---

# X

Search and read posts, publish, and delete. Read-heavy in practice: an agent researches a topic far more often
than it posts.

```bash
npm i @retinue/tools-x
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `x_search_posts` | `read` | never | **Tier-dependent.** Reports which window it searched |
| `x_get_post` | `read` | never | With public metrics and the author's handle |
| `x_get_user` | `read` | never | By handle or id |
| `x_list_user_posts` | `read` | never | By user id — `x_get_user` turns a handle into one |
| `x_post` | `external-write` | **always** | Public and immediate. Optional reply-to |
| `x_delete_post` | `destructive` | **always** | Irreversible, and the deletion is itself public |

Both writes are category `publishing`.

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createXToolkit } from "@retinue/tools-x";

const agent = createAgent({
  manifest: {
    id: "listener",
    name: "Listener",
    instructions: "Track what people are saying about our product. Draft replies; never post without being asked.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createXToolkit({
      credentialRef: "x",
      resolver: createStaticCredentialResolver({ x: process.env.X_BEARER_TOKEN ?? "" }),
      tier: "basic",
    }),
  ],
});
```

## Credentials and scopes

Two credentials, both bearers on the wire and **not interchangeable**:

| What the agent should do | Credential | Notes |
|---|---|---|
| Read posts, users and timelines | **App-only bearer** | Simplest. Cannot post — a post needs a user context |
| Publish or delete | **OAuth 2.0 user token** with `tweet.read tweet.write users.read offline.access` | `offline.access` is what makes a refresh token possible |

**The access tier is the other half of the answer, and it is a subscription rather than a scope:**

| Tier | `x_search_posts` | Other reads | Writes |
|---|---|---|---|
| Free | **Not available** | Very limited | ~500 posts/month |
| Basic | Last **7 days** | Yes | Yes, capped |
| Pro | **Full archive** | Yes | Yes |
| Enterprise | Full archive | Yes | Yes |

Pass `tier` so the toolkit can refuse a search the tier cannot perform, locally, rather than letting X answer
`403` with a "client-not-enrolled" message that a model reads as transient and retries.

X answers `403` for both a missing scope and an unavailable endpoint, and its message rarely says which. The
failure names both possibilities for that reason.

## Behaviour worth knowing

**Two rate limits, both reported as `429`, and only one of them is retryable.** This is the single most
important behaviour here:

- The **15-minute burst limit** (`x-rate-limit-remaining` / `-reset`) is retryable, and the failure carries the
  exact wait X states.
- The **24-hour cap** (`x-user-limit-24hour-remaining` / `x-app-limit-24hour-remaining`) is **not retryable**,
  and deliberately carries no `retryAfterMs` — a delay that long is not a delay, it is a different day.

A handler that treats them alike makes a run sit in exponential backoff against a limit that resets tomorrow,
consuming its whole budget waiting for something that cannot happen. The failure says so:

```
X's 24-hour cap for this endpoint is exhausted; it resets 2026-06-02T09:14:00.000Z. This is not a
burst limit and waiting will not help within this run — stop, and try again after the reset.
```

**Reads say what they could see.** Every search result carries `searched` and `tier`, not only the empty ones,
because an empty answer means "nothing matched", "your tier cannot see back that far", or "your tier cannot do
this" — and the API does not distinguish them.

**A post is counted in code points.** `String.length` counts UTF-16 units, so 280 emoji measures 560 and would
be refused wrongly. X counts what a person would call characters, and so does this.

**A delete can fail with a `200`.** X answers `{"data":{"deleted":false}}` when it declines, which a status
check misses entirely — the same envelope lesson as Slack's `ok: false`. That is treated as a failure.

**Post content is untrusted.** It arrives fenced. A post instructing the model to reply with something is data,
and the reply would still stop for approval.

## Limits

| Not offered | Why |
|---|---|
| Media upload | Chunked upload to a second host with its own auth — the same deferral as Slack's `upload_file` |
| Likes, reposts, bookmarks, follows | Public acts under the operator's brand with no undo semantics worth the name, and each one is an endorsement a person should make |
| Direct messages | A separate surface with a separate scope and separate consent expectations. Worth its own task |
| Lists, spaces, communities | Each is a distinct entity graph; a partial version would hide that |
| Streaming and filtered-stream rules | A long-lived connection is a deployment's concern, not a tool call |
| Full-archive search on a tier that lacks it | Refused locally rather than attempted, so the failure names the subscription |
| Editing a post | X's edit window is subscription-gated and time-limited, and an edit that silently fails would be worse than no edit tool |
