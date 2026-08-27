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
  responseFormat: ResponseFormat;    // text, or a validated object — see below
  toolPolicy: { preloaded: string[]; categories: string[]; excluded: string[] };
  skillPolicy: { assigned: string[]; allowTenantSkills: boolean };
  authorizationPolicyId: string;
  contextProviderIds: string[];
  limits: ExecutionLimits;           // max steps, tool calls, cost ceiling, timeout
};
```

:::warning Four of these fields are declared and not yet interpreted

`toolPolicy`, `skillPolicy`, `authorizationPolicyId` and `contextProviderIds` are read by nothing today. Setting
them has no effect — in particular **`toolPolicy.excluded` is not an enforced exclusion**; use a tenant toolset
for that. This is tracked as [#244](https://github.com/Rise-Experts/retinue/issues/244), which decides per field
whether an interpreter ships or the field is removed, and `check:reachability` now fails the build if a fifth
one joins them quietly.

:::

## Structured output

An agent can answer with a validated object instead of prose:

```ts
const triage = defineAgent({
  id: "triage",
  name: "Triage",
  instructions: "Classify the inbound message.",
  modelPolicy: { role: "smart", requiredCapabilities: { structuredOutput: true } },
  responseFormat: {
    kind: "structured",
    schema: z.object({ severity: z.enum(["low", "high"]), summary: z.string() }),
  },
});
```

The answer arrives as a single `structured` message part carrying the validated value. Four rules:

- **Use a Zod schema** (or anything implementing Standard Schema). A plain JSON-schema object is refused: the
  underlying SDK sends one to the provider and validates nothing coming back, so the platform would be promising
  a shape it never checks.
- **A non-conforming answer fails the run** — it is never handed back as text.
- **Nothing partial streams.** A half-built object does not satisfy the schema, so the value is emitted once, at
  the end of the turn. Tool calls stream normally around it.
- **Tools still work.** Only the final answer is constrained.

Ask for `requiredCapabilities: { structuredOutput: true }` so resolution picks a model that can do it, rather
than the run failing at the turn.

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
