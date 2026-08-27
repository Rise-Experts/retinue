<img src="https://raw.githubusercontent.com/Rise-Experts/retinue/main/brand/retinue-mark.svg" alt="Retinue" width="72" />

# @retinue/agentkit

[![npm](https://img.shields.io/npm/v/@retinue/agentkit)](https://www.npmjs.com/package/@retinue/agentkit)
[![licence](https://img.shields.io/npm/l/@retinue/agentkit)](https://github.com/Rise-Experts/retinue/blob/main/LICENSE)
[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen)](https://www.npmjs.com/package/@retinue/agentkit#provenance)

**A durable AI agent runtime for TypeScript.** Agents that survive a restart, tools that ask before
they act, and retrieval that cites its sources — behind ports you can replace.

For teams building an assistant or an automation that has to be *correct*: a run that crashes resumes
instead of vanishing, an external write waits for a human, and every token is accounted for.

## Install

```bash
npm i @retinue/agentkit
```

Node 20+. Provider SDKs, PostgreSQL, Redis and BullMQ are **optional peers** — install only what you use.
The package root imports nothing but `ai` and `zod`.

## Your first agent

```ts
import { createAgent } from "@retinue/agentkit/providers";

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions: "You are a helpful assistant. Be concise.",
    // A capability, not a hardcoded model id — swapping providers is config.
    modelPolicy: { role: "smart" },
  },
});

const result = await agent.run({
  conversationId: "conv-1",
  message: "Draft a one-line launch note for our analytics dashboard.",
});

console.log(result.text);     // the assistant's reply
console.log(result.outcome);  // "completed" | "failed" | "cancelled" | …
```

`createAgent` is the batteries-included path: it wires the in-memory stores, the model registry and the
default engine for you, and reads `ANTHROPIC_API_KEY` from the environment. Swap in PostgreSQL, Redis and
your own model catalogue when you need them — same code above.

## What you get

| | |
|---|---|
| **Durable runs** | Leases, checkpoints and recovery. Kill the worker mid-turn; the run resumes rather than disappearing |
| **Approval gates** | An external write stops and waits for a person. Idempotency keys mean a retry does not fire the side effect twice |
| **Tools that scale** | A compact catalogue in context, full schemas fetched on demand, authorization re-checked at execution |
| **Knowledge with citations** | Block-aware chunking, hybrid retrieval fused by rank, and answers that point at the source |
| **Injection containment** | Untrusted content is wrapped in a nonce-delimited envelope with delimiter forgery neutralised — structural, not a detector |
| **Usage you can bill** | Per-model, per-principal token and cost accounting, with quotas enforced before a run is admitted |
| **Flows and teams** | Durable multi-step workflows; a team compiles to a flow, and each member's turn is a child run with its own ceiling |
| **Replaceable everything** | 31 ports, three adapter families, one conformance suite held over all of them |

## Composing it yourself

The root exports five values and every type. Everything else sits behind a documented subpath, so a
consumer never installs a dependency they do not use:

```ts
import { createRuntime, defineAgent } from "@retinue/agentkit";
import { createDefaultEngine } from "@retinue/agentkit/runtime";
import { createPostgresConversationStore } from "@retinue/agentkit/adapters/postgres";
```

Anything reachable only by a deep import is **not** API — and that is enforced against the published
tarball rather than asserted here.

## Documentation

- [Getting started](https://docs.agentkit.riseexperts.de/docs/getting-started/installation) — install, first agent, configuration
- [Core concepts](https://docs.agentkit.riseexperts.de/docs/concepts/architecture) — agents, tools, durable runtime, retrieval, HITL
- [Package surface](https://docs.agentkit.riseexperts.de/docs/reference/package-surface) — every module, subpath, capability and tool
- [Versioning and deprecation](https://github.com/Rise-Experts/retinue/blob/main/docs/19-versioning.md) — what semver covers, and how you are told before it changes
- [Specifications](https://github.com/Rise-Experts/retinue/tree/main/docs) — the design documents, kept as reference

## Licence

MIT — see [LICENSE](https://github.com/Rise-Experts/retinue/blob/main/LICENSE).

Copyright (c) 2026 [Azeem Sarwar](https://github.com/azeem-sarwar) and
[Rise Experts](https://github.com/Rise-Experts).
