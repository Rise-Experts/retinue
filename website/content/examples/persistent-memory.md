---
sidebar_position: 2
---

# Example: persistent user memory

Facts a user tells the agent persist across conversations, scoped to that principal, and are fed back
into later prompts through a budgeted context provider.

```ts
import {
  createAgent,
  createMemoryPrincipalMemoryStore,
  createPrincipalMemoryProvider,
  commitExtractedMemories,
} from "@retinue/agentkit";
import { asId } from "@retinue/agentkit";

const memory = createMemoryPrincipalMemoryStore();
const tenantId = asId("acme");
const principalId = asId("user-1");

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions: "You are a helpful assistant. Use what you know about the user.",
    modelPolicy: { role: "smart" },
  },
  tenantId: "acme",
  // Relevant memories for the principal are retrieved under budget and added to the prompt.
  contextProviders: [createPrincipalMemoryProvider({ store: memory })],
});

// Commit a validated, de-duplicated memory (raw model output is never stored directly):
await commitExtractedMemories(memory, {
  tenantId,
  principalId,
  candidates: [{ text: "Prefers answers in metric units", tags: ["preferences"] }],
});

// A later, unrelated conversation for the same principal sees that memory:
const reply = await agent.run({
  conversationId: "B",
  principalId: "user-1",
  message: "How far is it from London to Paris?",
});
console.log(reply.text); // answers in kilometers
```

Memory is isolated per `(tenant, principal)`, never visible to another; disabled or deleted entries
never resurface; and every entry carries a provenance the context inspector can attribute. See the
**[Memory concept](../concepts/memory)**.
