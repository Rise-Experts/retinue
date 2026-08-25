---
sidebar_position: 3
---

# Configuration

## Embedded profile

`createAgent` is the batteries-included entry point. It defaults every port to a reference in-memory
adapter; override only what you need:

```ts
import { createAgent } from "@retinue/agentkit";

const agent = createAgent({
  manifest: { id: "assistant", name: "Assistant", instructions: "…", modelPolicy: { role: "smart" } },
  models,                // your model catalog (defaults to a small Anthropic catalog)
  roleAssignments,       // which model ids back "fast" / "smart"
  providerCredentials,   // per-provider keys (BYO keys), e.g. { anthropic: { apiKey } }
  tools,                 // ToolProvider[]
  contextProviders,      // ContextProvider[] (memory, retrieval, …)
  authorization,         // AuthorizationPolicy (defaults to allow-all in embedded)
  tenantId,
});
```

## Server profile ("AgentOS")

The server profile composes the same pieces explicitly — the durable worker driven by a real queue,
production adapters, and the HITL/usage services — so many runs execute concurrently with recovery
and a live UI:

```ts
import {
  createDurableWorker,
  createModelRegistry,
  createProviderFactory,
  createToolRegistry,
  createDefaultEngine,
  createUsageRecorder,
} from "@retinue/agentkit";

const worker = createDurableWorker({
  runs,                  // RunStore (Postgres)
  checkpoints,           // CheckpointStore
  eventLog,              // RunEventLog (catch-up on reconnect)
  publisher,             // RealtimePublisher (Supabase Realtime / Redis)
  engine: createDefaultEngine({ /* loadManifest, resolveModel, loadHistory, buildTools */ }),
  buildContext,          // build the ExecutionContext from your auth
  workerId: process.env.HOSTNAME!,
});

// A BullMQ processor calls worker.process({ tenantId, runId }) for each queued run.
```

The GraphQL schema + thin resolvers (`typeDefs`, `createResolvers`) and the SSE transport
(`openRunEventSse`) sit on top; the frontend package consumes them. See the
**[Durable runtime concept](../concepts/durable-runtime)** and the API reference.

## Adapters

Every capability is a **port**; you choose the adapter. Start in-memory, move to production adapters
without changing agent or tool code.

| Port | Development | Production |
|---|---|---|
| Stores | in-memory | PostgreSQL / Supabase (RLS) |
| Job dispatcher | inline | BullMQ + Redis |
| Realtime | in-memory event bus | Supabase Realtime / Redis pub-sub |
| Blob store | in-memory | S3-compatible |

## Automatic schema

Development adapters can **provision their own schema on startup** (`auto` mode), so a fresh database
is usable with no manual migration step. Production defaults to managed migrations (`off`).

## Environment

```bash
ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY, etc.
DATABASE_URL=postgres://...  # server profile
REDIS_URL=redis://...        # server profile
```

Model **IDs are never hardcoded** into agents — an agent asks for a `fast` or `smart` role and the
registry resolves it by capability, cost ceiling, and data residency.
