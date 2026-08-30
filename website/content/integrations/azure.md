---
sidebar_position: 13
---

# Azure

Read-first inspection of an Azure estate: subscriptions, resources, metrics, the activity log, and KQL against
Log Analytics. Two writes — a tag and a restart — and nothing that can create or destroy infrastructure.

```bash
npm i @retinue/tools-azure
```

## Tools

The **role** column is the least-privileged built-in role that permits the call. It is not the only role that
works — `Owner` works for everything — it is the narrowest one, which is what an administrator should actually
assign. Every read here is satisfied by a single `Reader` assignment at the subscription or group scope.

| Tool | Effect | Approval | Minimum RBAC role |
|---|---|---|---|
| `azure_list_subscriptions` | `read` | never | `Reader` |
| `azure_list_resource_groups` | `read` | never | `Reader` |
| `azure_list_resources` | `read` | never | `Reader` |
| `azure_get_resource` | `read` | never | `Reader` |
| `azure_query_logs` | `read` | never | `Log Analytics Reader` |
| `azure_get_metrics` | `read` | never | `Monitoring Reader` |
| `azure_list_activity_log` | `read` | never | `Monitoring Reader` |
| `azure_tag_resource` | `external-write` | **always** | `Tag Contributor` |
| `azure_restart_resource` | `destructive` | **always** | per type — see below |

`azure_restart_resource` refuses any resource type not in this table, before sending anything:

| Resource type | Minimum role | What a restart does |
|---|---|---|
| `Microsoft.Compute/virtualMachines` | `Virtual Machine Contributor` | Reboots the VM; everything on it stops |
| `Microsoft.Web/sites` | `Website Contributor` | Restarts the app service; in-flight requests are dropped |
| `Microsoft.ContainerInstance/containerGroups` | `Contributor` | Restarts every container in the group |

The allowlist is the safety property. `POST {id}/restart` is a convention, not a rule — the path, the
api-version and the meaning all vary by provider, and some providers spell something considerably worse than a
restart the same way. A generic "append `/restart` and hope" would be a destructive tool whose blast radius is
whatever a caller can name.

## Wire it up

```ts
import { bearer, refreshable, withRefreshingCredentials } from "@retinue/agentkit/tools";
import type { CredentialRefresher, CredentialResolver } from "@retinue/agentkit/tools";
import { createAzureToolkit } from "@retinue/tools-azure";

// Your own: reads the stored connection for this tenant.
declare const connectionResolver: CredentialResolver;

// Your own: exchanges the sealed refresh token for a new ARM access token.
const azureRefresher: CredentialRefresher = {
  async refresh() {
    const { accessToken, expiresInSeconds } = await exchangeStoredRefreshToken();
    return refreshable(bearer(accessToken), new Date(Date.now() + expiresInSeconds * 1000).toISOString());
  },
};
declare function exchangeStoredRefreshToken(): Promise<{ accessToken: string; expiresInSeconds: number }>;

// An ARM access token lives about an hour. Without this the toolkit stops working mid-task.
const resolver = withRefreshingCredentials(connectionResolver, azureRefresher);

const toolkit = createAzureToolkit({
  credentialRef: "azure",
  resolver,
  // The tool most worth removing, named explicitly — a typo here throws rather than being ignored.
  exclude: ["azure_restart_resource"],
});
```

A read-only deployment is `include`-ing the seven reads, or simply granting the credential nothing but
`Reader`: the two writes then fail with a message naming the role they would need, which is a clearer signal to
an operator than a tool that is missing.

## Credentials and scopes

**OAuth only, and `credentialRef` only.** Azure AD has no personal-access-token equivalent for ARM. Both
supported paths — a user consenting, and a service principal's client-credentials grant — produce a bearer
token for the `https://management.azure.com/.default` scope.

This package deliberately does **not** support:

- the ambient `az` CLI login,
- managed identity or the IMDS endpoint,
- any environment variable.

