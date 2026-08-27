---
sidebar_position: 3
---

# Tools

## What is it?

A **tool** is a capability the agent can call during a run — read data, draft content, publish a
post. Each tool declares an input/output schema, an **effect** classification, an approval
policy, and an idempotency requirement.

## Why would I use it?

Tools are how the model *does* things safely. Retinue filters them by permission before the
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
learn_tools · find_tools · execute_tool · load_skill · ask_questions · request_approval · read_tool_output
```

Execution **re-authorizes and re-validates** even for a tool that was discoverable earlier. An
unauthorized tool is absent from discovery and rejected if called directly.

## Bounding what stays resident

Compact entries still cost something: about 35 tokens each, on every turn, before a word of the conversation.
Two hundred tools is roughly 7,000 tokens of tool list. Three controls exist for that, and all three are off by
default.

**A catalogue budget.** `catalogBudget: { maxTokens }` caps the resident list. What does not fit is dropped from
the tail, and **never quietly**: a `catalog.truncated` run event names every dropped tool, the budget that bound,
and whether the model can still reach them. A shortened tool list is otherwise invisible — the model is not told
a tool was withheld, so it never calls it, and the transcript reads exactly like a run where it chose not to.

**`find_tools`.** Search over the catalogue by describing a need, so a dropped tool is deferred rather than
removed. It reuses the retrieval stack — the same rank fusion, the same relevance floor — and is filtered by the
same authorization as discovery, because a search that surfaced tools you may not use would be an enumeration
oracle. Wire it with `createToolSearch()`; pass an `EmbeddingProvider` for hybrid search, or leave it keyword-only.

**Per-tenant toolsets.** `toolsets` answers a question authorization does not: *does this tenant want this
category at all?* Applied before authorization filtering, so a switched-off category is absent from discovery,
from search, and from execution. Without it a catalogue is only ever as small as its largest customer.

A truncated list needs `execute_tool` to be useful, which is why it appears alongside `find_tools`: the tool the
model just found is by definition not in its own list. `execute_tool` unwraps to the ordinary call path, so
authorization, the tenant's toolset, the approval gate and the idempotency key all apply exactly as they would to
a direct call.

The same budget applies to the **skill catalogue**, where the notice goes into the prompt itself — a context
provider has no run event stream, and telling the model during the turn is what lets it say "there may be a
skill for this" instead of reporting that none exists.

## Running commands, and why it takes two switches

`shell_exec` is the only tool whose blast radius is not described by its schema, and its trigger is natural
language — including language the model merely *read*, in a document or an issue body. Without isolation it is a
remote code execution endpoint reachable by anyone who can get text in front of the agent.

So it needs **both** a `Sandbox` wired and the `shell` capability declared. Everywhere else in Retinue wiring is
the toggle; this is the one place a second switch earns its keep, because "somebody wired a sandbox for a test and
forgot" must not silently mean the agent can run commands on a machine. Declaring the capability without a sandbox
is refused at construction — a boot failure, not a tool that quietly declines.

The container adapter runs one throwaway container per command: no network at all, a read-only filesystem apart
from a `/scratch` tmpfs, memory and swap capped together, all capabilities dropped, not root, no TTY, a wall-clock
timeout, output capped with the truncation reported, and the exit code in the envelope rather than inferred from
the output. `createLocalSandbox` provides the timeout and the output cap and **none** of the isolation, which is
why it throws unless a deployment writes `allowUnsafeLocalExecution: true`.

Gating is by **effect**: `shell_exec` is `destructive`, so the approval gate always fires. It is tempting to
inspect the command instead — refuse `rm -rf`, allow `ls` — and that is a losing game. `find . -delete`, `dd`,
`python -c`, a base64 pipeline: any list of dangerous shapes is a list somebody gets around, and worse, it feels
like protection. A classification cannot be evaded by rephrasing.

## Result envelope

Every tool returns a shared success/error envelope; errors carry a stable code, retryability,
and safe details. Large results are compacted and may be **spilled to blob storage** with an
authorized reference (read back with `read_tool_output`).

## Bridging existing services

Tools **wrap** your existing services and functions rather than reimplementing them — a thin,
authorization + approval + idempotency envelope over the deterministic operation.

Next: **[Memory](memory)**.

## Where this is specified

This page is the shape of the thing. The specification is where the decisions and their reasons live — read it
when you need to know *why* something behaves the way it does, or what was considered and rejected.

- [Intelligence runtime → Tool registry](/specifications/intelligence-runtime)
- [The tool catalogue](/specifications/tool-catalogue)
- [Selection at scale, measured](/specifications/tool-selection-at-scale)
