<img src="https://raw.githubusercontent.com/Rise-Experts/retinue/main/brand/retinue-mark.svg" alt="Retinue" width="72" />

# Retinue — reusable AI platform packages

TypeScript implementation of the specifications in [`docs/`](docs/README.md). The palette, type pairing and usage
rules are in [`brand/tokens.json`](brand/tokens.json), measured by `npm run check:brand`.

| Folder | Package | Runs where |
|---|---|---|
| [`backend/`](backend) | `@retinue/agentkit` | Server: runtime, tools, MCP, skills, context, HITL, persistence adapters. **The root is five values and every type** — everything else is behind one of fifteen documented subpaths (#199), and the root's runtime graph reaches nothing at all |
| [`backend/src/tools/library/`](backend/src/tools/library) | `@retinue/agentkit/tools` | Twenty first-party tools — web fetch and search, HTTP, CSV, JSON, read-only SQL, knowledge search, attachments, path-scoped files, a sandboxed shell, time and arithmetic. No optional peer: they reach the network through the platform's own egress policy |
| [`backend/src/server/`](backend/src/server) | `@retinue/agentkit/server` | The reference GraphQL host: Yoga, the SSE endpoint, configuration and health probes. A subpath rather than its own package since #196 — one install, and the boundary is enforced by path (rules R12/R13) rather than by package name |
| [`services/api/`](services/api) | `@retinue/api-service` | A Nest.js service serving the platform's schema through Nest's container — the second consumer, and the one that tests whether the package can be wired more than one way |
| [`examples/`](examples) | `@retinue/example-app` | The reference application: what a deployment's own app module looks like |
| [`frontend/`](frontend) | `@retinue/react` | Client: headless React state, subscriptions and typed part reducers |
| [`tools/*`](tools) | `@retinue/tools-*` | **Sixteen integration packages, 161 tools.** Siblings, not folders in the runtime — a vendor's API change is a patch to one small package, not a platform release. Listed below |
| [`shareflow/`](shareflow) | `@retinue/shareflow` | The ShareFlow integration: its tools, context providers, skills and agent manifests. Depends on `backend`; nothing generic depends on it |
| [`brand/`](brand) | — | The marks, and the palette and type as tokens |
| [`docs/`](docs) | — | The specifications these packages implement |

## The integration packages

Each ships on its own version and is invisible to `@retinue/agentkit`. Install only what you use.

| Package | Tools | Worth knowing |
|---|---|---|
| `tools-github` | 44 | Code, issues, pull requests, reviews, actions, releases |
| `tools-google` | 28 | Gmail, Calendar, Drive, Docs, Sheets. The access token **must be refreshable** — Google's expires in about an hour |
| `tools-meta` | 10 | WhatsApp and Instagram, each surface toggled by its own id |
| `tools-azure` | 9 | Read-first by design: one tag write, one restart, and no create, delete or scale at all |
| `tools-jira` | 8 | The transition read ships with the transition write — a transition id is per workflow |
| `tools-linear` | 7 | The key goes in `Authorization` with **no** `Bearer` prefix; Linear rejects the prefixed form |
| `tools-notion` | 7 | Property names are validated before the call, not after the error |
| `tools-discord` | 7 | `Bot <token>` — the word is part of the value |
| `tools-confluence` | 6 | Shares Jira's credential; updates carry a version check |
| `tools-telegram` | 6 | Updates, messages, media |
| `tools-x` | 6 | The subscription tier is stated by the deployment, and reads report it |
| `tools-reddit` | 6 | Wants a user agent identifying *your* deployment, so it is configuration |
| `tools-browser` | 6 | You supply the browser: no driver ships, because isolation is the operator's decision (`docs/30`) |
| `tools-email` | 4 | One gated send and a **byte-identical** preview. Needs SPF, DKIM and DMARC on the sending domain |
| `tools-slack` | 4 | Reads the response envelope rather than the HTTP status — Slack answers `200` with `ok: false` |
| `tools-scrape` | 3 | SSRF closed at connect time, not at parse time; robots.txt honoured by default |
| `tools-search` | 0 | Supplies **providers** for the `web_search` the runtime already ships. One contract, several vendors |

## Status

The runtime is implemented and durable. All nineteen storage ports pass the shared conformance
suite against three adapters — in-memory, PostgreSQL and Supabase — and runs execute across worker
processes with a durable queue, per-conversation serialization, crash recovery and resumable
streaming.

Progress is tracked as a live matrix, published by CI on every run: see
`backend/.conformance/conformance-matrix.md` from any build. A cell that is neither passing nor
explicitly tracked to an issue fails the build, so absence is classified rather than invisible.

Anything not stated in the specifications is marked `@proposed` in the source and is not settled.

## Workspace

These four packages are npm workspaces of the repository root. `web/` and `mobile/`
are deliberately **not** members — they keep their own lockfiles, and CI installs
`web/` independently.

```bash
npm install          # from the repository root
npm run typecheck
npm run build        # before npm test: the release-gate CLI imports the built @retinue/agentkit
npm test
```

## CI

`ci.yml` runs on **GitHub-hosted runners**, which are free on a public repository. It ran on a self-hosted
runner while the repository was private and hosted minutes were exhausted; going public reversed both facts at
once, and a self-hosted runner on a public repository would execute a fork's pull request on our own hardware.
`ci-local.mjs --verify` now fails if a `pull_request`-triggered workflow names one.

`Jenkinsfile` describes the same pipeline for a Jenkins server, which is optional and not the package's gate.
What it adds is **test trends** — "this test has failed 3 of the last 20 builds" — which nothing in the Actions
UI provides. Setup, the plugin list, the stage-by-stage reasoning and the two hazards are in
[`docs/20-self-hosted-ci.md`](docs/20-self-hosted-ci.md).

```bash
npm run ci:local        # the same commands, on this machine
npm run release:check   # the full gate, plus the manifest checks a release needs
```

There is also a `Jenkinsfile`, for test **trends** — the one thing neither the Actions UI nor a console log gives.
`ci-local.mjs --verify` runs inside `npm test` and reads all three definitions, failing if `ci.yml` gains a command
the local runner or Jenkins lacks. Three descriptions of one pipeline reliably drift, and the one nobody watches
is the one that stops catching things.

## Names that still say `agentkit`

The packages are `@retinue/*` and the environment variables are `RETINUE_*` (#192). Some names were
left alone on purpose, because renaming them is a *migration* rather than an edit:

| Name | Why it stays |
|---|---|
| `agentkit-lock:*` Redis keys | Two processes must agree on a lock's name. Changing the prefix in a rolling deploy means old and new instances hold different locks for the same conversation — the exact race the lock exists to prevent. Renaming needs a release that reads both prefixes and a later one that stops |
| `x-agentkit-tenant`, `x-agentkit-principal`, `x-agentkit-roles` | Request headers are a wire contract. Every caller sends them today; renaming breaks them at the same moment the server starts expecting the new spelling |
| `schema_migrations` ids, `agentkit_example` schema | Applied migrations are recorded by id, and the schema name is where the data physically is. Both are what an existing database already contains |
| `mcp__agentkit-docs__*` tool ids | Tool ids appear in stored run history and in approval grants. Renaming them orphans grants that name the old id |
| the `agentkit` Worker that serves the docs site | Renaming a Worker is not an edit: `wrangler deploy` with a new `name` creates a second Worker and leaves the first serving the live domain. Moving the bindings and deleting the old one buys nothing over leaving the name alone |
| `agentkit-test-pg`, `agentkit-test-redis`, `agentkit-test-pgvector` | Local container names on developer machines. Renaming them orphans running containers and their volumes |

`RETINUE_*` variables fall back to their `AGENTKIT_*` spelling and warn once per variable, so an
existing deployment keeps booting; the fallback goes away in the next minor release.

The exported identifiers that still said `Agentkit` — `AgentkitConfig`, `AgentkitApp`, `createAgentkitHost`,
`AgentkitHost`, `AgentkitWorkerApp`, `AgentkitResolvers`, and `@retinue/react`'s `AgentkitClient`,
`AgentkitProvider` and `useAgentkitClient` — were renamed to `Retinue*` in #200. They were deferred out of the
package rename because they are public API and a breaking change; they are renamed *now* for the same reason,
since nothing is published yet and after the first publish it costs a major version and a migration guide.

## The release gate

Releases are gated on measured quality. `evals/thresholds.json` holds the per-dimension thresholds — data, not
code, with the reason each one holds its value written next to it. `evals/trend.json` is the committed,
append-only record of quality per release, and each entry stores the thresholds it was judged against, so
`git log -p evals/` distinguishes "quality improved" from "we moved the bar".

```bash
npm run release:gate -- --report <scored-run.json> [--baseline <prev.json>] [--record]
```

Exit codes: **0** pass or overridden, **1** a quality failure, **2** a usage error. An override needs both
`RETINUE_GATE_OVERRIDE_ACTOR` and `RETINUE_GATE_OVERRIDE_REASON`; half of one is refused rather than ignored,
and the trend entry records both. The CI job runs on a release tag and on demand, not on every push. See
`docs/09-quality-and-release.md` — including what the gate cannot yet do, which is score a live run.

## Telemetry

`src/telemetry` is a vendor-neutral port — traces, metrics and structured logs — and `src/adapters/otel` is the
only place OpenTelemetry is imported, enforced by boundary rule **R11**. `@retinue/agentkit` has no runtime
dependency on any OTel package: pass your own `TracerProvider` and `MeterProvider`, and your collector endpoint
stays in your wiring where it belongs.

Two guarantees are structural rather than conventional. A log line's message is a **closed union of literals**,
so no caller can put a prompt in it. Its fields are an **allowlist**, so a field nobody has heard of is dropped
without anyone having predicted it. See `docs/09-quality-and-release.md` for the rest, including what is not yet
wired.

## Load and resilience

`npm run loadtest -- --pg <url> --mode staircase|soak|inject` drives real workers against a real PostgreSQL
server and writes a JSON report. The measured envelope, the failure-injection results and a runbook per failure
mode are in [`docs/16-load-and-resilience.md`](docs/16-load-and-resilience.md) — including what has *not* been
measured, which is a deployed HTTP instance and a multi-hour soak.

## Security review

`npm run security:review` prints the checklist, the findings register and the checks a person must still walk by
hand, and exits non-zero once an accepted finding passes its revisit date. Everything a machine can decide is
asserted in `backend/src/__tests__/security-audit.test.ts` and runs in `npm test`.

Findings, severities and resolutions: [`docs/17-security-review.md`](docs/17-security-review.md). Two properties
worth knowing when writing a context provider: `ContextSection.origin` is required and has no default, and a
`platform` section that interpolates a user-supplied value must neutralise it.

## Data retention

`run_events` is pruned past a configured retention period — **default 90 days**, provisional until a product
owner ratifies it, in `backend/src/retention/index.ts`. Events belonging to a **non-terminal** run are never
deleted, whatever their age: a run waiting on a human approval for four months still needs its log for recovery.

Pruning is a bounded, callable operation on a separate maintenance surface; `RunEventLog` stays append-only.
There is no scheduler yet. See [`docs/18-data-retention.md`](docs/18-data-retention.md).

## Boundaries

Per [`docs/01-architecture.md`](docs/01-architecture.md), these packages must build and
test with neither ShareFlow/Chorus nor Twenty installed:

- `backend` imports no ShareFlow domain code and no UI.
- `frontend` is headless and carries no product styling.
- Adapters implement ports; ports never import adapters.
- No public API contains Twenty names or types.
- A generic package never imports `shareflow`, and `shareflow` never imports the ShareFlow
  application. The seam is the interfaces in `shareflow/src/services/` — declared there and
  implemented by ShareFlow, so the dependency points one way only.
- The AI SDK is confined to `backend/src/models`, and OpenTelemetry to `backend/src/adapters/otel`. Both are
  the same rule: a provider dependency that leaks out of its adapter is one the whole platform then has.
- Every package may only import what its own `package.json` declares. npm hoists all workspace
  dependencies into one `node_modules`, so an undeclared import works here and fails wherever the
  package is installed alone — the manifest is the only place "builds without ShareFlow installed"
  is actually written down.

`npm run check:boundaries` enforces all of the above and fails the build on a violation;
`scripts/check-boundaries.test.mjs` plants one of each and asserts it is caught.

Those rules are about *this* tree. The boundary a consumer meets is a different question, and
`npm run check:consumer` asks it: `npm pack` the runtime, install the tarball into a directory that knows the
package only through `node_modules`, then require that every subpath in `exports` loads and typechecks, that a
deep import into `dist/` or `src/` fails **with `ERR_PACKAGE_PATH_NOT_EXPORTED`** — the boundary refusing it,
not the file happening to be absent — and that no sources or sourcemaps are shipped. It is what makes the
separate-repository argument in [`docs/21-platform.md`](docs/21-platform.md) enforceable rather than cultural.

ShareFlow-specific tools, context providers, skills and agents are registered through
the public interfaces from `shareflow/`, never added to a generic package.

## Deployment

Two processes, one image. They share every dependency, so two images would only drift.

### The docs site

**[docs.retinue.riseexperts.de](https://docs.retinue.riseexperts.de)**, served by an assets-only Cloudflare
Worker named `retinue-docs`. Both `wrangler.jsonc` files declare it, and both attach the hostname as a
**custom domain** rather than a route — that is not a detail: `docs.retinue.riseexperts.de` is a second-level
subdomain, which Cloudflare's universal certificate does not cover, and a custom domain is what provisions an
Advanced Certificate for the exact hostname. Attached as a plain route it answers over HTTP and fails the TLS
handshake, which is what it did for several hours on 27 Aug 2026.

The Worker name has been wrong twice. It said `agentkit-docs`, which never existed, so the documented
`npx wrangler deploy` would have created a third Worker and published the site to it — a deploy that succeeds
and serves nobody. Then it said `agentkit`, which did serve the old hostname. Whenever this line changes again,
remember that `wrangler deploy` with a new `name` does not rename a Worker: it creates another one and leaves
the first serving whatever it was serving, so check what the old one still has attached first.

`npm run check:domain` verifies the result, and needs no argument: it reads `url` from the config and holds
reality to it — the intended host serves, the legacy host answers a **301 to the same path**, the sitemap and
canonical tags name the intended host rather than one that redirects, and both wrangler configs attach *that*
hostname as a custom domain. The last of those is new, and it exists because the config and the deploy
disagreed for hours: the site claimed a hostname nothing was attached to, which is worse than a wrong one
because it looks deliberate. `-- --offline` runs the half that compares
the built output with the config, which is what CI runs, because a gate that fails when DNS is slow is a gate
people skip.

### Configuration

Validated at startup: a missing or malformed variable fails the boot with a message naming it, and
**all** problems are reported at once rather than one per deploy.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `RETINUE_DATABASE_URL` | yes | — | `postgres://…` |
| `RETINUE_REDIS_URL` | yes | — | `redis://…`, for the job queue and the lock |
| `RETINUE_SCHEMA_MODE` | no | `off` | `off` \| `plan` \| `auto`. Keep `off` in production so managed migrations stay in control; `plan` logs the pending diff and applies nothing |
| `RETINUE_WORKER_CONCURRENCY` | no | `4` | Runs handled at once per worker |
| `RETINUE_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `PORT` | no | `4000` | API host only |

### Running

Both commands need one more variable: `RETINUE_APP_MODULE`, pointing at a module that
default-exports your wiring — `{ authenticate, deps }` for the API host, plus `{ engine, buildContext }`
for the worker. There is deliberately **no default for `authenticate`**: a fallback would serve an open
API to anyone who forgot to set it, which is a worse failure than refusing to start.

```bash
# API host — GraphQL at /graphql, SSE at /runs/events, probes at /healthz and /readyz
RETINUE_APP_MODULE=./dist/my-app.js node node_modules/@retinue/agentkit/dist/server/cli.js

# Worker — consumes the run queue, heartbeats its claims, reaps stale runs
RETINUE_APP_MODULE=./dist/my-app.js node node_modules/@retinue/agentkit/dist/server/cli-worker.js
```

With the image:

```bash
docker build -t retinue .
docker run -p 4000:4000 --env-file .env retinue                                        # API host
docker run --env-file .env retinue node backend/dist/server/cli-worker.js              # worker
```

The image builds the runtime and the `examples` app layer, and defaults `RETINUE_APP_MODULE` to it, so
it boots as-is. Your own deployment replaces that layer: the runtime declares its heavy dependencies as
*optional* peers, so the application is what declares the ones a given wiring actually uses. That is
also why the runtime stage installs with `--omit=dev` — an app layer that imports something it does not
declare fails the image build rather than production.

`RETINUE_DATABASE_URL` must carry its own `search_path` where the schema is not the default one; the
host builds its pool from the URL alone and cannot be told separately.

### Probes

| Path | Answers | Behaviour |
|---|---|---|
| `/healthz` | Is the process alive? | 200 **even while the database is down**. Restarting a process because a dependency is unavailable turns a blip into a restart storm |
| `/readyz` | Should traffic come here? | 200 when Postgres and the schema version check out, plus Redis where the app module exposes a connection (`redis` on its default export — without it Redis is not probed, and a host that cannot take a lock still reports ready); **503** naming every failing probe otherwise |

Both are served before authentication, because a load balancer carries no credentials.

### First boot against an empty database

```bash
RETINUE_SCHEMA_MODE=auto node node_modules/@retinue/agentkit/dist/server/main.js   # provisions, then logs the applied migration ids
```

`auto` is idempotent — a second boot applies nothing — but the production default is `off` on purpose.

## Licence

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 [Azeem Sarwar](https://github.com/azeem-sarwar) and
[Rise Experts](https://github.com/Rise-Experts), jointly. Both are named, on their own line each, because a
joint holder who is not in the notice is not a holder — and the notice is what every consumer is obliged to
reproduce.

MIT so that installing the runtime needs no conversation: it is the shortest permissive licence and the one
every reviewer already knows. What it gives up against Apache-2.0 is an **explicit patent grant** — MIT grants
patent rights only by implication, which is a distinction some enterprise reviews care about and most do not.
That trade was made deliberately.

It does **not** oblige anything built on top to be open source. The platform (REQ-042, `docs/21-platform.md`)
lives in its own repository, consumes this package as a published dependency, and is proprietary — which any
permissive licence permits, and one of the reasons the boundary in that document is worth enforcing.

The deprecation policy that governs how a removed export stops working is in
[`docs/19-versioning.md`](docs/19-versioning.md#deprecation-policy): one minor version, told three ways.
