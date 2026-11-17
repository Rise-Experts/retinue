/**
 * Reconstructing a conversation for the model — retinue REQ-041 (#190).
 *
 * The engine's `loadHistory` has to come from the application, because the platform ships no
 * projection: a message row carries parts, and which parts a given product puts in front of a model is
 * a product decision.
 *
 * It is a plain read of `messages` in order. It does **not** fold the run event log, and that is worth
 * stating because an earlier platform version had to: assistant turns existed only as `part.added`
 * rows, so history was one query per turn plus a fold. The worker now records the assistant's turn at
 * every terminal transition, so folding as well would double every assistant turn.
 */

import type { ConversationId, Message, MessageStore, TenantId, TurnMessage } from "@retinue/agentkit";

import { compactThread } from "@retinue/agentkit/context";
import type { ThreadSummarizer } from "@retinue/agentkit/context";
import type { ThreadSummaryStore } from "@retinue/agentkit/persistence";

import { DEFAULT_CHARS_PER_TOKEN, estimateTokensAt } from "./token-ratio.js";
import { historyTokenBudget } from "./prompt-budget.js";
import { SUMMARY_MAX_CHARS } from "./thread-summary.js";
import { KEEP_AFTER_COMPACT } from "./context-window.js";
import { stripToolRecordEcho } from "./tool-record-echo.js";
import { outputText, toolResultRef } from "../adapters/tool-results.js";

/**
 * How many recent messages the prompt may draw on.
 *
 * **A cap is silent truncation, which is why the number is large.** Nothing here condenses the older
 * prefix into a summary yet, so a conversation past this bound loses its beginning with no trace. The
 * bound exists to keep one query bounded, not as a context policy — when compaction is wired, it
 * should fire long before this matters.
 */
export const HISTORY_READ_LIMIT = 400;

