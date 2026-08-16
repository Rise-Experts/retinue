---
sidebar_position: 1
---

# Installation

## What you need

- **Node.js 20+**
- A model provider API key (e.g. `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`)
- For the server profile: PostgreSQL/Supabase and Redis (durable runs & jobs)

## Install

@agentkit ships as focused packages under the `@agentkit` scope — install only what you use.

```bash
# core contracts + runtime + a model provider
npm install @agentkit/core @agentkit/runtime @agentkit/models

# storage (start with in-memory; swap for postgres/supabase later)
npm install @agentkit/persistence

# headless React client (optional, for a UI)
npm install @agentkit/react
```

## Two profiles

@agentkit runs the same core in two shapes — pick per app:

| Profile | Use for | Adds |
|---|---|---|
| **Embedded** | scripts, jobs, single-tenant apps, tests | in-process, synchronous, persistent sessions |
| **Server** ("AgentOS") | multi-tenant products with a live UI | BullMQ + Redis, GraphQL, realtime, recovery |

The embedded profile needs no server infrastructure — just a store. See
**[Configuration](configuration)** for wiring, then the **[Quick Start](quick-start)**.

## Verify

```bash
node -e "import('@agentkit/core').then(() => console.log('agentkit ready'))"
```
