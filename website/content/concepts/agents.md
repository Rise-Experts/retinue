---
sidebar_position: 2
---

# Agents

## What is it?

An **agent** is a declarative, versioned manifest — instructions, a model policy, and which
tools, skills and context providers it may use. Agents are data, not code: stored, versioned,
and auditable.

## Why would I use it?

Because the alternative — hardcoding a model id and a prompt into your app — makes every change
a deploy and every A/B test a fork. A manifest lets you evolve behavior, pin versions per
conversation, and record exactly which agent version produced each turn.

## The manifest

```ts
type AgentManifest = {
  id: string;
  version: number;
  name: string;
  instructions: string;
  modelPolicy: ModelPolicy;          // asks for a `fast`/`smart` role, not a model id
  responseFormat: ResponseFormat;
  toolPolicy: { preloaded: string[]; categories: string[]; excluded: string[] };
  skillPolicy: { assigned: string[]; allowTenantSkills: boolean };
  authorizationPolicyId: string;
  contextProviderIds: string[];
  limits: ExecutionLimits;           // max steps, tool calls, cost ceiling, timeout
};
```

## Model resolution

An agent never names a model. It requests a **role** (`fast` or `smart`); the model registry
resolves the concrete model by capability, tenant policy, data residency, cost ceiling, and
deprecation state. Switching providers changes no agent code.

## Versioning

A conversation is **bound to an agent and (optionally) a version**, so a resumed thread runs the
same brain that produced its earlier turns. Every run records the agent + skill versions it used.

## Configuration

| Field | Purpose |
|---|---|
| `modelPolicy` | role + constraints (cost, residency) |
| `toolPolicy` | preloaded tools, allowed categories, exclusions |
| `limits` | max steps / tool calls / cost / wall-clock |
| `authorizationPolicyId` | which permission policy governs this agent |

Next: **[Tools](tools)**.

## Where this is specified

This page is the shape of the thing. The specification is where the decisions and their reasons live — read it
when you need to know *why* something behaves the way it does, or what was considered and rejected.

- [Intelligence runtime](/specifications/intelligence-runtime)
