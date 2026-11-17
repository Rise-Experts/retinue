/**
 * What the model is told the conversation was — retinue REQ-041 (#190).
 *
 * Two bugs live in this function, and both are silent. The reference application shipped the first and
 * documented it; the second is the shape of the data rather than the query.
 */
import { describe, expect, it, vi } from "vitest";

import { HISTORY_READ_LIMIT, conversationHistory, isSummaryTurn, textOf, toolRecordOf, turnContentOf } from "../history.js";
import { SUMMARY_MAX_CHARS } from "../thread-summary.js";

/** A message store that records how it was asked, so the *query* can be asserted and not just its result. */
const store = (items: readonly unknown[]) => {
  const calls: unknown[] = [];
  return {
    calls,
    messages: {
      async listByConversation(input: unknown) {
        calls.push(input);
        return { items, nextCursor: null };
      },
    } as never,
  };
};

const message = (role: string, text: string, id = role + text) => ({
  id,
  role,
  parts: text === "" ? [] : [{ id: id + "p", type: "text", text }],
});

describe("conversationHistory", () => {
  it("asks for the newest page and returns it oldest-first", async () => {
    /**
     * **The bug this exists to prevent.** Reading ascending with a limit hands back the *first* N
     * messages, so in a conversation longer than the limit the model sees the beginning and nothing
     * since — and the longer the thread, the worse it gets. The reference application found it with a
     * load probe: reported context utilisation was identical at 100, 500 and 2000 messages, because the
     * same first hundred rows were read every time.
     *
     * So two things are asserted: the store is asked `newestFirst`, and what comes back is reversed.
     */
    const { messages, calls } = store([message("assistant", "second"), message("user", "first")]);
    const turns = await conversationHistory({ messages, tenantId: "t1", conversationId: "c1" });
    expect((calls[0] as { newestFirst: boolean }).newestFirst).toBe(true);
    expect(turns.map((turn) => turn.content)).toEqual(["first", "second"]);
  });

  it("bounds the read, and the bound is large because a cap is silent truncation", async () => {
    const { messages, calls } = store([]);
    await conversationHistory({ messages, tenantId: "t1", conversationId: "c1" });
    expect((calls[0] as { limit: number }).limit).toBe(HISTORY_READ_LIMIT);
    // Large on purpose: nothing here condenses the older prefix yet, so a conversation past this loses
    // its beginning with no trace. A small number would make that common rather than exceptional.
    expect(HISTORY_READ_LIMIT).toBeGreaterThanOrEqual(200);
  });

  it("maps every non-assistant role to user", async () => {
    /**
     * An approval decision and a question answer are fed back as `user` turns, which is how the model
     * learns what was decided. A role it does not recognise reaching the provider is a rejected request
     * — and the run fails for a reason that names the provider, not this projection.
     */
    const { messages } = store([message("assistant", "a"), message("user", "b"), message("system", "c")]);
    const turns = await conversationHistory({ messages, tenantId: "t1", conversationId: "c1" });
    // Two user turns side by side are joined (#650): Anthropic rejects consecutive turns of one role.
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(turns[0]?.content).toBe("c\n\nb");
  });

  it("drops a message with no text rather than sending an empty turn", async () => {
    /**
     * An empty turn is not neutral. Some providers reject it outright; the ones that do not read it as
     * the model having said nothing, when in fact it emitted parts this projection does not carry — a
     * tool call, an error, a citation. Dropping it is honest about what this function can see.
     */
    const { messages } = store([message("user", "hello"), message("assistant", "")]);
    const turns = await conversationHistory({ messages, tenantId: "t1", conversationId: "c1" });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toBe("hello");
  });

  it("joins several text parts rather than keeping only the first", async () => {
    // A turn is a list of parts, and a model that saw only the first sentence of its own last answer
    // would contradict itself on the next one.
    const { messages } = store([
      {
        id: "m1",
        role: "assistant",
        parts: [
          { id: "a", type: "text", text: "First." },
          { id: "b", type: "tool-call", toolName: "x" },
          { id: "c", type: "text", text: "Second." },
        ],
      },
    ]);
    const turns = await conversationHistory({ messages, tenantId: "t1", conversationId: "c1" });
    expect(turns[0]?.content).toBe("First.\nSecond.");
  });
});

