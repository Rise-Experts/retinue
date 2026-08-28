# @retinue/tools-linear

Linear tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: search, read and edit issues, and
move them between workflow states.

```bash
npm i @retinue/tools-linear
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createLinearToolkit } from "@retinue/tools-linear";

const toolkit = createLinearToolkit({
  credentialRef: "linear",
  // A Linear personal API key goes in `Authorization` **without** a `Bearer` prefix.
  resolver: createStaticCredentialResolver({
    linear: { scheme: "custom-header", header: "Authorization", value: process.env.LINEAR_API_KEY ?? "" },
  }),
});
```

## Tools

Four reads — `linear_search_issues`, `linear_get_issue`, `linear_list_teams`, `linear_list_states` — and three
writes: `linear_create_issue`, `linear_update_issue`, `linear_comment`. Every write requires approval and
carries an idempotency key.

## Worth knowing

**There is no `linear_transition_issue`.** Unlike Jira, a Linear state is a field: any state on the team may be
set, so state belongs in `linear_update_issue`. A second tool would be a confusable near-duplicate.

**States are per team**, and both teams and states are addressed by uuid in the API. Every tool here takes
human identifiers — a team key, an issue identifier like `ENG-123`, a state *name* — and resolves ids itself.
A name that does not match fails naming the ones that do.

**Descriptions and comments are markdown natively**, so nothing is converted in either direction.

Full documentation: <https://docs.retinue.riseexperts.de/integrations/linear>

MIT.
