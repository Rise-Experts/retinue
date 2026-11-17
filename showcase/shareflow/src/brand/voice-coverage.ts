/**
 * Choosing which flagged posts the model is shown — REQ-013 AC-3, #278, from spike #279.
 *
 * ## What the spike found, and why this is not what the issue asked for
 *
 * #278 AC-3 says *"examples chosen by relevance, not just recency"*, and spike #279 was written to
 * decide **how**: embeddings or a heuristic. It measured the assumption underneath that question
 * first, because the two arms cost wildly different amounts — the heuristic is an `ORDER BY`, and
 * embeddings need a `vector` extension (not installed), an embedding dependency (none), a call in the
 * model adapter (none), a migration, a backfill and re-embedding on every edit.
 *
 * Relevance-to-brief did essentially nothing. Lexical relevance scored a drift of 0.293 against
 * recency's 0.293 on a consistent-voice corpus, and 0.308 against 0.321 on a varied one. Both arms of
 * the question optimise topical similarity, and topical similarity is not what moves whether the
 * examples *sound like this workspace* — which is what few-shot voice examples are for. A better
 * implementation of that objective is a better implementation of the wrong objective.
 *
 * There was real headroom, and it was somewhere else: 72% of the achievable range in the homogeneous
 * case, 36% in the heterogeneous one. A greedy **voice-coverage** selector reached the exhaustive
 * optimum in both conditions, with no model call, no vector column, no migration and no backfill.
 *
 * So this selects for representativeness, and the failure mode it avoids is specific: choosing
 * exemplars by similarity to the brief means a brief about a spring sale retrieves past *sale* posts,
 * the model sees three posts of one kind, and it imitates their structure along with their voice. The
 * sample gets narrower exactly when it should be representative.
 *
 * ## What the spike does not establish
 *
 * Stated here rather than only in `docs/spikes/279-exemplar-selection.md`, because this is where
 * someone will be standing when it matters. The corpora were **constructed** — there was no real one
 * to measure, the local database has four posts and none with real text — so the stylistic spread was
 * a controlled variable rather than an observed one. n was 6 and K was 3; a greedy selector reaching
 * the exhaustive optimum is far easier at six posts than at two hundred, and while the *ranking* of
 * the strategies should hold, "hits the ceiling exactly" may not. And representativeness is a proxy:
 * the chain assumes a more representative sample makes the model write more like the workspace, which
 * is plausible and untested.
 *
 * Re-run `shareflow/scripts/spike-exemplar-selection.mjs` against a real workspace's flagged posts
 * before treating any of this as settled. `featuresOf` below is the same function it measures with.
 */

/**
 * The measurable part of "how this workspace writes" — six features, all string operations on text
 * the query already returns.
 *
 * **A faithful transcription of the spike's, including its rough edge.** `questionRate` asks whether
 * the trimmed sentence appears in the source followed by `?`, which is an indirect way to find the
 * terminator that split it off and can mis-attribute when the same sentence appears twice with
 * different punctuation. It is kept exactly as measured: changing it would make this a different
 * feature set from the one the numbers above describe, and a selector justified by a measurement of
 * something else is worse than one with a known rough edge.
 *
 * They are cheap and legible, not a validated model of voice. A workspace whose style lives in
 * vocabulary rather than in structure would be measured poorly by them.
 */
