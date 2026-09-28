---
sidebar_position: 2
---

# Persistent memory

Make an agent remember a user across conversations.

## Session vs user memory

- **Session** memory is automatic — a thread continues where it left off.
- **User** memory follows a person across *all* their threads. That's what this guide adds.

## Wire the memory store + provider

```ts
import { createPrincipalMemoryProvider } from "@retinue/agentkit/context";
import { createMemoryPrincipalMemoryStore } from "@retinue/agentkit/persistence";
import { createAgent } from "@retinue/agentkit/providers";

const memory = createMemoryPrincipalMemoryStore(); // swap for a Postgres adapter in production

const agent = createAgent({
  manifest: { id: "assistant", name: "Assistant", instructions: "…", modelPolicy: { role: "smart" } },
  contextProviders: [createPrincipalMemoryProvider({ store: memory, maxEntries: 8 })],
});
```

## Remember a fact (validated + de-duplicated)

An extraction step *proposes* candidate facts; `commitExtractedMemories` **validates and dedupes**
them against existing entries before committing — raw model output is never stored directly.

```ts
import { commitExtractedMemories } from "@retinue/agentkit/context";

await commitExtractedMemories(memory, {
  tenantId,
  principalId,
  candidates: [{ text: "Prefers a formal tone", tags: ["preferences"] }],
});
```

## Retrieval into a run

You don't fetch memory manually — the context provider injects the entries relevant to the current
turn, drawn from the **user-context budget** so it never crowds out recent turns or session state.

## User control

Users can **list, edit, disable, and delete** their memory directly on the store:

```ts
const page = await memory.list({ tenantId, principalId, limit: 50 });
await memory.update({ tenantId, principalId, id, expectedVersion, patch: { disabled: true } });
await memory.delete({ tenantId, principalId, id }); // hard delete — can't resurface in a later prompt
```

Disabled and deleted entries never surface to the provider, and each retrieved entry carries a
`principal-memory:<id>` provenance the context inspector attributes.

## Isolation

Memory is strictly `tenantId` + `principalId` scoped — never visible to another user or tenant.

## Project memory — shared by a group of conversations

Some things belong to a *project*, not a person: "never say revolutionary", "slide 1 names the dish". Scoped
memory keeps them for every conversation in the project, with the same limits and dedupe.

```ts
import { commitExtractedScopedMemories, createScopedMemoryProvider } from "@retinue/agentkit/context";
import { createMemoryScopedMemoryStore } from "@retinue/agentkit/persistence";

const projectMemory = createMemoryScopedMemoryStore(); // createPostgresScopedMemoryStore in production

const agent = createAgent({
  manifest: { id: "assistant", name: "Assistant", instructions: "…", modelPolicy: { role: "smart" } },
  contextProviders: [createScopedMemoryProvider({ store: projectMemory, maxBytes: 2048 })],
});

// The host names the run's scopes; the model never can.
await agent.run({ conversationId, message, memoryScopes: [`project:${projectId}`] });

// After a turn: the source (conversation, run, person) comes from the context, and the scope must be the run's.
await commitExtractedScopedMemories(projectMemory, {
  context, // the run's ExecutionContext
  candidates: [{ text: "Never say revolutionary" }],
  requireConfirmation: true, // stored as "proposed" until someone confirms it
});
```

A project settings page uses the store directly: `list({ tenantId, scope, status: "proposed", limit })` for the
review queue, `update(... patch: { status: "active" })` to confirm, and `delete` to forget.

See **[Memory](../concepts/memory)** for the full model.
