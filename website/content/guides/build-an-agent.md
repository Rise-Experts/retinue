---
sidebar_position: 1
---

# Build an agent with a tool

Give an agent a tool it can call. `defineTool` handles the result envelope and descriptor defaults;
the registry enforces authorization, validation, idempotency and approval on every call.

## 1. Define a tool

You write `execute(input, context) => data` and throw on failure — the shared success/error envelope
is applied for you. The effect classification drives the approval policy.

```ts
import { defineTool, toolProvider } from "@agentkit/backend";
import { z } from "zod";

const getWeather = defineTool({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  effect: "read",                                   // read → no approval needed
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }, ctx) => {
    // wrap your existing service; ctx carries the tenant + principal
    return weatherService.current(ctx.tenantId, city);
  },
});
```

External writes are approval-gated automatically:

```ts
const publishPost = defineTool({
  name: "publish_post",
  description: "Publish a saved draft to a connected channel.",
  effect: "external-write",                         // → approvalPolicy "always", idempotency required
  inputSchema: z.object({ draftId: z.string(), channel: z.string() }),
  execute: ({ draftId, channel }, ctx) => publishingService.publish(ctx.tenantId, draftId, channel),
});
```

## 2. Give the tools to the agent

```ts
import { createAgent } from "@agentkit/backend";

const agent = createAgent({
  manifest: {
    id: "social-assistant",
    name: "Social assistant",
    instructions: "Help the user check the weather and draft posts.",
    modelPolicy: { role: "smart" },
  },
  tools: [toolProvider("demo", [getWeather, publishPost])],
});

const result = await agent.run({ conversationId: "c1", message: "What's the weather in Berlin?" });
console.log(result.text);
```

The model discovers `get_weather`, calls it, and the registry runs it through authorization +
validation before returning the result to the model — all within the single `run`.

## Approval-gated tools

`publish_post` is `external-write`, so it cannot execute without an approval grant. In the **embedded**
profile a call to it returns an `approval_required` result to the model. In the **server** profile the
run pauses at `WaitingForApproval`, and you resolve it with the HITL service — the *stored* input then
executes once, with an idempotency key, so there is never a double publish:

```ts
await approvals.decide({ tenantId, interactionId, runId, decision: "allow-once" });
```

See **[Approvals & safety](approvals-and-safety)** and **[Human-in-the-loop](../concepts/human-in-the-loop)**.

## What happened

- The tool was only discoverable because the caller was authorized for it.
- `read` ran inline; `external-write` is gated behind approval.
- On approval, the **stored input** executes once with an idempotency key — no double side effect.
