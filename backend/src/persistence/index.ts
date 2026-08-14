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
import type { ConversationId, MessageId, RunId } from "../core/ids.js";
import type { PendingApproval, PendingQuestion } from "../hitl/index.js";
import type { Run } from "../runtime/index.js";
import type { SkillCatalogEntry, SkillVersion } from "../skills/index.js";

export type Conversation = {
  readonly id: ConversationId;
  readonly title: string;
  readonly archivedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export interface ConversationStore {
  findById(input: TenantScope & { id: ConversationId }): Promise<Conversation | null>;
  list(input: TenantScope & PageRequest): Promise<Page<Conversation>>;
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
