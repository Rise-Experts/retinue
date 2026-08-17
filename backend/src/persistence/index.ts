/**
 * Storage and infrastructure ports — `docs/02-core-and-persistence.md`.
 *
 * Small interfaces rather than one database adapter. Every read and write receives
 * `tenantId` explicitly: `findById(id)` is forbidden, `findById({ tenantId, id })` is
 * the shape. Ports never import adapters.
 *
 * Method bodies are intentionally sparse at this stage — each port is filled in as its
 * phase in `docs/08-migration-plan.md` lands, against the shared conformance suite.
 */

import type { Page, PageRequest, TenantScope } from "../core/context.js";
import type { Message } from "../core/content-parts.js";
import type { AgentManifest } from "../agents/index.js";
import type { PlatformError } from "../core/errors.js";
import type {
  AgentId,
  ApprovalGrantId,
  BlobRef,
  ConversationId,
  InteractionId,
  MessageId,
  RunId,
  TenantId,
} from "../core/ids.js";
import type { ApprovalDecision, ApprovalGrant, PendingApproval, PendingQuestion } from "../hitl/index.js";
import type { Run, RunCheckpoint, RunStatus } from "../runtime/index.js";
import type { UsageEvent } from "../usage/index.js";
import type { SkillCatalogEntry, SkillVersion } from "../skills/index.js";

