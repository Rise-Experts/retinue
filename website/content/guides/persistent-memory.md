---
sidebar_position: 2
---

# Persistent memory

Make an agent remember a user across conversations.

## Session vs user memory

- **Session** memory is automatic — a thread continues where it left off.
- **User** memory follows a person across *all* their threads. That's what this guide adds.

## Remember a user-stated fact

```ts
await platform.memory.remember({
  tenantId, principalId,
  text: "Prefers a formal tone",
  source: "user-stated",
});
```

## Extraction (automatic)

After a turn, an extraction step *proposes* candidate facts; @agentkit **validates and dedupes**
them against existing entries before committing. Raw model output is never stored directly.

## Retrieval into a run

You don't fetch memory manually — a **context provider** injects the entries relevant to the
current turn, ranked *below* recent turns so it never crowds the live conversation.

```ts
const results = await platform.memory.search({
  tenantId, principalId,
  query: "communication preference",
  limit: 5,
});
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `principalId` | string | required | who the memory belongs to |
| `limit` | number | 5 | max entries retrieved |
| `threshold` | number | 0.7 | relevance cut-off |

## User control

Users can **list, edit, delete, and disable** their memory, and the context inspector shows
which entries influenced a turn. Deletion propagates immediately — a deleted fact can't resurface
in a later prompt.

## Isolation

Memory is strictly `tenantId` + `principalId` scoped — never visible to another user or tenant.

See **[Memory](../concepts/memory)** for the full model.
