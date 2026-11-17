import { describe, expect, it } from "vitest";

import { featuresOf, selectByVoiceCoverage } from "../voice-coverage.js";

/**
 * REQ-013 AC-3 — *"examples chosen by relevance, not just recency"* — as spike #279 decided it should
 * be read.
 *
 * The spike's finding is that relevance-to-brief moves nothing and representativeness moves most of
 * the achievable range, so what is asserted here is representativeness: does the chosen K sound like
 * the pool, and does it beat what shipped (the first K)?
 *
 * `drift` is reimplemented in this file rather than exported from the module under test. That is on
 * purpose: a test that measures with the implementation's own arithmetic passes whenever the
 * arithmetic is self-consistent, including when it is self-consistently wrong. This is the spike's
 * formula, transcribed from `scripts/spike-exemplar-selection.mjs`, and the two agreeing is the claim.
 */
const KEYS = Object.keys(featuresOf("a. b"));

const drift = (sample: readonly string[], corpus: readonly string[]): number => {
  const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const profile = (texts: readonly string[]) =>
    Object.fromEntries(KEYS.map((key) => [key, mean(texts.map((text) => featuresOf(text)[key] as number))]));
  const sampleProfile = profile(sample);
  const corpusProfile = profile(corpus);
  let sum = 0;
  for (const key of KEYS) {
    const values = corpus.map((text) => featuresOf(text)[key] as number);
    const average = mean(values);
    const sd = Math.sqrt(mean(values.map((value) => (value - average) ** 2))) || 1;
    sum += (((sampleProfile[key] as number) - (corpusProfile[key] as number)) / sd) ** 2;
  }
  return Math.sqrt(sum / KEYS.length);
};

/** Every K-sized subset's drift, so "no method could have done better" is a fact rather than a hope. */
const exhaustiveBest = (corpus: readonly string[], k: number): number => {
  let best = Infinity;
  const walk = (start: number, acc: string[]) => {
    if (acc.length === k) {
      best = Math.min(best, drift(acc, corpus));
      return;
    }
    for (let i = start; i < corpus.length; i += 1) walk(i + 1, [...acc, corpus[i] as string]);
  };
  walk(0, []);
  return best;
};

/**
 * A workspace whose posts vary sharply — a marketer, an engineer and an intern all posting.
 *
 * Ordered newest-first, as the query returns them, and the three newest are deliberately the three
 * least typical. That is the whole case: recency would hand the model the shouty sale posts and the
 * model would learn to write those.
 */
const MIXED = [
  "HUGE news!!! 🎉🎉 The new roast is HERE and it is INSANE 🔥 go get it #coffee #new #fire #musttry",
  "Sale!! 20% off EVERYTHING this weekend only!! Don't miss out!! 🛍️🛍️🛍️ #sale #deal #shopnow",
  "LAST CHANCE!!! 😱😱 Everything must go!! Tap the link NOW!! #sale #urgent #lastchance",
  "We shipped the new roasting profile this week. Three months of tasting, and the difference is in the finish. #coffee",
  "Our spring lot is landing Monday. We cupped every bag twice before saying yes to it. #coffee #springlot",
  "We rebuilt the grinder burrs over the weekend. Small change, and the espresso is noticeably sweeter. #coffee",
  "A short note on extraction yield: we now target 21% for the house espresso, up from 19.5%.",
  "We have completed the migration of our roasting profile documentation to the new internal system.",
];

const pick = (texts: readonly string[], k: number) => selectByVoiceCoverage(texts, k).map((i) => texts[i] as string);

