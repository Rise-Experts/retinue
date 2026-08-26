# Subpath entry points

One file per published subpath (#196). Each exists so the heavy dependency behind it is an **optional peer** and
not something every consumer installs.

Importing the package root loads `ai` and `zod`. Nothing else.

| Entry | Subpath | Who calls it | Optional peer |
|---|---|---|---|
| — | `.` | Everyone. Five values and every type | *none* |
| `runtime.ts` | `./runtime` | A host composing its own engine instead of taking `createRuntime`'s defaults | *none* |
| `tools.ts` | `./tools` | Anyone writing or dispatching a tool, plus the first-party library (#188) | *none* — the tools use the global `fetch` |
| `persistence.ts` | `./persistence` | A host wiring storage; the in-memory adapters live here | *none* — verified: it reaches nothing at all |
| `context.ts` | `./context` | Prompt assembly and budgeting, skills, per-principal memory, citations, and the untrusted-content fence | *none* |
| `knowledge.ts` | `./knowledge` | Retrieval, documents, files, artifacts, export | *none* |
| `hitl.ts` | `./hitl` | Approvals, questions, authorization | *none* |
| `usage.ts` | `./usage` | Spend, quotas, rollups | *none* |
| `mcp.ts` | `./mcp` | Importing another server's tools, and the egress policy | *none* |
| `observability.ts` | `./observability` | Telemetry, retention, the security review, the load and evaluation harnesses | *none* |
| `providers.ts` | `./providers` | Choosing a model provider | the six `@ai-sdk/*` packages |
| `adapters-postgres.ts` | `./adapters/postgres` | | `pg` |
| `adapters-redis.ts` | `./adapters/redis` | | `ioredis` |
| `adapters-bullmq.ts` | `./adapters/bullmq` | | `bullmq`, `ioredis` |
| `adapters-otel.ts` | `./adapters/otel` | | *none* — the adapter takes structural types; the SDK appears only in its tests |
| `server.ts` | `./server` | The reference GraphQL host, the schema and the resolvers, the runnable commands | `graphql`, `graphql-yoga`, `@whatwg-node/server` |

## The root is five values

`createRuntime`, `resolveCapabilities`, `defineAgent`, `asId`, and `AgentPlatformError` with its guard. It was
392 (#199).

Types are unaffected: every type in the package is still exported from the root by `export type *`, which emits
no import. So the root's runtime graph reaches **nothing** — not `ai`, not `zod`, not one module of its own
beyond the handful those five need. `root-import-weight.test.ts` asserts that as an empty list rather than a
shrinking one, because a shrinking list passes when something new is added.

**Each name has exactly one subpath.** Three did not when the split was made — convenience re-exports inside
layer modules, each a one-line kindness that quietly gave one name two futures — and `public-surface.test.ts`
now fails on a fourth. The five the root keeps also appear on their own layer's subpath, which is deliberate: a
`./runtime` exporting `ERROR_CODES` but not `AgentPlatformError` would be a subpath with an invisible hole. What
is asserted there is that both paths lead to the **same binding**, since two paths to two objects is how
`instanceof` starts failing.

## Why there is no `./testing` yet

The SPEC left it open, and the build settles it for now: `src/testing/**` is **excluded** from `tsconfig.json`,
so the conformance suite is not compiled and cannot be an entry of this build. Shipping it means compiling it and
taking `vitest` as a peer dependency — which is a real decision about whether adapters written outside this
repository are a supported extension point, not a packaging detail to slip in.

Deferred deliberately rather than decided quietly. Until then an external adapter author cannot be held to the
same behaviour as the ones in here, and that is a gap worth naming.