describe("textOf", () => {
  it("ignores non-text parts without dropping the text around them", () => {
    expect(
      textOf({
        parts: [
          { type: "tool-call" },
          { type: "text", text: "kept" },
          { type: "error" },
        ],
      } as never),
    ).toBe("kept");
  });

  it("returns empty for a message with no parts at all", () => {
    expect(textOf({ parts: [] } as never)).toBe("");
    expect(textOf({} as never)).toBe("");
  });
});

/**
 * The history endpoints — `GET /api/conversations` and `GET /api/conversations/:id/messages`.
 *
 * WHY THEY EXIST: `@retinue/react`'s client contract needs `listConversations` and `listMessages`, and
 * this deployment had no HTTP surface for either — the old chat read its history from Agno. So the
 * React chat could not have rendered a transcript at all.
 *
 * WHAT IS ASSERTED: the path matching (a path that means something else must not be answered as if it
 * meant this), the bounded page size, and the refusal when a deployment has not wired the stores.
 */
import { describe as describeHistory, expect as expectHistory, it as itHistory } from "vitest";

import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, boundedLimit, conversationIdFrom } from "../server.js";

describeHistory("conversationIdFrom", () => {
  itHistory("reads the id out of the messages path", () => {
    expectHistory(conversationIdFrom("/api/conversations/c1/messages")).toBe("c1");
    // Ids are URL-encoded on the way in, so they are decoded on the way out.
    expectHistory(conversationIdFrom("/api/conversations/a%2Fb/messages")).toBe("a/b");
  });

  itHistory("does not answer a path that means something else", () => {
    /**
     * Matched rather than split. `/api/conversations/x/messages/y` addresses one message, not a list —
     * answering it with the list would be the wrong resource under a right-looking URL.
     */
    for (const path of [
      "/api/conversations",
      "/api/conversations/c1",
      "/api/conversations/c1/messages/m1",
      "/api/conversations//messages",
      "/api/message",
      "/api/conversations/c1/messages?limit=5",
    ]) {
      expectHistory(conversationIdFrom(path), path).toBeNull();
    }
  });
});

describeHistory("boundedLimit", () => {
  itHistory("defaults rather than failing when nothing usable was asked for", () => {
    // A client asking for nothing in particular wants a sensible page, not a 400.
    for (const raw of [null, "", "  ", "not-a-number", "NaN"]) {
      expectHistory(boundedLimit(raw), JSON.stringify(raw)).toBe(DEFAULT_HISTORY_LIMIT);
    }
  });

  itHistory("caps what a caller may ask for", () => {
    // The ceiling belongs to the server: a page is rendered, and a caller does not get to decide how
    // much of the database arrives in one response.
    expectHistory(boundedLimit("100000")).toBe(MAX_HISTORY_LIMIT);
    expectHistory(boundedLimit("0")).toBe(1);
    expectHistory(boundedLimit("-5")).toBe(1);
    expectHistory(boundedLimit("25")).toBe(25);
    // A fractional page is a whole number of rows.
    expectHistory(boundedLimit("25.7")).toBe(25);
  });
});

/**
 * The input ceiling, enforced where the growth actually is.
 *
 * `maxInputTokens: 120_000` was declared and enforced nowhere: `assemblePrompt` had zero callers and
 * `compactThread` had zero callers, so nothing measured a prompt against it. And of everything that
 * goes into a prompt, history is the one input that grows without bound — the context block measures
 * **148 tokens** on the production workspace, while `HISTORY_READ_LIMIT` allows 400 messages of any
 * length, its own comment saying the bound "exists to keep one query bounded, not as a context
 * policy".
 *
 * So this is where the budget either exists or does not. The tests drive it with a small explicit
 * budget rather than with four hundred long fixtures: the arithmetic is the same and the failure is
 * legible.
 */
