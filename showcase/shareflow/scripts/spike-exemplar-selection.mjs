/**
 * Spike #279 — embeddings vs heuristic for choosing voice exemplars.
 *
 * Run: `node shareflow/scripts/spike-exemplar-selection.mjs`
 *
 * ## What this measures, and why it is not what the issue asks
 *
 * The issue asks which *relevance* method to use. That question assumes relevance-selection helps,
 * and the assumption is worth testing first, because the two arms cost wildly different amounts:
 * the heuristic is an `ORDER BY`, and embeddings need a vector extension (not installed), an
 * embedding dependency (none), an embedding call in the model adapter (none), a migration, a
 * backfill, and re-embedding on every edit.
 *
 * Few-shot voice examples exist for **style transfer**, not topical retrieval. The model is shown
 * them to learn how this workspace writes, not what it writes about. So the thing that matters is
 * whether a chosen K **represents the corpus's voice** — and if every selection strategy represents
 * it about equally, the expensive arm buys nothing regardless of which is theoretically better.
 *
 * ## Why a constructed corpus
 *
 * There is no real one to measure. The local database has four posts and none with real text, and
 * production content is not mine to pull. A constructed corpus is weaker evidence about this
 * product's actual writing and stronger evidence about the *mechanism*, because the stylistic
 * spread is a controlled variable rather than an accident of whoever happened to post.
 *
 * Read the numbers as "under these conditions", and re-run against a real workspace before treating
 * the recommendation as settled. `measureCorpus` takes any array of strings.
 */