export type Conversation = {
  readonly id: ConversationId;
  readonly tenantId: TenantId;
  readonly title: string;
  /** Optimistic-concurrency version; incremented on every write. */
  readonly version: number;
  readonly archivedAt?: string;
  /** Set by soft-delete; `findById`/`list` hide soft-deleted rows. */
  readonly deletedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ConversationPatch = {
  readonly title?: string;
  /** `null` un-archives; a timestamp archives. */
  readonly archivedAt?: string | null;
};

/**
 * The exemplar store. **Every store follows this shape** (docs/02 mandatory method behavior):
 * an explicit `{ tenantId }` on every call (bare `findById(id)` is a type error), cursor
 * pagination on lists, `expectedVersion` optimistic concurrency on updates, and soft-delete
 * semantics. Adapters are verified by the shared conformance harness.
 */
export interface ConversationStore {
  create(input: TenantScope & { id: ConversationId; title: string }): Promise<Conversation>;
  findById(input: TenantScope & { id: ConversationId }): Promise<Conversation | null>;
  list(input: TenantScope & PageRequest): Promise<Page<Conversation>>;
  update(
    input: TenantScope & { id: ConversationId; expectedVersion: number; patch: ConversationPatch },
  ): Promise<Conversation>;
  softDelete(input: TenantScope & { id: ConversationId }): Promise<void>;
}

/**
 * Cross-run working memory for a thread (`docs/13-sessions-and-threads.md`). Bounded, versioned,
 * written by the runtime/tools — never raw model output. **Frozen v1.**
 */
export type SessionState = {
  readonly conversationId: ConversationId;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
};

export interface SessionStateStore {
  get(input: TenantScope & { conversationId: ConversationId }): Promise<SessionState | null>;
  /** Optimistic concurrency: rejects when `expectedVersion` is stale. */
  put(
    input: TenantScope & {
      conversationId: ConversationId;
      expectedVersion: number;
      data: Readonly<Record<string, unknown>>;
    },
  ): Promise<SessionState>;
}

export type AgentVersionPolicy = "pinned" | "latest";

/**
 * Binds a thread to the agent that owns it (`docs/13`). A resumed thread runs the same agent — and,
 * when pinned, the same version — that produced its earlier turns, so continuation is deterministic.
 * Kept as its own record rather than bloating the frozen `Conversation`.
 */
export type ConversationBinding = {
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly agentVersionPolicy: AgentVersionPolicy;
  /** Recorded when the policy is `pinned`. */
  readonly agentVersion?: number;
};

export interface ConversationBindingStore {
  bind(input: TenantScope & ConversationBinding): Promise<void>;
  get(input: TenantScope & { conversationId: ConversationId }): Promise<ConversationBinding | null>;
}

/**
 * Per-conversation run serialization (`docs/13` → Run ordering). At most one `Running` run per
 * conversation; further runs queue FIFO by enqueue time so session-state and message order are
 * deterministic. Backed by `DistributedLockStore` semantics in production; in-memory for tests.
 */
export interface ConversationRunCoordinator {
  /**
   * Atomically claim the conversation for `runId`, or enqueue it FIFO if one is already active. This
   * MUST be atomic (no claim→enqueue gap) so a run can never slip past into an idle-but-unclaimed
   * slot and strand itself. The primary entry point for starting a run.
   */
  claimOrEnqueue(
    input: TenantScope & { conversationId: ConversationId; runId: RunId },
  ): Promise<{ status: "started" | "queued"; position: number }>;
  /**
   * Atomically release `runId` (if it holds the slot) and promote the next queued run. MUST be atomic
   * (no release→dequeue→claim gap) so two runs can never both become active. Returns the promoted run
   * to dispatch, or null when the backlog is empty. The primary entry point on run terminal.
   */
  releaseAndPromote(
    input: TenantScope & { conversationId: ConversationId; runId: RunId },
  ): Promise<RunId | null>;
  active(input: TenantScope & { conversationId: ConversationId }): Promise<RunId | null>;
  depth(input: TenantScope & { conversationId: ConversationId }): Promise<number>;
}

/** Compacted older history (`docs/13`). Recent turns stay verbatim; this is versioned. */
export type ThreadSummary = {
  readonly conversationId: ConversationId;
  readonly version: number;
  readonly summary: string;
  readonly coversUpToMessageId: MessageId;
  readonly createdAt: string;
};

export interface ThreadSummaryStore {
  latest(input: TenantScope & { conversationId: ConversationId }): Promise<ThreadSummary | null>;
  append(
    input: TenantScope & { conversationId: ConversationId; summary: string; coversUpToMessageId: MessageId },
  ): Promise<ThreadSummary>;
}

export type NewRun = {
  readonly id: RunId;
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly agentVersion: number;
};

/**
 * The run's durable lifecycle store. Beyond read/claim it owns lease keepalive, guarded status
 * transitions, durable cancellation and stale-lease reaping — the primitives the durable worker
 * (`createDurableWorker`) needs for crash recovery without duplicate work. Verified by the shared
 * `runStoreConformance` harness so every adapter agrees on claim/lease/transition semantics.
 */
export interface RunStore {
  create(input: TenantScope & NewRun): Promise<Run>;
  findById(input: TenantScope & { id: RunId }): Promise<Run | null>;
  /**
   * Atomic lease-based claim. Succeeds for a `queued` run, or for a `running` run whose lease has
   * expired (crash recovery). Returns null when another worker holds a live lease or the run is
   * terminal — so two workers never process one run.
   */
  claim(
    input: TenantScope & { id: RunId; workerId: string; leaseMs: number; now: string },
  ): Promise<Run | null>;
  /** Extend the lease. Returns false when the claim was lost (reaped/stolen) so the worker aborts. */
  keepalive(
    input: TenantScope & { id: RunId; workerId: string; leaseMs: number; now: string },
  ): Promise<boolean>;
  /** Guarded transition by the claiming worker; rejects moves absent from `RUN_TRANSITIONS`. */
  transition(
    input: TenantScope & {
      id: RunId;
      workerId: string;
      to: RunStatus;
      now: string;
      error?: PlatformError;
    },
  ): Promise<Run>;
  /** Persist a cancellation request. The owning worker observes it and stops cooperatively. */
  requestCancel(input: TenantScope & { id: RunId; now: string }): Promise<Run | null>;
  /**
   * Maintenance sweep for runs whose lease expired — recovery candidates. Cross-tenant by design
   * (a background reaper has no tenant); each returned run carries its own `tenantId` for re-claim.
   */
  reapExpired(input: { now: string; limit: number }): Promise<readonly Run[]>;
}

export interface MessageStore {
  findById(input: TenantScope & { id: MessageId }): Promise<Message | null>;
  listByConversation(
    input: TenantScope & PageRequest & { conversationId: ConversationId },
  ): Promise<Page<Message>>;
}

export interface AgentStore {
  findByVersion(
    input: TenantScope & { agentId: string; version: number },
  ): Promise<AgentManifest | null>;
}

export interface SkillStore {
  listCatalog(input: TenantScope): Promise<readonly SkillCatalogEntry[]>;
  findVersion(
    input: TenantScope & { name: string; version: number },
  ): Promise<SkillVersion | null>;
}

/**
 * Durable human-in-the-loop interactions (`docs/04` → Questions & Approvals). Pending questions and
 * approvals survive restart/deploy. `answer`/`decide` are idempotent — the first call resolves the
 * interaction and reports `alreadyResolved: false`; a duplicate reports `true` and changes nothing,
 * so a continuation is queued exactly once.
 */
export interface InteractionStore {
  createQuestion(input: TenantScope & { question: PendingQuestion }): Promise<void>;
  findPendingQuestion(input: TenantScope & { runId: RunId }): Promise<PendingQuestion | null>;
  answerQuestion(
    input: TenantScope & { interactionId: InteractionId; answers: Readonly<Record<string, string>>; at: string },
  ): Promise<{ question: PendingQuestion; alreadyResolved: boolean }>;

  createApproval(input: TenantScope & { approval: PendingApproval }): Promise<void>;
  findPendingApproval(input: TenantScope & { runId: RunId }): Promise<PendingApproval | null>;
  decideApproval(
    input: TenantScope & { interactionId: InteractionId; decision: ApprovalDecision; at: string },
  ): Promise<{ approval: PendingApproval; alreadyResolved: boolean }>;
}

/** Standing approval grants from `allow-conversation` / `allow-always` (`docs/04` → Approvals). */
export interface ApprovalGrantStore {
  grant(input: TenantScope & { grant: ApprovalGrant }): Promise<void>;
  /**
   * An active (unrevoked, unexpired) grant matching the tool name or category, or null. A
   * conversation-scoped grant matches only when `conversationId` is supplied and equal — so an
   * `allow-conversation` grant never leaks to another conversation or tenant-wide.
   */
  findActive(
    input: TenantScope & { toolNameOrCategory: string; now: string; conversationId?: string },
  ): Promise<ApprovalGrant | null>;
  revoke(input: TenantScope & { grantId: ApprovalGrantId; at: string }): Promise<void>;
}

export interface CheckpointStore {
  latest(input: TenantScope & { runId: RunId }): Promise<RunCheckpoint | null>;
  /** Overwrite the run's checkpoint. Monotonic: a save with a lower sequence is ignored. */
  save(input: TenantScope & { checkpoint: RunCheckpoint }): Promise<void>;
}

/** Aggregated usage across a set of events — the basis of ceiling checks and rollups. */
export type UsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly costMinorUnits: number;
  readonly eventCount: number;
};