describe("the history token budget", () => {
  const trims: { dropped: number; kept: number; tokens: number; budget: number }[] = [];
  const onTrimmed = (input: { dropped: number; kept: number; tokens: number; budget: number }) => {
    trims.push(input);
  };

  const read = async (items: readonly unknown[], tokenBudget: number) => {
    trims.length = 0;
    return conversationHistory({
      ...store(items),
      tenantId: "t1",
      conversationId: "c1",
      tokenBudget,
      onTrimmed,
    });
  };

  // `estimateTokens` is length/4, so 40 characters is 10 tokens — the fixtures are sized in tokens.
  const turn = (role: string, tokens: number, label: string) =>
    message(role, label.padEnd(tokens * 4, "."), label);

  it("keeps everything when the conversation fits", async () => {
    const history = await read([turn("user", 10, "a"), turn("assistant", 10, "b")], 1_000);

    expect(history).toHaveLength(2);
    expect(trims).toEqual([]);
  });

  it("drops the oldest turns, not the newest, when it does not fit", async () => {
    /**
     * The direction matters more than the count. The turn being answered is the last one, so a
     * conversation is trimmed from its beginning; dropping from the other end would keep the greeting
     * and lose the question. The store is read newest-first and reversed, so a bug here would be
     * invisible in a two-message fixture — hence four.
     */
    // Listed **newest first**, which is how the store returns them (`newestFirst: true`) and what
    // `conversationHistory` reverses. A fixture in reading order would describe the other conversation.
    const history = await read(
      [turn("assistant", 10, "newest"), turn("user", 10, "third"), turn("assistant", 10, "second"), turn("user", 10, "oldest")],
      25,
    );

    const labels = history.map((h) => String(h.content).trim().replace(/\.+$/, ""));
    expect(labels).toEqual(["third", "newest"]);
  });

  it("returns them oldest first, because that is what the model reads", async () => {
    const history = await read([turn("assistant", 10, "then"), turn("user", 10, "first")], 1_000);
    expect(history.map((h) => String(h.content).slice(0, 5))).toEqual(["first", "then."]);
  });

  it("says what it dropped rather than trimming silently", async () => {
    /**
     * A silently shortened history is an assistant that forgets the beginning of a thread with nothing
     * anywhere saying why — the same failure as a context provider that throws and is swallowed. The
     * numbers are in the report because "which turns" is the whole question when someone asks why the
     * assistant lost the plot.
     */
    await read([turn("user", 10, "c"), turn("assistant", 10, "b"), turn("user", 10, "a")], 15);

    expect(trims).toHaveLength(1);
    expect(trims[0]?.dropped).toBe(2);
    expect(trims[0]?.kept).toBe(1);
    expect(trims[0]?.budget).toBe(15);
  });

  it("sends a single oversized turn alone rather than sending nothing", async () => {
    /**
     * The edge that decides between a strange answer and no answer. One turn bigger than the whole
     * budget cannot be trimmed to fit, and returning an empty history would hand the model a question
     * with the question removed. A provider's own limit is a better place for that complaint.
     */
    const history = await read([turn("user", 500, "enormous")], 20);

    expect(history).toHaveLength(1);
    expect(trims).toEqual([]);
  });

  it("keeps the newest turn even when an older one is enormous", async () => {
    // The same edge one step along: the oversized turn must not crowd out the turn being answered.
    const history = await read([turn("assistant", 5, "reply"), turn("user", 500, "enormous")], 20);

    expect(history.map((h) => String(h.content).slice(0, 5))).toEqual(["reply"]);
  });

  it("counts a parts-array turn rather than treating it as free", async () => {
    /**
     * `TurnMessage.content` is `string | readonly TurnContentPart[]`. This projection only builds the
     * string form, so the array branch is unreachable today — and a cost function that measured it as
     * zero would stop being true the moment a turn carries one, silently and in the direction that
     * overflows.
     */
    const { withinTokenBudget } = await import("../history.js");
    const dropped: number[] = [];
    const kept = withinTokenBudget({
      turns: [
        { role: "user", content: [{ type: "text", text: "x".repeat(400) }] },
        { role: "assistant", content: "short" },
      ] as never,
      budget: 20,
      report: ({ dropped: d }) => dropped.push(d),
    });

    expect(kept).toHaveLength(1);
    expect(String((kept[0] as { content: unknown }).content)).toBe("short");
    expect(dropped).toEqual([1]);
  });

  it("still bounds the query, so one turn cannot read an unbounded table", async () => {
    // The token budget replaces the *policy* role of the message cap, not the query bound.
    const { calls } = store([]);
    await conversationHistory({ messages: { async listByConversation(i: unknown) { calls.push(i); return { items: [] }; } } as never, tenantId: "t1", conversationId: "c1" });
    expect((calls[0] as { limit: number }).limit).toBe(HISTORY_READ_LIMIT);
  });
});

