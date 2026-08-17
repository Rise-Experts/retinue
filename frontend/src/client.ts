/**
 * Transport-agnostic client contract — `docs/06`. The headless hooks depend only on this interface,
 * never on a concrete transport, so the same hooks run over GraphQL, SSE, or a test double. A host
 * provides an implementation (e.g. a GraphQL client) through `AgentkitProvider`.
 */

import type { ApprovalDecision } from "@agentkit/backend";
import type { ConversationSummary, ContextInspection, Message, RunEvent } from "./types/index.js";

export type { ApprovalDecision };

export type Paged<T> = { readonly items: readonly T[]; readonly nextCursor?: string };

export interface AgentkitClient {
  listConversations(input: { includeArchived?: boolean; cursor?: string }): Promise<Paged<ConversationSummary>>;
  listMessages(input: { conversationId: string; cursor?: string }): Promise<Paged<Message>>;
  sendMessage(input: { conversationId: string; text: string }): Promise<{ runId: string }>;
  cancelRun(input: { runId: string }): Promise<void>;
  answerQuestion(input: { interactionId: string; runId: string; answers: Record<string, string> }): Promise<void>;
  decideApproval(input: { interactionId: string; runId: string; decision: ApprovalDecision }): Promise<void>;
  /** Resumable event stream for a run; `after` is the last-seen sequence (0 from the start). */
  subscribeRun(input: { runId: string; conversationId: string; after: number }): AsyncIterable<RunEvent>;
  uploadAttachment?(file: Blob, filename: string, onProgress?: (fraction: number) => void): Promise<{ fileId: string }>;
  getArtifact?(input: { artifactId: string }): Promise<{ title: string; versionId: string; content: string }>;
  /** The context inspection for a conversation/run — what shaped the prompt (Context panel, #39). */
  getConversationContext?(input: { conversationId: string; runId?: string }): Promise<ContextInspection>;
}
