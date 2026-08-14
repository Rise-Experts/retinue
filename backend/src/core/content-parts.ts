/**
 * Typed message parts — `docs/02-core-and-persistence.md`.
 *
 * Every part carries a schema version and is JSON-runtime validated. Provider-specific
 * metadata may be retained in the namespaced `providerMetadata` field but cannot define
 * application behaviour.
 */

import type {
  ArtifactId,
  ArtifactVersionId,
  BlobRef,
  ConversationId,
  FileId,
  InteractionId,
  MessageId,
  MessagePartId,
  RunId,
  ToolCallId,
} from "./ids.js";
import type { PlatformError } from "./errors.js";

export const MESSAGE_PART_TYPES = [
  "text",
  "reasoning",
  "tool-call",
  "tool-result",
  "question",
  "approval",
  "file",
  "image",
  "citation",
  "source",
  "artifact",
  "status",
  "error",
] as const;

export type MessagePartType = (typeof MESSAGE_PART_TYPES)[number];

type PartBase<T extends MessagePartType> = {
  readonly id: MessagePartId;
  readonly type: T;
  /** Schema version of this part's payload. Bumped on any breaking payload change. */
  readonly schemaVersion: number;
  readonly createdAt: string;
  /** Namespaced, non-authoritative provider detail. Never drives application behaviour. */
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
};

export type TextPart = PartBase<"text"> & {
  readonly text: string;
};

export type ReasoningPart = PartBase<"reasoning"> & {
  readonly text: string;
  /** Reasoning is pruned before recent semantic turns when the budget is tight. */
  readonly redacted?: boolean;
};

export type ToolCallPart = PartBase<"tool-call"> & {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly input: unknown;
};

export type ToolResultPart = PartBase<"tool-result"> & {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Populated for inline results. Large results are spilled and referenced instead. */
  readonly output?: unknown;
  /** Authorized reference to an offloaded result, read back via `read_tool_output`. */
  readonly spilledOutputRef?: BlobRef;
  readonly truncated: boolean;
};

export type QuestionPart = PartBase<"question"> & {
  readonly interactionId: InteractionId;
  readonly questions: readonly {
    readonly key: string;
    readonly prompt: string;
    readonly options?: readonly string[];
  }[];
  readonly answeredAt?: string;
};

export type ApprovalPart = PartBase<"approval"> & {
  readonly interactionId: InteractionId;
  readonly toolName: string;
  readonly summary: string;
  readonly riskCategory: string;
  readonly decidedAt?: string;
};

export type FilePart = PartBase<"file"> & {
  readonly fileId: FileId;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
};

export type ImagePart = PartBase<"image"> & {
  readonly fileId: FileId;
  readonly mediaType: string;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
};

export type CitationPart = PartBase<"citation"> & {
  readonly sourceId: string;
  readonly quote: string;
  readonly locator?: string;
};

export type SourcePart = PartBase<"source"> & {
  readonly sourceId: string;
  readonly title: string;
  readonly url?: string;
};

export type ArtifactPart = PartBase<"artifact"> & {
  readonly artifactId: ArtifactId;
  readonly versionId: ArtifactVersionId;
  readonly title: string;
};

export type StatusPart = PartBase<"status"> & {
  readonly status: string;
  readonly detail?: string;
};

export type ErrorPart = PartBase<"error"> & {
  readonly error: PlatformError;
};

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | QuestionPart
  | ApprovalPart
  | FilePart
  | ImagePart
  | CitationPart
  | SourcePart
  | ArtifactPart
  | StatusPart
  | ErrorPart;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type Message = {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly runId?: RunId;
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  readonly createdAt: string;
};
