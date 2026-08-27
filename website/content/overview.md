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

## Find your way by what you are trying to do

Nobody arrives at documentation wanting section four. Start from the question:

| What you want | Where to go |
|---|---|
| Get something running in five minutes | **[Installation](getting-started/installation)** → **[Quick start](getting-started/quick-start)** |
| Let the agent *do* something, not just talk | **[Your first tool](getting-started/first-tool)** |
| Stop it doing something irreversible without a human | **[Human-in-the-loop](concepts/human-in-the-loop)**, and `confirms()` in **[Your first tool](getting-started/first-tool)** |
| Stop it saying something, or seeing something | **[Guardrails](concepts/guardrails)** |
| Have it remember a person between conversations | **[Persistent memory](guides/persistent-memory)** → **[Memory](concepts/memory)** |
| Answer from my documents, with citations | **[Retrieval](concepts/retrieval)** |
| Connect GitHub, Slack, or web search | **[Integrations](integrations/overview)** |
| Run a multi-step process that survives a restart | **[Your first flow](getting-started/first-flow)** → **[Durable runtime](concepts/durable-runtime)** |
| Serve many users, with a queue and a database | **[Configuration](getting-started/configuration)** |
| Know what a turn cost | **[Usage and accounting](/specifications/usage-and-accounting)** |
| Build the UI | **[Frontend](concepts/frontend)** |
| Understand why something behaves as it does | **[Specifications](/specifications/)** — the design decisions and what was rejected |
| Look up a type or a function | **[API reference](/api/)** — generated from the source |

## How the docs are organized

| Section | For |
|---|---|
| **Getting Started** | Install → first agent → first tool → first flow. Every sample on these pages is typechecked against the published package on every build |
| **Core Concepts** | How each subsystem works, each linking down into its specification |
| **Integrations** | The shipped toolkits, all on one page template |
| **Guides** | Task-focused walkthroughs |
| **Examples** | Copy-paste starting points |
| **[API Reference](/api/)** | Generated from the TypeScript types |
| **[Specifications](/specifications/)** | The internal design specs — decisions, reasoning, and rejected alternatives |

:::note Status
Retinue is under active development. Concept docs describe the settled design; code examples
show the intended public API as it comes online.
:::