/**
 * Append-only usage ledger (`docs/12`). Events are never edited or deleted; corrections are new
 * compensating events. Rollups are derived from events, never a second source of truth. Appends are
 * idempotent on `(runId, stepId)` (or `id`) so a recovered run never double-counts.
 */
export interface UsageStore {
  append(input: TenantScope & { event: UsageEvent }): Promise<void>;
  listByRun(input: TenantScope & PageRequest & { runId: RunId }): Promise<Page<UsageEvent>>;
  /** Running totals, optionally scoped to a run or conversation — used by `reserve()` and rollups. */
  totals(
    input: TenantScope & { runId?: RunId; conversationId?: ConversationId },
  ): Promise<UsageTotals>;
}

export interface EvaluationStore {}
export interface FileMetadataStore {}
export interface KnowledgeStore {}
export interface ArtifactStore {}

export interface VectorIndex {}
export interface KeywordIndex {}

/**
 * Content-addressable blob storage for spilled tool output (`docs/03` → Tool results). A large
 * result is offloaded here and referenced by an authorized `BlobRef`, read back via
 * `read_tool_output`. Tenant-scoped so a ref from one tenant can never resolve another's bytes.
 */
export interface BlobStore {
  put(input: TenantScope & { value: unknown }): Promise<BlobRef>;
  get(input: TenantScope & { ref: BlobRef }): Promise<unknown | null>;
}

/**
 * Neutral unit of work, so a transaction-dependent workflow does not hardcode a
 * database. Adapters that cannot provide transactions must not advertise the
 * capability — startup validation fails loudly instead of degrading silently.
 */
export interface UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export const ADAPTER_CAPABILITIES = [
  "transactions",
  "row-level-security",
  "full-text-search",
  "vector-search",
  "realtime",
  "distributed-locking",
  "durable-jobs",
] as const;

export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

export interface CapabilityAware {
  capabilities(): readonly AdapterCapability[];
}
