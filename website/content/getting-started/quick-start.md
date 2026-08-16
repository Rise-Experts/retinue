---
sidebar_position: 2
---

# Quick Start

Build and run a minimal agent with the **embedded** profile — no server required.

## 1. Create an agent

```ts
import { createAgent } from "@agentkit/runtime";
import { memoryStore } from "@agentkit/persistence";

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions: "You are a helpful assistant. Be concise.",
    modelPolicy: { role: "smart" }, // resolved by capability, not a hardcoded model id
  },
  store: memoryStore(),            // persistent sessions; swap for postgres in production
});
```

## 2. Run a turn

```ts
const { parts } = await agent.run({
  conversationId: "conv-1",
  message: "Draft a one-line launch tweet for our analytics dashboard.",
});

for (const part of parts) {
  if (part.type === "text") console.log(part.text);
}
```

The run is **synchronous** in the embedded profile, but state is still persisted: the next
turn on `conv-1` remembers the previous one.

## 3. Continue the conversation

```ts
await agent.run({ conversationId: "conv-1", message: "Make it more playful." });
```

Because the thread carries **session state**, you don't re-send prior context — @agentkit
assembles it under the model's token budget for you.

## Next

- Add a tool the agent can call → **[Guides → Build an agent](../guides/build-an-agent)**
- Remember facts about a user across conversations → **[Persistent memory](../guides/persistent-memory)**
- Understand what just happened → **[Core Concepts](../concepts/architecture)**
