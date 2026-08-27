# Models, Agents, Tools, Skills and Context

## Model platform

Initial providers: OpenAI, Anthropic, Google, Mistral, Azure OpenAI, Amazon Bedrock and OpenAI-compatible endpoints.

Each model definition contains:

- Provider and model ID.
- Label and lifecycle state.
- Input modalities and output features.
- Context and output limits.
- Tool, structured-output, reasoning and native-search capabilities.
- Input, output and cache pricing.
- Data-residency metadata.

Resolution considers administrator policy, tenant policy, required capabilities, data residency, availability, cost ceiling and deprecation state. Support `fast` and `smart` roles without hardcoding model IDs into agents.

## Agent manifest

```ts
type AgentManifest = {
  id: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  modelPolicy: ModelPolicy;
  responseFormat: ResponseFormat;
  toolPolicy: {
    preloaded: string[];
    categories: string[];
    excluded: string[];
  };
  skillPolicy: {
    assigned: string[];
    allowTenantSkills: boolean;
  };
  authorizationPolicyId: string;
  contextProviderIds: string[];
  limits: ExecutionLimits;
};
```

Agents are declarative, stored, versioned and auditable.

### Which of these fields the runtime honours

A field on a stored definition is worth nothing until something reads it, and five of these were read by nothing
through 0.2.0 — see task [#242](https://github.com/Rise-Experts/retinue/issues/242). `check:reachability` now
holds every field of this type, so the table below is enforced rather than asserted:

| Field | State |
|---|---|
| `id`, `version` | Identity. A run records `agentId` and `agentVersion`, so editing an agent never rewrites history. |
| `name`, `description` | Display. Rendered by a host, returned over GraphQL. |
| `instructions` | The system prompt, unless the host overrides `systemPrompt`. |
| `modelPolicy` | Read by `resolveModel`. |
| `limits` | Enforced — step ceiling, output-token ceiling as the *lower* of agent and model definition, temperature, retries. |
| `responseFormat` | **Honoured** ([#243](https://github.com/Rise-Experts/retinue/issues/243)). See below. |
| `toolPolicy` | **Honoured** ([#244](https://github.com/Rise-Experts/retinue/issues/244)). `excluded` is a permission enforced on every path; `preloaded`/`categories` are protected from a catalogue budget. |
| `skillPolicy` | **Honoured** — `assigned` and `allowTenantSkills` gate both the catalogue section and `load_skill`. |
| `contextProviderIds` | **Honoured** — a selection, in order. Empty means every wired provider; an unknown id is an error. |
| `authorizationPolicyId` | **Honoured** — selects a registered policy. An unregistered id refuses rather than falling back. |

### The four policy fields, and what each decision was

All four were declared and read by nothing through 0.2.0. `check:reachability` now holds every field, so none of
this can silently regress.

**`toolPolicy` — interpreted.** `excluded` reads as a security control, so it is one: it travels on
`ExecutionContext` (which a model cannot write to, so it cannot be widened from inside a turn) and is applied in
the registry's authorized-tool set, before authorization. That single point covers discovery, `find_tools`,
`learn_tools`, direct execution, `execute_tool` and delegating tools — an exclusion enforced only where the
catalogue is built is bypassed by the first caller who already knows the tool's name.

`preloaded` and `categories` say "loaded up front; everything else discovered lazily". *Resident* is what that
means here, so they are protected from the catalogue budget. With no budget configured every tool is resident
anyway and the fields are a no-op. They cannot make a tool appear: exclusion is a permission and residency is a
budget, and the permission wins.

**`skillPolicy` — interpreted.** The subsystem was complete and unreachable: `SkillResolver.listCatalog` already
took `{ assigned, allowTenantSkills }` verbatim, the store had adapters under a conformance suite, and
`ContextKind`/`ContextBudget` reserved a `skills` bucket for a section nothing produced. Wiring a resolver now
adds that section and makes `load_skill` real — which had been in `META_TOOLS` since the registry was written
with nothing implementing it, the third instance after `execute_tool` and `learn_tools`. The same policy gates
loading as well as listing: one that filtered the list but not the load would be no policy at all.

**`contextProviderIds` — interpreted.** An empty list means *every* wired provider rather than none, because
`defineAgent` defaults it to `[]` and reading empty as "no context" would silently strip memory and attachments
from every agent already written. A named id nothing supplies is an error, because the alternative is an
assistant that quietly remembers nothing — indistinguishable from a model choosing not to use its memory.

**`authorizationPolicyId` — interpreted, as a selector.** A registered map is required for any id other than
`"default"`; an unregistered id **refuses**. The reading it had — an agent asking for a narrow policy and
silently getting allow-all — is the worst available, and failing at construction is loud and cheap. The platform
does not check that a named policy is narrower than another: a policy is an interface the host implements, and
composing two into an intersection would mean second-guessing a deployment's own authorization. What is
guaranteed is that the policy an agent named is the policy it got, or the run does not start.

### Structured output

`responseFormat: { kind: "structured", schema }` makes the agent answer with a validated object instead of prose.

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

Four things are true of it, and each is a deliberate choice:

- **The schema must be one this process can validate** — a Zod schema, or anything implementing Standard Schema.
  A bare JSON-schema object is **refused**, with an error naming the fix. The AI SDK's `jsonSchema()` wrapper
  leaves `validate` undefined: it constrains the provider's generation and checks nothing on the way back, so
  accepting one would mean promising a shape nobody verifies. Tools keep taking JSON schema, because a tool's
  arguments are validated by the provider and a bad call is a tool error the model can see and retry — a
  different situation from a guarantee made to a caller about a return value.
- **A non-conforming answer fails the run.** It is never returned as text. A caller who wanted best-effort prose
  did not ask for a schema.
- **Nothing partial streams.** A half-built object does not satisfy the schema, so the answer arrives once, as a
  single `structured` message part, at the end of the turn. Tool calls stream normally around it, so the turn is
  not silent.
- **Tools still work.** Structured output constrains the final answer only; the model↔tool loop is unchanged.

Add `requiredCapabilities: { structuredOutput: true }` to the model policy. Without it, resolution can return a
model that cannot do this, and the engine then refuses at resolution time with a message naming the model —
better than mid-turn, but later than necessary.

`examples/` ships a working one: `examples/src/structured.ts` and `npm run structured`.

## Tool registry

Tool descriptors declare name, label, description, category, input/output schemas, effect classification, approval policy and idempotency requirement. The model-facing description stays canonical; the user-facing label/description is localizable (a catalog key or locale map) per docs/14.

Effects:

- `read`
- `internal-write`
- `external-write`
- `destructive`

The runtime builds a permission-filtered compact catalog. Only commonly required tools are preloaded. Other schemas are loaded lazily.

Built-in meta-tools:

- `learn_tools`
- `execute_tool`
- `load_skill`
- `ask_questions`
- `request_approval`
- `read_tool_output`

Execution rechecks authorization and validates input even when the tool was discoverable earlier.

## Tool results

All tools use a shared success/error envelope. Errors contain a stable code, retryability and safe details. Large results are compacted and may be spilled to blob storage with an authorized reference.

## Skills

Skills are versioned records with a compact catalog description and lazily loaded instruction body. Sources are built-in, tenant or plugin. Arbitrary skill scripts are disabled by default. Skill versions used by a run are recorded.

## Context providers

Each provider returns a section with priority, token estimate, provenance, sensitivity, cacheability and expiry.

Built-in providers:

- Principal, role, locale, timezone and current date.
- Relevant user memory (cross-session, per principal — see docs/15).
- Tenant instructions.
- Application/screen context.
- Uploaded files.
- Relevant knowledge.
- Active workflow state.
- Recent conversation.

Application integrations supply domain providers, such as ShareFlow brand and campaign context.

## Context budget

Prompt assembly has explicit budgets for base policy, user/application context, tools, skills, retrieved knowledge and history. When near the model limit, prune old reasoning and tool details first while preserving recent semantic turns and tool continuity. If context still cannot fit, fail clearly rather than silently truncating critical instructions.

## Acceptance criteria

- Switching providers does not change application tool or message code.
- Unauthorized tools are absent from discovery and rejected if executed directly.
- Only task-relevant tool schemas and skill bodies enter context.
- Prompt composition is previewable with per-section token estimates.
- Agent and skill versions are recorded on every run.

