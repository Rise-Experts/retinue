---
sidebar_position: 3
---

# Configuration

The **server** profile is composed through a single root. You pass the ports (infrastructure
capabilities); @agentkit provides the runtime.

```ts
import { createAgentPlatform } from "@agentkit/runtime";

const platform = createAgentPlatform({
  modelRegistry,        // providers + models + pricing
  stores,               // conversation, run, message, session-state, … (a storage adapter)
  jobDispatcher,        // BullMQ (server) or inline (embedded)
  realtimePublisher,    // Supabase Realtime / Redis pub-sub
  lockStore,            // distributed lock for run claiming
  authorizationPolicy,  // who may do what
  usageRecorder,        // token + cost accounting
  vectorIndex,          // retrieval
  blobStore,            // files & spilled tool output
});

platform.registerToolProvider(domainToolProvider);
platform.registerContextProvider(domainContextProvider);
platform.registerAgent(assistant);
platform.registerMcpServer(tenantMcpConnection);
```

## Adapters

Every capability is a **port**; you choose the adapter. Start in-memory, move to production
adapters without changing agent or tool code.

| Port | Development | Production |
|---|---|---|
| Stores | in-memory | PostgreSQL / Supabase (RLS) |
| Job dispatcher | inline | BullMQ + Redis |
| Vector index | in-memory | pgvector / Qdrant |
| Blob store | local filesystem | S3-compatible |

## Automatic schema

Development adapters can **provision their own schema on startup** (`auto` mode), so a fresh
database is usable with no manual migration step. Production defaults to managed migrations
(`off`).

## Environment

```bash
ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY, etc.
DATABASE_URL=postgres://...  # server profile
REDIS_URL=redis://...        # server profile
```

Model **IDs are never hardcoded** into agents — an agent asks for a `fast` or `smart` role and
the registry resolves it by capability, cost ceiling, and data residency.
