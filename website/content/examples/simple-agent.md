---
sidebar_position: 1
---

# Example: a simple agent

A complete, minimal embedded agent — no server.

```ts
import { createAgent } from "@agentkit/runtime";
import { memoryStore } from "@agentkit/persistence";

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions: "You are a concise, helpful assistant.",
    modelPolicy: { role: "smart" },
  },
  store: memoryStore(),
});

async function main() {
  const first = await agent.run({
    conversationId: "demo",
    message: "Give me three name ideas for a note-taking app.",
  });
  console.log(text(first));

  // The thread remembers the previous turn:
  const second = await agent.run({
    conversationId: "demo",
    message: "Make them one word each.",
  });
  console.log(text(second));
}

const text = (r) =>
  r.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");

main();
```

Run it:

```bash
ANTHROPIC_API_KEY=... npx tsx simple-agent.ts
```

To make this durable and multi-user, swap `memoryStore()` for a Postgres adapter and compose the
**server profile** — see **[Configuration](../getting-started/configuration)**.
