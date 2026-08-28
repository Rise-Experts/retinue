---
sidebar_position: 4
---

# Jira

Search with JQL, read and edit issues, move them along their workflow, and comment. Descriptions and comments
are markdown in both directions — Jira's own format is a JSON document tree, and you never see it.

```bash
npm i @retinue/tools-jira
```

Jira and Confluence share one credential and one site host, so a deployment that wires this also wires
[Confluence](./confluence.md) at no extra cost.

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `jira_search_issues` | `read` | never | JQL, sent as a POST body — a JQL string in a query parameter is the most common way this call fails |
| `jira_get_issue` | `read` | never | Fields, status, assignee, labels and recent comments, all as markdown |
| `jira_list_projects` | `read` | never | The keys search and create take |
| `jira_list_transitions` | `read` | never | **Not optional** — see below. Gives each transition's id *and the status it lands in* |
| `jira_create_issue` | `external-write` | **always** | Markdown description, converted for you |
| `jira_update_issue` | `external-write` | **always** | Summary, description, assignee, labels, priority. **Never status** |
| `jira_transition_issue` | `external-write` | **always** | Takes a transition **id**; refuses a status name |
| `jira_comment` | `external-write` | **always** | Markdown in, ADF out |

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createJiraToolkit } from "@retinue/tools-jira";

// Basic, not bearer: Atlassian takes an account email and an API token.
const resolver = createStaticCredentialResolver({
  atlassian: {
    scheme: "basic",
    username: process.env.ATLASSIAN_EMAIL ?? "",
    password: process.env.ATLASSIAN_API_TOKEN ?? "",
  },
});

const agent = createAgent({
  manifest: {
    id: "triage",
    name: "Triage",
    instructions:
      "Help triage the ENG board. Before moving an issue, list its transitions and say which one you intend to use.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createJiraToolkit({
      credentialRef: "atlassian",
      resolver,
      siteUrl: "https://acme.atlassian.net",
    }),
  ],
});
```

## Credentials and scopes

An **account email plus an API token**, presented as HTTP Basic. Create the token at
`id.atlassian.com/manage-profile/security/api-tokens`. There are no scopes on an API token: it carries
**exactly the permissions of the account that created it**, which is the single most important thing to know
here.

| What the agent should do | What the account needs |
|---|---|
| Search and read issues | *Browse Projects* on the projects in scope |
| Create issues | *Create Issues* |
| Edit summary, description, labels, priority | *Edit Issues* |
| Assign | *Assign Issues* (separate from *Edit Issues*) |
| Transition | *Transition Issues*, **and** the workflow condition on that specific transition |
| Comment | *Add Comments* |

Two consequences worth planning around:

- **Use a dedicated Atlassian account**, not a person's. An API token from an admin's account gives an agent
  admin's reach over every project, and revoking it later logs that person out of their own integrations.
- **A transition can be barred by the workflow itself**, not by a permission — a condition like "only the
  assignee may start work". `jira_list_transitions` returns what is legal *right now* for this issue and this
  account, which is why reading it is the only reliable way to know.

A missing permission comes back as `unauthorized` and is **not retryable**, naming Atlassian's own message.

## Behaviour worth knowing

**A transition is not a field, and this toolkit will not guess.** Jira's status moves along a workflow, and
which moves are legal depends on the project's workflow, the issue's type and its current status. So
`jira_update_issue` cannot change status at all, and `jira_transition_issue` takes a numeric transition id from
`jira_list_transitions`.

Passing a status name is refused:

```
"Done" is not a transition id. Transition ids are numeric and specific to this issue's workflow —
call jira_list_transitions to get the ids available right now, then pass one of them. A status name
is not a transition id, and this tool will not guess between them.
```

That refusal is deliberate and it is the most opinionated thing in this package. Transition names and status
names are different vocabularies that overlap confusingly — "Done" is usually a status and sometimes a
transition, and they need not correspond. A fuzzy match would pick one silently, and the wrong pick *succeeds*:
the issue lands somewhere nobody asked for and the tool reports success. One extra call cannot be wrong.

`jira_list_transitions` returns `to` alongside `name` because "move it to In Progress" is about the status a
transition **lands in**, which is often not what the transition is called.

**A transition is read back, not assumed.** A workflow can carry a post-function that changes more than the
status, so the tool re-reads the issue and reports where it actually ended up.

**A `404` may mean permission, not absence.** Jira answers `404` identically for an issue that does not exist
and one this account cannot see. The failure says both, because reporting "not found" would send a model looking
for a different key when the real problem is access.

**A `409` or `412` is a `conflict` and is not retryable.** Somebody edited the issue in between. Retrying the
identical call would conflict again; the message says to re-read and re-apply.

**Descriptions and comments are ADF, and conversion is lossy on purpose.** Jira's format is a JSON document
tree. Paragraphs, headings, bullet and ordered lists, code blocks, links, bold, italic, strikethrough and inline
code round-trip exactly. Everything else — panels, tables, expands, media, status lozenges — **degrades to its
text** rather than throwing. A tool that refused a document containing a panel would fail on the real issues in
any real Jira project, and the information a model needs is in the text.

Mentions keep their display name where ADF carries one, so "somebody was named here" is not silently lost.

**Issue content is untrusted.** It arrives fenced. An issue description instructing the model to close
something is data, and the close would still stop for approval.

## Limits

| Not offered | Why |
|---|---|
| Deleting issues, comments or projects | Irreversible, and Jira's own UI hides it behind an admin role. Closing with `not_planned` is the reversible way to say "no" |
| Creating or editing workflows, screens, field configurations | Instance-wide changes that affect every project and every other integration |
| Attachments | Multipart upload to a second host — the same deferral as Slack's `upload_file` |
| Worklogs and time tracking | A timesheet is a claim about what a *person* did, which an agent should not be filing |
| Sprints and boards (Agile API) | A separate API with its own permission model. Worth its own task rather than a partial version here |
| Custom fields by id | `customfield_10042` is exactly the opaque identifier this project refuses to put in a schema. Needs a name-resolving design first, like `github_set_project_field` |
| Bulk operations | One call that changes fifty issues is one approval for fifty acts |
| Atlassian 3LO OAuth | The `credentialRef` seam makes this a resolver change rather than a toolkit change, so it waits for a registered app |