/** Voice features — the measurable part of "how this workspace writes". */
const featuresOf = (text) => {
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  return {
    wordsPerSentence: sentences.length === 0 ? 0 : words.length / sentences.length,
    emojiPerPost: (text.match(/\p{Extended_Pictographic}/gu) ?? []).length,
    hashtagsPerPost: (text.match(/#\w+/g) ?? []).length,
    questionRate: sentences.length === 0 ? 0 : sentences.filter((s) => text.includes(`${s}?`)).length / sentences.length,
    firstPersonRate: words.length === 0 ? 0 : words.filter((w) => /^(we|our|us|i|my)$/i.test(w)).length / words.length,
    exclaimRate: text.length === 0 ? 0 : (text.match(/!/g) ?? []).length / Math.max(sentences.length, 1),
  };
};

const KEYS = Object.keys(featuresOf("a. b"));

const profile = (texts) => {
  const rows = texts.map(featuresOf);
  return Object.fromEntries(KEYS.map((k) => [k, rows.reduce((sum, r) => sum + r[k], 0) / (rows.length || 1)]));
};

/**
 * How far a sample's voice profile sits from the whole corpus's, normalised per feature so words per
 * sentence (tens) does not drown emoji count (units). 0 = the sample writes like the corpus.
 */
const drift = (sample, corpus) => {
  const s = profile(sample);
  const c = profile(corpus);
  const spread = Object.fromEntries(
    KEYS.map((k) => {
      const values = corpus.map((t) => featuresOf(t)[k]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
      return [k, sd || 1];
    }),
  );
  return Math.sqrt(KEYS.reduce((sum, k) => sum + ((s[k] - c[k]) / spread[k]) ** 2, 0) / KEYS.length);
};

// --- selection strategies -------------------------------------------------

/** What ships today: `order by updated_at desc`. The corpus is given newest-first. */
const byRecency = (corpus, k) => corpus.slice(0, k);

/**
 * The heuristic arm: lexical overlap with the brief. A stand-in for "relevance" that needs no
 * infrastructure — the cheapest thing that could be called relevance-selection.
 */
const byLexicalRelevance = (corpus, k, brief) => {
  const terms = new Set(brief.toLowerCase().match(/\w{4,}/g) ?? []);
  return [...corpus]
    .map((text) => {
      const words = new Set(text.toLowerCase().match(/\w{4,}/g) ?? []);
      let hits = 0;
      for (const t of terms) if (words.has(t)) hits += 1;
      return { text, hits };
    })
    .sort((a, b) => b.hits - a.hits)
    .slice(0, k)
    .map((r) => r.text);
};

/**
 * The third option the issue does not name: select for **voice coverage**, greedily.
 *
 * Start from nothing and repeatedly add the post that moves the sample's profile closest to the
 * corpus's. Needs no model, no vector column and no migration — it reads the same six numbers
 * `featuresOf` already computes, which are string operations on text the query returns anyway.
 *
 * Included because a spike that only reports "neither arm helps" leaves the reader with nothing to
 * do. This says what the headroom is actually reachable by.
 */
const byVoiceCoverage = (corpus, k) => {
  const chosen = [];
  const pool = [...corpus];
  while (chosen.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestDrift = Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const d = drift([...chosen, pool[i]], corpus);
      if (d < bestDrift) {
        bestDrift = d;
        bestIndex = i;
      }
    }
    chosen.push(pool.splice(bestIndex, 1)[0]);
  }
  return chosen;
};

/**
 * The ceiling: the K whose profile is closest to the corpus's, found by search. No real strategy can
 * beat this, so it bounds what *any* selection method — embeddings included — could win.
 */
const bestPossible = (corpus, k) => {
  let best = null;
  const combos = (arr, size, start = 0, acc = []) => {
    if (acc.length === size) {
      const d = drift(acc, corpus);
      if (best === null || d < best.d) best = { d, sample: [...acc] };
      return;
    }
    for (let i = start; i < arr.length; i += 1) combos(arr, size, i + 1, [...acc, arr[i]]);
  };
  combos(corpus, k);
  return best;
};

// --- corpora --------------------------------------------------------------

/** A workspace with a consistent voice — the premise of having one at all. */
const HOMOGENEOUS = [
  "We shipped the new roasting profile this week. Three months of tasting, and the difference is in the finish. #coffee #roasting",
  "Our spring lot is landing Monday. We cupped every bag twice before saying yes to it. #coffee #springlot",
  "We rebuilt the grinder burrs over the weekend. Small change, and the espresso is noticeably sweeter. #coffee #espresso",
  "Our new bags arrived. We moved to a recyclable liner without losing the freshness window. #coffee #packaging",
  "We tasted eleven samples for the summer blend. Two made it. The rest were good, not right. #coffee #blend",
  "Our cafe opens an hour earlier from June. We kept hearing the same request, so we listened. #coffee #cafe",
];

/** A workspace whose posts vary sharply — a marketer, an engineer and an intern all posting. */
const HETEROGENEOUS = [
  "HUGE news!!! 🎉🎉 The new roast is HERE and it is INSANE 🔥 go get it #coffee #new #fire #musttry",
  "We have completed the migration of our roasting profile documentation to the new internal system.",
  "why does the grinder always jam on mondays 😭",
  "Our spring lot arrives Monday. We cupped every bag twice before saying yes to it. #coffee",
  "Sale!! 20% off EVERYTHING this weekend only!! Don't miss out!! 🛍️🛍️🛍️ #sale #deal #shopnow",
  "A short note on extraction yield: we now target 21% for the house espresso, up from 19.5%.",
];

const BRIEF = "announce the spring lot arriving next week";
const K = 3;

// --- run ------------------------------------------------------------------

const report = (label, corpus) => {
  const recency = drift(byRecency(corpus, K), corpus);
  const lexical = drift(byLexicalRelevance(corpus, K, BRIEF), corpus);
  const ceiling = bestPossible(corpus, K);
  const coverage = drift(byVoiceCoverage(corpus, K), corpus);
  const worst = (() => {
    let w = 0;
    const combos = (arr, size, start = 0, acc = []) => {
      if (acc.length === size) {
        w = Math.max(w, drift(acc, corpus));
        return;
      }
      for (let i = start; i < arr.length; i += 1) combos(arr, size, i + 1, [...acc, arr[i]]);
    };
    combos(corpus, K);
    return w;
  })();

  console.log(`\n${label} (n=${corpus.length}, k=${K})`);
  console.log(`  recency (ships today)   drift ${recency.toFixed(3)}`);
  console.log(`  lexical relevance       drift ${lexical.toFixed(3)}`);
  console.log(`  voice coverage (cheap)  drift ${coverage.toFixed(3)}`);
  console.log(`  best possible K         drift ${ceiling.d.toFixed(3)}   <- no method can beat this`);
  console.log(`  worst possible K        drift ${worst.toFixed(3)}`);
  console.log(
    `  headroom for ANY selection method: ${(recency - ceiling.d).toFixed(3)} ` +
      `(${worst === ceiling.d ? "n/a" : `${(((recency - ceiling.d) / (worst - ceiling.d)) * 100).toFixed(0)}% of the range`})`,
  );
};

console.log("Spike #279 — does exemplar choice change the voice shown to the model?");
console.log("Lower drift = the chosen examples write more like the corpus as a whole.");
report("Homogeneous voice", HOMOGENEOUS);
report("Heterogeneous voice", HETEROGENEOUS);
console.log("\nSee docs/spikes/279-exemplar-selection.md for what follows from these numbers.");
