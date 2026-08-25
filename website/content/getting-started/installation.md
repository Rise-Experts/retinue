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