export const featuresOf = (text: string): Readonly<Record<string, number>> => {
  const sentences = text.split(/[.!?]+/).map((part) => part.trim()).filter((part) => part !== "");
  const words = text.split(/\s+/).filter((word) => word !== "");
  return {
    wordsPerSentence: sentences.length === 0 ? 0 : words.length / sentences.length,
    emojiPerPost: (text.match(/\p{Extended_Pictographic}/gu) ?? []).length,
    hashtagsPerPost: (text.match(/#\w+/g) ?? []).length,
    questionRate:
      sentences.length === 0 ? 0 : sentences.filter((part) => text.includes(`${part}?`)).length / sentences.length,
    firstPersonRate:
      words.length === 0 ? 0 : words.filter((word) => /^(we|our|us|i|my)$/i.test(word)).length / words.length,
    exclaimRate: text.length === 0 ? 0 : (text.match(/!/g) ?? []).length / Math.max(sentences.length, 1),
  };
};

const KEYS = Object.keys(featuresOf("a. b"));

/**
 * Pick `limit` texts whose voice profile sits closest to the whole pool's.
 *
 * Returns **indexes into `texts`**, not the texts, so a caller can carry whatever else its rows hold
 * (an id, a title) without this function knowing about any of it.
 *
 * ## Greedy, then swaps — and the second half was earned by measurement
 *
 * The spike's selector was greedy alone: start from nothing and repeatedly add the candidate that
 * moves the running sample closest to the pool. It reached the exhaustive optimum in both of the
 * spike's conditions, and the spike's own caveat said that claim was the fragile one — *"a greedy
 * selector reaching the exhaustive optimum is far easier at six posts than at two hundred"*.
 *
 * It was right. Measured against a search of every subset of an eight-post pool, greedy alone ranks:
 *
 *     k=2   rank 7 of 28      k=3   rank 3 of 56      k=4   rank 5 of 70
 *     k=5   rank 25 of 56     k=6   rank 3 of 28
 *
 * Never bad — it beats recency by a wide margin at every k — but not the ceiling, and at k=5 not even
 * close to it. A steepest-descent pass afterwards (try every swap of one chosen row for one unchosen,
 * take the best improvement, repeat) fixes it:
 *
 *     k=2   rank 5 of 28      k=3   rank 1 of 56      k=4   rank 1 of 70
 *     k=5   rank 1 of 56      k=6   rank 1 of 28
 *
 * Still a local optimum, not a proof — k=2 is the case it does not close, because a two-row mean has
 * very little freedom to move. The exhaustive search this was measured against is `O(C(n, k))` and is
 * not something to run on a request; this is `O(rounds · k · (n - k) · features)` with both totals
 * carried incrementally, which at the deployed bounds (pool 60, at most 20 examples) is a few tens of
 * thousands of arithmetic operations.
 *
 * ## Details that decide behaviour
 *
 * Features are normalised by the pool's own standard deviation per feature, which is what stops words
 * per sentence (tens) drowning emoji count (units). A feature with no variation across the pool gets a
 * spread of 1, so it contributes nothing rather than dividing by zero — correct, since a feature every
 * post shares says nothing about which posts to choose.
 *
 * **Ties go to the earlier index**, and a swap is taken only on a strict improvement. So a caller that
 * passes rows newest-first gets recency as the tie-break for free, and the result is deterministic.
 */
export const selectByVoiceCoverage = (texts: readonly string[], limit: number): readonly number[] => {
  if (limit <= 0 || texts.length === 0) return [];
  /*
   * A pool no larger than the ask is returned whole, in its original order.
   *
   * Not an optimisation — it is the only correct answer. "The most representative 4 of 4" is every
   * post, and running the selector would only reorder them. This is also the common case today: no
   * workspace has more than a handful of flagged posts, so the change is a no-op until a corpus
   * exists, which is the right shape for a selector justified by a spike on constructed data.
   */
  if (texts.length <= limit) return texts.map((_text, index) => index);

  const rows = texts.map((text) => KEYS.map((key) => featuresOf(text)[key] as number));
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const corpus = KEYS.map((_key, feature) => mean(rows.map((row) => row[feature] as number)));
  const spread = KEYS.map((_key, feature) => {
    const values = rows.map((row) => row[feature] as number);
    const average = corpus[feature] as number;
    const sd = Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
    // A feature every post shares divides nothing and decides nothing.
    return sd === 0 ? 1 : sd;
  });

  /** How far a sample described by these running totals sits from the pool. */
  const driftOf = (totals: readonly number[], size: number): number => {
    let sum = 0;
    for (let feature = 0; feature < KEYS.length; feature += 1) {
      const sampleMean = (totals[feature] as number) / size;
      sum += (((sampleMean - (corpus[feature] as number)) / (spread[feature] as number)) ** 2);
    }
    return Math.sqrt(sum / KEYS.length);
  };

  const totals = KEYS.map(() => 0);
  const chosen: number[] = [];
  const taken = new Set<number>();

  while (chosen.length < limit) {
    let bestIndex = -1;
    let bestDrift = Infinity;
    for (let index = 0; index < rows.length; index += 1) {
      if (taken.has(index)) continue;
      const row = rows[index] as number[];
      const drift = driftOf(
        totals.map((total, feature) => total + (row[feature] as number)),
        chosen.length + 1,
      );
      // Strictly less than: the first index wins a tie, which is what makes this deterministic.
      if (drift < bestDrift) {
        bestDrift = drift;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) break;
    taken.add(bestIndex);
    chosen.push(bestIndex);
    const row = rows[bestIndex] as number[];
    for (let feature = 0; feature < KEYS.length; feature += 1) {
      totals[feature] = (totals[feature] as number) + (row[feature] as number);
    }
  }

  /*
   * The swap pass. Bounded, because a loop that only exits on "no improvement found" is one floating
   * point comparison away from never exiting, and this runs on every assistant turn.
   *
   * The bound is not expected to bind: each accepted swap strictly lowers the drift, so the sequence
   * is monotone and terminates on its own. It is there so that if it ever does not, the assistant
   * answers a little worse rather than not at all.
   */
  const MAX_ROUNDS = 32;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let bestDrift = driftOf(totals, chosen.length);
    let swapOut = -1;
    let swapIn = -1;
    for (let position = 0; position < chosen.length; position += 1) {
      const leaving = rows[chosen[position] as number] as number[];
      for (let index = 0; index < rows.length; index += 1) {
        if (taken.has(index)) continue;
        const arriving = rows[index] as number[];
        const drift = driftOf(
          totals.map((total, feature) => total - (leaving[feature] as number) + (arriving[feature] as number)),
          chosen.length,
        );
        // Strict, so an equally good swap is not taken — the incumbent is the more recent post.
        if (drift < bestDrift) {
          bestDrift = drift;
          swapOut = position;
          swapIn = index;
        }
      }
    }
    if (swapOut === -1) break;
    const leaving = rows[chosen[swapOut] as number] as number[];
    const arriving = rows[swapIn] as number[];
    for (let feature = 0; feature < KEYS.length; feature += 1) {
      totals[feature] = (totals[feature] as number) - (leaving[feature] as number) + (arriving[feature] as number);
    }
    taken.delete(chosen[swapOut] as number);
    taken.add(swapIn);
    chosen[swapOut] = swapIn;
  }

  /*
   * Sorted back into the caller's order, not returned in the order they were picked.
   *
   * The spike measured which **set** of posts represents the corpus; it says nothing about what order
   * to show them in. Returning selection order would change two things at once — which examples the
   * model sees and the sequence it sees them in — and only one of those has evidence behind it.
   */
  return chosen.sort((a, b) => a - b);
};
