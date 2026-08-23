# Reusable AI Platform Packages

TypeScript implementation of the specifications in [`docs/`](docs/README.md).

| Folder | Package | Runs where |
|---|---|---|
| [`backend/`](backend) | `@agentkit/backend` | Server: runtime, tools, MCP, skills, context, HITL, persistence adapters. **Takes no server or HTTP dependency and reads no environment variables.** |
| [`server/`](server) | `@agentkit/server` | The reference GraphQL host: Yoga, the SSE endpoint, configuration and health probes |
| [`frontend/`](frontend) | `@agentkit/frontend` | Client: headless React state, subscriptions and typed part reducers |
| [`shareflow/`](shareflow) | `@agentkit/shareflow` | The ShareFlow integration: its tools, context providers, skills and agent manifests. Depends on `backend`; nothing generic depends on it |
| [`docs/`](docs) | — | The specifications these packages implement |

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
npm run build        # before npm test: the release-gate CLI imports the built @agentkit/backend
npm test
```

## The release gate

Releases are gated on measured quality. `evals/thresholds.json` holds the per-dimension thresholds — data, not
code, with the reason each one holds its value written next to it. `evals/trend.json` is the committed,
append-only record of quality per release, and each entry stores the thresholds it was judged against, so
`git log -p evals/` distinguishes "quality improved" from "we moved the bar".

```bash
npm run release:gate -- --report <scored-run.json> [--baseline <prev.json>] [--record]
```

Exit codes: **0** pass or overridden, **1** a quality failure, **2** a usage error. An override needs both
`AGENTKIT_GATE_OVERRIDE_ACTOR` and `AGENTKIT_GATE_OVERRIDE_REASON`; half of one is refused rather than ignored,
and the trend entry records both. The CI job runs on a release tag and on demand, not on every push. See
`docs/09-quality-and-release.md` — including what the gate cannot yet do, which is score a live run.

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
- Every package may only import what its own `package.json` declares. npm hoists all workspace
  dependencies into one `node_modules`, so an undeclared import works here and fails wherever the
  package is installed alone — the manifest is the only place "builds without ShareFlow installed"
  is actually written down.

`npm run check:boundaries` enforces all of the above and fails the build on a violation;
`scripts/check-boundaries.test.mjs` plants one of each and asserts it is caught.

ShareFlow-specific tools, context providers, skills and agents are registered through
the public interfaces from `shareflow/`, never added to a generic package.

## Deployment

Two processes, one image. They share every dependency, so two images would only drift.

### Configuration

Validated at startup: a missing or malformed variable fails the boot with a message naming it, and
**all** problems are reported at once rather than one per deploy.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AGENTKIT_DATABASE_URL` | yes | — | `postgres://…` |
| `AGENTKIT_REDIS_URL` | yes | — | `redis://…`, for the job queue and the lock |
| `AGENTKIT_SCHEMA_MODE` | no | `off` | `off` \| `plan` \| `auto`. Keep `off` in production so managed migrations stay in control; `plan` logs the pending diff and applies nothing |
| `AGENTKIT_WORKER_CONCURRENCY` | no | `4` | Runs handled at once per worker |
| `AGENTKIT_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `PORT` | no | `4000` | API host only |

### Running

Both commands need one more variable: `AGENTKIT_APP_MODULE`, pointing at a module that
default-exports your wiring — `{ authenticate, deps }` for the API host, plus `{ engine, buildContext }`
for the worker. There is deliberately **no default for `authenticate`**: a fallback would serve an open
API to anyone who forgot to set it, which is a worse failure than refusing to start.

```bash
# API host — GraphQL at /graphql, SSE at /runs/events, probes at /healthz and /readyz
AGENTKIT_APP_MODULE=./dist/my-app.js node server/dist/cli.js

# Worker — consumes the run queue, heartbeats its claims, reaps stale runs
AGENTKIT_APP_MODULE=./dist/my-app.js node server/dist/cli-worker.js
```

With the image:

```bash
docker build -t agentkit .
docker run -p 4000:4000 --env-file .env agentkit                     # API host
docker run --env-file .env agentkit node server/dist/cli-worker.js   # worker
```

### Probes

| Path | Answers | Behaviour |
|---|---|---|
| `/healthz` | Is the process alive? | 200 **even while the database is down**. Restarting a process because a dependency is unavailable turns a blip into a restart storm |
| `/readyz` | Should traffic come here? | 200 when Postgres, Redis and the schema version all check out; **503** naming every failing probe otherwise |

Both are served before authentication, because a load balancer carries no credentials.

### First boot against an empty database

```bash
AGENTKIT_SCHEMA_MODE=auto node server/dist/main.js   # provisions, then logs the applied migration ids
```

`auto` is idempotent — a second boot applies nothing — but the production default is `off` on purpose.
