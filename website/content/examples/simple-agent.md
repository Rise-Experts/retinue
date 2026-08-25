---
sidebar_position: 1
---

# Example: a simple agent

A complete, minimal embedded agent — no server.

```ts
import { createAgent } from "@retinue/agentkit";

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions: "You are a concise, helpful assistant.",
    modelPolicy: { role: "smart" },
  },
});

async function main() {
  const first = await agent.run({
    conversationId: "demo",
    message: "Give me three name ideas for a note-taking app.",
  });
  console.log(first.text);

  // The thread remembers the previous turn:
  const second = await agent.run({
    conversationId: "demo",
    message: "Make them one word each.",
  });
  console.log(second.text);
}

main();
```

Run it:

```bash
ANTHROPIC_API_KEY=... npx tsx simple-agent.ts
```

To make this durable and multi-user, swap the default in-memory adapters for the Postgres/Supabase
adapters and drive the worker from a real queue (the **server profile**) — same engine, same
contracts. See **[Configuration](../getting-started/configuration)**.