All three would make the toolkit work on the machine where it was set up because of state that machine happens
to hold, and fail everywhere else with a 401 that explains nothing. A source-level test asserts none of those
names appear in the package.

Azure has two independent permission systems and they are routinely confused:

- **OAuth scope** decides whether the token may talk to ARM at all. There is one, and it is all or nothing.
- **RBAC role assignment** decides what that identity may do, per scope. This is the one that actually gates
  each tool, and it is granted in the portal or with `az role assignment create` — never through consent.

Which is why a missing role and an expired token get different error codes here. See below.

## Behaviour worth knowing

**A 403 means two different things.** Azure answers both "you lack a role" and, on some endpoints, "your token
expired" with `403`, and the remedies are opposite: an administrator grants a role, or a person reconnects the
account. This package reads Azure's own error code out of the body and reports the first as `forbidden` and the
second as `unauthorized`, so a caller can branch without matching on prose. The `forbidden` message names the
action that was denied and the role that would permit it.

**Throttling tells you how long.** ARM rate limits per subscription and per operation type, and a `429` carries
`Retry-After`. That number is used rather than a default backoff. The read budget
(`x-ms-ratelimit-remaining-subscription-reads`) is included in the error message, so an operator can see a
throttle approaching instead of discovering it.

**Log queries are bounded, and refuse rather than clamp.** `azure_query_logs` requires `timespanHours`, caps it
at seven days, and applies a row limit that reports `truncated`. An over-wide request is **refused with the
limit named**, not silently narrowed — a query quietly shortened from thirty days to seven answers a different
question and reports success, and "no errors in the last month" would then be a false statement produced by a
tool that did not error.

**Log Analytics goes through ARM, not `api.loganalytics.io`.** The dedicated host needs a token for its own
audience — a second credential under one `credentialRef`, which would work for whoever configured it and fail
for everyone else. ARM proxies the same query API, so there is one host and one token. The cost is an older
api-version.

**Resource ids are parsed before use.** A malformed id fails locally with an explanation, rather than becoming
a `404` that is indistinguishable from a resource in a subscription this credential cannot see. The check is
also a security boundary: an id is interpolated into a URL to which every call appends `?api-version=`, so a
"name" containing `?`, `#` or `%` is refused rather than encoded.

**Reads are one page.** `truncated` says when there is more. Nothing here follows `nextLink`, because a list
tool that silently pages can pull an entire subscription's inventory into a model's context.

## Limits

**There is no way to create, delete, scale, deploy, or assign a role.** That is a decision, not a gap.

Everywhere else in this catalogue a gated write costs a person an approval click if it was wrong. Here it can
cost a production environment — and unlike a sent message, an accidentally deleted resource group is not
embarrassing, it is an outage with a restore procedure attached. The approval gate is a good mechanism and it
is not a good enough mechanism for `az group delete`, because the person approving is reading a tool call, not
a change plan.

Provisioning also already has a better tool than an agent: Terraform, Bicep and ARM templates exist, are
reviewed, and leave a diff. An agent that can create infrastructure outside that loop creates infrastructure
nobody's state file knows about, which is a worse problem than the one it solved.

So this package is for **understanding** an estate — what is there, what changed, what the logs say, what the
metrics show — plus the two writes that are safe to reason about: a tag, which changes no running behaviour,
and a restart, which is the one remediation an on-call agent is genuinely asked for.

Also not built:

- **No `nextLink` paging.** `truncated` is reported; narrow the query instead.
- **No metric dimension filtering.** A metric split by dimension returns several series and this package shows
  the first, so exposing dimensions without filtering would present an unlabelled ambiguity.
- **No tag removal.** Removing one requires `Replace` semantics, which delete every tag not named in the
  request — a metadata write that can silently drop cost-centre attribution is not a `confirms()`.
- **No management-group or tenant scope.** Every id must be subscription-scoped.
