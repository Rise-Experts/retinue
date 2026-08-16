---
sidebar_position: 1
---

# Build an agent with a tool

Give an agent a tool it can call, with authorization and approval handled for you.

## 1. Define a tool

A tool declares its schema and effect. External writes are approval-gated automatically.

```ts
import { defineTool } from "@agentkit/tools";

const publishPost = defineTool({
  name: "publish_post",
  label: "Publish post",
  description: "Publish a saved draft to a connected channel.",
  effect: "external-write",          // → requires approval
  input: { draftId: "string", channel: "string" },
  idempotent: true,
  run: async ({ draftId, channel }, ctx) => {
    // wrap your existing publishing service; ctx carries tenant + principal
    return publishingService.publish(ctx.tenantId, draftId, channel);
  },
});
```

## 2. Register it and the agent

```ts
platform.registerToolProvider({ tools: [publishPost] });
platform.registerAgent({
  id: "social-assistant",
  instructions: "Help the user draft and publish social posts.",
  modelPolicy: { role: "smart" },
  toolPolicy: { preloaded: [], categories: ["posts", "publishing"], excluded: [] },
});
```

## 3. Run — approval happens automatically

```ts
const run = await platform.send({ conversationId, agentId: "social-assistant",
  message: "Publish the 'Spring sale' draft to LinkedIn." });

// The run pauses at `WaitingForApproval`; approve it:
await platform.decideApproval({ interactionId: run.pendingApprovalId, decision: "allow-once" });
```

## What happened

- The tool was only discoverable because the caller was authorized for it.
- Its `external-write` effect **paused the run for approval**.
- On approval, the **stored input** executed once, with an idempotency key — no double publish.

## Common errors

| Symptom | Cause |
|---|---|
| Tool never called | Not in the agent's `toolPolicy` or caller unauthorized |
| Run stuck at `WaitingForApproval` | Awaiting `decideApproval` |
| Duplicate side effect | Tool not marked `idempotent` |

See **[Approvals & safety](approvals-and-safety)**.
