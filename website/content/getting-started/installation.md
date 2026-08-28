---
sidebar_position: 1
---

# Installation

## What you need

- **Node.js 20+**
- A model provider API key (e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)
- For the server profile only: PostgreSQL/Supabase and Redis (durable runs & jobs)

## Install

Retinue ships as two packages:

```bash
# backend: contracts, runtime, engine, tools, adapters, embedded agent facade
npm install @retinue/agentkit

# headless React client (optional, for a UI) — React is a peer dependency
npm install @retinue/react react
```

`@retinue/agentkit` bundles everything server-side: the durable runtime, the default AI-SDK engine,
the tool registry, the model registry and the reference in-memory adapters. Swap in the Postgres /
Supabase adapters for production. `@retinue/react` is transport-agnostic headless state — hooks,
reducers, localization — plus an optional UI component set.

## The whole stack, with Docker

For the server profile, `compose.yaml` in the repository brings up Postgres (with pgvector), Redis, a migration
step and the API host and worker:

```bash
RETINUE_MODEL_API_KEY=sk-… docker compose up
```

Three things about it are deliberate:

- **The ports are not the defaults** — 55440, 56380 and 4010. You very likely have Postgres on 5432 and Redis on
  6379 already, holding data that matters, and a compose file that binds them looks broken for reasons nobody
  connects to this.
- **Migrations are a service**, not a note in the README. `api` and `worker` wait for it to complete
  successfully, so a stack that comes up has a schema. "Remember to migrate" is a step people forget exactly
  once and then debug for an hour.
- **`RETINUE_MODEL_API_KEY` has no default and is not written down.** Starting without it fails with a message
  naming the variable, rather than a stack that starts and dies on the first message.

`docker compose down` keeps the data; `down -v` is the deliberate reset.

## Two profiles

Retinue runs the same core in two shapes — pick per app:

| Profile | Use for | Adds |
|---|---|---|
| **Embedded** | scripts, jobs, single-tenant apps, tests | in-process, `createAgent().run()`, persistent sessions |
| **Server** ("AgentOS") | multi-tenant products with a live UI | BullMQ + Redis, GraphQL/SSE, realtime, HITL, recovery |

The embedded profile needs no server infrastructure. See **[Quick Start](quick-start)** to run your
first agent, then **[Configuration](configuration)** for the server profile.

## Verify

```bash
node -e "import('@retinue/agentkit').then(() => console.log('retinue ready'))"
```
