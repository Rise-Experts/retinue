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
  FileId,
  InteractionId,
  MessageId,
  PrincipalId,
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

/**
 * The ceiling on session state, defined here rather than in an adapter (#97). It is a domain limit —
 * session state is bounded working memory, not a document store — and every adapter must enforce the
 * same one. It previously lived in `adapters/memory/sessions.ts`, which made two adapters agreeing on
 * it a coincidence rather than a property.
 */
export const DEFAULT_SESSION_STATE_MAX_BYTES = 64 * 1024;

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

  /** One approval by id — how a one-time authorization is verified against what was stored. */
  findApproval(input: TenantScope & { interactionId: InteractionId }): Promise<PendingApproval | null>;
  /**
   * The run's decided-but-unclaimed approval: what a resumed run must execute. Decided and claimed
   * are separate states because the decision is the human's and the claim is the runtime's — without
   * the second, nothing distinguishes "approved, waiting to run" from "approved, already run".
   */
  findDecidedApproval(input: TenantScope & { runId: RunId }): Promise<PendingApproval | null>;
  /**
   * Claim the single execution a decided approval authorizes — the mechanism behind `allow-once`.
   *
   * A compare-and-set, not a read-then-write: two workers racing a resumed run must see exactly one
   * `claimed: true`, because the loser executing anyway is a duplicate publish. `claimed` is false
   * for an approval that is already claimed *and* for one nobody has decided, so an undecided
   * interaction can never be turned into permission.
   */
  claimApproval(
    input: TenantScope & { interactionId: InteractionId; at: string },
  ): Promise<{ approval: PendingApproval; claimed: boolean }>;
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
export interface KnowledgeStore {}
export interface ArtifactStore {}

// ---------------------------------------------------------------------------
// Files (`docs/05-knowledge-and-documents.md`, REQ-026). Two ports, not one.
//
// `BlobStore` below is `put(value) -> ref` / `get(ref) -> value` — JSON, for spilled tool output. It has
// no content type, no size and no stream, so it cannot hold a file: bytes through a `jsonb` column means
// base64, which is the "inject rather than reference" failure the platform forbids everywhere else. #102
// recorded this in the `0011` migration when it declined to make `blobs` a pointer table.
//
// So metadata and bytes are separate ports. They also have genuinely different lifecycles: metadata is
// transactional and soft-deleted, bytes are eventually deleted by a sweep, and the gap between the two is
// where orphans live.
// ---------------------------------------------------------------------------

/**
 * Where a file is in its lifecycle.
 *
 * `pending` exists because an upload is two writes — metadata, then bytes — and the window between them is
 * real. A file stuck in `pending` is metadata with no bytes, which is one of the two orphan directions
 * reconciliation looks for.
 *
 * `deleting` is the same window in reverse: the metadata is gone from the user's view and the bytes are
 * not yet gone from storage. Deleting them in one transaction is not available — object storage does not
 * join a database transaction — so the intermediate state is named rather than pretended away.
 */
export const FILE_STATES = ["pending", "stored", "deleting", "deleted"] as const;
export type FileState = (typeof FILE_STATES)[number];

export type FileMetadata = {
  readonly id: FileId;
  /**
   * The conversation that owns it.
   *
   * Ownership rather than association: AC-3 and AC-4 of #129 both follow from it — entitlement to the file
   * *is* entitlement to the conversation, and deleting the conversation is what schedules the bytes. A file
   * with no owner would need its own permission model, which is a second one to keep in step.
   */
  readonly conversationId: ConversationId;
  /** As the user named it. Display only — never used to address the bytes. */
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  /**
   * How the content store addresses the bytes. Opaque here.
   *
   * Deliberately not derived from the filename or the id: a key a caller can *construct* is a key a caller
   * can guess, and `sanitizeMediaRefs`' comment in ShareFlow is the cautionary tale — its workspace-prefix
   * check was "the ONLY thing standing between a forged path and a signed URL to another tenant's private
   * object".
   */
  readonly contentKey: string;
  /** Of the bytes as stored, so a read-back can be checked rather than assumed. */
  readonly checksum?: string;
  readonly state: FileState;
  /** Extraction outcome (#131). Absent for a file nothing has tried to extract yet. */
  readonly extraction?: FileExtraction;
  readonly uploadedBy: PrincipalId;
  readonly createdAt: string;
  /** Soft delete. A row is kept so a reference to it resolves to "deleted" rather than to nothing. */
  readonly deletedAt?: string;
};

/**
 * What a file records about its derived text (#131).
 *
 * Declared here rather than imported from `documents/`: a store port that depended on the extraction pipeline
 * would make the pipeline a prerequisite for storing a file, and `persistence` is the layer nothing above it
 * gets to reach into.
 *
 * Separate from the file's own `state` on purpose. A file is perfectly `stored` while its extraction has
 * `failed`, and conflating the two would make an unreadable document look like a lost upload.
 */
export type FileExtraction = {
  readonly state: "pending" | "running" | "extracted" | "failed" | "skipped";
  /** Where the extracted document lives. `BlobStore` holds JSON, which is exactly what it is. */
  readonly ref?: BlobRef;
  readonly failureReason?: string;
  readonly failureMessage?: string;
  readonly pageCount?: number;
  readonly blockCount?: number;
  readonly truncated?: boolean;
  readonly at?: string;
};