/**
 * Long threads condensed rather than truncated — `compactThread`, wired.
 *
 * It had no caller anywhere, in this package or in `@retinue/agentkit`, while its store
 * (`createPostgresThreadSummaryStore`) and its table (`thread_summaries`, migrated by the platform)
 * both existed and waited. So the history budget was enforced by dropping the oldest turns and saying
 * so; now they are summarized, once, and the summary is stored.
 *
 * **The cost control is the design**, and it is what these test hardest. `compactThread`
 * re-summarizes its whole `older` prefix on every call — it layers on `priorSummary` but does not skip
 * what that summary covers — so a caller invoking it once per turn would spend a model call and write
 * a summary version every turn: the same prompt size as trimming, plus a round trip. Two things stop
 * that, and both are asserted below: the covered prefix is removed before anything is measured, and
 * the summarizer is reached only when what remains is still over budget.
 */
describe("thread compaction", () => {
  const summaryStore = (initial: { summary: string; coversUpToMessageId: string } | null = null) => {
    let latest = initial === null ? null : { ...initial, version: 1, createdAt: "2026-01-01T00:00:00.000Z" };
    const appended: { summary: string; coversUpToMessageId: string }[] = [];
    return {
      appended,
      get current() {
        return latest;
      },
      store: {
        async latest() {
          return latest;
        },
        async append({ summary, coversUpToMessageId }: { summary: string; coversUpToMessageId: string }) {
          appended.push({ summary, coversUpToMessageId });
          latest = { summary, coversUpToMessageId, version: (latest?.version ?? 0) + 1, createdAt: "2026-01-02T00:00:00.000Z" };
          return latest;
        },
      } as never,
    };
  };

  const summarizer = (text = "They chose the durability angle. Draft p1 is scheduled for Friday.") => {
    const calls: { priorSummary?: string; messages: readonly unknown[] }[] = [];
    return {
      calls,
      summarizer: {
        async summarize(input: { priorSummary?: string; messages: readonly unknown[] }) {
          calls.push(input);
          return text;
        },
      } as never,
    };
  };

  const turn = (role: string, tokens: number, label: string) =>
    message(role, label.padEnd(tokens * 4, "."), label);

  const read = async (
    items: readonly unknown[],
    tokenBudget: number,
    compaction: Record<string, unknown>,
    onTrimmed: () => void = () => {},
  ) =>
    conversationHistory({
      ...store(items),
      tenantId: "t1",
      conversationId: "c1",
      tokenBudget,
      onTrimmed,
      compaction: compaction as never,
    });

  it("does not reach the model when the thread fits", async () => {
    /**
     * The property everything else rests on. A summarizer called on a short conversation is a round
     * trip and a stored row bought for nothing, on the hot path of a turn.
     */
    const store = summaryStore();
    const sum = summarizer();

    const history = await read([turn("assistant", 5, "b"), turn("user", 5, "a")], 1_000, {
      summaries: store.store,
      summarizer: sum.summarizer,
    });

    expect(sum.calls).toEqual([]);
    expect(store.appended).toEqual([]);
    expect(history).toHaveLength(2);
  });

  it("summarizes the older turns when the thread does not fit, and keeps the newest", async () => {
    const store = summaryStore();
    const sum = summarizer("Earlier: they picked the durability angle.");

    const history = await read(
      [turn("assistant", 10, "newest"), turn("user", 10, "third"), turn("assistant", 10, "second"), turn("user", 10, "oldest")],
      25,
      { summaries: store.store, summarizer: sum.summarizer },
    );

    expect(sum.calls).toHaveLength(1);
    // The summary comes first — as a labelled note, never a system message (providers refuse those in history) —
    // and the turn being answered is still there verbatim.
    expect(isSummaryTurn(history[0])).toBe(true);
    expect(history.some((h) => (h.role as string) === "system")).toBe(false);
    expect(String(history[0]?.content)).toContain("Earlier: they picked the durability angle.");
    expect(String(history.at(-1)?.content)).toContain("newest");
  });

  it("stores the summary, so the next turn does not pay for it again", async () => {
    const store = summaryStore();
    const sum = summarizer();

    await read(
      [turn("assistant", 10, "newest"), turn("user", 10, "third"), turn("assistant", 10, "second"), turn("user", 10, "oldest")],
      25,
      { summaries: store.store, summarizer: sum.summarizer },
    );

    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]?.coversUpToMessageId).toBeTruthy();
  });

  it("excludes what the stored summary already covers, and stays off the model", async () => {
    /**
     * The second half of the cost control, and the one a naive wiring gets wrong. On the turn after a
     * compaction the page still contains all four hundred messages; measuring *those* would find the
     * thread over budget again and summarize again, every turn, forever. Measured here as: a prior
     * summary covering the older half leaves a short remainder, and the model is not reached.
     */
    const store = summaryStore({ summary: "The first half, condensed.", coversUpToMessageId: "second" });
    const sum = summarizer();

    const history = await read(
      [turn("assistant", 10, "newest"), turn("user", 10, "third"), turn("assistant", 10, "second"), turn("user", 10, "oldest")],
      // 80, not 45: the summary turn carries a prefix explaining what it is, and prefix + summary +
      // two remaining turns is ~49 tokens. A budget under that compacts again, which is the thing
      // this test is asserting does *not* happen.
      80,
      { summaries: store.store, summarizer: sum.summarizer },
    );

    expect(sum.calls).toEqual([]);
    expect(store.appended).toEqual([]);
    // Summary, then only the two turns after the one it covers — the summary note opens the first user turn.
    expect(history).toHaveLength(2);
    expect(isSummaryTurn(history[0])).toBe(true);
    expect(String(history[0]?.content)).toContain("third.");
    expect(String(history[1]?.content).slice(0, 6)).toBe("newest");
  });

  it("keeps every message when the stored summary is older than this page", async () => {
    /**
     * `HISTORY_READ_LIMIT` bounds the read at 400, so a summary can cover messages that are no longer
     * in the page. Not finding the id means everything here comes *after* it — the opposite reading,
     * that nothing here is uncovered, would silently send the model an empty conversation.
     */
    const store = summaryStore({ summary: "Long ago.", coversUpToMessageId: "a-message-from-last-year" });
    const sum = summarizer();

    const history = await read([turn("assistant", 5, "b"), turn("user", 5, "a")], 1_000, {
      summaries: store.store,
      summarizer: sum.summarizer,
    });

    expect(history).toHaveLength(2);
    expect(isSummaryTurn(history[0])).toBe(true);
    expect(String(history[0]?.content)).toContain("a...");
    expect(String(history[1]?.content).slice(0, 4)).toBe("b...");
  });

  it("falls back to trimming when the summarizer fails, rather than failing the turn", async () => {
    /**
     * A summarizer is a model call, and model calls fail — a rate limit, an outage, a schema the model
     * would not satisfy. The ceiling has never been reached in production, so none of those is worth a
     * refused turn. Degraded means the thread loses its beginning instead of having it condensed.
     */
    const store = summaryStore();
    const trims: unknown[] = [];
    const history = await read(
      [turn("assistant", 10, "newest"), turn("user", 10, "third"), turn("assistant", 10, "second"), turn("user", 10, "oldest")],
      25,
      {
        summaries: store.store,
        summarizer: { async summarize() { throw new Error("provider is down"); } },
      },
      () => trims.push(1),
    );

    expect(history.length).toBeGreaterThan(0);
    expect(String(history.at(-1)?.content)).toContain("newest");
    expect(trims).toHaveLength(1);
    expect(store.appended).toEqual([]);
  });

  it("falls back when the summary store cannot be read", async () => {
    // Same reasoning one layer down: a table that is missing or unreachable is not a reason to refuse.
    const history = await read([turn("assistant", 10, "newest"), turn("user", 10, "oldest")], 15, {
      summaries: { async latest() { throw new Error("relation does not exist"); }, async append() { throw new Error("no"); } },
      summarizer: summarizer().summarizer,
    });

    expect(String(history.at(-1)?.content)).toContain("newest");
  });

  it("never summarizes away the turn being answered", async () => {
    /**
     * `engine.js` builds the model's list as `[...history]` and finds "the newest user turn" inside it,
     * so the last message here *is* the question. `keepRecent` is floored at one for that reason: a
     * budget small enough to summarize everything would otherwise hand the model a conversation with
     * the question removed.
     */
    const store = summaryStore();
    const sum = summarizer("everything before, condensed");

    const history = await read(
      [turn("user", 400, "question"), turn("assistant", 400, "older"), turn("user", 400, "oldest")],
      10,
      { summaries: store.store, summarizer: sum.summarizer },
    );

    expect(String(history.at(-1)?.content)).toContain("question");
  });

  it("reports what it condensed", async () => {
    const store = summaryStore();
    const sum = summarizer();
    const events: { summarized: number; kept: number; tokensReclaimed: number }[] = [];

    await read(
      [turn("assistant", 10, "newest"), turn("user", 10, "third"), turn("assistant", 10, "second"), turn("user", 10, "oldest")],
      25,
      { summaries: store.store, summarizer: sum.summarizer, onCompacted: (e: never) => events.push(e) },
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.summarized).toBeGreaterThan(0);
    expect(events[0]?.kept).toBeGreaterThan(0);
  });

  it("layers the prior summary rather than starting over", async () => {
    // `compactThread` passes `priorSummary` so one summary covers the whole thread; without it each
    // compaction would describe only its own slice and the thread would read as disconnected fragments.
    const store = summaryStore({ summary: "The first half.", coversUpToMessageId: "oldest" });
    const sum = summarizer();

    await read(
      [turn("assistant", 40, "newest"), turn("user", 40, "third"), turn("assistant", 40, "second"), turn("user", 10, "oldest")],
      45,
      { summaries: store.store, summarizer: sum.summarizer },
    );

    expect(sum.calls).toHaveLength(1);
    expect(sum.calls[0]?.priorSummary).toBe("The first half.");
  });

  it("still bounds the result, because keepRecent is chosen from an estimate", async () => {
    /**
     * The summary's real length is only known after the model writes it, so `keepRecent` — chosen from
     * an estimate beforehand — can leave the compacted history over budget. The trim afterwards is what
     * makes the budget a guarantee rather than an intention.
     *
     * The budget here is a realistic one. A budget smaller than a whole summary cannot be honoured at
     * all, because the summary is protected from trimming; `HISTORY_FLOOR_TOKENS` is derived from
     * `SUMMARY_MAX_CHARS` so that case cannot arise in production, and the test below asserts it.
     */
    const store = summaryStore();
    const sum = summarizer("s".repeat(400));

    const history = await read(
      [turn("assistant", 60, "newest"), turn("user", 60, "third"), turn("assistant", 60, "second"), turn("user", 60, "oldest")],
      200,
      { summaries: store.store, summarizer: sum.summarizer },
    );

    const tokens = history.reduce((sum2, h) => sum2 + Math.ceil(String(h.content).length / 4), 0);
    // 60 is the single-oversized-turn allowance: the newest turn is kept whatever it costs.
    expect(tokens).toBeLessThanOrEqual(200 + 60);
  });

  it("keeps the summary when the budget is tight, because it replaced every older turn", async () => {
    /**
     * The bug this caught, written down. `withinTokenBudget` drops from the front and the summary sits
     * at the front, so it used to be the **first** thing dropped: a model call spent condensing the
     * thread, the condensation discarded, and the raw turns kept instead. Measured as
     * `expected 'assistant' to be 'system'`.
     */
    const store = summaryStore({ summary: "The whole thread, condensed.", coversUpToMessageId: "oldest" });
    const history = await read(
      [turn("assistant", 200, "newest"), turn("user", 10, "oldest")],
      60,
      { summaries: store.store, summarizer: summarizer().summarizer },
    );

    expect(isSummaryTurn(history[0])).toBe(true);
    expect(String(history[0]?.content)).toContain("The whole thread, condensed.");
  });

  it("cannot be configured so a summary does not fit its own budget", async () => {
    /**
     * The invariant that makes protecting the summary safe. It is protected from trimming, so a
     * summary larger than the budget would make the budget unenforceable — and both numbers are
     * constants somebody could move independently. `HISTORY_FLOOR_TOKENS` is derived from
     * `SUMMARY_MAX_CHARS` for that reason, and this asserts the relationship rather than the numbers.
     */
    const { HISTORY_FLOOR_TOKENS, historyBudgetFitsASummary, historyTokenBudget } = await import("../prompt-budget.js");

    expect(historyBudgetFitsASummary(HISTORY_FLOOR_TOKENS)).toBe(true);
    // And at the floor there is still room for the turn being answered, not only the summary.
    expect(HISTORY_FLOOR_TOKENS - Math.ceil(SUMMARY_MAX_CHARS / 4)).toBeGreaterThanOrEqual(1_000);
    // Including on a deployment whose model is far smaller than this one's.
    expect(historyBudgetFitsASummary(historyTokenBudget(8_000))).toBe(true);
  });
});