/** Flatten a stored message's parts into the text a model sees. */
export const textOf = (message: Message): string =>
  (message.parts ?? [])
    .map((part) => (part.type === "text" ? ((part as { text?: string }).text ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n")
    .trim();

/** Ids a later turn needs to act on the same thing again: edit this post, attach to it, open this document. */
const RECORD_KEYS = ["postDraftId", "artifactId", "assetId", "mediaAssetId", "jobId", "campaignId", "scheduleId", "leadId", "linkId"] as const;
const RECORD_LIMIT = 12;

const channelsIn = (output: Record<string, unknown>): readonly string[] => {
  if (Array.isArray(output["targetPlatforms"])) return (output["targetPlatforms"] as unknown[]).filter((p): p is string => typeof p === "string");
  // draft_post_for_channels: one post, a caption written per channel.
  if (Array.isArray(output["written"])) {
    return (output["written"] as unknown[])
      .map((w) => (w !== null && typeof w === "object" ? (w as Record<string, unknown>)["platformId"] : undefined))
      .filter((p): p is string => typeof p === "string");
  }
  return [];
};

/**
 * How much of a reply's tool work a turn carries — #644.
 *
 * - `full`: every call's input **and** result (each capped at `FULL_CHARS`). This is what Claude-style context
 *   means: the deck the agent wrote in `create_artifact`, the page `read_source` returned, the draft it saved.
 *   Before #644 the inputs were never carried at all, so the agent could not see a document it had written three
 *   turns earlier and rebuilt it from memory as a new one (production chat d756738b, 2026-09-29).
 * - `preview`: a short input and a `TOOL_PREVIEW_CHARS` result.
 * - `ref`: one line per call with its ids and a `ref` for `recall_tool_result`.
 *
 * `toTurns` hands out `full` newest-first until half the history budget is spent, then `preview`, then `ref`, so a
 * thread keeps everything verbatim until it is genuinely long, and condensing (`COMPACT_AT`) only starts near the
 * model's real window.
 */
export type ToolDetail = "full" | "preview" | "ref";

/** One input or one result, in full. A larger one ends with a pointer to the rest. */
export const FULL_CHARS = 20_000;
/** How much of one output a previewed reply carries inline (~500 tokens). The rest is a `recall_tool_result` away. */
export const TOOL_PREVIEW_CHARS = 2_000;
const PREVIEW_INPUT_CHARS = 300;
/** How many replies past the full ones still carry previews; older ones carry refs only. */
export const DETAILED_REPLIES = 3;
/** The share of the history budget that full replies may use. */
export const FULL_DETAIL_SHARE = 0.5;
/** #659: tool-detail tiers move once per this many replies, so cached history stays byte-identical in between. */
export const TIER_BLOCK = 10;

const clipped = (value: unknown, limit: number, flatten: boolean): string => {
  const raw = outputText(value);
  const text = flatten ? raw.replace(/\s+/g, " ").trim() : raw;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [${text.length - limit} more characters — recall_tool_result]`;
};

type CallPart = { readonly toolCallId?: string; readonly toolName?: string; readonly input?: unknown };

/** The action behind a meta call: `execute_tool` runs another tool, named in its input. */
const actionOf = (toolName: string, input: unknown): { readonly name: string; readonly input: unknown } => {
  if (toolName === "execute_tool" && input !== null && typeof input === "object") {
    const inner = input as { name?: unknown; input?: unknown };
    if (typeof inner.name === "string") return { name: inner.name, input: inner.input };
  }
  return { name: toolName, input };
};

/**
 * How a tool record opens — #650.
 *
 * The record is carried at the start of the **next user turn**, as a note from the system, never inside the
 * assistant's own reply. Production, 2026-09-30: with the record appended to the assistant's turns, every earlier
 * reply in the prompt ended with a "[Your tool calls in this reply …]" block, and the model continued the
 * pattern — it *wrote* a fake update_artifact and generate_pdf record instead of calling the tools, and the chat
 * showed it. Text the model reads as someone else's is text it does not reproduce as its own. The last words say
 * so outright, and `tool-record-echo.ts` removes any copy from what the model writes anyway.
 *
 * Interim: agentkit carrying real tool parts in history (Rise-Experts/retinue#292) replaces this.
 */
export const TOOL_NOTE_HEADERS: Record<ToolDetail, string> = {
  full: "[System note, not from the person — what your tools did in your previous reply, with what you sent and what came back. Reuse these ids to change the same things. Never write a note like this in a reply:]",
  preview:
    "[System note, not from the person — what your tools returned in your previous reply (previews; recall_tool_result with a ref reads the full output). Reuse these ids to change the same things. Never write a note like this in a reply:]",
  ref: "[System note, not from the person — what your tools did in your previous reply (recall_tool_result with a ref reads the full output). Reuse these ids to change the same things. Never write a note like this in a reply:]",
};

/**
 * What an assistant turn's tools did, as text the next turn can read. See `ToolDetail`.
 *
 * Production, 2026-09-28: a post saved by draft_post_for_channels, then "add the url" in the next message — and
 * the model saved three NEW drafts with create_post_draft, because history carried text only. Every call is
 * listed with its ids and a `ref`; how much of its input and output comes too is the `detail`.
 */
export const toolRecordOf = (message: Message, options: { readonly detail?: boolean | ToolDetail } = {}): string => {
  if (message.role !== "assistant") return "";
  const detail: ToolDetail = options.detail === true ? "preview" : options.detail === false || options.detail === undefined ? "ref" : options.detail;
  const calls = new Map<string, CallPart>();
  for (const part of message.parts ?? []) {
    if (part.type === "tool-call") {
      const call = part as CallPart;
      if (typeof call.toolCallId === "string") calls.set(call.toolCallId, call);
    }
  }
  const lines: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type !== "tool-result") continue;
    const { toolName, output, toolCallId } = part as { toolName?: string; output?: unknown; toolCallId?: string };
    if (typeof toolName !== "string") continue;
    // Every stored result has a call id; one without (hand-written, legacy) is listed without a ref.
    const at = typeof toolCallId === "string" ? ` (ref ${toolResultRef(String(message.id), toolCallId)})` : "";
    const call = typeof toolCallId === "string" ? calls.get(toolCallId) : undefined;
    const action = actionOf(toolName, call?.input);
    const name = action.name === toolName ? toolName : action.name;
    const o = output !== null && typeof output === "object" ? (output as Record<string, unknown>) : {};
    const inputLine =
      detail === "ref" || action.input === undefined
        ? ""
        : `\n  input: ${clipped(action.input, detail === "full" ? FULL_CHARS : PREVIEW_INPUT_CHARS, detail !== "full")}`;
    if (o["ok"] === false) {
      const error = o["error"] as { message?: unknown } | undefined;
      lines.push(`- ${name}${at} failed: ${String(error?.message ?? "error").slice(0, detail === "full" ? 1_000 : 160)}${inputLine}`);
    } else {
      const ids = RECORD_KEYS.filter((key) => typeof o[key] === "string").map((key) => `${key} ${String(o[key])}`);
      const channels = channelsIn(o);
      const head = `- ${name}${at}${ids.length === 0 ? "" : `: ${ids.join(", ")}`}${channels.length === 0 ? "" : ` (channels: ${channels.join(", ")})`}`;
      if (detail === "ref") lines.push(head);
      else lines.push(`${head}${inputLine}\n  ${detail === "full" ? "result: " : ""}${clipped(output, detail === "full" ? FULL_CHARS : TOOL_PREVIEW_CHARS, detail !== "full")}`);
    }
    if (detail === "ref" && lines.length === RECORD_LIMIT) break;
  }
  if (lines.length === 0) return "";
  const header = TOOL_NOTE_HEADERS[detail];
  return [header, ...lines].join("\n");
};

/** A stored message's text and tool record together — what it costs in the prompt, wherever the record is placed. */
export const turnContentOf = (message: Message, options: { readonly detail?: boolean | ToolDetail } = {}): string =>
  [textOf(message), toolRecordOf(message, options)].filter((part) => part !== "").join("\n\n");

/**
 * Stored messages projected to the turns a model reads, in the order given.
 *
 * Newest first, each assistant reply gets `full` detail while the full replies fit in `FULL_DETAIL_SHARE` of the
 * budget, then `preview` for `DETAILED_REPLIES` more, then `ref`. A message with no text is dropped rather than
 * sent empty: some providers reject an empty turn outright, and the ones that do not read it as the model having
 * said nothing when in fact it emitted parts this projection does not carry.
 */
const toTurns = (
  messages: readonly Message[],
  budget: number = historyTokenBudget(),
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): readonly TurnMessage[] => {
  const detail = new Map<Message, ToolDetail>();
  let fullSpent = 0;
  let fullOpen = true;
  let previews = 0;
  /*
   * #659: the tiers are decided as of the last whole block of `TIER_BLOCK` replies, and every reply after it stays in
   * full. Deciding them from the newest reply moved one reply down a tier on almost every turn, which rewrote text
   * already in the provider's prompt cache — and everything after that point was billed again. Now an earlier reply's
   * text changes once every `TIER_BLOCK` replies.
   */
  const replies = messages.filter((message) => message.role === "assistant");
  const anchored = new Set(replies.slice(0, Math.floor(replies.length / TIER_BLOCK) * TIER_BLOCK));
  for (const reply of replies) if (!anchored.has(reply)) detail.set(reply, "full");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant" || !anchored.has(message)) continue;
    if (fullOpen) {
      const cost = estimateTokensAt(turnContentOf(message, { detail: "full" }), charsPerToken);
      if (fullSpent + cost <= budget * FULL_DETAIL_SHARE) {
        fullSpent += cost;
        detail.set(message, "full");
        continue;
      }
      // Strictly newest-first: once one reply does not fit in full, none older does.
      fullOpen = false;
    }
    if (previews < DETAILED_REPLIES) {
      previews += 1;
      detail.set(message, "preview");
    } else detail.set(message, "ref");
  }
  /*
   * #650: an assistant turn carries its text only; what its tools did opens the next user turn, as a system note.
   * A record with no user turn after it (a run resumed after an approval) becomes a user turn of its own.
   */
  const turns: TurnMessage[] = [];
  let pendingNote = "";
  for (const message of messages) {
    if (message.role === "assistant") {
      const note = toolRecordOf(message, { detail: detail.get(message) ?? "ref" });
      pendingNote = [pendingNote, note].filter((part) => part !== "").join("\n\n");
      // A reply saved before #650 can hold a record the model wrote itself; it would teach the pattern again.
      const text = stripToolRecordEcho(textOf(message)).text;
      if (text !== "") turns.push({ role: "assistant", content: text });
      continue;
    }
    const text = textOf(message);
    const content = [pendingNote, text].filter((part) => part !== "").join("\n\n");
    pendingNote = "";
    if (content !== "") turns.push({ role: "user", content });
  }
  if (pendingNote !== "") turns.push({ role: "user", content: pendingNote });
  return mergeAdjacent(turns);
};

/**
 * Consecutive turns of one role joined into one. An assistant reply that was tool calls only has no text, so the
 * user turns around it would otherwise sit side by side — which Anthropic rejects and others read oddly.
 */
const mergeAdjacent = (turns: readonly TurnMessage[]): readonly TurnMessage[] => {
  const out: TurnMessage[] = [];
  for (const turn of turns) {
    const last = out.at(-1);
    if (last !== undefined && last.role === turn.role && typeof last.content === "string" && typeof turn.content === "string") {
      out[out.length - 1] = { role: turn.role, content: `${last.content}\n\n${turn.content}` };
    } else out.push(turn);
  }
  return out;
};

/**
 * Conversation history for the model, oldest first.
 *
 * **The most recent page, then reversed.** Reading ascending with a limit hands back the *first* N
 * messages, so in a conversation longer than the limit the model sees the beginning and nothing since
 * — and the longer the thread, the worse it gets. Newest-first from the store and reversed here,
 * because everything downstream expects oldest-first; paging to the tail would be a round trip per
 * page on every turn.
 */
export const conversationHistory = async (input: {
  readonly messages: MessageStore;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly limit?: number;
  /**
   * The token ceiling for what this returns. Defaults to `historyTokenBudget()`.
   *
   * Injected so a test can drive the trimming with three short messages instead of four hundred long
   * ones, and so a deployment on a smaller model can pass its own.
   */
  readonly tokenBudget?: number;
  /**
   * #657: condense once the thread passes this many tokens, instead of at the budget. Idle compaction passes a lower
   * number, so a long chat is condensed while nobody is waiting rather than on the turn the person comes back to.
   */
  readonly compactAt?: number;
  /** #657: how many tokens stay verbatim after condensing. Defaults to `KEEP_AFTER_COMPACT` of the budget. */
  readonly keepTokens?: number;
  /**
   * #658: how many characters the answering provider counts as one token on this conversation — learned from the
   * previous turn's measured input (`token-ratio.ts`). Every estimate below, and so the budget, the compaction
   * threshold and how much stays verbatim, is in that provider's tokens. Defaults to 4, the old chars ÷ 4.
   */
  readonly charsPerToken?: number;
  /** Reported when turns are dropped to fit. Defaults to `console.warn`; a test passes its own. */
  readonly onTrimmed?: (input: {
    readonly dropped: number;
    readonly kept: number;
    readonly tokens: number;
    readonly budget: number;
  }) => void;
  /**
   * Condense the older turns instead of dropping them. Absent means drop.
   *
   * Optional rather than required because both halves are a deployment's choice — the store is a
   * table and the summarizer is a model call — and a deployment that wires neither must still get a
   * bounded prompt. Absent is the honest degradation, not an unconfigured hole: without it the budget
   * is still enforced, just by losing the beginning of a long thread rather than summarizing it.
   */
  readonly compaction?: {
    readonly summaries: ThreadSummaryStore;
    readonly summarizer: ThreadSummarizer;
    /** Reported when a thread is condensed. There is no default: `onTrimmed` already covers the loss. */
    readonly onCompacted?: (input: {
      readonly summarized: number;
      readonly kept: number;
      readonly tokensReclaimed: number;
    }) => void;
  };
}): Promise<readonly TurnMessage[]> => {
  const page = await input.messages.listByConversation({
    tenantId: input.tenantId as TenantId,
    conversationId: input.conversationId as ConversationId,
    limit: input.limit ?? HISTORY_READ_LIMIT,
    newestFirst: true,
  });

  const ordered = [...page.items].reverse();

  const budget = input.tokenBudget ?? historyTokenBudget();
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const turns = toTurns(ordered, budget, charsPerToken);
  const report = input.onTrimmed ?? defaultTrimReport;

  /**
   * Without a summarizer wired, the budget is enforced by dropping the oldest turns. With one, they are
   * condensed instead. Optional because the store and the model call are a deployment's choice, and an
   * unconfigured one must still get a bounded prompt rather than an unbounded one.
   */
  if (input.compaction === undefined) return forProvider(withinTokenBudget({ turns, budget, report, charsPerToken }));

  return forProvider(await compacted({
    ...input.compaction,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    ordered,
    turns,
    budget,
    charsPerToken,
    compactAt: input.compactAt ?? budget,
    keepTokens: input.keepTokens ?? Math.max(0, Math.floor(budget * KEEP_AFTER_COMPACT) - summaryAllowanceTokens(charsPerToken)),
    report,
  }));
};

/**
 * History with its older half condensed rather than dropped.
 *
 * ## Why the model call is conditional, and why that is the whole design
 *
 * `compactThread` re-summarizes its entire `older` prefix on every call — it takes `priorSummary` and
 * layers, but it does not skip what that summary already covers. So a caller that invoked it once per
 * turn would spend a model call and write a new summary version *every turn*, which is worse than the
 * trimming it replaces: same prompt size, plus a round trip.
 *
 * Two things make it cheap. The prefix already covered by the stored summary is removed before
 * anything is measured, so a thread that was compacted last turn is measured as summary-plus-a-few,
 * not as four hundred messages. And the summarizer is reached **only when that still exceeds the
 * budget** — which is once, at the crossing, and then not again until enough new turns accumulate to
 * cross it a second time. The common case is a `latest()` read and no model call at all.
 *
 * ## It cannot fail a turn
 *
 * A summarizer is a model call, and model calls fail: a rate limit, a provider outage, a schema the
 * model would not satisfy. Any of those falls back to the token trim, which is the behaviour without
 * compaction wired — degraded, because the thread loses its beginning instead of having it condensed,
 * and not a failed turn. The same reasoning as the context block's budget: the ceiling has never been
 * reached in production, so nothing here is worth a refused turn.
 */
const compacted = async (input: {
  readonly summaries: ThreadSummaryStore;
  readonly summarizer: ThreadSummarizer;
  readonly onCompacted?: (input: { readonly summarized: number; readonly kept: number; readonly tokensReclaimed: number }) => void;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly ordered: readonly Message[];
  readonly turns: readonly TurnMessage[];
  readonly budget: number;
  readonly charsPerToken: number;
  readonly compactAt: number;
  readonly keepTokens: number;
  readonly report: Parameters<typeof withinTokenBudget>[0]["report"];
}): Promise<readonly TurnMessage[]> => {
  const scope = { tenantId: input.tenantId as TenantId, conversationId: input.conversationId as ConversationId };

  const prior = await input.summaries.latest(scope).catch((error: unknown) => {
    // A store that cannot be read is not a reason to fail a turn; it is a reason to fall back to trimming.
    console.warn(`[shareflow] could not read this thread's summary: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  const uncovered = prior === null ? input.ordered : after(input.ordered, prior.coversUpToMessageId);
  const withSummary = (summary: string, messages: readonly Message[]): readonly TurnMessage[] => [
    summaryTurn(summary),
    ...toTurns(messages, input.budget, input.charsPerToken),
  ];

  const current = prior === null ? input.turns : withSummary(prior.summary, uncovered);
  if (cost(current, input.charsPerToken) <= input.compactAt) return current;

  /**
   * How many trailing messages stay verbatim.
   *
   * Derived from the budget rather than configured, because a message count cannot be chosen once for
   * threads whose messages differ in size by two orders of magnitude. #630: `KEEP_AFTER_COMPACT` of it,
   * not all of it — keeping whatever still fit re-crossed the budget a turn or two later and condensed
   * again, a model call and a broken prompt cache every few messages. **Never below one**: the newest
   * message in history is the turn being answered — `engine.js` builds the model's list as
   * `[...history]` and finds "the newest user turn" inside it — so summarizing it away would hand the
   * model a conversation with the question removed.
   */
  const keepRecent = Math.min(Math.max(1, fittingFromEnd(uncovered, input.keepTokens, input.charsPerToken)), Math.max(1, uncovered.length - 1));

  /*
   * #657: condensed in pieces of at most `SUMMARY_CHUNK_TOKENS`, oldest first, each layered on the summary before it
   * (`compactThread` reads the latest and passes it as `priorSummary`). One call over a whole long thread sent as much
   * as the turn itself in the same minute — the likely reason a 520k chat locked (2026-09-30) — and a failure lost all
   * of it. A piece that fails now keeps every piece before it.
   */
  let remaining = uncovered;
  let summary: string | undefined;
  let summarized = 0;
  let reclaimed = 0;
  const estimate = (messages: readonly Message[]) => messages.reduce((sum, message) => sum + estimateTokensAt(turnContentOf(message), input.charsPerToken), 0);
  try {
    while (remaining.length > keepRecent) {
      const older = remaining.length - keepRecent;
      const take = Math.min(older, Math.max(1, fittingFromStart(remaining, SUMMARY_CHUNK_TOKENS, input.charsPerToken)));
      const result = await compactThread({
        ...scope,
        messages: remaining.slice(0, take),
        keepRecent: 0,
        summaries: input.summaries,
        summarizer: input.summarizer,
        estimateTokens: estimate,
      });
      // Null means there was nothing worth compacting — a thread over budget in one or two messages.
      if (result === null) break;
      summary = result.summary.summary;
      summarized += take - result.kept.length;
      reclaimed += result.event.tokensReclaimed;
      remaining = [...result.kept, ...remaining.slice(take)];
      if (result.kept.length >= take) break; // nothing moved; do not loop on the same piece
    }
  } catch (error) {
    console.warn(
      `[shareflow] part of this thread could not be condensed (${error instanceof Error ? error.message : String(error)}). ` +
        (summary === undefined
          ? "Its oldest turns were dropped instead — the model has lost the beginning of this conversation."
          : "The pieces already condensed are kept; the rest is trimmed to fit."),
    );
  }

  if (summary === undefined) return withinTokenBudget({ turns: current, budget: input.budget, report: input.report, charsPerToken: input.charsPerToken });
  input.onCompacted?.({ summarized, kept: remaining.length, tokensReclaimed: reclaimed });

  /**
   * Trimmed again afterwards, and not as a formality.
   *
   * `keepRecent` is chosen from an estimate and the summary's real length is only known once the
   * model has written it, so the compacted history can still come back over budget — most obviously
   * when one kept message is enormous. Passing it through the same trim makes the budget a
   * guarantee rather than an intention.
   */
  return withinTokenBudget({ turns: withSummary(summary, remaining), budget: input.budget, report: input.report, charsPerToken: input.charsPerToken });
};

/** #657: the most a single summary call is handed, in estimated tokens. */
export const SUMMARY_CHUNK_TOKENS = 100_000;

/** How many leading messages fit in `budget`, counting from the oldest. At least none. */
const fittingFromStart = (messages: readonly Message[], budget: number, charsPerToken: number): number => {
  let used = 0;
  let count = 0;
  for (const message of messages) {
    const next = used + estimateTokensAt(turnContentOf(message), charsPerToken);
    if (next > budget) break;
    used = next;
    count += 1;
  }
  return count;
};

/**
 * What a summary costs against the history budget, reserved before choosing how much to keep.
 *
 * `SUMMARY_MAX_CHARS` is the summarizer's ceiling, so this is the worst case rather than the expected
 * one. Reserving the expected size and being handed the worst would put the compacted history back
 * over budget, which the trim would then fix by dropping the turns compaction was meant to preserve.
 *
 * #658: in the provider's tokens — a function of the conversation's ratio, not a constant at chars ÷ 4.
 */
const summaryAllowanceTokens = (charsPerToken: number): number => estimateTokensAt("x".repeat(SUMMARY_MAX_CHARS), charsPerToken);

/** The messages after the one with this id; all of them when the id is older than this page. */
const after = (messages: readonly Message[], id: string): readonly Message[] => {
  const index = messages.findIndex((message) => String(message.id) === String(id));
  /**
   * Not found means the summary covers messages older than this page — the read is bounded at
   * `HISTORY_READ_LIMIT` — so everything here comes after it and nothing is dropped. Returning an empty
   * list on a miss would be the dangerous reading of the same fact.
   */
  return index === -1 ? messages : messages.slice(index + 1);
};

/** How many trailing messages fit in `budget`, counting from the newest. At least none. */
const fittingFromEnd = (messages: readonly Message[], budget: number, charsPerToken: number): number => {
  let used = 0;
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const next = used + estimateTokensAt(turnContentOf(message), charsPerToken);
    if (next > budget) break;
    used = next;
    count += 1;
  }
  return count;
};

const cost = (turns: readonly TurnMessage[], charsPerToken: number): number => turns.reduce((sum, turn) => sum + turnCost(turn, charsPerToken), 0);

/**
 * The summary, as a `system` turn.
 *
 * `system` rather than `user` or `assistant` because it is neither: nobody said it. Attributing it to
 * the person would put words in their mouth that a later turn could quote back at them, and
 * attributing it to the assistant would let the model treat its own summary as something it committed
 * to. `TurnMessage` allows all three roles, and this is what the third is for.
 */
const summaryTurn = (summary: string): TurnMessage => ({
  role: "system",
  content: `${SUMMARY_NOTE}\n\n${summary}`,
});

/** How a condensed thread's summary opens, so it can be recognised wherever it ends up. */
export const SUMMARY_NOTE =
  "[System note, not from the person — earlier in this conversation, condensed because the thread outgrew the context window:]";

/** True when a history turn is the thread's summary — #657 follow-up. */
export const isSummaryTurn = (turn: TurnMessage | undefined): boolean => typeof turn?.content === "string" && turn.content.startsWith(SUMMARY_NOTE);

/**
 * History as a provider accepts it — #657 follow-up.
 *
 * The summary is a `system` turn inside this module, where the trim protects a leading one, but a `system` message in
 * the history is refused outright: production, 2026-10-02, the first thread ever condensed failed every turn with
 * "Invalid prompt: System messages are not allowed in the prompt or messages fields". So on the way out it becomes a
 * clearly labelled note at the start of the first user turn — never in the assistant's voice (#650), never as words
 * the person said.
 */
const forProvider = (turns: readonly TurnMessage[]): readonly TurnMessage[] =>
  mergeAdjacent(turns.map((turn): TurnMessage => (turn.role === "system" ? { role: "user", content: turn.content } : turn)));

const defaultTrimReport = ({
  dropped,
  kept,
  tokens,
  budget,
}: {
  readonly dropped: number;
  readonly kept: number;
  readonly tokens: number;
  readonly budget: number;
}): void => {
  console.warn(
    `[shareflow] this conversation is longer than the history budget, so its oldest ${dropped} turn(s) ` +
      `were not sent: ${kept} turns, ${tokens} tokens, against a budget of ${budget}. The model no ` +
      `longer has the beginning of this thread.`,
  );
};

/**
 * What one turn costs, whichever shape its content is in.
 *
 * `TurnMessage.content` is `string | readonly TurnContentPart[]`. This projection only ever builds the
 * string form, so the array branch is unreachable today — and measuring it as zero would be the kind of
 * assumption that stops being true quietly, the moment a turn carries an image or a tool part. Summed
 * over the parts that have text, because that is what a text estimate can honestly speak for.
 */
const turnCost = (turn: TurnMessage, charsPerToken: number): number => {
  if (typeof turn.content === "string") return estimateTokensAt(turn.content, charsPerToken);
  return turn.content.reduce(
    (sum, part) => sum + estimateTokensAt(typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "", charsPerToken),
    0,
  );
};

/**
 * The most recent turns that fit, oldest first.
 *
 * **This is where the input ceiling is actually enforced.** `HISTORY_READ_LIMIT` bounds the *query* at
 * 400 messages and its own comment says it is "not a context policy"; 400 messages of arbitrary length
 * is the one input that can exceed the model's window on its own, and nothing was measuring it. The
 * context block is 148 tokens on the production workspace, so this — not the brand profile — is where
 * a prompt budget either exists or does not.
 *
 * Newest-first when deciding, oldest-first when returning: a conversation is trimmed from its
 * beginning, because the turn being answered is the one at the end. Dropping from the other end would
 * keep the greeting and lose the question.
 *
 * A single turn larger than the whole budget is still returned, alone. Returning nothing would send the
 * model a question with no question in it, and a provider's own limit is a better place for that
 * complaint than silence here.
 */
export const withinTokenBudget = (input: {
  readonly turns: readonly TurnMessage[];
  readonly budget: number;
  /** #658: the conversation's chars-per-token ratio. Defaults to 4. */
  readonly charsPerToken?: number;
  readonly report: (input: {
    readonly dropped: number;
    readonly kept: number;
    readonly tokens: number;
    readonly budget: number;
  }) => void;
}): readonly TurnMessage[] => {
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  /**
   * A leading `system` turn is the thread's summary, and it is never trimmed.
   *
   * This function drops from the front, and the summary sits at the front — so without this it was the
   * **first** thing dropped, which defeats compaction entirely: a model call spent condensing the
   * thread, then the condensation discarded and the raw turns kept. Found by the test that asserts the
   * summary is first, which failed with `'assistant'`.
   *
   * It is protected rather than merely prioritised because it is not one old turn among others — it is
   * what all of them were replaced by. Its cost comes off the budget first, and the rest of the
   * conversation is trimmed into what remains.
   */
  const [first] = input.turns;
  if (first !== undefined && first.role === "system") {
    const rest = withinTokenBudget({
      turns: input.turns.slice(1),
      budget: Math.max(0, input.budget - turnCost(first, charsPerToken)),
      report: input.report,
      charsPerToken,
    });
    return [first, ...rest];
  }

  const kept: TurnMessage[] = [];
  let tokens = 0;

  for (let index = input.turns.length - 1; index >= 0; index -= 1) {
    const turn = input.turns[index];
    if (turn === undefined) continue;
    const cost = turnCost(turn, charsPerToken);
    // `kept.length === 0` is the single-oversized-turn case: take it and stop, rather than return none.
    if (kept.length > 0 && tokens + cost > input.budget) break;
    kept.push(turn);
    tokens += cost;
    if (tokens >= input.budget) break;
  }

  kept.reverse();
  const dropped = input.turns.length - kept.length;
  if (dropped > 0) input.report({ dropped, kept: kept.length, tokens, budget: input.budget });
  return kept;
};
