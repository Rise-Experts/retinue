# @retinue/agentkit

Server-side half of the reusable AI platform. Implements the specifications in
[`../docs`](../docs).

## Status

Implemented and exercised end to end. 174 source files, ~36,000 lines, 2,143 tests.

This section said *"Contracts only … there is no execution logic yet"* until 2026-08-24,
which stopped being true a long time before it was corrected — a README that understates
a package this far is worse than none, because the reader concludes it does nothing and
looks elsewhere.

What exists now: a durable run loop with leases, checkpointing and recovery; a streaming
agent engine with tool calls, approvals, questions and citations; three storage adapter
families held to one conformance suite; usage accounting with quota enforcement; MCP tool
import; and a GraphQL surface. `examples/` is a runnable application over all of it, and
`shareflow/` is the first real integration.

Verified against real Postgres, Redis and a live model provider, not only in memory — the
distinction matters, and `docs/09` records which claims rest on which.

## Modules

| Module | Specification | Contains |
|---|---|---|
| `core` | [02](../docs/02-core-and-persistence.md) | `ExecutionContext`, branded IDs, typed message parts, error and event contracts |
| `capabilities` | #198, #196 | `createRuntime` — the composition root. The wired set is **derived** from the dependencies supplied, not declared beside them, so there is one statement of intent and one of fact. A capability that is off is **enforced**: `runtime.stores.messages` throws when `history` is off, so no caller has to remember to check |
| `capabilities` *(model)* | #198 | What a runtime does, **declared and cross-checked**. A capability on with nothing wired refuses to construct; so does one wired that nothing declares — the second direction is what catches a feature present, tested and reachable from nothing. Profiles for the two common shapes: a chat assistant, and a headless automation |
| `models` | [03](../docs/03-intelligence-runtime.md) | Model definitions, capabilities, pricing, resolution policy |
| `agents` | [03](../docs/03-intelligence-runtime.md) | `AgentManifest` — declarative, stored, versioned |
| `tools` | [03](../docs/03-intelligence-runtime.md) | Tool descriptors, effect classification, result envelope, meta-tools |
| `skills` | [03](../docs/03-intelligence-runtime.md) | Versioned skills with a compact catalog entry and lazily loaded body |
| `context` | [03](../docs/03-intelligence-runtime.md) | Context providers, section metadata, prompt budgets |
| `runtime` | [04](../docs/04-durable-runtime-and-hitl.md) | Run lifecycle states and execution limits |
| `hitl` | [04](../docs/04-durable-runtime-and-hitl.md) | Durable questions, approvals and idempotency |
| `persistence` | [02](../docs/02-core-and-persistence.md) | Tenant-scoped store ports and infrastructure ports |
| `usage` | [12](../docs/12-usage-and-accounting.md) | Recomputed rollups keyed on tenant, period and principal; quota enforcement at admission across **every** applicable limit — calendar windows, rolling windows and per-model allowances — with a warning below the limit; provider reconciliation that reports rather than corrects |
| `evaluation` | [09](../docs/09-quality-and-release.md) | Deterministic graders for six of seven expectation kinds, a pinned and cached judge for the seventh, and a release comparison that names the cases that moved |
| `mcp` | [10](../docs/10-mcp-integration.md) | Outbound MCP-server connections, tool import with safe-by-default effect classification, per-run catalog snapshots for drift detection, and an HTTP egress policy |
| `files` | [05](../docs/05-knowledge-and-documents.md) | The attachment lifecycle: capped uploads, mediated reads, scheduled deletion, orphan reconciliation; the reference-not-inject context provider and the bounded `read_attachment` step |
| `documents` | [05](../docs/05-knowledge-and-documents.md) | Extraction to structured blocks (headings, tables, lists), bounded parsers for PDF/Markdown/CSV/JSON, OCR and vision ports, confidence flagging, typed failures, and the bounded `read_document` step |
| `artifacts` | [05](../docs/05-knowledge-and-documents.md) | Named, versioned assistant output: content by reference, compare-and-set versioning, required provenance, restore, and conversation-scoped access |
| `export` | [05](../docs/05-knowledge-and-documents.md) | Deterministic PDF and Markdown rendering, one export per version per format, downloads through the mediated file path |
| `knowledge` | [05](../docs/05-knowledge-and-documents.md) | Structure-aware chunking, the batched embedding pipeline, incremental resumable re-indexing, the freshness target, and hybrid rank-fusion retrieval with an honest empty result |
| `citations` | [05](../docs/05-knowledge-and-documents.md) | Per-claim provenance as a durable snapshot, groundedness derived from the citation graph, permission checked at citation time |
| `adapters` | [02](../docs/02-core-and-persistence.md) | Every storage and infrastructure implementation: `memory` (18 files, the reference), `postgres` (26), `supabase` (RLS over the Postgres adapters), `redis`, `bullmq`, `otel`. All three store families are held to the same conformance suite — 29 memory / 28 postgres (1 n/a) / 29 supabase, with no unaccounted cells |
| `authorization` | [11](../docs/11-authorization.md) | The policy port. **Frozen v1.** Tools are filtered before discovery and re-authorized during execution; untrusted text can never widen capability |
| `graphql` | [06](../docs/06-graphql-and-frontend.md) | SDL plus a thin resolver map the host mounts on its own server, so the library takes no GraphQL server dependency |
| `idempotency` | [04](../docs/04-durable-runtime-and-hitl.md) | The idempotency contract. **Frozen v1.** Every external or destructive call carries a key derived from tenant, run and tool-call identity |
| `principal-memory` | [15](../docs/15-user-memory.md) | Per-person memory, scoped to the principal as well as the tenant — enforced in the adapters and by RLS, not by a `WHERE` clause the caller has to remember |
| `retention` | [18](../docs/18-data-retention.md) | Retention windows and the deletion path |
| `security` | [17](../docs/17-security-review.md) | The security review as executable acceptances, each with a revisit date the release gate checks |
| `telemetry` | [16](../docs/16-load-and-resilience.md) | The telemetry port and its OTel adapter |
| `loadtest` | [16](../docs/16-load-and-resilience.md) | Load, soak and failure injection harnesses |
| `worker` | [05](../docs/05-knowledge-and-documents.md) | The export worker |
| `server` | [06](../docs/06-graphql-and-frontend.md) | The reference GraphQL host, SSE endpoint, boot, config, health and the runnable API and worker commands. Reached at the `./server` subpath; `graphql`, `graphql-yoga` and `@whatwg-node/server` are **optional peers**, so a consumer embedding the runtime in their own server installs none of them. Rules **R12** and **R13** keep the dependency one-way |
| `testing` | [09](../docs/09-quality-and-release.md) | The conformance suite every adapter runs, plus PGlite fixtures. Named `testing` and shipped deliberately: an adapter written outside this repository has to be holdable to the same behaviour |

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
npm run typecheck -w @retinue/agentkit
npm test -w @retinue/agentkit
npm run build -w @retinue/agentkit
```

From the repository root, the checks that gate a change:

```bash
npm run conformance          # the adapter matrix, and it fails on an unaccounted cell
npm run check:boundaries     # the dependency rules between workspaces
npm run check:reachability    # every declared capability is wired, every run event is emitted
npm run security:review      # the acceptances in `security`, and their revisit dates
```

`check:reachability` exists because the recurring defect in this codebase is not code that
is wrong — it is code that is **correct, tested and unreachable**. Citations, questions,
usage recording, compaction, skills and MCP import were each built, each passing tests,
and each wired to nothing.

## Subpaths

The root exports the runtime and installs `ai` and `zod` — nothing else. Everything with a driver behind it is a
subpath with an optional peer:

```ts
import { createRuntime } from "@retinue/agentkit";
import { createPostgresRunStore } from "@retinue/agentkit/adapters/postgres";  // peer: pg
import { runApiHost } from "@retinue/agentkit/server";                          // peer: graphql, graphql-yoga
```

`src/entries/README.md` lists them all, including why there is no `./testing` yet.

## Import convention

The package is ESM with `NodeNext` resolution, so relative imports carry an explicit
`.js` extension even in TypeScript sources.
