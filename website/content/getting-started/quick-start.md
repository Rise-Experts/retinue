---
sidebar_position: 2
---

# Quick Start

Build and run a minimal agent with the **embedded** profile — no server, no queue. `createAgent`
wires the reference in-memory stores, model registry, tool registry and the default engine into the
durable runtime for you.

## 1. Create an agent

```ts
import { createAgent } from "@agentkit/backend";

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions: "You are a helpful assistant. Be concise.",
    modelPolicy: { role: "smart" }, // resolved by capability, never a hardcoded model id
  },
});
```

The default catalog maps `role: "smart"` and `role: "fast"` to Claude models, using the
`ANTHROPIC_API_KEY` from your environment. Pass `models` / `roleAssignments` / `providerCredentials`
to use your own catalog or a different provider.

## 2. Run a turn

```ts
const result = await agent.run({
  conversationId: "conv-1",
  message: "Draft a one-line launch tweet for our analytics dashboard.",
});

console.log(result.text);           // the assistant's reply
console.log(result.parts);          // the full typed parts (text, tool calls, …)
console.log(result.outcome);        // "completed" | "failed" | "cancelled" | …
```

Each `run` executes the turn to completion through the durable worker and returns once the run
reaches a terminal state. Token/cost usage is recorded as the turn streams.

## 3. Continue the conversation

```ts
await agent.run({ conversationId: "conv-1", message: "Make it more playful." });
```

Because the thread carries its own history, you don't re-send prior context — @agentkit loads the
conversation's messages and assembles the prompt under the model's token budget for you. State
persists across turns on the same `conversationId`.

## Next

- Give the agent a tool it can call → **[Guides → Build an agent](../guides/build-an-agent)**
- Remember facts about a user across conversations → **[Persistent memory](../guides/persistent-memory)**
- Go durable/multi-user (server profile) → **[Configuration](configuration)**
- Understand what just happened → **[Core Concepts](../concepts/architecture)**
