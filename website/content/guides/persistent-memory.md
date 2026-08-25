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
import {
  createAgent,
  createMemoryPrincipalMemoryStore,
  createPrincipalMemoryProvider,
} from "@retinue/agentkit";

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
import { commitExtractedMemories } from "@retinue/agentkit";

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

See **[Memory](../concepts/memory)** for the full model.
