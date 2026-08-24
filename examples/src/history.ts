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
import type { ConversationId, Message, SqlExecutor, TenantId, TurnMessage } from "@agentkit/backend";

/**
 * One turn, with the parts it was made of.
 *
 * The engine wants text and the page wants text *and* citations, and the temptation is two functions. Two
 * functions is two projections of one conversation that can disagree, which is the whole reason this file
 * exists. So there is one read, returning everything, and `historyForModel` narrows it.
 */
export type ConversationTurn = TurnMessage & {
  /** The stored parts. The page derives citation markers from these; the model is given only `text`. */
  readonly parts: readonly Message["parts"][number][];
};

export const conversationTurns = async (input: {
  readonly sql: SqlExecutor;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly limit?: number;
}): Promise<readonly ConversationTurn[]> => {
  const page = await createPostgresMessageStore(input.sql).listByConversation({
    tenantId: input.tenantId as TenantId,
    conversationId: input.conversationId as ConversationId,
    limit: input.limit ?? 100,
  });

  const turns: ConversationTurn[] = [];
  for (const message of page.items) {
    // Text only. Tool calls and their results are in the parts too, and a model does not need to be told
    // again what it already has in its own transcript — but an empty turn would be a hole in the history,
    // so a message that produced no text is skipped rather than pushed blank.
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join("");
    if (text.trim() === "") continue;
    turns.push({ role: message.role === "assistant" ? "assistant" : "user", text, parts: message.parts });
  }
  return turns;
};

/**
 * The same turns, narrowed to what a model is given.
 *
 * Text only. Tool calls, results and citations are in the parts, and a model does not need to be told again what
 * it already has in its own transcript — a citation especially: it is evidence *for* the reader, and feeding it
 * back invites the model to paraphrase provenance in prose.
 */
export const historyForModel = (turns: readonly ConversationTurn[]): readonly TurnMessage[] =>
  turns.map(({ role, text }) => ({ role, text }));
