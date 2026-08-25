# @retinue/agentkit/server

The reference GraphQL host for [`@retinue/agentkit`](../backend). 9 source files, ~1,100
lines, 89 tests.

This README did not exist until 2026-08-24. The package did, and was runnable — which is
the worse half: a deployable component with no entry point in writing is one every new
reader rediscovers from `package.json`.

## What it is for

`@retinue/agentkit` deliberately takes no HTTP or GraphQL server dependency: it ships SDL
and a resolver map, and the host mounts them. This package is *a* host — the one used to
prove the surface works and to run the examples — not the only way to deploy.

Use it to run the platform without writing a host first. Read it to see what a host has to
supply.

| Module | Contains |
|---|---|
| `host` | Mounts the backend's SDL and resolvers on a WHATWG-fetch server, with GraphiQL for development |
| `sse-route` | The HTTP endpoint for run events, resuming from a sequence so a reconnect loses nothing |
| `boot` | Load configuration, provision the schema for the configured mode, and log what it actually did |
| `config` | Deployment configuration, validated at boot rather than on first use |
| `health` | Liveness and readiness, separated: readiness fails while a dependency is unreachable |
| `cli` / `cli-worker` / `main` | The runnable API and worker commands. Two processes, deliberately — the split is what makes the durable path real rather than asserted |

## Two processes, not one

The API admits work and the worker executes it. That boundary is load-bearing, and running
them in one process hides exactly the defects worth finding: [#161](https://github.com/Rise-Experts/retinue/issues/161)
(a hard-coded no-op event publisher, so nothing streamed) and
[#157](https://github.com/Rise-Experts/retinue/issues/157) (an unwired message store, so
turn two saw half of turn one) both survived because nothing exercised the split.

## Scripts

```bash
npm run typecheck -w @retinue/agentkit/server
npm test -w @retinue/agentkit/server
npm run build -w @retinue/agentkit/server
```

For something runnable end to end — a page, a worker, real Postgres and Redis — use
[`examples/`](../examples), which is built on this package.
