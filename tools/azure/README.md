# @retinue/tools-azure

Azure tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: read-first inspection of an Azure
estate, with two gated writes and no way to provision anything.

```bash
npm i @retinue/tools-azure
```

## Why this one is read-first

Everywhere else in this catalogue a gated write costs a person an approval click if it was wrong. Here it can
cost a production environment. So there is no create, no delete, no scale, no deployment and no role
assignment — see **Limits** on the [integration page](https://retinue.dev/integrations/azure), which states
that as a decision rather than apologising for a gap.

## Tools

Seven reads, satisfied by a single `Reader` assignment:

`azure_list_subscriptions` · `azure_list_resource_groups` · `azure_list_resources` · `azure_get_resource` ·
`azure_query_logs` · `azure_get_metrics` · `azure_list_activity_log`

Two writes, both gated and both requiring an idempotency key:

- `azure_tag_resource` — `external-write`. Metadata only, and it **merges**: tags this call did not name are
  kept. `Tag Contributor`.
- `azure_restart_resource` — `destructive`. Causes an outage, is not idempotent from a user's point of view,
  and refuses any resource type outside a short allowlist.

## Usage

```ts
import { withRefreshingCredentials } from "@retinue/agentkit/tools";
import type { CredentialRefresher, CredentialResolver } from "@retinue/agentkit/tools";
import { createAzureToolkit } from "@retinue/tools-azure";

// Yours: reads the stored connection, and exchanges the sealed refresh token for a new ARM access token.
declare const connectionResolver: CredentialResolver;
declare const azureRefresher: CredentialRefresher;

const toolkit = createAzureToolkit({
  credentialRef: "azure",
  // An ARM token lives about an hour; without this the toolkit stops working mid-task.
  resolver: withRefreshingCredentials(connectionResolver, azureRefresher),
  exclude: ["azure_restart_resource"],
});
```

`credentialRef` only. Not the ambient `az` CLI login, not managed identity, and no environment variable — all
three make a toolkit that works on the machine where it was configured and nowhere else.

## Behaviour worth knowing

- **A 403 is either a missing role or a dead credential**, and Azure uses the same status for both. This
  package reads Azure's error code and reports `forbidden` or `unauthorized` accordingly; the `forbidden`
  message names the denied action and the role that would permit it.
- **`Retry-After` is honoured**, and the remaining per-subscription read budget is reported in the message.
- **`azure_query_logs` requires a time span** and refuses an over-wide one rather than shortening it. A query
  silently narrowed answers a different question and reports success.
- **Resource ids are validated locally**, which is both a usability and a security boundary — a name
  containing `?`, `#` or `%` is refused rather than encoded into an authenticated ARM URL.

MIT.
