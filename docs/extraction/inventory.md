# Extraction Inventory — Twenty / Agno → @agentkit

What we extract, from where (pinned to a source commit), the target `@agentkit` package, and
the dependency edges that block a clean lift — each with a proposed neutral port. Analysis only.

## Sources (pinned)

| Source | Repo | Commit | Role |
|---|---|---|---|
| ShareFlow AI backend | `Rise-Experts/social_share` → `ai_backend/` | `731c93fe` | The running **Agno** runtime being replaced |
| Twenty | `Rise-Experts/twenty` | `454be88b71` | Architectural patterns (not a running agent) |
| Twenty apps | `Rise-Experts/twenty-apps` | `163ec22` | How the social app consumes the runtime |

Naming follows Agno's concepts; the target **structure** follows Twenty's layered module layout,
which the `@agentkit` package map already mirrors.

## Agno runtime → @agentkit (file-level)

### `ai_backend/app/assistant/` — orchestration
| Agno file | Concept | Target package | Extract vs rebuild |
|---|---|---|---|
| `agent.py` | Agno `Agent` build (history, deps) | `runtime` + `agents` | rebuild (drop `num_history_runs`) |
| `factory.py` | assistant factory / composition | `runtime` (composition root) | rebuild |
| `specialists.py`, `studio.py` | multi-agent **Team**, per-role specialists | `agents` (versioned manifests) | rebuild as declarative manifests |
| `context.py` | `contextvars` (workspace_id, user_id) | `core` `ExecutionContext` | rebuild (explicit, passed not global) |
| `dependencies.py` | deps injected into run | `context` providers | rebuild |
| `auth.py`, `middleware.py` | request auth / middleware | `authorization` + transport (`graphql`) | rebuild |
| `db.py`, `db_skills.py` | persistence + workspace skills | `persistence` + `skills` | extract logic, re-port storage |
| `skills.py` | skill loading (`LocalSkills`) | `skills` | rebuild on the skills port |
| `tools.py` | `@tool` defs (`generate_content`, `search_web`) | `tools` (+ ShareFlow integration) | rebuild on the tool registry |
| `llm_resolve.py` | model resolution | `models` | rebuild |

### `ai_backend/app/agents/` — the specialist team + adapters
| Agno file | Concept | Target package | Notes |
|---|---|---|---|
| `planner_agent`, `writer`, `tailor`, `reply`, `researcher`, `quality`, `vision` | specialist agents | `agents` manifests + `runtime` | ShareFlow-specific manifests live in the integration |
| `model.py` | `complete()` provider adapter, `LlmOverride` | `models` (provider factory) | rebuild on Vercel AI SDK |
| `memory.py` | `get_agno_db()` → Agno `PostgresDb`/`InMemoryDb` | `persistence` (`SessionStateStore`) | **AVOID Agno session pattern** (see gaps) |
| `tools.py` | agent tools | `tools` | rebuild |

### `ai_backend/app/llm/`, `core/`, `schemas/`
| Agno file | Concept | Target package |
|---|---|---|
| `llm/registry.py` | `LlmOverride`, `SUPPORTED_PROVIDERS` (pure data, no SDK) | `models` (registry) |
| `llm/agno_factory.py` | build Agno model per provider | `models` (provider factory) |
| `core/browser,capture,readpage,readpdf,makepdf,safefetch,websearch` | web/pdf/vision utilities | `files` / `documents` / `pdf` / `rag` + research `tools` |
| `core/config.py` | settings | composition/config |
| `schemas/api.py` | request/response contracts | `graphql` |

### `ai_backend/skills/` — built-in skills (ShareFlow-specific)
`analytics-reporting`, `document-generation`, `mermaid-diagrams`, `platform-media-rules`,
`post-composition`, `publishing-safety`, `research-and-citation` → the **skill-loading
mechanism** goes to `skills`; the skill **content** is ShareFlow's and lives in the integration.
Note: `db_skills.py` already enforces TEXT-ONLY workspace skills (no executable code) — matches
the platform rule "arbitrary skill scripts disabled by default".

## Twenty patterns → @agentkit

| Twenty source | Pattern | Target |
|---|---|---|
| `twenty-server/src/modules/workflow/workflow-executor`, `workflow-tools` | step/tool execution, status machine | `runtime` + `tools` |
| `twenty-server/src/modules/dashboard/tools` | tool descriptor shape | `tools` |
| `twenty-sdk` / `twenty-client-sdk` (`graphql-sse`) | transport, subscriptions over SSE | `graphql` + the SSE adapter (SPEC #27) |

## Blocking dependency edges → proposed neutral port

| Blocking coupling (Agno/Twenty) | Why it blocks | Proposed neutral port |
|---|---|---|
| Agno `Agent(db=…)` binds runtime to Agno's DB | can't swap storage | `persistence` stores + `SessionStateStore` |
| `contextvars` global request context | hidden global, not tenant-safe by construction | explicit `ExecutionContext` (host-built) |
| `num_history_runs=20` history injection | token bloat + failures | budgeted context (docs/03) + compaction (docs/13) |
| `SUPABASE_DB_URL` / Supabase wiring in `memory.py` | provider lock-in | `persistence` (Postgres/Supabase adapters) + `BlobStore` |
| `LlmOverride` + `agno_factory` tie to Agno models | provider lock-in | `models` registry + provider factory (Vercel AI SDK) |
| Agno `Team` routing by role string | framework-specific | declarative `agents` manifests + `runtime` router |

## Gap notes (keep vs avoid)

- **Context window (AVOID).** Agno uses `add_history_to_context=True, num_history_runs=20` — a
  fixed, model-unaware window plus manual token pointers. Replace with model-registry limits +
  per-section budgets + pruning (docs/03).
- **Session handling (AVOID).** Agno sessions via `get_agno_db` re-inject 20 turns and drop the
  rest (no summarization). Replace with session state + versioned thread-summary compaction
  (docs/13).
- **Retry (KEEP).** Agno's retry is the pattern worth carrying over — reimplemented Claude-style
  (backoff+jitter, honor `retry-after`, transient classes only, bounded attempts) and made safe
  by idempotency keys (docs/04). Now specified and surfaced to the frontend.
