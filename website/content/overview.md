---
slug: overview
sidebar_position: 1
---

# Overview

**Retinue** is a reusable, provider-neutral AI agent platform for TypeScript. It gives an
application everything it needs to run AI agents in production — durable execution, safe tools,
layered memory, human-in-the-loop approvals, and permission-aware retrieval — without tying the
application to any single model provider or framework.

## Why Retinue

Most agent frameworks are easy to demo and hard to run. Retinue is built for the parts that
actually bite in production:

- **Provider neutrality** — one model registry over OpenAI, Anthropic, Google, Mistral, Azure,
  Bedrock. Switch a model without changing agent or tool code.
- **Durability** — runs are queued, checkpointed, and recoverable; they survive page refreshes
  and worker restarts, retry transient failures the way the Anthropic SDK does, and never
  double-fire an external write.
- **Layered memory under a budget** — session, user, and tenant memory, assembled into each
  prompt within the selected model's token budget, with compaction instead of silent truncation.
- **Safety** — tools are authorization-filtered before discovery and re-checked at execution;
  external actions pause for approval.
- **Reusability** — ports-and-adapters throughout, a headless React client, and two runtime
  profiles (embedded library or hosted server).

## How the docs are organized

| Section | For |
|---|---|
| **Getting Started** | Install and run your first agent |
| **Core Concepts** | How agents, tools, memory, sessions, HITL and retrieval work |
| **Guides** | Task-focused walkthroughs |
| **Examples** | Copy-paste starting points |
| **[API Reference](/api/)** | Generated from the TypeScript types |
| **[Specifications](/specifications/)** | The internal design specs |

New here? Start with **[Installation](getting-started/installation)** then the
**[Quick Start](getting-started/quick-start)**.

:::note Status
Retinue is under active development. Concept docs describe the settled design; code examples
show the intended public API as it comes online.
:::
