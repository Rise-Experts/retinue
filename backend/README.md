# @agentkit/backend

Server-side half of the reusable AI platform. Implements the specifications in
[`../docs`](../docs).

## Status

Contracts only. Every type here is transcribed from a specification section; there is
no execution logic yet. Modules marked `@proposed` are not in the specifications and
are open to change.

## Modules

| Module | Specification | Contains |
|---|---|---|
| `core` | [02](../docs/02-core-and-persistence.md) | `ExecutionContext`, branded IDs, typed message parts, error and event contracts |
| `models` | [03](../docs/03-intelligence-runtime.md) | Model definitions, capabilities, pricing, resolution policy |
| `agents` | [03](../docs/03-intelligence-runtime.md) | `AgentManifest` — declarative, stored, versioned |
| `tools` | [03](../docs/03-intelligence-runtime.md) | Tool descriptors, effect classification, result envelope, meta-tools |
| `skills` | [03](../docs/03-intelligence-runtime.md) | Versioned skills with a compact catalog entry and lazily loaded body |
| `context` | [03](../docs/03-intelligence-runtime.md) | Context providers, section metadata, prompt budgets |
| `runtime` | [04](../docs/04-durable-runtime-and-hitl.md) | Run lifecycle states and execution limits |
| `hitl` | [04](../docs/04-durable-runtime-and-hitl.md) | Durable questions, approvals and idempotency |
| `persistence` | [02](../docs/02-core-and-persistence.md) | Tenant-scoped store ports and infrastructure ports |
| `mcp` | *none yet* — `@proposed` | Outbound MCP-server connections, tool import and effect classification |
| `files` | [05](../docs/05-knowledge-and-documents.md) | The attachment lifecycle: capped uploads, mediated reads, scheduled deletion, orphan reconciliation; the reference-not-inject context provider and the bounded `read_attachment` step |
| `documents` | [05](../docs/05-knowledge-and-documents.md) | Extraction to structured blocks (headings, tables, lists), bounded parsers for PDF/Markdown/CSV/JSON, typed failures, and the bounded `read_document` step |

## Rules these contracts encode

1. Every tenant-sensitive operation takes an explicit tenant context. `findById(id)` is
   forbidden; ports use `findById({ tenantId, id })`.
2. `ExecutionContext` identity is constructed by the host application. Model-generated
   input can never override it.
3. Tools are authorization-filtered before discovery **and** re-authorized during
   execution.
4. Every external or destructive tool call carries an idempotency key derived from
   tenant, run and tool-call identity.
5. Untrusted text — tenant-authored skill bodies, MCP tool descriptions — can never
   widen capability. Authorization lives in the policy layer, never in the prompt.

## Scripts

```bash
npm run typecheck -w @agentkit/backend
npm test -w @agentkit/backend
npm run build -w @agentkit/backend
```

## Import convention

The package is ESM with `NodeNext` resolution, so relative imports carry an explicit
`.js` extension even in TypeScript sources.
