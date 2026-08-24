/**
 * Summarising a long thread — #169, and the `/compact` command.
 *
 * `compactThread` has existed since #-whenever, with tests, and **nothing called it**: the fourth thing in this
 * platform built, verified and unreachable, after citations, questions and usage recording. It takes an injected
 * `ThreadSummarizer` precisely so the platform stays provider-neutral, and providing one is the app's job.
 *
 * Two triggers, deliberately both:
 *
 * - **Automatic**, when the window crosses a threshold. A conversation that fails on its fortieth turn because
 *   nobody pressed a button is a conversation that has to be restarted, and the person had no way to know.
 * - **On demand**, via `POST /api/compact` and `/compact` in the composer. Automatic compaction picks its moment
 *   from a number; a person compacts when they have finished with a topic, which is a better moment and one no
 *   threshold can see.
 */

import { compactThread, estimateTokens } from "@agentkit/backend";
import type { ExampleStores } from "./stores.js";
import type {
  ConversationId,
  ExecutionContext,
  Message,
  TenantId,
  ThreadSummarizer,
  ThreadSummary,
} from "@agentkit/backend";

/**
 * Compact when the window is this full.
 *
 * 0.7, not 0.9. Compaction itself costs a model call over the whole prefix, and at 0.9 the prefix plus the
 * summarisation prompt may not fit — so a threshold set to "nearly full" is a threshold that fails exactly when
 * it is needed. Leaving 30% also means the turn that triggers compaction still has room to answer.
 */
export const COMPACT_AT_FRACTION = 0.7;

/**
 * Turns kept verbatim.
 *
 * Recent turns are what a conversation is *about*; a summary is what it *was* about. Twelve is generous on
 * purpose: the failure mode of keeping too few is an assistant that has forgotten the thing being discussed
 * right now, which reads as a much worse fault than a long prompt.
 */
export const KEEP_RECENT_TURNS = 12;

/**
 * The summariser: a model call, with an instruction that says what a summary is *for*.
 *
 * Prose rather than bullet points, and facts rather than narration. "The user asked about X and the assistant
 * replied" is a description of a transcript; what the next turn needs is the *content* — decisions taken, values
 * given, things ruled out. A summary written as a meeting minute leaves the model knowing a conversation
 * happened and not what it established.
 *
 * `priorSummary` is layered rather than replaced, because compaction is repeated: the second compaction
 * summarises the prefix *after* the first, and dropping the earlier summary would silently forget the start of a
 * long thread — the exact thing this exists to prevent.
 */
export const createExampleSummarizer = (deps: {
  readonly generate: (prompt: string) => Promise<string>;
}): ThreadSummarizer => ({
  async summarize({ priorSummary, messages }) {
    const transcript = messages
      .map((m) => {
        const text = m.parts
          .filter((p) => p.type === "text")
          .map((p) => String((p as { text?: unknown }).text ?? ""))
          .join("");
        return text.trim() === "" ? "" : `${m.role}: ${text}`;
      })
      .filter((line) => line !== "")
      .join("\n");

    const prompt = [
      "Condense the conversation below into a summary the assistant will read instead of the original turns.",
      "",
      "Write what was *established*, not what happened: decisions made, facts stated, values given, options",
      "ruled out, and anything the person asked you to remember or do. Keep names, numbers and identifiers",
      "exactly. Do not write 'the user asked about X' — write X and its answer.",
      "",
      "Prose, a few short paragraphs at most. No preamble, no headings, no bullet points.",
      ...(priorSummary === undefined
        ? []
        : [
            "",
            "An earlier part of this conversation was already summarised. Fold it into your summary so nothing",
            "from it is lost — the result replaces both.",
            "",
            "## Earlier summary",
            priorSummary,
          ]),
      "",
      "## Conversation",
      transcript,
    ].join("\n");

    const summary = (await deps.generate(prompt)).trim();
    /**
     * An empty summary is refused rather than stored.
     *
     * `compactThread` would append it and report the tokens reclaimed, and the thread's entire prefix would be
     * replaced by nothing — data loss reported as a success. Throwing leaves the history intact and the run
     * failing loudly, which is recoverable.
     */
    if (summary === "") throw new Error("the summariser returned nothing; refusing to replace history with it");
    return summary;
  },
});

export type CompactionOutcome =
  | { readonly compacted: false; readonly reason: "too-short" | "nothing-older" }
  | {
      readonly compacted: true;
      readonly summary: ThreadSummary;
      readonly keptTurns: number;
      readonly droppedParts: number;
      readonly tokensReclaimed: number;
    };

/**
 * Compact one conversation.
 *
 * Reports "not compacted" as a *value*, not as a null the caller has to interpret and not as an error. A person
 * pressing `/compact` on a three-turn conversation has done nothing wrong, and telling them "nothing to compact
 * yet" is the honest answer; an error would suggest they broke something.
 */
export const compactConversation = async (input: {
  /** The summary store, injected — so the memory composition compacts too (#155 AC-7). */
  readonly stores: Pick<ExampleStores, "summaries">;
  readonly context: ExecutionContext;
  readonly conversationId: string;
  readonly messages: readonly Message[];
  readonly summarizer: ThreadSummarizer;
  readonly keepRecent?: number;
}): Promise<CompactionOutcome> => {
  const keepRecent = input.keepRecent ?? KEEP_RECENT_TURNS;
  if (input.messages.length <= keepRecent) return { compacted: false, reason: "too-short" };

  const result = await compactThread({
    tenantId: input.context.tenantId as TenantId,
    conversationId: input.conversationId as ConversationId,
    messages: input.messages,
    keepRecent,
    summaries: input.stores.summaries,
    summarizer: input.summarizer,
    // The platform's own estimator, so "tokens reclaimed" is measured the same way the budget measures spend.
    estimateTokens: (messages) =>
      messages.reduce(
        (sum, m) =>
          sum +
          m.parts.reduce((s, p) => s + estimateTokens(String((p as { text?: unknown }).text ?? "")), 0),
        0,
      ),
  });
  // Null here means the tool-continuity split left nothing older — a prefix that is all tool messages whose
  // calls are in the kept side. Distinguished from "too short" because they are different situations.
  if (result === null) return { compacted: false, reason: "nothing-older" };

  return {
    compacted: true,
    summary: result.summary,
    keptTurns: result.kept.length,
    droppedParts: result.event.droppedParts,
    tokensReclaimed: result.event.tokensReclaimed,
  };
};
