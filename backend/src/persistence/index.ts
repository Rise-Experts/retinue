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
import type { ConversationId, MessageId, RunId, TenantId } from "../core/ids.js";
import type { PendingApproval, PendingQuestion } from "../hitl/index.js";
import type { Run } from "../runtime/index.js";
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

export interface RunStore {
  findById(input: TenantScope & { id: RunId }): Promise<Run | null>;
  /** Atomic claim. Returns null when another worker already holds the run. */
  claim(input: TenantScope & { id: RunId; workerId: string }): Promise<Run | null>;
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

export interface InteractionStore {
  findPendingQuestion(
    input: TenantScope & { runId: RunId },
  ): Promise<PendingQuestion | null>;
  findPendingApproval(
    input: TenantScope & { runId: RunId },
  ): Promise<PendingApproval | null>;
}

export interface CheckpointStore {
  latest(input: TenantScope & { runId: RunId }): Promise<unknown | null>;
}

export interface UsageStore {}
export interface EvaluationStore {}
export interface FileMetadataStore {}
export interface KnowledgeStore {}
export interface ArtifactStore {}

export interface VectorIndex {}
export interface KeywordIndex {}
export interface BlobStore {}

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
