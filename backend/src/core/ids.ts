/**
 * Branded identifiers.
 *
 * Every durable record in `docs/02-core-and-persistence.md` gets a distinct ID type so
 * a run ID can never be passed where a conversation ID is expected.
 */

declare const brand: unique symbol;

/**
 * Exported so a downstream package can mint its own IDs with the same mechanism rather than a second,
 * incompatible one. `asId` is generic over this, so an integration package's `PostDraftId` gets the
 * same "cannot be passed where another ID is expected" guarantee the platform's own IDs have.
 */
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Branded<string, "TenantId">;
export type PrincipalId = Branded<string, "PrincipalId">;
export type MembershipId = Branded<string, "MembershipId">;
export type RoleId = Branded<string, "RoleId">;
export type RequestId = Branded<string, "RequestId">;

export type AgentId = Branded<string, "AgentId">;
export type SkillId = Branded<string, "SkillId">;
export type ConversationId = Branded<string, "ConversationId">;
export type RunId = Branded<string, "RunId">;
export type MessageId = Branded<string, "MessageId">;
export type MessagePartId = Branded<string, "MessagePartId">;
export type CheckpointId = Branded<string, "CheckpointId">;
export type InteractionId = Branded<string, "InteractionId">;
export type ApprovalGrantId = Branded<string, "ApprovalGrantId">;
export type UsageEventId = Branded<string, "UsageEventId">;
export type EvaluationCaseId = Branded<string, "EvaluationCaseId">;
export type EvaluationRunId = Branded<string, "EvaluationRunId">;
export type FileId = Branded<string, "FileId">;
export type FileVersionId = Branded<string, "FileVersionId">;
export type KnowledgeCollectionId = Branded<string, "KnowledgeCollectionId">;
export type KnowledgeSourceId = Branded<string, "KnowledgeSourceId">;
export type KnowledgeChunkId = Branded<string, "KnowledgeChunkId">;
export type ArtifactId = Branded<string, "ArtifactId">;
export type ArtifactVersionId = Branded<string, "ArtifactVersionId">;
export type ToolCallId = Branded<string, "ToolCallId">;
export type BlobRef = Branded<string, "BlobRef">;
export type AuditEventId = Branded<string, "AuditEventId">;

/** Opaque cursor for the stable pagination every list method uses. */
export type Cursor = Branded<string, "Cursor">;

/**
 * Casts a raw string to a branded ID. Reserved for boundaries that have already
 * validated the value — adapters reading a database row, or a resolver that has
 * authenticated the caller. Never call this on model-generated input.
 */
export const asId = <T extends Branded<string, string>>(value: string): T => value as T;
