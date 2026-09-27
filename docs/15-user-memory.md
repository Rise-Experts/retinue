# User-Level Memory

The third memory scope, alongside session state (docs/13) and tenant knowledge (docs/05).
**User (principal) memory** is what lets the assistant *remember the user across their
conversations* — preferences, standing facts, working style — the "ChatGPT remembers you"
layer, done as tenant-isolated, user-controlled infrastructure.

## The three scopes, kept distinct

| Scope | Keyed by | Lifetime | Home |
|---|---|---|---|
| Session state | `conversationId` | one thread | `SessionStateStore` (docs/13) |
| **User memory** | `tenantId` + `principalId` | across the user's threads | **`PrincipalMemoryStore` (this doc)** |
| Tenant knowledge | `tenantId` | org-wide | RAG collections (docs/05) |

User memory is **not** session state (which dies with the thread) and **not** tenant knowledge
(which is org-wide). It follows one person across their sessions, within one tenant.

## Record

```ts
type PrincipalMemoryEntry = {
  id: string;
  tenantId: string;
  principalId: string;
  text: string;                       // one atomic fact/preference
  source: "user-stated" | "extracted";
  confidence: number;                 // extracted entries carry a score
  sensitivity: "normal" | "sensitive";
  createdAt: string;
  lastUsedAt?: string;
  version: number;                    // optimistic concurrency
};
```

Entries are atomic facts, tenant- and principal-scoped, bounded in count/size.

## Write path — extraction, never blind

- **User-stated** memories ("remember that I prefer a formal tone") are captured explicitly.
- **Extracted** memories are *proposed* by a post-turn extraction step and pass a deterministic
  validation + **dedupe/merge against existing entries** before commit — the model proposes,
  the platform commits. Raw model output is never written directly.
- Writes are versioned (optimistic concurrency) and bounded; over the ceiling, lowest-value or
  stalest entries are retired, not silently dropped without record.
- No secrets are stored; `sensitive` entries are flagged and redaction rules apply.

## Read path — a budgeted context provider

User memory enters a run through a **context provider** (docs/03), not by dumping every entry:

- Only entries **relevant to the current turn** are retrieved (recency + relevance), with
  provenance and sensitivity, and a token estimate.
- It competes in the context budget like any other section — **lower priority than recent turns
  and session state**, so it never crowds out the live conversation.
- `lastUsedAt` is updated when an entry actually influences a turn (feeds the inspector below).

## Authorization & privacy

- Strictly `tenantId` + `principalId` scoped — one user can never see another's memory, and
  memory never crosses tenants. Enforced by the authorization `scope()` (docs/11) and RLS.
- Every write and every deletion is audited.

## User control & transparency

- The user can **list, edit and delete** their memories (GraphQL mutations + a UI panel), and
  disable memory entirely.
- The Context inspector (docs/06) shows **which memory entries influenced a turn**, so memory is
  never opaque.
- Deletion propagates immediately: a deleted entry cannot re-enter a later prompt.

## Interfaces

- `PrincipalMemoryStore` — versioned, scoped CRUD + relevance query.
- `MemoryExtractor` — proposes candidate entries from a completed turn (validated before commit).
- A built-in **user-memory context provider**.

## Scoped memory — #285

Memory for a **group of conversations** rather than a person: what a project's chats have taught
("never say *revolutionary*", "slide 1 names the dish"), known to every chat in that project.

| Scope | Keyed by | Lifetime | Home |
|---|---|---|---|
| **Scoped memory** | `tenantId` + `scope` (`kind:id`, e.g. `project:7f3c…`) | across every conversation in the scope | **`ScopedMemoryStore`** |

**A second store, not a column on `principal_memory`.** That table's RLS policy is
`principal_id = app.principal_id` — right for a person, wrong for a project, where a rule Alice's chat taught
must reach Bob's chat. Folding both into one table would weaken the policy on everyone's personal memory, or
make it switch per row; a separate `scoped_memory` table with a tenant-only policy keeps the personal
guarantee untouched. Which scopes a run may read is the host's decision, made when it names them.

Everything else is shared with personal memory: `MEMORY_LIMITS`, `validateAndDedupe`, `MemoryCandidate`,
`MemoryPatch` — one gate, not two.

- **The host names scopes per run** — `NewRun.memoryScopes` (or `RunInput.memoryScopes` on `createAgent`). The
  engine copies them from the run row onto `ExecutionContext.memoryScopes`, the one object a model cannot write
  to, so a tool argument can never add a scope. `parseMemoryScope` decides what is well formed; `principal` is
  reserved as a kind.
- **The provider** (`createScopedMemoryProvider`) emits one "What this project has learned" section per scope,
  **bounded in UTF-8 bytes** (`maxBytes`, default 2,048, per scope). Entries are taken most-salient first and
  added whole while they fit; one that does not fit is skipped, never cut. `estimatedTokens` is computed from
  the body actually emitted and the section draws from the `user-context` bucket, so the assembler's budget
  sees exactly what it costs. `provenance` is `scoped-memory:<scope>#<entry ids>` for the inspector.
- **Extraction** (`commitExtractedScopedMemories`) takes the execution context: the source (conversation, run,
  principal) is read from it, and the target scope must be one the run belongs to. `requireConfirmation: true`
  stores accepted candidates as `proposed` — listed for review, never retrieved until a person confirms them.
- **The host UI's API is the store**: `list` (with `status: "proposed"` for the review queue), `update` to edit,
  disable or confirm (`patch: { status: "active" }`), and `delete` to forget — a hard delete, so a forgotten
  entry cannot re-enter the next turn.
- **Every write records its source.** `put` requires `source: { conversationId, runId?, principalId? }`, and
  `conversationId` is required-but-nullable: a note typed into a project's settings says `null` explicitly.

Migration `0037_scoped_memory` adds the table and `runs.memory_scopes`; it is additive and reversible.

## Acceptance criteria

- Memory persists across a principal's conversations and is never visible to another principal
  or tenant, proven by isolation tests.
- Extracted memories are validated and deduped before commit; raw model output is never stored.
- The provider retrieves only relevant entries under budget and never crowds out recent turns.
- A user can list/edit/delete/disable their memory; deletion cannot resurface in later prompts.
- The inspector attributes which memory entries influenced a given turn.
- (#285) A memory written in one conversation of a scope appears in the next conversation of the same scope,
  and never in another scope or tenant — proven against Postgres (`postgres-scoped-memory.test.ts`).
- (#285) Forgetting a scoped memory removes it from the next turn's context.
- (#285) The scoped section respects a byte budget and reports its size to the context-budget accounting.
