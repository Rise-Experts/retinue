---
sidebar_position: 3
---

# Your first tool

An agent that cannot do anything is a chat box. A **tool** is how it acts — and in Retinue a tool is a thin
envelope over a function you already have, with authorization, human approval and idempotency wrapped around it
rather than written into it.

This page adds two tools to the agent from the [quick start](quick-start): one that reads and one that writes.
The difference between them is a single field, and that field is what decides whether a human is asked first.

## 1. Declare a read

```ts
import { defineTool } from "@retinue/agentkit/tools";

const inventory = new Map([
  ["SKU-1", { name: "Blue mug", inStock: 14 }],
  ["SKU-2", { name: "Green mug", inStock: 0 }],
]);

const checkStock = defineTool({
  name: "check_stock",
  label: "Check stock",
  description: "Look up how many of a product are in stock, by SKU.",
  category: "inventory",
  // The default, and stated anyway: an effect is a decision, and a tool that leaves it out has had it made
  // for it.
  effect: "read",
  inputSchema: {
    type: "object",
    properties: { sku: { type: "string", description: "The product SKU, e.g. SKU-1." } },
    required: ["sku"],
  },
  execute: async (input: { sku: string }) => inventory.get(input.sku) ?? { error: "no such SKU" },
});
```

Two things are doing work here.

**The `description` is the interface.** It is what the model reads to decide whether this is the tool for the
job — so write it for the model, not for a reader who already knows what you meant. "Look up how many of a
product are in stock, by SKU" is a better description than "stock lookup", and it costs nothing.

**The `inputSchema` is not optional in practice.** A tool that declares no schema reaches the model as "takes any
object", so the model has no parameter names to fill in and emits calls with empty arguments. That failure looks
like the platform dropping your call, and it is one of the more expensive afternoons you can have.

## 2. Declare a write

```ts
import { confirms } from "@retinue/agentkit/tools";

const reorder = confirms({
  name: "reorder_stock",
  label: "Reorder stock",
  description: "Place a restock order with the supplier for a given SKU and quantity.",
  category: "inventory",
  inputSchema: {
    type: "object",
    properties: { sku: { type: "string" }, quantity: { type: "number" } },
    required: ["sku", "quantity"],
  },
  execute: async (input: { sku: string; quantity: number }) => ({ ordered: input.quantity, sku: input.sku }),
});
```

`confirms()` sets three things together — `effect: "external-write"`, `approvalPolicy: "always"`, and
`requiresIdempotencyKey: true` — and the type forbids overriding any of them. That is deliberate: those three
travel together, and a write declared as a read is not a mistake you find in review. Use `destroys()` for
something that cannot be undone.

## 3. Give them to the agent

Tools reach an agent through a **provider**: anything with an `id` and a `listTools`. It takes the execution
context, so which tools exist can depend on who is asking.

```ts
import { createAgent } from "@retinue/agentkit/providers";

const agent = createAgent({
  manifest: {
    id: "stockroom",
    name: "Stockroom",
    instructions: "Help with stock questions. Check before you answer; never guess a number.",
    modelPolicy: { role: "smart" },
  },
  tools: [{ id: "inventory", listTools: async () => [checkStock, reorder] }],
});

const answer = await agent.run({ conversationId: "conv-1", message: "How many blue mugs do we have?" });
console.log(answer.text);
```

The read runs. Ask it to reorder and something different happens:

```ts
const attempt = await agent.run({ conversationId: "conv-1", message: "Order 50 more blue mugs." });
console.log(attempt.outcome); // "waiting-for-approval"
```

The run **stops**. The tool did not execute, the supplier was not called, and a durable approval is waiting for a
person to decide. Nothing was retried, and nothing happened twice — see
[Human-in-the-loop](../concepts/human-in-the-loop) for deciding it and resuming the run.

## What you just got for free

| | |
|---|---|
| **Authorization** | The tool is filtered out of discovery for a principal who may not use it, and refused if called directly anyway |
| **Approval** | Enforced by the classification, not by remembering to check |
| **Idempotency** | A retried write returns the first result instead of firing the side effect twice |
| **A result envelope** | A thrown error becomes a typed result the model can read and explain, not a stack trace |
| **Audit** | Every call and result is in the run's event log, with the arguments |

## Next

- The whole tool contract → **[Concepts → Tools](../concepts/tools)**
- Ready-made integrations for GitHub, Slack and web search → **[Integrations](../integrations/overview)**
- Chain several agents and tools into one process → **[Your first flow](first-flow)**
