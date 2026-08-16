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

