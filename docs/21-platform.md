# The Platform

Status: decided (boundary, order, deployment model) · programme not started
REQ reference: REQ-042 (#191) · SPEC #195
Depends on: the flow engine (#187, #202), the public surface cut (#199), versioning (#189)

The platform is the product a customer logs into: connections to their Google account, a webhook that starts an
automation, a page showing what an automation did and what it cost, and eventually a canvas to draw one. The
runtime is the product a developer installs.

This document exists to fix three things before any of it is built, because all three are cheap now and
expensive in three months: **where the platform lives**, **what order it is built in**, and **what it is not
allowed to do**. It is not a design for the eight pieces — each needs its own SPEC, and most of them are defined
by what a flow step can be, which is only now settled.

---

## 1. Where it lives: a separate repository, consuming the published package

**Decided.** The reasoning matters more than the conclusion, because the conclusion is the kind that gets
quietly reversed by a deadline.

If the platform lives in this workspace it will import runtime internals. Not maliciously — because they are
*reachable*, and because at 6pm on a Thursday a deep import is cheaper than an API discussion. The sequence is
predictable: one import of something not exported, then a second because the first was fine, and within a month
the runtime cannot be released without releasing the platform, the `exports` map is decorative, and there is one
large product where there were two sellable ones.

Consuming the published package makes the boundary physical rather than cultural. The platform can only use what
is exported; needing more is a runtime release with a version number. That is friction, and the friction is the
feature — it is the moment where "I need this internal" becomes "then it should be public API", which is a
conversation worth having and one nobody has voluntarily.

The cost is honest and should be stated: two repositories, a release cycle between a runtime change and its use,
and prereleases on `next` to make that bearable (see [19-versioning](19-versioning.md)). Worth paying.

It is also what keeps the licensing simple. The runtime is MIT and the platform is proprietary; a
proprietary product built on a permissive *dependency* is ordinary and needs no argument, whereas one built by
reaching into that dependency's internals — vendored, forked, or deep-imported — is a question somebody's
counsel asks at the worst possible moment. The boundary is the answer, which is a second reason to enforce it
mechanically rather than by convention.

### What makes it real today

The argument above is worth exactly what enforces it, and until #195 nothing had ever tried a deep import and
watched it fail. `npm run check:consumer` now does, in the pipeline
([scripts/check-consumer-boundary.mjs](../scripts/check-consumer-boundary.mjs)):

1. `npm pack` the runtime, so the checks run against the artifact a consumer installs — `files` globs applied,
   `src/` absent — rather than through a workspace symlink where the whole tree is readable.
2. Every subpath in `exports` must **load** and **typecheck** from a directory whose only knowledge of the
   package is `node_modules`. Loading, not existing: an entry whose transitive imports are missing ships fine and
   throws on the consumer's first import.
3. Seven deep imports must fail — into `dist/`, into `src/`, at an invented `internal` entry, and at a half-path
   (`/adapters`, whose children are real).
4. The tarball must contain no sources and no sourcemaps. A consumer who can read the internals will read them,
   and then they are the API in practice whatever the map says.

**The one detail worth keeping.** A deep import failing is not the guarantee; failing *with
`ERR_PACKAGE_PATH_NOT_EXPORTED`* is. The first version of the check accepted any error and passed. Sabotaging it
by adding `"./*": "./dist/*"` to the map — the exact mistake being guarded against, which reopens every internal
module as public API — produced `ERR_MODULE_NOT_FOUND` on every forbidden path, because the wildcard aimed them
at `dist/dist/…`. The boundary was wide open and every probe still threw. So the check requires the specific
code: a missing file stops being missing the moment somebody adds it, and then nothing is left refusing the
import.

## 2. Deployment: one multi-tenant service, with dedicated deployment as a different *price*, not a different product

**Decided.** The runtime supports both — every tenant-sensitive call already takes an explicit tenant context,
and [11-authorization](11-authorization.md) is not a deployment-shaped concern. The pricing is what does not
support both, and the failure mode of leaving it open is a fork: a dedicated-install customer asks for something
the shared service cannot do, and the second implementation begins.

So: the shared multi-tenant service is *the* platform. A dedicated deployment is the same image, the same
migrations and the same code, with its own database and its own price — sold on the deployment, not on usage.
What it must never be is a branch, a feature flag, or a second set of tenancy code. If a dedicated customer
needs behaviour the shared service does not have, that behaviour is built in the shared service and configured
off, or it is not built.

## 3. Definitions before the canvas

**Decided: a documented API over the stored definition first, and the studio after.** Weeks rather than months,
and it answers a question the studio cannot: whether the engine's shape is right.

A `FlowDefinition` is data. It can be written by hand, committed to a repository, diffed in a pull request and
generated by a script — and if it *cannot* comfortably be written by hand, that is a finding about the engine,
discovered for the price of writing one down. Build the canvas first and it becomes the only client; every
awkwardness in the definition format is invisible because a program produces it, and the first customer who
wants their automation in version control finds out there is no format to give them.

This also gives the studio its acceptance test: API → studio → API must be byte-identical. A builder that cannot
round-trip is a builder that holds semantics the engine does not, which is two products where one is
undocumented.

---

## The pieces, in dependency order

### 1. Traces

First, deliberately. It is assembled from the run event log and the telemetry that already exist
([12-usage-and-accounting](12-usage-and-accounting.md)), so it is the cheapest thing on this list, and it is the
support tool. Ship the builder first and every customer problem is answered by a database query written by
whoever is awake.

A flow execution already carries what a trace needs: the step records, the child run per agent step, and usage
attributed per member. "What did this automation do, and what did it cost" is one join today — see the
[status table](#acceptance-criteria-status) — and should be one page.

Must not: become a second event store. It reads the runtime's.

### 2. Connections

Per-tenant OAuth, third-party tokens in a credential store. The runtime already models `credentialRef` and never
holds a secret; the platform is what resolves one. This is a security surface first and a feature second — it is
a token store for other people's Google accounts, and it should be specified as such: encryption at rest with a
key the application database cannot decrypt on its own, rotation, revocation that takes effect on in-flight
runs, and an audit record of every resolution.

Must not: put a token anywhere a flow definition, a tool input, a trace or a log can reach. The resolution
happens at the point of use, against a reference.

#### Amendment: the runtime half of connections moved into the package — REQ-063 ([#259](https://github.com/Rise-Experts/retinue/issues/259))

The paragraph above assigns all of this to the platform. That is now split, and the reason is a fact that was not
true when it was written: **the package ships eight toolkits and none of them is usable by a second tenant.**
Every one takes a `credentialRef`, and the only resolver that ships is a static map — so a deployment supports
one tenant per toolkit, configured at boot. Eight more toolkits are specified in the integrations milestone. A
platform that does not exist yet cannot be what unblocks them.

So the line moves, and it moves along the seam that was already there:

| Belongs to the package | Belongs to the platform |
|---|---|
| The `ConnectionStore` port and its adapters | The connect button, and the screen listing what a tenant has connected |
| The `SecretCipher` seam and encryption at rest | The consent copy and the scope explanations a person reads |
| The OAuth flow — authorize, callback, exchange, refresh, revoke | Which providers a tenant is *offered*, and the catalogue that decides |
| Per-tool auth-mode and scope declarations | Reminders, expiry warnings, connection health in a dashboard |

The test of the split: the package must be able to complete an OAuth flow and run a tool with no platform
present, and the platform must add no credential storage of its own. Anything that fails the first half is
under-scoped here; anything that fails the second is the second implementation this document's decision 2
already forbids.

**What does not change.** The security requirements in the paragraph above are the specification for the package
work — not a softer version of it. Three of them shaped the design directly:

- *"encryption at rest with a key the application database cannot decrypt on its own"* is why the recommendation
  in [#261](https://github.com/Rise-Experts/retinue/issues/261) is a `SecretCipher` seam encrypting in the
  application, with Supabase Vault as one implementation of it rather than the foundation. A `pgcrypto` design
  keyed from a column in the same database fails this sentence, and a Vault-only design fails it for every
  deployment not on Supabase.
- *"revocation that takes effect on in-flight runs"* is a harder property than revoking at the provider, because
  a run holding a resolved credential in a local scope has already passed the store. It is an acceptance
  criterion, not an implementation detail.
- *"an audit record of every resolution"* means the resolver is an audited call site, which is a change to
  `CredentialResolver` and therefore belongs with [#260](https://github.com/Rise-Experts/retinue/issues/260)'s
  breaking change rather than after it.

One capability was added that this section did not anticipate: a run that needs a connection it does not have
**pauses and asks**, returning a login URL the way an approval gate returns a decision request, and resuming
when consent completes. That is the runtime's HITL machinery rather than a platform feature, which is a second
reason the flow has to live in the package — see
[#264](https://github.com/Rise-Experts/retinue/issues/264).

### 3. Triggers

Schedule, webhook, connected-account event. Each is an authenticated, rate-limited, replay-protected entry point
into a tenant's automation, and the third is the one that gets forgotten: a webhook without replay protection is
an automation anyone who has seen one delivery can run repeatedly.

Replay protection has three parts and needs all three — a signature over the body, a timestamp window, and a
store of delivery ids already seen. The first two alone leave a valid recent delivery replayable, and the window
is what stops the id store growing forever. The id then maps to the run's idempotency key, so a duplicate
delivery resolves to the *same* execution rather than being rejected: rejection and deduplication look identical
in a test that only counts executions, and only one of them is right when the sender retries because our
response was slow.

### 4. Studio

The visual builder over the flow engine. It edits the stored definition and nothing else — see decision 3.

Must not: hold a step kind the API cannot express, hold layout in the definition (it belongs beside it, or a
hand-written definition becomes invalid for lacking coordinates), or validate differently from the engine. Two
validators disagreeing means a flow the builder accepts and the engine rejects, discovered by a customer.

### 5. Integration catalogue

Third-party tools over the first-party set from #188, each a connection plus a tool definition. The runtime's
tool contract already carries permissions, approval policy and result envelopes, so a catalogue entry is data —
which is the test of whether the tool contract is right.

### 6. Marketplace

Publishing flows and tools between tenants. Needs a trust model before it needs a page: an installed flow is
someone else's definition, running against your data, with your credentials. That is a supply chain, and the
mechanisms are known — review, provenance, a pinned version, and a permission prompt at install that lists what
the flow can reach, derived from the definition rather than written by its author.

Must not: let an installed definition acquire permissions at run time that were not on the prompt at install.

### 7. Organisation management

SSO, roles above the runtime's authorization policy, an audit trail of who changed what. Roles here map onto the
runtime's policy; they do not replace it.

### 8. Billing

Usage and quotas already meter and enforce. This turns metering into plans and invoices, and its correctness
argument is the runtime's: per-modality pricing and the cost ledger are where the number comes from.

---

## What the platform must not do

Four rules, each stated as the failure it prevents rather than as a principle.

**Re-implement authorization.** The runtime decides what a principal may do; the platform decides who a
principal is. Two authorization systems means a permission granted in one and not the other, and the interesting
direction is the one that grants.

**Hold model credentials per user.** Tenant-level, through the same resolution path. Per-user model credentials
make usage unattributable and a leak unbounded in blast radius.

**Own durability.** A flow's state lives in the runtime's stores. A platform process holding half a customer's
automation loses it on deploy — and deploys are frequent, which makes this the rule most likely to be broken by
something that works in testing.

**Bypass approval.** A flow that publishes routes through the approval gate, whatever the builder draws. The
builder is a way to write a definition; it is not a way to be exempt from one.

---

## Acceptance criteria status

#195's acceptance criteria span this repository and a programme that has not started. Split honestly:

| AC | State | Evidence |
| --- | --- | --- |
| **AC-1** consumes the runtime as a published dependency; a deep import fails the build | **holds** | `npm run check:consumer`: 17 subpaths load and typecheck from an installed tarball, 7 deep imports refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`, no sources or sourcemaps shipped. Six sabotages. |
| **AC-7** multi-tenancy is the runtime's, not a second implementation | **holds by construction** | Decision 2 above; the cross-tenant tests are the runtime's and a platform adds no tenancy code. Re-verifiable only once a platform exists. |
| **AC-8** a platform outage does not lose in-flight automation state | **holds in the runtime half** | Flow state is in Postgres; an execution reloads and resumes, and a child run is recovered by the reaper (#187, #202). The platform half is rule 3 above. |
| **AC-5** third-party credentials never in a definition, a tool input or a trace | **half** | The runtime resolves `credentialRef` and never persists a secret. The other half is the connection store, which does not exist. |
| **AC-2** traces before the builder | **ordered, not built** | Piece 1. The data exists: usage joins to the child run that spent it, so cost per member is a query today. |
| **AC-3** every trigger authenticated, rate-limited, replay-protected | **not built** | Piece 3, with the three-part design above. |
| **AC-4** the builder produces only definitions the API can express; round-trip lossless | **not built** | Piece 4, and decision 3 is what makes the round-trip testable before the builder exists. |
| **AC-6** an installed marketplace flow declares what it can reach | **not built** | Piece 6. |

## Follow-up SPECs

Each piece needs its own, in the platform repository's backlog rather than this one, and in this order: traces,
connections, triggers, definition API and format, studio, integration catalogue, marketplace, organisation
management, billing. Writing them before the platform repository exists would put nine specifications for
another codebase in this one.
