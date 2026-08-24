# Core Domain and Persistence

## Execution context

```ts
type ExecutionContext = {
  tenantId: string;
  principalId: string;
  membershipId?: string;
  roleIds: string[];
  locale: string;
  timezone: string;
  conversationId?: string;
  runId?: string;
  requestId: string;
};
```

Context identity is constructed by the host application. Model-generated input can never override it.

## Durable records

Logical entities:

- Tenant
- Agent and agent version
- Skill and skill version
- Conversation (thread, with agent binding and ownership)
- Session state (cross-run working memory)
- Thread summary (compacted history)
- Principal memory (cross-session user memory)
- Run
- Message
- Message part
- Checkpoint
- Pending interaction
- Approval grant
- Usage event
- Evaluation case/run/result
- File and file version
- Knowledge collection/source/chunk
- Artifact and artifact version
- Tool-output blob
- Audit event

## Typed message parts

Required types:

- `text`
- `reasoning`
- `tool-call`
- `tool-result`
- `question`
- `approval`
- `file`
- `image`
- `citation`
- `source`
- `artifact`
- `status`
- `error`

Every part contains a schema version and is JSON-runtime validated. Provider-specific metadata may be retained in an optional namespaced field but cannot define application behavior.

## Storage ports

Use small interfaces rather than one database adapter:

```ts
interface ConversationStore {}
interface SessionStateStore {}
interface ThreadSummaryStore {}
interface PrincipalMemoryStore {}
interface RunStore {}
interface MessageStore {}
interface AgentStore {}
interface SkillStore {}
interface InteractionStore {}
interface CheckpointStore {}
interface UsageStore {}
interface EvaluationStore {}
interface FileMetadataStore {}
interface KnowledgeStore {}
interface ArtifactStore {}
```

### `MessageStore.append` (#157)

Worth calling out because it was absent for a long time and its absence was not obvious. `MessageStore` was
read-only, and both the Postgres and in-memory adapters carried an `append` documented as a "test-only
affordance" — so there was no *supported* way for an application to record what a user said, and every host
reached past the port with a cast or wrote raw SQL. The engine reads history from this store, so something has
to write to it.

It is **insert-only and idempotent on the id**. A message is immutable once written: editing one would rewrite
history a client has already streamed and a model has already been shown. So there is deliberately no update and
no delete, and a repeat of the same id is a no-op rather than an error — a retried request must not fail and must
not duplicate.

The assistant's turn is written by `createDurableWorker`, at every **terminal** transition and only there. A run
that failed or was cancelled still streamed text the person read; dropping it would show them a reply that
vanishes on reload. The paused states are excluded by construction — they transition back to `queued`, and
writing there would take the id first, so the partial turn would win and the completed one would be silently
discarded as a duplicate.

Separate infrastructure ports:

```ts
interface VectorIndex {}
interface KeywordIndex {}
interface BlobStore {}
interface JobDispatcher {}
interface RealtimePublisher {}
interface DistributedLockStore {}
```

## Mandatory method behavior

- Every read/write method receives `tenantId` explicitly.
- List methods use stable cursor pagination.
- Writes accept idempotency or expected-version inputs where applicable.
- Stores expose optimistic concurrency behavior consistently.
- Deletes define soft-delete, hard-delete and cascade semantics.
- Transaction-dependent workflows use a neutral unit-of-work abstraction.

Unsafe APIs such as `findById(id)` are forbidden; use `findById({tenantId, id})`.

## Initial adapters

| Adapter | Release |
|---|---|
| In-memory | Foundation; reference contract tests |
| PostgreSQL | Foundation; reference production adapter |
| Supabase | Foundation; ShareFlow RLS and Realtime integration |
| Redis | Durable locks and event coordination |
| BullMQ | Run and ingestion jobs |
| pgvector | Initial semantic retrieval |
| S3-compatible | Production blobs |
| Local filesystem | Self-hosted development |

MySQL, SQLite, MongoDB and other vector databases are deferred until a real consumer requires them.

## Capability declarations

Adapters advertise capabilities including transactions, RLS, full-text search, vector search, realtime, distributed locking, durable jobs and managed schema. Startup validation fails with an actionable message when an enabled feature lacks a required capability.

## Automatic schema provisioning

An adapter that advertises the `managedSchema` capability can create and upgrade its own
tables and indexes on startup, so a fresh database becomes usable without a manual
migration step — the zero-config experience Agno provides today.

```ts
interface SchemaManager {
  currentVersion(): Promise<number>;
  targetVersion(): number;
  plan(): Promise<SchemaChange[]>;   // no side effects
  apply(): Promise<void>;            // create/upgrade to targetVersion
}
```

- Mode is explicit config: `auto` (provision on startup, for development and self-hosted),
  `plan` (log the diff and refuse to run), or `off` (production-managed migrations own the
  schema). Default is `off` for the PostgreSQL adapter and `auto` for memory/dev.
- Provisioning is versioned, forward-only within an adapter, and idempotent — running it
  twice is a no-op. It composes with, and never bypasses, the versioned reversible
  migrations required in doc 09.
- Auto mode acquires a distributed lock so concurrent workers cannot provision at once.
- The applied schema version is recorded and surfaced in the adapter health check.

## Conformance suite

Every adapter must pass shared tests for:

- Tenant isolation.
- CRUD and pagination.
- Idempotency.
- Concurrent updates.
- Checkpoint recovery.
- Deletion propagation.
- Permission filtering.
- Transaction semantics when advertised.

