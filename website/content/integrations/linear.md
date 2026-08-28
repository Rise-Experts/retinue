---
sidebar_position: 6
---

# Linear

Search, read and edit issues, and move them between workflow states. Descriptions and comments are markdown in
both directions — Linear stores them that way, so nothing is converted.

```bash
npm i @retinue/tools-linear
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `linear_search_issues` | `read` | never | Filter by team, state name or assignee; optional text match |
| `linear_get_issue` | `read` | never | By identifier, `ENG-123` — what a person pastes |
| `linear_list_teams` | `read` | never | The keys every other tool takes |
| `linear_list_states` | `read` | never | **Per team.** Each state's `type` says whether it counts as started, completed or cancelled |
| `linear_create_issue` | `external-write` | **always** | Team by key, state by name |
| `linear_update_issue` | `external-write` | **always** | **Including state** — there is no separate transition |
| `linear_comment` | `external-write` | **always** | Markdown, stored natively |

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createLinearToolkit } from "@retinue/tools-linear";

// A Linear personal API key goes in `Authorization` **without** a `Bearer` prefix.
const resolver = createStaticCredentialResolver({
  linear: { scheme: "custom-header", header: "Authorization", value: process.env.LINEAR_API_KEY ?? "" },
});

const agent = createAgent({
  manifest: {
    id: "triage",
    name: "Triage",
    instructions: "Help triage the ENG board. List a team's states before moving anything into one.",
    modelPolicy: { role: "smart" },
  },
  tools: [createLinearToolkit({ credentialRef: "linear", resolver })],
});
```

## Credentials and scopes

A **personal API key** from Linear's Settings → Security & access → Personal API keys.

**It goes in `Authorization` raw**, with no `Bearer` prefix. This is the single most common way a Linear
integration fails, and the error does not say so — it reports an authentication failure that reads like a bad
key. That is why this toolkit declares `schemes: ["custom-header"]` rather than `bearer`: the header name is
standard and the format is not.

There are no scopes on a personal API key: it carries **exactly the access of the person who created it**,
across every team they can see.

| What the agent should do | What the account needs |
|---|---|
| Read issues, teams and states | Membership of, or visibility into, the teams in scope |
| Create and update issues | The same — Linear does not separate read from write on a personal key |
| Comment | The same |

Two consequences worth planning around:

- **Use a dedicated Linear account** on the teams the agent should reach. A key from an admin's account gives
  an agent that person's whole workspace.
- **A private team is invisible, not forbidden.** `linear_list_teams` simply will not list it, and an issue in
  it reports as not found. The failure says both, because the API cannot tell them apart.

Linear also supports OAuth, whose tokens *are* bearers. That is a second mode and is not offered yet — the
`credentialRef` seam makes it a resolver change rather than a toolkit change.

## Behaviour worth knowing

**A GraphQL `200` carrying `errors` is a failure.** Linear is GraphQL-only, and GraphQL reports application
errors with an HTTP 200 and `data: null`. The transport reads the envelope and surfaces the first message, so
you get `Entity not found: Team` rather than an internal error about reading a field off null.
`AUTHENTICATION_ERROR` and `FORBIDDEN` in that envelope map to `unauthorized` and are not retryable, because
that distinction exists nowhere else.

**A mutation can report `success: false` with no errors at all.** The envelope reader cannot catch that — the
GraphQL call succeeded — so each write checks it explicitly. Without that, the tool would report a created
issue that does not exist.

**There is no `linear_transition_issue`, deliberately.** Jira needs one because its status moves along a
workflow whose legal moves depend on the issue. Linear has no such constraint: any state on the team may be
set, so state is a field on `linear_update_issue`. Inventing a second tool would create the confusable
near-duplicate that measurably costs tool-selection accuracy.

**States are per team, and so is their meaning.** A state called "In Review" on one team may not exist on
another, and whether it counts as done is in its `type`, not its name. `linear_list_states` returns both, in
board order.

**Text search narrows the page, and says so.** Linear's issue filter has no free-text field — full-text search
is a separate connection with a different shape — so a `query` is applied to the issues the filters returned.
The result carries a note saying exactly that, rather than implying it searched the workspace.

**Issue content is untrusted.** It arrives fenced. A description instructing the model to close something is
data, and the close would still stop for approval.

## Limits

| Not offered | Why |
|---|---|
| Deleting or archiving issues | Archive is Linear's soft delete and is reversible only through the UI. Moving to a cancelled state is the reversible way to say "no" |
| Creating or editing teams, states, labels or templates | Workspace-shaping changes that affect every other integration |
| Projects, cycles, roadmaps and initiatives | Each is a separate entity graph with its own semantics. Worth its own task rather than a partial version here |
| Sub-issues and issue relations | The relation types (`blocks`, `duplicate`, `related`) carry planning meaning an agent should not be asserting unprompted |
| Attachments | Upload to a second host — the same deferral as Slack's `upload_file` |
| Assigning by name | Linear's `assigneeId` is a uuid, and resolving a display name to a person is a guess with a real cost when two people share a first name. `assigneeId` is accepted; a name is not |
| Webhooks and OAuth app management | Standing configuration, which is a deployment decision rather than an agent's |
