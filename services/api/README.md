# `@retinue/api-service`

A Nest.js service that serves the platform — REQ-044 ([#201](https://github.com/Rise-Experts/retinue/issues/201)).

```bash
RETINUE_DEV_AUTH=1 RETINUE_SCHEMA=agentkit_example PORT=4200 npm start -w @retinue/api-service
```

| | |
|---|---|
| `POST /graphql` | The platform's schema, from the platform's resolvers |
| `POST /api/message` | Start a turn. **This service's own**, because the platform deliberately does not own message ingestion |
| `GET /runs/events` | The run-event stream, mounted from the platform's route |
| `GET /healthz` · `GET /readyz` | The platform's probes |

## Why it exists

The runtime had exactly one host — ours — so nothing showed the package being consumed by a *framework*, and
nothing tested its composition surface against a container that inverts the wiring. Nest was the specific ask and
is a good stress test: it composes through providers and tokens rather than top-down, and it needs decorator
metadata in an ESM `NodeNext` repo.

## No second copy of the API

`typeDefs` and `createResolvers` come from `@retinue/agentkit`, and this service adds **no resolver of its own**.
That is checked rather than intended: `src/__tests__/schema.test.ts` compares the served schema against the
reference host's and asserts every root field resolves from the platform's map.

A Nest service with hand-written resolvers would be a second implementation of one API, and two implementations
of one thing drift — the way an unwired message store (#157) and a no-op publisher (#161) drifted, each correct
in one arrangement and quietly broken in the other.

The same argument applies twice more:

- **SSE is mounted, not reimplemented.** Nest's `@Sse()` takes an RxJS observable and does its own framing, and
  taking it would mean a second implementation of the frame format, the keep-alive comment and the cursor resume
  — re-deriving the bugs #109 and #111 fixed. `createServerAdapter` bridges the platform's route instead.
- **The probes are the platform's.** A service with its own readiness check eventually disagrees with the host
  about what "ready" means, and the disagreement shows up as traffic routed to a process that cannot serve it.

## What the service does decide

Everything an application is supposed to: who a request is, which roles exist, and what a message is.

`POST /api/message` is the interesting one. `sendMessage(conversationId, runId)` takes ids and no text, because
what a message is — who may send one, what it may contain, what else happens when one arrives — belongs to the
application. The order in that controller is load-bearing and each step is commented with the failure it avoids:
quota **before** anything exists, the conversation idempotently, the message through the port, then the run row,
then the slot, then the job. A job enqueued before its run row exists points at nothing.

## Authentication has no default

`RetinueModule.forRoot` requires an `authenticate`, so forgetting one is a type error rather than an open API.
The bundled `createDevAuthenticate` reads a tenant and principal from headers — which is *not* authentication,
any caller can claim any tenant — and refuses to build unless `RETINUE_DEV_AUTH=1` acknowledges that. Checked at
construction, so a misconfigured service fails at boot with one message instead of 401ing every request.

## Roles must match the worker's

The service records `principalId` and `roleIds` on the run at admission, and the **worker** authorizes tools from
them. A run admitted under a role the worker's policy does not know gets an empty tool catalogue — so the model
answers from memory and looks like it ignored its tools. Found exactly that way: a turn admitted as `operator`
against the example's worker (which knows `editor` and `viewer`) produced arithmetic done in the model's head,
and the same turn as `editor` called `calculate` and returned the right number.

That is authorization behaving correctly. It is also a sharp edge between two processes that have to agree, and
it is worth knowing before an empty catalogue reads as a broken tool.

## Configuration

Read through the platform's `loadConfig`, so the `RETINUE_*` → `AGENTKIT_*` deprecation path (#192) applies here
too. `RETINUE_SCHEMA` is this service's addition: the platform builds its pool from `databaseUrl` alone and
cannot be told about a schema separately, so the schema is folded into the URL — unless an explicit `options`
parameter is already there, which is an operator being specific.

## Shutdown

`enableShutdownHooks` plus an `onApplicationShutdown` that closes the pool and Redis with `allSettled`, so a
Redis that has already dropped cannot leave the pool open. Verified live: connections 11 → 12 while serving →
11 after SIGTERM.

## What it does not do

Run the worker. `runWorker` is in the same package and takes an app module with an engine and a context builder,
both of which are application decisions this service does not make yet. Until it does, runs it admits are
executed by whatever worker is pointed at the same database and queue.
