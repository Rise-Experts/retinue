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

## Acceptance criteria

- Memory persists across a principal's conversations and is never visible to another principal
  or tenant, proven by isolation tests.
- Extracted memories are validated and deduped before commit; raw model output is never stored.
- The provider retrieves only relevant entries under budget and never crowds out recent turns.
- A user can list/edit/delete/disable their memory; deletion cannot resurface in later prompts.
- The inspector attributes which memory entries influenced a given turn.
