---
sidebar_position: 4
---

# Your first flow

One agent turn is a conversation. A **flow** is a process: several steps, each with its own prompt, a shared
state, a budget it cannot exceed, and a point where a person is asked before it continues. It survives a restart
mid-way, because every step's result is checkpointed as it happens.

Reach for a flow when the work has a shape you already know. If the shape is "let the model decide what to do
next", that is an agent with tools — use [that](first-tool) instead.

## 1. Define the steps

```ts
import type { FlowDefinition } from "@retinue/agentkit/flows";
import { asId } from "@retinue/agentkit";
import type { AgentId, ExecutionContext, PrincipalId, RequestId, RunId, TenantId } from "@retinue/agentkit";

const brief: FlowDefinition = {
  id: "launch-brief",
  version: 1,
  name: "Launch brief",
  start: "outline",
  // The ceiling, and it is checked *before* every step rather than after. A flow cannot overspend by one step.
  budget: { maxSteps: 6 },
  steps: [
    {
      name: "outline",
      kind: "agent",
      agentId: asId<AgentId>("writer"),
      prompt: "Outline a launch announcement for {{product}}. Three bullet points, no prose.",
      next: "review",
    },
    {
      name: "review",
      kind: "checkpoint",
      question: "Send this outline to the mailing list?",
      options: ["Send", "Rewrite it"],
      next: "finish",
    },
    { name: "finish", kind: "done", outcome: "sent" },
  ],
};
```

A step is identified by its `name`, and `start` and `next` refer to it by that name.

`{{product}}` is interpolated from the flow's state, which is where a step's output goes and where the next
step's prompt reads it from. Nothing is passed by closure: state is data, so it can be checkpointed and a
half-finished flow can be picked up by a different process.

## 2. Wire a runner

The runner owns the loop. You supply two stores and a **handler** — the handler is the part that decides what an
"agent step" actually means in your deployment.

```ts
import { createFlowRunner } from "@retinue/agentkit/flows";
import { createMemoryFlowDefinitionStore, createMemoryFlowExecutionStore } from "@retinue/agentkit/persistence";
import { createAgent } from "@retinue/agentkit/providers";

const writer = createAgent({
  manifest: {
    id: "writer",
    name: "Writer",
    instructions: "Write plainly. No superlatives.",
    modelPolicy: { role: "smart" },
  },
});

const definitions = createMemoryFlowDefinitionStore();
const executions = createMemoryFlowExecutionStore();

const runner = createFlowRunner({
  definitions,
  executions,
  handler: {
    // Inline, which is the simplest thing that works. Returning `parked-on-run` instead makes each step a
    // child run — it earns checkpointing, recovery, quota admission and its own usage rows, and it is what a
    // production deployment wants.
    async runAgent(context, input) {
      const result = await writer.run({ conversationId: `flow-${input.idempotencyKey}`, message: input.prompt });
      return { kind: "ok", value: result.text };
    },
    async callTool() {
      return { kind: "failed", error: "this flow has no tool steps" };
    },
    // A checkpoint goes through the *existing* human-in-the-loop path, so a parked flow is the same object your
    // approval surface already knows how to answer.
    async askHuman(context, input) {
      return { kind: "parked", interactionId: `question-${input.question.length}` };
    },
  },
});
```

## 3. Publish it and start it

```ts
// Branded ids, so a principal id cannot be passed where a tenant id belongs.
const context: ExecutionContext = {
  tenantId: asId<TenantId>("acme"),
  principalId: asId<PrincipalId>("alice"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
};

await definitions.put({
  tenantId: context.tenantId,
  definition: {
    flowId: brief.id,
    version: brief.version,
    name: brief.name,
    kind: "flow",
    definition: brief,
    createdAt: new Date().toISOString(),
  },
});

const started = await runner.start(context, {
  flowId: "launch-brief",
  runId: asId<RunId>("run-1"),
  state: { product: "the analytics dashboard" },
});

console.log(started.stopped); // "waiting" — it reached the checkpoint and stopped
console.log(started.execution.currentStep); // "review"
```

`stopped` is the useful field, and it has three values that mean different things:

| `stopped` | What happened |
|---|---|
| `settled` | The flow reached a `done` step, or failed |
| `waiting` | It parked — on a person, a signal, or a child run |
| `slice-exhausted` | The worker's slice ran out. The flow is fine; call again and it continues |

That third one is why a flow can be long. A worker hands its slot back rather than holding it for an hour, and
the next call picks up exactly where the last one stopped.

## A version is immutable

`definitions.put` **refuses** to overwrite an existing `flowId@version`. That is not strictness for its own sake:
an execution pins the version it started with and reads it forever, so a definition that could change underneath
a running flow would make a checkpoint meaningless. Publish a new version instead — running executions finish on
the old one.

## Next

- Steps, branches, budgets and teams in full → **[Concepts → Durable runtime](../concepts/durable-runtime)**
- Deciding a checkpoint and resuming → **[Human-in-the-loop](../concepts/human-in-the-loop)**
- Running this durably, across processes → **[Configuration](configuration)**
