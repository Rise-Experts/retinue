---
sidebar_position: 2
---

# Example: persistent memory

An agent that remembers a user across separate conversations.

```ts
import { createAgent } from "@agentkit/runtime";
import { postgresStore } from "@agentkit/persistence";

const store = postgresStore({ url: process.env.DATABASE_URL, schema: "auto" });
const agent = createAgent({
  manifest: { id: "assistant", name: "Assistant", instructions: "Be helpful and concise.",
    modelPolicy: { role: "smart" } },
  store,
});

const tenantId = "acme";
const principalId = "user-123";

// Conversation A — the user states a preference.
await agent.run({ tenantId, principalId, conversationId: "A",
  message: "Remember I prefer TypeScript examples." });

// …later, a brand new conversation B — the agent still knows.
const reply = await agent.run({ tenantId, principalId, conversationId: "B",
  message: "Show me how to read a file." });
// → responds with a TypeScript example, because user memory carried across threads.
```

## What made this work

- `principalId` scopes **user memory** — it follows the person, not the thread.
- The preference was captured once and retrieved as a **budgeted context section** in the new
  conversation, ranked below the live turn.
- `schema: "auto"` provisioned the tables on first run (development); production uses managed
  migrations.

See **[Persistent memory](../guides/persistent-memory)** for control and isolation details.
