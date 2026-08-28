# @retinue/tools-jira

Jira Cloud tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: JQL search, read and edit
issues, move them along their workflow, and comment.

```bash
npm i @retinue/tools-jira
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createJiraToolkit } from "@retinue/tools-jira";

const toolkit = createJiraToolkit({
  credentialRef: "atlassian",
  // Basic, not bearer: Atlassian takes an account email and an API token.
  resolver: createStaticCredentialResolver({
    atlassian: {
      scheme: "basic",
      username: process.env.ATLASSIAN_EMAIL ?? "",
      password: process.env.ATLASSIAN_API_TOKEN ?? "",
    },
  }),
  siteUrl: "https://acme.atlassian.net",
});
```

Pass it to an agent's `tools`. Jira and Confluence share one credential and one site host, so
[`@retinue/tools-confluence`](https://www.npmjs.com/package/@retinue/tools-confluence) wires from the same
resolver.

## Tools

Four reads — `jira_search_issues`, `jira_get_issue`, `jira_list_projects`, `jira_list_transitions` — and four
writes: `jira_create_issue`, `jira_update_issue`, `jira_transition_issue`, `jira_comment`. Every write requires
approval and carries an idempotency key.

## Two things worth knowing before you wire it

**A transition is not a field, and this toolkit will not guess.** Status moves along a workflow, so
`jira_update_issue` cannot change it and `jira_transition_issue` takes a numeric id from
`jira_list_transitions`. A status name is refused rather than fuzzy-matched: transition names and status names
are different vocabularies that overlap, and a wrong guess *succeeds* — the issue moves somewhere nobody asked
for and the tool reports success.

**Descriptions and comments are markdown in both directions.** Jira's own format is a JSON document tree (ADF);
you never see it. Paragraphs, headings, lists, code, links and inline emphasis round-trip exactly; panels,
tables and other structures degrade to their text rather than throwing.

Full documentation, including permissions and what is deliberately not built:
<https://docs.retinue.riseexperts.de/integrations/jira>

MIT.