describe("selecting voice examples by coverage — REQ-013 AC-3, spike #279", () => {
  it("beats recency at every size, which is the whole reason to do anything at all", () => {
    /*
     * The shipped behaviour is `order by updated_at desc limit k` — the first k of this pool, which
     * here are the three shoutiest posts. If the selector does not beat that, none of this is worth a
     * line of code. Asserted at every k rather than one, because "better on average" is not the claim.
     */
    for (let k = 2; k < MIXED.length; k += 1) {
      expect(drift(pick(MIXED, k), MIXED), `k=${k}`).toBeLessThan(drift(MIXED.slice(0, k), MIXED));
    }
  });

  it("reaches the exhaustive optimum for three examples or more", () => {
    /**
     * Checked against a search of every subset, not against another heuristic — and this is where the
     * spike's headline claim was found to be **too strong**.
     *
     * #279 reported that greedy selection "reached the theoretical optimum in both test conditions",
     * at n=6 and K=3, and flagged that exact claim as the fragile one. At n=8 greedy alone ranks 7th
     * of 28 at k=2, 3rd of 56 at k=3 and 25th of 56 at k=5 — never bad, and not the ceiling. The
     * steepest-descent pass in `selectByVoiceCoverage` is what closes it, and it was added because of
     * this test rather than the other way round.
     *
     * A claim about *this* corpus at *this* size. At two hundred posts neither half is guaranteed.
     */
    for (const k of [3, 4, 5, 6]) {
      expect(drift(pick(MIXED, k), MIXED), `k=${k}`).toBeCloseTo(exhaustiveBest(MIXED, k), 10);
    }
  });

  it("does not reach it at two, which is stated rather than hidden", () => {
    /**
     * The known gap. Two rows is the hardest case — a mean of two has very little freedom to move —
     * and local search settles 5th of 28 here rather than 1st. It still beats recency by a factor of
     * three, so it is a real improvement and not a solved problem.
     *
     * Pinned, so that a change which makes k=2 *worse* is caught. Loosening this number is fine when
     * the selector improves; loosening it to make a regression pass is what the assertion exists to
     * make visible.
     */
    const all: number[] = [];
    for (let i = 0; i < MIXED.length; i += 1) {
      for (let j = i + 1; j < MIXED.length; j += 1) all.push(drift([MIXED[i] as string, MIXED[j] as string], MIXED));
    }
    all.sort((a, b) => a - b);
    const chosen = drift(pick(MIXED, 2), MIXED);
    const rank = all.filter((d) => d < chosen - 1e-12).length + 1;
    expect(rank, "k=2 rank among all 28 pairs").toBeLessThanOrEqual(5);
    expect(chosen).toBeGreaterThan(exhaustiveBest(MIXED, 2));
    expect(chosen).toBeLessThan(drift(MIXED.slice(0, 2), MIXED) / 2);
  });

  it("does not just avoid the outliers — it represents the spread", () => {
    /*
     * A selector that only ever picked the calmest posts would also beat recency here, and would be
     * wrong for a workspace that genuinely posts both ways. At k=4 over this pool the chosen set
     * should still carry some of the loud voice, because the pool does.
     */
    const chosen = pick(MIXED, 4);
    expect(chosen.some((text) => text.includes("!!"))).toBe(true);
    expect(chosen.some((text) => !text.includes("!!"))).toBe(true);
  });

  it("returns the pool untouched when there is nothing to choose between", () => {
    /*
     * "The most representative 4 of 4" is every post. This is also the state of every workspace today
     * — no corpus has more than a handful of flagged posts — so the change is a no-op until one does.
     */
    const four = MIXED.slice(0, 4);
    expect(selectByVoiceCoverage(four, 4)).toEqual([0, 1, 2, 3]);
    expect(selectByVoiceCoverage(four, 10)).toEqual([0, 1, 2, 3]);
  });

  it("returns indexes in the caller's order, not the order it picked them", () => {
    /**
     * The spike measured which **set** represents the corpus and says nothing about what order to show
     * them in. Returning greedy order would change two things at once, and only one has evidence.
     */
    const indexes = selectByVoiceCoverage(MIXED, 4);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("asks for exactly what it was asked for", () => {
    for (let k = 1; k <= MIXED.length; k += 1) expect(selectByVoiceCoverage(MIXED, k)).toHaveLength(k);
  });

  it("is deterministic, and breaks ties towards the earlier row", () => {
    /*
     * The caller passes rows newest-first, so the earlier index is the more recent post — recency
     * survives as the tie-break rather than being replaced by whatever order the loop happened to hit.
     */
    const identical = ["Same post.", "Same post.", "Same post.", "Same post.", "Same post."];
    expect(selectByVoiceCoverage(identical, 2)).toEqual([0, 1]);
    expect(selectByVoiceCoverage(MIXED, 3)).toEqual(selectByVoiceCoverage(MIXED, 3));
  });

  it("survives text a post can actually contain", () => {
    // An empty body, one word, no punctuation at all — none of which may divide by zero.
    const rough = ["", "Hi", "no terminator here", "!!!", "#tag", "🎉"];
    expect(() => selectByVoiceCoverage(rough, 3)).not.toThrow();
    expect(selectByVoiceCoverage(rough, 3)).toHaveLength(3);
  });

  it("returns nothing for a request for nothing", () => {
    expect(selectByVoiceCoverage(MIXED, 0)).toEqual([]);
    expect(selectByVoiceCoverage(MIXED, -1)).toEqual([]);
    expect(selectByVoiceCoverage([], 3)).toEqual([]);
  });
});

describe("the six features are the ones the spike measured", () => {
  /**
   * The numbers in `docs/spikes/279-exemplar-selection.md` are only evidence for *this* feature set.
   * Changing one silently would leave a selector justified by a measurement of something else, so the
   * shape is pinned and each feature is checked against a case where it is the thing that differs.
   */
  it("computes exactly six, under the names the spike used", () => {
    expect(Object.keys(featuresOf("A post. Another!"))).toEqual([
      "wordsPerSentence",
      "emojiPerPost",
      "hashtagsPerPost",
      "questionRate",
      "firstPersonRate",
      "exclaimRate",
    ]);
  });

  it("measures each of them", () => {
    expect(featuresOf("One two three. Four five six.").wordsPerSentence).toBeCloseTo(3);
    expect(featuresOf("Nice 🎉 day 🔥").emojiPerPost).toBe(2);
    expect(featuresOf("Look #here and #there").hashtagsPerPost).toBe(2);
    expect(featuresOf("Are you ready? Yes.").questionRate).toBeCloseTo(0.5);
    expect(featuresOf("we did it").firstPersonRate).toBeCloseTo(1 / 3);
    expect(featuresOf("Wow! Amazing!").exclaimRate).toBeCloseTo(1);
  });

  it("gives an empty post zeroes rather than NaN", () => {
    // Division by a sentence count of zero is the obvious way this breaks, and a NaN poisons every
    // drift it touches — silently, since NaN comparisons are all false and the loop would pick index 0.
    for (const value of Object.values(featuresOf(""))) expect(Number.isFinite(value)).toBe(true);
  });
});
