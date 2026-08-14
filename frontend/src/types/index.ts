/**
 * Client-facing types.
 *
 * The wire contract is owned by the backend package; the client re-exports it rather
 * than restating it, so the two can never drift. Everything here is type-only and
 * erased at build time — there is no runtime dependency on the backend package.
 */

export type {
  ApprovalPart,
  ArtifactPart,
  CitationPart,
  ErrorPart,
  FilePart,
  ImagePart,
  Message,
  MessagePart,
  MessagePartType,
  MessageRole,
  PlatformError,
  QuestionPart,
  ReasoningPart,
  RunEvent,
  RunEventType,
  RunStatus,
  SourcePart,
  StatusPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "@agent-platform/backend";

/** Local echo state for an optimistic send, before the server confirms it. */
export type OptimisticState = "pending" | "confirmed" | "failed";

export type ConversationSummary = {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
};

/** Where a subscription resumes from after a reconnect. */
export type ResumeCursor = {
  readonly runId: string;
  readonly lastSequence: number;
};
