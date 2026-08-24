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

import { createPostgresMessageStore, createPostgresThreadSummaryStore } from "@agentkit/backend";
import type { ConversationId, Message, SqlExecutor, TenantId, TurnMessage } from "@agentkit/backend";

/**
 * One turn, with the parts it was made of.
 *
 * The engine wants text and the page wants text *and* citations, and the temptation is two functions. Two
 * functions is two projections of one conversation that can disagree, which is the whole reason this file
 * exists. So there is one read, returning everything, and `historyForModel` narrows it.
 */
/**
 * How many recent messages a prompt may draw on before compaction has to do the work.
 *
 * **A cap is silent truncation, and that is the point of the number being large.** Compaction condenses the
 * older prefix into a summary; a cap drops it with no trace. So the cap exists only as a bound on one query,
 * and the design intent is that compaction fires long before it matters — which is why
 * `/api/context` reports the total message count alongside the windowed one, and why a conversation longer than
 * this triggers compaction on its own regardless of how full the window looks.
 *
 * The load probe is what made this visible: reported utilization was identical at 100, 500 and 2000 messages,
 * because a fixed 100-message read means the figure describes the cap rather than the conversation.
 */
export const HISTORY_READ_LIMIT = 400;

export type ConversationTurn = TurnMessage & {
  /** The stored parts. The page derives citation markers from these; the model is given only `text`. */
  readonly parts: readonly Message["parts"][number][];
};

export const conversationTurns = async (input: {
  readonly sql: SqlExecutor;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly limit?: number;
  /**
   * Replace turns a summary already covers with the summary — #169.
   *
   * Off by default, and **on for the model**. The page shows the whole transcript because a person scrolling back
   * expects to find what they said; the model gets the compacted form, which is the entire point of compacting.
   * If both saw the compacted form, compaction would look like the assistant deleting the conversation.
   */
  readonly compacted?: boolean;
}): Promise<readonly ConversationTurn[]> => {
  /**
   * The **most recent** page, then reversed — #167.
   *
   * This read `limit: 100` in ascending order, which in a conversation longer than 100 messages handed back turns
   * 1–100 and nothing since. The model saw the beginning of the conversation and none of the present, and the
   * longer the thread the worse it got. The load probe found it: the reported context utilization was identical
   * at 100, 500 and 2000 messages, because the same first hundred rows were being read every time.
   *
   * Newest-first from the store, reversed here, because everything downstream — the transcript, the prompt — is
   * oldest-first. Reversing a bounded page is cheap; paging to the tail is O(n) round trips on every turn.
   */
  const page = await createPostgresMessageStore(input.sql).listByConversation({
    tenantId: input.tenantId as TenantId,
    conversationId: input.conversationId as ConversationId,
    limit: input.limit ?? HISTORY_READ_LIMIT,
    newestFirst: true,
  });
  const items = [...page.items].reverse();

  /**
   * The summary, and the point in the transcript it covers up to.
   *
   * `coversUpToMessageId` is a message id rather than a count or a timestamp, which matters: turns arriving while
   * compaction ran are *after* that id and are kept, where a count would have silently dropped them.
   */
  const summary = input.compacted === true
    ? await createPostgresThreadSummaryStore(input.sql).latest({
        tenantId: input.tenantId as TenantId,
        conversationId: input.conversationId as ConversationId,
      })
    : null;
  const covered = new Set<string>();
  if (summary !== null) {
    for (const message of items) {
      covered.add(String(message.id));
      if (String(message.id) === String(summary.coversUpToMessageId)) break;
    }
  }

  const turns: ConversationTurn[] = [];
  if (summary !== null && covered.size > 0) {
    /**
     * A `user`-role turn, matching how an approval decision and a question answer are fed back.
     *
     * Not `system`: a mid-conversation system message is handled inconsistently across providers, and this is
     * not an instruction — it is something the model is being told about the conversation it is in. Labelled, so
     * the model can tell a condensed record from a verbatim turn and does not quote it back as something the
     * person said.
     */
    turns.push({
      role: "user",
      text: `[earlier in this conversation, condensed]\n${summary.summary}`,
      parts: [],
    });
  }

  for (const message of items) {
    if (covered.has(String(message.id))) continue;
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
