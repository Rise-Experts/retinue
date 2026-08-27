---
sidebar_position: 5
---

# Configuration

## Embedded profile

`createAgent` is the batteries-included entry point. It defaults every port to a reference in-memory
adapter; override only what you need:

```ts
import { createAgent } from "@retinue/agentkit/providers";

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions: "Be concise.",
    modelPolicy: { role: "smart" },
  },
  tenantId: "acme",
  providerCredentials: { openai: { apiKey: process.env.OPENAI_API_KEY ?? "" } },
  roleAssignments: { smart: ["gpt-4o"], fast: ["gpt-4o-mini"] },
});
```

Everything else has a default that works:

| Option | Default | Override when |
|---|---|---|
| `models` | a small built-in catalog | You have your own model list, pricing or residency constraints |
| `roleAssignments` | maps `smart`/`fast` to the built-in catalog | You changed `models` |
| `providerCredentials` | read from the environment by the provider factory | You hold keys somewhere else |
| `tools` | none | Always, eventually — see [your first tool](first-tool) |
| `contextProviders` | none | You want memory or retrieval in the prompt |
| `authorization` | allow-all | More than one kind of user |
| `guardrails` | none | You need input or output checks — see [Guardrails](../concepts/guardrails) |
| `toolSearch` / `catalogBudget` / `toolsets` | off | Your catalogue is large; read [the measurement](/specifications/tool-selection-at-scale) first |
| `tenantId` | `"default"` | Always, in anything multi-tenant |

## Server profile ("AgentOS")

The server profile composes the same pieces explicitly — the durable worker driven by a real queue,
production adapters, and the HITL/usage services — so many runs execute concurrently with recovery
and a live UI:

```ts
import { asId, defineAgent } from "@retinue/agentkit";
import type { AgentId, ResolvedModel, Run } from "@retinue/agentkit";
import { createDefaultEngine, createDurableWorker, createMemoryEventBus } from "@retinue/agentkit/runtime";
import {
  createMemoryCheckpointStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
} from "@retinue/agentkit/persistence";

const bus = createMemoryEventBus();

const worker = createDurableWorker({
  // The in-memory adapters here so this compiles as written. A deployment swaps in the Postgres ones from
  // `@retinue/agentkit/adapters/postgres` — same ports, no change to any agent or tool.
  runs: createMemoryRunStore(),
  checkpoints: createMemoryCheckpointStore(),
  eventLog: createMemoryRunEventLog(),
  publisher: bus.publisher,
  engine: createDefaultEngine({
    // `defineAgent` fills in the manifest's defaults — response format, tool policy, limits. A hand-written
    // manifest has to supply every field, which is a lot of typing to say "the usual".
    loadManifest: async () =>
      defineAgent({
        // Branded ids: `asId<AgentId>` rather than a bare string, so a conversation id cannot be passed where an
        // agent id belongs. The compiler is the only thing that catches that swap.
        id: asId<AgentId>("assistant"),
        name: "Assistant",
        instructions: "Be concise.",
        modelPolicy: { role: "smart" },
      }),
    resolveModel: () => ({ model: {} as ResolvedModel, modelId: "gpt-4o" }),
    loadHistory: async () => [],
  }),
  buildContext: (run: Run) => ({
    tenantId: run.tenantId,
    principalId: asId("system"),
    roleIds: [],
    locale: "en",
    timezone: "UTC",
    requestId: asId(`req-${run.id}`),
    conversationId: run.conversationId,
    runId: run.id,
  }),
  workerId: process.env.HOSTNAME ?? "worker-1",
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

## The `retinue` command

Installing the package puts a `retinue` binary on your path. Nothing here needs you to write an entrypoint
first.

```bash
npx retinue doctor
```

| Command | Does |
|---|---|
| `retinue migrate` | Applies pending migrations. Idempotent, and safe to run from several pods at once — it takes a Postgres advisory lock, so concurrent runs serialise instead of racing on DDL. |
| `retinue migrate --status` | Reports applied and pending migrations. Changes nothing. |
| `retinue migrate --dry-run` | Prints the statements that would run. Changes nothing — not even the ledger table. |
| `retinue serve` | Starts the API host. Needs `RETINUE_APP_MODULE`. |
| `retinue worker` | Starts a run worker. Needs `RETINUE_APP_MODULE`. |
| `retinue doctor` | Checks configuration, the database, the schema version and Redis. |

`migrate` and `doctor` deliberately need **no** app module: a database is provisioned before an application
exists, and a diagnostic you cannot run until everything else is configured is a diagnostic nobody can use.

### `doctor` reports every failure, not the first

```
✓ configuration: schema mode off, port 4000
✗ postgres: postgres://db.internal:5432/app: connect ECONNREFUSED
    → Check the database is running and RETINUE_DATABASE_URL points at it.
– schema: not checked — Postgres is unreachable, so this would fail for the same reason
✗ redis: redis://cache.internal:6379/0: connection refused
    → Check Redis is running and RETINUE_REDIS_URL points at it.

✗ 2 of 5 check(s) failed
```

Three things it will not do. It does not stop at the first problem — otherwise it adds nothing over starting the
server and reading the error. It does not report a check it could not run as a pass: a `–` means skipped, and a
check downstream of a failure is skipped rather than blamed. And it never prints a credential — a connection
string is reduced to host and database, and if the value is ambiguous (an unescaped `@` in a password, say) it
prints nothing at all rather than guessing which part was the secret.

## Automatic schema

Development adapters can **provision their own schema on startup** (`auto` mode), so a fresh database
is usable with no manual migration step. Production defaults to managed migrations (`off`) — run
`retinue migrate` as a deploy step.

## Environment

```bash
ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY, etc.
DATABASE_URL=postgres://...  # server profile
REDIS_URL=redis://...        # server profile
```

Model **IDs are never hardcoded** into agents — an agent asks for a `fast` or `smart` role and the
registry resolves it by capability, cost ceiling, and data residency.