/**
 * Production, 2026-09-28: a post saved with draft_post_for_channels, then "add the url" — and three new
 * drafts. History was text only, so the post's id was in no turn the model could read.
 */
describe("toolRecordOf", () => {
  const saved = {
    role: "assistant",
    parts: [
      { type: "tool-call", toolName: "draft_post_for_channels", input: {} },
      {
        type: "tool-result",
        toolName: "draft_post_for_channels",
        output: { postDraftId: "4773fdba", written: [{ platformId: "facebook" }, { platformId: "linkedin" }], failed: [] },
      },
      { type: "tool-result", toolName: "create_post_draft", output: { ok: false, error: { message: "4 hashtags; facebook allows at most 3." } } },
      { type: "tool-result", toolName: "create_artifact", output: { artifactId: "f4887f2f", title: "Doc" } },
      { type: "tool-result", toolName: "read_source", output: { passages: [{ excerpt: "long page text" }] } },
      { type: "text", text: "I've created the post." },
    ],
  };

  it("keeps the ids and channels a later edit needs, and what failed", () => {
    const record = toolRecordOf(saved as never);
    expect(record).toContain("draft_post_for_channels: postDraftId 4773fdba (channels: facebook, linkedin)");
    expect(record).toContain("create_post_draft failed: 4 hashtags; facebook allows at most 3.");
    expect(record).toContain("create_artifact: artifactId f4887f2f");
  });

  it("leaves out tool bodies that carry no id", () => {
    expect(toolRecordOf(saved as never)).not.toContain("long page text");
  });

  it("sizes a reply as its text plus its record", () => {
    const content = turnContentOf(saved as never);
    expect(content.startsWith("I've created the post.\n\n[System note, not from the person")).toBe(true);
  });

  it("adds nothing to a user message or a reply without tools", () => {
    expect(toolRecordOf({ role: "user", parts: [{ type: "tool-result", toolName: "x", output: { postDraftId: "p" } }] } as never)).toBe("");
    expect(turnContentOf({ role: "assistant", parts: [{ type: "text", text: "Hi." }] } as never)).toBe("Hi.");
  });

  it("reaches the model through conversationHistory", async () => {
    const messages = {
      async listByConversation() {
        return { items: [saved, { role: "user", parts: [{ type: "text", text: "add the url" }] }].reverse() };
      },
    } as never;
    const turns = await conversationHistory({ messages, tenantId: "t1", conversationId: "c1" });
    expect(turns[0]).toEqual({ role: "assistant", content: "I've created the post." });
    expect(turns[1]?.role).toBe("user");
    expect(turns[1]?.content).toContain("postDraftId 4773fdba");
    expect(String(turns[1]?.content).endsWith("add the url")).toBe(true);
  });

/**
 * #650 — the record is never in the assistant's own voice.
 *
 * Production, 2026-09-30: with it appended to earlier replies, the model wrote a fake record (update to version 3,
 * a PDF that did not exist) instead of calling the tools. Text it reads as a note from the system is text it does
 * not reproduce as its own.
 */
describe("the tool record's place in history (#650)", () => {
  const history = async (oldestFirst: readonly unknown[]) =>
    conversationHistory({
      messages: { async listByConversation() { return { items: [...oldestFirst].reverse() }; } } as never,
      tenantId: "t1",
      conversationId: "c1",
    });

  it("keeps every assistant turn free of any record", async () => {
    const turns = await history([{ role: "user", parts: [{ type: "text", text: "make a post" }] }, saved, { role: "user", parts: [{ type: "text", text: "add the url" }] }]);
    for (const turn of turns.filter((t) => t.role === "assistant")) expect(String(turn.content)).not.toContain("[");
  });

  it("gives a record with no user turn after it a user turn of its own", async () => {
    const turns = await history([{ role: "user", parts: [{ type: "text", text: "make a post" }] }, saved]);
    expect(turns.at(-1)?.role).toBe("user");
    expect(String(turns.at(-1)?.content)).toContain("postDraftId 4773fdba");
  });

  it("joins the notes of a tools-only reply into the next user turn", async () => {
    const toolsOnly = { role: "assistant", parts: saved.parts.filter((part: { type: string }) => part.type !== "text") };
    const turns = await history([{ role: "user", parts: [{ type: "text", text: "make a post" }] }, toolsOnly, { role: "user", parts: [{ type: "text", text: "thanks" }] }]);
    expect(turns.map((t) => t.role)).toEqual(["user"]);
    expect(String(turns[0]?.content)).toContain("postDraftId 4773fdba");
  });

  it("removes a record an old reply wrote itself, so it does not teach the pattern again", async () => {
    const leaked = { role: "assistant", parts: [{ type: "text", text: "Done.\n[Your tool calls in this reply, with what you sent — do not show this block:]\n- update_artifact: version 3" }] };
    const turns = await history([{ role: "user", parts: [{ type: "text", text: "make it dark" }] }, leaked, { role: "user", parts: [{ type: "text", text: "thanks" }] }]);
    expect(turns[1]).toEqual({ role: "assistant", content: "Done." });
  });
});
});
