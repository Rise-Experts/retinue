---
sidebar_position: 1
---

# Package surface

The module inventory, the published subpaths, the capability list, the first-party tools and the flow
primitives — moved here from the package README, which is a front door rather than a reference.

Nothing here is a promise on its own: what is covered by semver is the package root's exports and the
documented subpaths, and that is stated in
[Versioning, API surface and deprecation](https://github.com/Rise-Experts/retinue/blob/main/docs/19-versioning.md).

## Modules

| Module | Specification | Contains |
|---|---|---|
| `core` | [02](/specifications/core-and-persistence) | `ExecutionContext`, branded IDs, typed message parts, error and event contracts |
| `capabilities` | #198, #196 | `createRuntime` — the composition root. The wired set is **derived** from the dependencies supplied, not declared beside them, so there is one statement of intent and one of fact. A capability that is off is **enforced**: `runtime.stores.messages` throws when `history` is off, so no caller has to remember to check |
| `capabilities` *(model)* | #198 | What a runtime does, **declared and cross-checked**. A capability on with nothing wired refuses to construct; so does one wired that nothing declares — the second direction is what catches a feature present, tested and reachable from nothing. Profiles for the two common shapes: a chat assistant, and a headless automation |
| `models` | [03](/specifications/intelligence-runtime) | Model definitions, capabilities, pricing, resolution policy |
| `agents` | [03](/specifications/intelligence-runtime) | `AgentManifest` — declarative, stored, versioned |
| `tools` | [03](/specifications/intelligence-runtime) | Tool descriptors, effect classification, result envelope, meta-tools |
| `skills` | [03](/specifications/intelligence-runtime) | Versioned skills with a compact catalog entry and lazily loaded body |
| `context` | [03](/specifications/intelligence-runtime) | Context providers, section metadata, prompt budgets |
| `runtime` | [04](/specifications/durable-runtime-and-hitl) | Run lifecycle states and execution limits |
| `hitl` | [04](/specifications/durable-runtime-and-hitl) | Durable questions, approvals and idempotency |
| `persistence` | [02](/specifications/core-and-persistence) | Tenant-scoped store ports and infrastructure ports |
| `usage` | [12](/specifications/usage-and-accounting) | Recomputed rollups keyed on tenant, period and principal; quota enforcement at admission across **every** applicable limit — calendar windows, rolling windows and per-model allowances — with a warning below the limit; provider reconciliation that reports rather than corrects |
| `evaluation` | [09](/specifications/quality-and-release) | Deterministic graders for six of seven expectation kinds, a pinned and cached judge for the seventh, and a release comparison that names the cases that moved |
| `mcp` | [10](/specifications/mcp-integration) | Outbound MCP-server connections, tool import with safe-by-default effect classification, per-run catalog snapshots for drift detection, and an HTTP egress policy |
| `files` | [05](/specifications/knowledge-and-documents) | The attachment lifecycle: capped uploads, mediated reads, scheduled deletion, orphan reconciliation; the reference-not-inject context provider and the bounded `read_attachment` step |
| `documents` | [05](/specifications/knowledge-and-documents) | Extraction to structured blocks (headings, tables, lists), bounded parsers for PDF/Markdown/CSV/JSON, OCR and vision ports, confidence flagging, typed failures, and the bounded `read_document` step |
| `artifacts` | [05](/specifications/knowledge-and-documents) | Named, versioned assistant output: content by reference, compare-and-set versioning, required provenance, restore, and conversation-scoped access |
| `export` | [05](/specifications/knowledge-and-documents) | Deterministic PDF and Markdown rendering, one export per version per format, downloads through the mediated file path |
| `knowledge` | [05](/specifications/knowledge-and-documents) | Structure-aware chunking, the batched embedding pipeline, incremental resumable re-indexing, the freshness target, and hybrid rank-fusion retrieval with an honest empty result |
| `citations` | [05](/specifications/knowledge-and-documents) | Per-claim provenance as a durable snapshot, groundedness derived from the citation graph, permission checked at citation time |
| `adapters` | [02](/specifications/core-and-persistence) | Every storage and infrastructure implementation: `memory` (18 files, the reference), `postgres` (26), `supabase` (RLS over the Postgres adapters), `redis`, `bullmq`, `otel`. All three store families are held to the same conformance suite — 29 memory / 28 postgres (1 n/a) / 29 supabase, with no unaccounted cells |
| `authorization` | [11](/specifications/authorization) | The policy port. **Frozen v1.** Tools are filtered before discovery and re-authorized during execution; untrusted text can never widen capability |
| `graphql` | [06](/specifications/graphql-and-frontend) | SDL plus a thin resolver map the host mounts on its own server, so the library takes no GraphQL server dependency |
| `idempotency` | [04](/specifications/durable-runtime-and-hitl) | The idempotency contract. **Frozen v1.** Every external or destructive call carries a key derived from tenant, run and tool-call identity |
| `principal-memory` | [15](/specifications/user-memory) | Per-person memory, scoped to the principal as well as the tenant — enforced in the adapters and by RLS, not by a `WHERE` clause the caller has to remember |
| `retention` | [18](/specifications/data-retention) | Retention windows and the deletion path |
| `security` | [17](/specifications/security-review) | The security review as executable acceptances, each with a revisit date the release gate checks |
| `telemetry` | [16](/specifications/load-and-resilience) | The telemetry port and its OTel adapter |
| `loadtest` | [16](/specifications/load-and-resilience) | Load, soak and failure injection harnesses |
| `worker` | [05](/specifications/knowledge-and-documents) | The export worker |
| `server` | [06](/specifications/graphql-and-frontend) | The reference GraphQL host, SSE endpoint, boot, config, health and the runnable API and worker commands. Reached at the `./server` subpath; `graphql`, `graphql-yoga` and `@whatwg-node/server` are **optional peers**, so a consumer embedding the runtime in their own server installs none of them. Rules **R12** and **R13** keep the dependency one-way |
| `tools/library` | — | The first-party tools (#188), reached at the `./tools` subpath: web fetch and search, HTTP, CSV, JSON, read-only SQL, knowledge search, attachments, time and arithmetic. Envelopes only — rule **R7** forbids I/O here |
| `toolkit` | — | The deterministic functions those tools delegate to, and the only place the outbound HTTP client is built. Separate from `tools/` precisely because it *does* perform I/O |
| `testing` | [09](/specifications/quality-and-release) | The conformance suite every adapter runs, plus PGlite fixtures. Named `testing` and shipped deliberately: an adapter written outside this repository has to be holdable to the same behaviour |

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

The root is the **semver boundary**: what is exported from it is API, and what is not exported from it cannot be
broken. So it is **five values** — it was 392 (#199).

```ts
import { createRuntime, resolveCapabilities, defineAgent, asId, AgentPlatformError } from "@retinue/agentkit";
```

Every **type** is still exported from the root, by `export type *`, which emits no import. That is what makes the
cut affordable: a consumer holding an `ExecutionContext` does not have to know which layer defined it, and a type
cannot be broken by being imported. The split is **types by subject, values by consumer**.

The root's runtime graph now reaches *nothing* — not `ai`, not `zod`. Those are still real dependencies of the
package, because `./runtime` and `./tools` need them, and they stay `dependencies` rather than peers: a consumer
who installs this will use at least one subpath and should not have to install two more things to do it.

```ts
import { createDefaultEngine } from "@retinue/agentkit/runtime";
import { defineTool, createStandardToolProvider } from "@retinue/agentkit/tools";  // no peer: uses global fetch
import { createMemoryRunStore } from "@retinue/agentkit/persistence";              // no peer at all
import { createPostgresRunStore } from "@retinue/agentkit/adapters/postgres";      // peer: pg
import { typeDefs, createResolvers } from "@retinue/agentkit/server";              // peer: graphql, graphql-yoga
```

`src/entries/README.md` lists them all, including why there is no `./testing` yet.

## Capabilities

Eight booleans, declared and cross-checked against the wiring — REQ-043 (#197).

```ts
const runtime = createRuntime({
  profile: "automation",              // or "assistant", or no profile and set them yourself
  capabilities: { memory: "on" },     // an override, without restating the rest
  floor: { runs },                    // what every runtime needs
  stores: { usage, principalMemory },
});
```

| Capability | Needs | On means |
|---|---|---|
| `history` | `messages` | Prior turns reach the model |
| `memory` | `principalMemory` | Per-person memory is read and written |
| `compaction` | `summaries`, `summarizer` | A long thread is condensed rather than refused |
| `citations` | `citations` | Claims carry provenance |
| `questions` | `interactions` | A run can park on a question and resume |
| `skills` | `skills` | Named instruction blocks load on demand |
| `mcp` | `mcpConnections`, `mcpClient` | Another server's tools are importable |
| `usage` | `usage` | Spend is metered |

**A declaration that disagrees with the wiring refuses to start**, in both directions and naming every
mismatch at once. Declared on with nothing wired is the obvious half. Wired but *not* declared is the half that
matters more: it is how a declaration drifts into a lie, and this repo has found the same defect six times
(#157, #159, #161, #163, #165, #185) — a capability that existed, passed its tests, and was wired to nothing.

**Off removes the cost.** No store is required, no query is issued, and reading the dependency of an off
capability throws rather than returning undefined — access is the gate, so no caller has to remember to check.

**Approvals and quotas are not on this list, deliberately.** They have no off switch. An automation that needs no
human approves through a *policy* that records what it approved, which is auditable; a boolean that removed the
gate would remove the record with it. That distinction is the difference between "nobody had to approve this" and
"nobody knows whether anybody approved this".

### The minimum viable configuration

The smallest thing that runs a tool-calling automation — no conversation, no memory, no human in the loop:

```ts
const runtime = createRuntime({ profile: "automation", floor: { runs }, stores: { usage } });
```

One store beyond the floor. A run in this configuration has **no `conversationId`** — absent, not invented
(#198): the conversation-scoped capabilities are unavailable rather than operating on a fabricated id, which is
what #164 did with `principalId` and why every per-person figure silently read as a machine's.

All 256 combinations of the eight are constructed and gate-checked in `capabilities/__tests__/runtime.test.ts`.
That test used to enumerate six hand-picked mixes, on the reasoning that the matrix would "assert that
combinations nobody has thought about work" — which is backwards for a surface of eight independent booleans,
where the combination nobody thought about is the one a customer picks first.

## Tools

Fifteen first-party tools, at `@retinue/agentkit/tools`. **Wiring is the toggle** — a tool exists when its
dependency was supplied and not otherwise, because a separate `enable` flag beside a `sqlQuery` function is how a
deployment ends up with a tool that is enabled and unwired:

```ts
const tools = createStandardToolProvider({
  deps: { authorization, idempotency, approvals },
  http: {},                                          // fetch_url, fetch_json, http_request, http_write
  search: braveProvider,                             // web_search — omitted, and the tool does not exist
  sql: { query: readOnlyPool, readOnly: true, schemas: ["app"] },
  knowledge: { retriever, authSubjects: (ctx) => [String(ctx.conversationId)] },
});
```

| | |
|---|---|
| `fetch_url`, `fetch_json`, `http_request` | `read`. Egress-policy checked before any request, redirects refused rather than followed, bodies bounded while reading and fenced as untrusted content |
| `http_write` | `external-write`, so approval and an idempotency key are required by the registry. Two tools rather than one with a `method` argument, because effect is classified per *tool* — a single tool could only be gated for every call or none |
| `parse_csv`, `query_json` | `read`, pure. They take text, not a path or a URL: reading is `read_attachment`'s or `fetch_url`'s job, and each should be checked by the thing that should check it |
| `sql_query`, `sql_schema` | `read`, and only honest because `createSqlQuery` demands a `readOnly: true` acknowledgement. The keyword scan inside it is a second line of defence; the connection is the control |
| `search_knowledge` | `read`. `authSubjects` comes from the host, never from tool input — a model must not widen its own read scope by asking |
| `read_attachment`, `list_attachments`, `read_document` | `read`, through `FileService` so the entitlement check is not duplicated |
| `now`, `calculate` | `read`, pure. `calculate` is a parser, not `eval`: the expression comes from a model |

Credentials are configured per host (`headersFor`) and never appear in a tool's input schema. The client refuses
an `authorization` or `cookie` header supplied by a caller rather than forwarding it.

## Flows and teams

`@retinue/agentkit/flows` — REQ-038 ([#187](https://github.com/Rise-Experts/retinue/issues/187)) and REQ-037
([#186](https://github.com/Rise-Experts/retinue/issues/186)).

**A team is a kind of flow step, and a team compiles to a flow.** Both issues say they share design, and they are
right: a flow's step and a team's member turn are the same idea, and modelling them separately produces two
overlapping notions of "a step" to keep in agreement forever.

```ts
import { compileTeam, createFlowRunner } from "@retinue/agentkit/flows";
```

### The interpreter is a pure function

`advance(definition, execution, outcome)` returns the next execution and **one effect** for the caller to perform.
It performs nothing itself — no agent call, no tool call, no clock read, no store write. Every property these two
REQs ask for is a consequence rather than a separate mechanism:

| Property | Why it follows |
|---|---|
| Durable resume | The returned execution *is* the position. A host persists it; after a restart it calls `advance` again and gets the same effect. There is no interpreter instance to rebuild |
| Idempotency across a resume | The effect's key is `(executionId, step, attempt)` — all three are in the stored state, so a step that wrote externally and crashed produces the *same* key and the idempotency store answers with the first result |
| Budgets | Checked before the effect is produced, so an over-budget flow performs nothing rather than spending and then noticing |
| Tests | Feeding outcomes to a function needs no agent, no database and no clock. The awkward cases — a crash mid-step, a retry surviving a process death — are testable at all |

The alternative, an async interpreter that awaits its own effects, is shorter and cannot be made durable without a
checkpoint after every `await` — which is the same state machine with the states implicit.

### A definition and an execution are different things

`FlowExecution.flowVersion` is pinned at start and the definition is read at that version for the execution's whole
life. **Editing a flow does not change one already running.** Proven live: a v2 with a completely different shape
was published while an execution sat parked at a checkpoint, and it still finished through v1.

The store refuses to overwrite a version at all — `(tenant_id, flow_id, version)` is the primary key with no
`ON CONFLICT` — which is what makes the pin worth having.

### Step kinds

`agent`, `team`, `tool`, `branch`, `wait`, `checkpoint`, `subflow`, `done`. A `checkpoint` uses the **existing**
HITL path, so a parked flow is the same object the assistant surface already answers.

Two arithmetic details that were bugs first: `done` consumes no budget and is not gated by one, because a budget
stops *work* and finishing is not work. Counting it meant a flow whose ceiling exactly matched its work always
failed on the last step — so `maxSteps: 3` really meant two steps and a marker. A `branch` does count, because a
branch can loop.

### Failure is chosen in the definition

`retry` (bounded, with backoff), `skip`, `escalate`, `fail`. A retry gets a **different** idempotency key, because
reusing it would have the store answer with the *failed* first result — a retry policy that silently does nothing.
A failed step that spent money is still charged, or a retrying flow costs more than its ceiling allows.

### Teams

`sequential` chains one agent step per member, each reading the previous one's output *and* the original brief —
passing only the previous output loses the request by the third member, which is how a chain of agents drifts off
the question. `manager-led` compiles to **one** agent step whose tools include a delegation tool, so the engine's
own turn loop does the iterating and a delegation is a real tool call: authorised, approved, deduplicated and
accounted for unchanged, because it *is* one rather than resembling one.

A member's tools are an **intersection**, never a union: a member cannot reach a tool the delegating context could
not, and the delegation tool itself is always stripped — a member that could delegate would be a manager.

### An agent step is a child run

Each agent step creates a `Run` of its own and the flow parks on it (#202). A run rather than an inline model
call, because a `Run` is what earns checkpointing, recovery, quota admission and its own usage rows — calling a
model from the runner would be a second turn implementation with none of those, and it would pass a demo.

Three decisions inside that, each with an appealing wrong answer:

- **The child has no conversation.** `ConversationRunCoordinator` claims a *conversation's* single run slot, so a
  flow inside a conversation whose steps also claimed it would deadlock against the conversation's own turn — the
  parent holds the slot and waits for a child that can never get it. A conversation-less run (#198) has no slot to
  contend for, and what the member needs travels in the run's `input`.
- **The ceiling is the flow's remainder**, re-derived per step. Handing each member the flow's original budget
  would let every one of them spend the whole thing. Visible live: the first member gets 6 steps, the second 5.
- **Two ways to wake up, and only one of them is load-bearing.** `onRunSettled` on the worker is the fast path;
  correctness is a *poll* of the child's state at the top of every resume. A crash between the child completing
  and the notification being sent loses the message, and a parent that only woke on notifications would sit
  forever with nothing looking again.

`Run.input` and `Run.limits` exist because of this. #198 made a run able to exist without a conversation, but the
only place a request could live was a `Message` — and a message requires a conversation. So the run shape said "no
conversation needed" while the storage said its input still needed one.

`npm run flow -w @retinue/example-app` drives all of it against Postgres: a flow straight through, one parked for
a person, a reload from storage by something that never held it, the version pin against a published v2, a team
whose members become child runs with shrinking ceilings, a lost notification recovered by the poll, and a failing
member routed into its step's policy.

## Where the boundary is enforced

`npm run check:consumer` packs the published tarball, installs it into a directory whose only knowledge of the
package is `node_modules`, and requires every subpath above to load *and* typecheck while a deep import into
`dist/` or `src/` is refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`. So this page describes a surface that is
checked against the artefact a consumer installs, not against the source tree.