export interface FileMetadataStore {
  create(input: TenantScope & { file: FileMetadata }): Promise<void>;

  /** `null` for another tenant's file as well as an absent one — the two must be indistinguishable. */
  get(input: TenantScope & { id: FileId }): Promise<FileMetadata | null>;

  /** Live files only: soft-deleted rows are excluded, since this is what a user sees. */
  listByConversation(
    input: TenantScope & PageRequest & { conversationId: ConversationId },
  ): Promise<Page<FileMetadata>>;

  /**
   * Advance the lifecycle, with the state it must currently be in.
   *
   * Compare-and-set rather than a blind write: two workers finishing the same upload, or a delete racing a
   * completion, must not leave a file `stored` after its bytes were scheduled for removal. Returns whether
   * this call was the one that moved it.
   */
  transition(
    input: TenantScope & {
      id: FileId;
      from: FileState;
      to: FileState;
      at: string;
      checksum?: string;
    },
  ): Promise<{ readonly moved: boolean }>;

  /**
   * Record the outcome of extraction (#131).
   *
   * Idempotent and deliberately **not** a compare-and-set, unlike `transition`. A retried extraction writing
   * the same outcome twice is harmless, and requiring the caller to state the previous extraction state would
   * make a retry after a crash impossible — the crash is exactly why it does not know what that state was.
   *
   * `recorded: false` means the file is gone, which a retry after a conversation delete will legitimately
   * hit; reported rather than thrown, because it is an ordinary race and not a fault.
   */
  recordExtraction(
    input: TenantScope & { id: FileId; extraction: FileExtraction },
  ): Promise<{ readonly recorded: boolean }>;

  /**
   * Files in a given extraction state, oldest first.
   *
   * The reconciliation of *extraction*, distinct from `listByState`'s reconciliation of bytes: a file stuck in
   * `running` is a worker that died mid-parse, and nothing else would ever notice.
   */
  listByExtractionState(
    input: TenantScope & PageRequest & { state: FileExtraction["state"]; olderThan: string },
  ): Promise<Page<FileMetadata>>;

  /**
   * Mark every live file of a conversation for byte deletion.
   *
   * One call rather than a list-then-loop, because a file uploaded between the list and the loop would be
   * missed — and it would be missed silently, leaving bytes for a conversation that no longer exists.
   */
  scheduleConversationDeletion(
    input: TenantScope & { conversationId: ConversationId; at: string },
  ): Promise<{ readonly scheduled: number }>;

  /**
   * Files in a state longer than they should be — reconciliation's input.
   *
   * `olderThan` rather than "all in this state", because a file that entered `pending` a second ago is an
   * upload in progress and a file that entered it yesterday is an orphan. Without the threshold the job
   * would report every upload happening while it ran.
   */
  listByState(
    input: TenantScope & PageRequest & { state: FileState; olderThan: string },
  ): Promise<Page<FileMetadata>>;
}

/** What the content store recorded about the bytes it accepted. */
export type StoredContent = {
  readonly contentKey: string;
  /** As actually written, which may differ from what the caller declared — see `putFile`. */
  readonly byteSize: number;
  readonly checksum: string;
};

/** One object as the content store sees it. Used only by reconciliation. */
export type StoredObject = {
  readonly contentKey: string;
  readonly byteSize: number;
};

/**
 * The bytes.
 *
 * Separate from `FileMetadataStore` because object storage cannot join a database transaction, and
 * pretending otherwise is what produces orphans. Every method is tenant-scoped: a `contentKey` from one
 * tenant must never resolve another's object, and the key alone must not be sufficient.
 */
export interface FileContentStore {
  /**
   * Write bytes and report what was written.
   *
   * **`maxBytes` is enforced while reading, not checked beforehand.** A declared size is a claim; the cap is
   * the defence. An adapter must stop consuming and discard the partial object when the cap is passed —
   * reading to the end and then refusing is a denial of service that happens to return an error.
   */
  putFile(
    input: TenantScope & {
      contentKey: string;
      mediaType: string;
      bytes: AsyncIterable<Uint8Array>;
      maxBytes: number;
    },
  ): Promise<StoredContent>;

  /** `null` when absent, or when the key belongs to another tenant. */
  readFile(input: TenantScope & { contentKey: string }): Promise<AsyncIterable<Uint8Array> | null>;

  /**
   * A short-lived authorised URL, or `null` when this adapter proxies reads instead.
   *
   * `expiresInSeconds` is **required**, and there is deliberately no method that returns a durable URL —
   * that is AC-6 of #129 made structural rather than left as a rule an adapter has to remember. An adapter
   * with no signing mechanism returns `null` and the caller streams through `readFile`.
   */
  signedUrl(
    input: TenantScope & { contentKey: string; expiresInSeconds: number },
  ): Promise<string | null>;

  /** Idempotent: deleting an absent object is a no-op, because a retried sweep must not fail. */
  deleteFile(input: TenantScope & { contentKey: string }): Promise<void>;

  /**
   * Objects this tenant has stored.
   *
   * For reconciliation's second direction — bytes with no metadata — which is the one that costs money
   * silently and which the metadata store cannot see at all.
   */
  listObjects(input: TenantScope & PageRequest & { prefix?: string }): Promise<Page<StoredObject>>;
}

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
