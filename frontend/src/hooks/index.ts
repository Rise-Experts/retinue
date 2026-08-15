/**
 * Headless hook contracts — `docs/06-graphql-and-frontend.md`.
 *
 * Signatures only. The implementations land with the GraphQL surface in the migration
 * plan; declaring the shapes first lets `web/` and `mobile/` agree on one protocol
 * before either is wired up.
 *
 * The package is transport-agnostic and carries no product styling. React Native uses
 * the same reducers and hook contracts with native renderers.
 */

import type {
  ConversationSummary,
  Message,
  MessagePart,
  PlatformError,
  ResumeCursor,
  RunEvent,
  RunStatus,
} from "../types/index.js";

export type AsyncState<T> = {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: PlatformError | undefined;
};

export type UseConversations = (input?: {
  includeArchived?: boolean;
}) => AsyncState<readonly ConversationSummary[]> & {
  readonly fetchMore: () => void;
  readonly hasMore: boolean;
};

export type UseConversation = (input: {
  conversationId: string;
}) => AsyncState<readonly Message[]> & {
  readonly fetchEarlier: () => void;
};

export type UseSendMessage = (input: { conversationId: string }) => {
  /** Renders optimistically, then reconciles against authoritative query state. */
  readonly send: (text: string) => Promise<void>;
  readonly sending: boolean;
  readonly error: PlatformError | undefined;
};

/**
 * Retry detail surfaced from the latest `run.retry-pending` event, so a UI can show
 * "attempt 2 of 5, retrying in ~3s" and not just the bare `retry-pending` status.
 * `undefined` once the run leaves `retry-pending`.
 */
export type RetryState = {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly reason: PlatformError;
};

export type UseRunSubscription = (input: {
  runId: string;
  /** Resume point after a reconnect, so no part is missed or rendered twice. */
  resumeFrom?: ResumeCursor;
}) => {
  readonly status: RunStatus | undefined;
  readonly parts: readonly MessagePart[];
  readonly lastEvent: RunEvent | undefined;
  /** Present while `status === "retry-pending"`; drives the retry indicator. */
  readonly retry: RetryState | undefined;
  readonly connected: boolean;
};

export type UsePendingInteraction = (input: { runId: string }) => {
  readonly question: Extract<MessagePart, { type: "question" }> | undefined;
  readonly approval: Extract<MessagePart, { type: "approval" }> | undefined;
};

export type UseAnswerQuestion = () => {
  readonly answer: (input: {
    interactionId: string;
    answers: Record<string, string>;
  }) => Promise<void>;
  readonly submitting: boolean;
};

export type UseDecideApproval = () => {
  readonly decide: (input: {
    interactionId: string;
    decision: "allow-once" | "allow-conversation" | "allow-always" | "deny";
  }) => Promise<void>;
  readonly submitting: boolean;
};

export type UseCancelRun = () => {
  readonly cancel: (input: { runId: string }) => Promise<void>;
  readonly cancelling: boolean;
};

export type UseAttachmentUpload = () => {
  readonly upload: (file: Blob, filename: string) => Promise<{ fileId: string }>;
  readonly progress: number;
  readonly error: PlatformError | undefined;
};

export type UseArtifact = (input: { artifactId: string }) => AsyncState<{
  readonly title: string;
  readonly versionId: string;
  readonly content: string;
}>;
