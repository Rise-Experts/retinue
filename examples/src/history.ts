/**
 * Reconstructing a conversation — #155.
 *
 * One function, used by **both** the engine's `loadHistory` and the page's `/api/history`. That is the whole
 * point of it living here: two projections of the same conversation that could disagree would be a worse
 * problem than the awkwardness of the projection itself.
 *
 * It is now a plain read of `messages` in order. It used to fold the run event log with `reduceRunEvent` for
 * every user turn, because user turns were persisted and assistant turns were not — `MessageStore` was
 * read-only and `DurableWorkerDeps` took no message store, so the assistant's reply existed only as
 * `part.added` rows in `run_events`. #157 closed that: the worker records the assistant's turn at every
 * terminal transition, so history is one query instead of one query per turn plus a fold.
 *
 * The fold is not merely redundant now — keeping it would double every assistant turn.
 */

import { createPostgresMessageStore } from "@agentkit/backend";
import type { ConversationId, SqlExecutor, TenantId, TurnMessage } from "@agentkit/backend";

export const conversationTurns = async (input: {
  readonly sql: SqlExecutor;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly limit?: number;
}): Promise<readonly TurnMessage[]> => {
  const page = await createPostgresMessageStore(input.sql).listByConversation({
    tenantId: input.tenantId as TenantId,
    conversationId: input.conversationId as ConversationId,
    limit: input.limit ?? 100,
  });

  const turns: TurnMessage[] = [];
  for (const message of page.items) {
    // Text only. Tool calls and their results are in the parts too, and a model does not need to be told
    // again what it already has in its own transcript — but an empty turn would be a hole in the history,
    // so a message that produced no text is skipped rather than pushed blank.
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join("");
    if (text.trim() === "") continue;
    turns.push({ role: message.role === "assistant" ? "assistant" : "user", text });
  }
  return turns;
};
