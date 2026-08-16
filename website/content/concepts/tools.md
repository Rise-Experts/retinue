---
sidebar_position: 3
---

# Tools

## What is it?

A **tool** is a capability the agent can call during a run — read data, draft content, publish a
post. Each tool declares an input/output schema, an **effect** classification, an approval
policy, and an idempotency requirement.

## Why would I use it?

Tools are how the model *does* things safely. @agentkit filters them by permission before the
model even sees them, re-checks authorization at execution, and gates dangerous ones behind
approval — so a model can't act beyond what the caller is allowed to do.

## Effects

| Effect | Meaning | Approval |
|---|---|---|
| `read` | no side effect | no |
| `internal-write` | changes your own data | policy |
| `external-write` | publishes / sends externally | yes |
| `destructive` | deletes / irreversible | yes |

## Lazy, permission-filtered discovery

The runtime builds a **compact, permission-filtered catalog**. Only commonly-needed tools are
preloaded; the rest are discovered on demand via meta-tools — so only task-relevant schemas
enter the context window.

```
learn_tools · execute_tool · load_skill · ask_questions · request_approval · read_tool_output
```

Execution **re-authorizes and re-validates** even for a tool that was discoverable earlier. An
unauthorized tool is absent from discovery and rejected if called directly.

## Result envelope

Every tool returns a shared success/error envelope; errors carry a stable code, retryability,
and safe details. Large results are compacted and may be **spilled to blob storage** with an
authorized reference (read back with `read_tool_output`).

## Bridging existing services

Tools **wrap** your existing services and functions rather than reimplementing them — a thin,
authorization + approval + idempotency envelope over the deterministic operation.

Next: **[Memory](memory)**.
