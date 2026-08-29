# @retinue/tools-jira

Jira Cloud tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: JQL search, read and edit
issues, move them along their workflow, and comment.

```bash
npm i @retinue/tools-jira
```

Descriptions and comments are **markdown in both directions**. Jira's own format is a JSON document tree (ADF),
and you never see it.

## Use it

```ts
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

const jira = createJiraToolkit({
  credentialRef: "atlassian",
  resolver,
  siteUrl: "https://acme.atlassian.net",
});
```

Pass `jira` in an agent's `tools`. The credential is resolved **per call**, so a rotated token takes effect
without a restart, and nothing here reads the environment itself.

Jira and Confluence share one credential and one site host, so
[`@retinue/tools-confluence`](https://www.npmjs.com/package/@retinue/tools-confluence) wires up alongside this
at no extra cost.

## Tools

| Tool | Effect | Approval |
|---|---|---|
| `jira_search_issues` | `read` | never |
| `jira_get_issue` | `read` | never |
| `jira_list_projects` | `read` | never |
| `jira_list_transitions` | `read` | never |
| `jira_create_issue` | `external-write` | always |
| `jira_update_issue` | `external-write` | always |
| `jira_transition_issue` | `external-write` | always |
| `jira_comment` | `external-write` | always |

Every write requires approval and carries an idempotency key. That is derived from the effect, not set
alongside it, so the three cannot drift apart.

## A transition is not an update

The one thing worth knowing before you wire this up.

Jira's status is not a field — it moves along a **workflow**, and which moves are legal depends on the project's
workflow, the issue's type and its current status. So `jira_update_issue` cannot change status at all, and
`jira_transition_issue` takes a numeric transition id from `jira_list_transitions`.

Passing a status name is refused rather than guessed:

```
"Done" is not a transition id. Transition ids are numeric and specific to this issue's workflow —
call jira_list_transitions to get the ids available right now, then pass one of them.
```

Transition names and status names are different vocabularies that overlap confusingly, and they need not
correspond. A fuzzy match would pick one silently — and the wrong pick *succeeds*, landing the issue somewhere
nobody asked for while reporting success. One extra call cannot be wrong.

## Requirements

- Node 20+
- `@retinue/agentkit` as a peer dependency
- An Atlassian account email and an API token from
  [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens). An API token has **no
  scopes** — it carries exactly the permissions of the account that created it, so use a dedicated account
  rather than a person's.

Full documentation, including per-permission requirements and what is deliberately not built:
[docs.retinue.riseexperts.de](https://docs.retinue.riseexperts.de/integrations/jira).

MIT
