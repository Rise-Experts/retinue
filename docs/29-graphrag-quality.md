# GraphRAG Quality, Measured

Status: measured, 29 Aug 2026 · REQ-064 ([#270](https://github.com/Rise-Experts/retinue/issues/270)), task
[#275](https://github.com/Rise-Experts/retinue/issues/275)
Harness: `evals/retrieval-quality.mjs` · dataset: `evals/cases/retrieval.json` · raw output:
`evals/retrieval-quality.json`

GraphRAG was built because two questions exist that top-k retrieval cannot answer: ones whose answer is spread
across documents, and ones about the corpus as a whole. `docs/26` exists because this repository has been wrong
about retrieval twice, so the mode shipped opt-in and with a measurement attached.

**The measurement says do not turn it on.** On this corpus GraphRAG loses to plain semantic search on every
query class it was built for, and `graph-global` cannot run at all within a sane cost ceiling.

## The result

Same corpus and same harness as `docs/26`: this repository's own documentation, parsed by the platform's
`parseMarkdown` and chunked by its `chunkDocument`. 71 documents, 768 chunks, ~157,000 embedded tokens.
24 queries in three classes.

| arm | success@5 | right document | P@1 | recall | MRR | ms/query |
|---|---|---|---|---|---|---|
| keyword | 58.3% | 75.0% | 25.0% | 49.3% | 0.365 | 7 |
| **semantic** | **75.0%** | **87.5%** | **37.5%** | **66.7%** | **0.528** | 281 |
| hybrid | 62.5% | 83.3% | 33.3% | 60.4% | 0.446 | 327 |
| graph-local | 20.8% | 45.8% | 0.0% | 14.6% | 0.071 | 2 |
| graph-global | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 3 |

By class, which is the comparison that matters — the eighteen original queries are the regression check, and
the six new ones are what GraphRAG exists for:

| arm | chunk (n=18) | multi-hop (n=3) | corpus-level (n=3) |
|---|---|---|---|
| semantic | **77.8%** | **100%** | **33.3%** coverage |
| hybrid | 66.7% | 66.7% | 33.3% coverage |
| graph-local | 11.1% | 66.7% | 16.7% coverage |
| graph-global | 0% | 0% | 0% coverage |

`corpus-level` is graded by **document coverage**, not success@5 — see *How corpus-level questions are graded*.

**Semantic wins every class, including the two written specifically for GraphRAG.** That is the headline and it
is not close.

## Cost

Stated beside quality rather than under it, because a mode that loses *and* costs money is a different
decision from one that merely loses.

| | |
|---|---|
| Extraction | 768 calls — one per chunk |
| Community summaries | 539 calls, at the coarsest level only |
| Tokens | 445,099 in + 388,443 out |
| Money | **≈ $0.30** on `gpt-4o-mini` |
| Wall clock | **1,599 s** (~27 minutes) |
| Communities | 3,368 across 5 levels |

For comparison, the semantic arm's entire index costs about two cents of embeddings and runs in under a minute.

`graph-global` additionally costs one model call per community **per query**. See below for why that is fatal.

## 1. `graph-global` could not run: 539 communities at the coarsest level

The mode refused all 24 queries:

```
A corpus-wide answer at level 4 would read 539 community summaries, and the ceiling is 200 model calls.
```

That is the ceiling working exactly as designed — refusing before spending rather than reporting a third of
the corpus as a whole-corpus answer. But the number behind it is the finding.

**Louvain does not aggregate this graph.** Two levels — the runtime default — left 741 communities at the
coarsest. Raising it to six levels produced five actual levels and still left **539**. Community detection is
supposed to turn a corpus into a handful of themes; here it produces roughly one community per one and a half
chunks.

The cause is graph sparsity. Extraction over technical documentation yields entities that mostly appear in a
single chunk and link to very few others, so each Louvain pass merges only a little and the hierarchy plateaus.
GraphRAG's global search assumes a graph with genuine community structure; a documentation corpus, where each
page is largely self-contained, does not have one.

At 539 communities, answering the 24 queries would have cost ~12,900 model calls. There is no ceiling setting
that makes that reasonable — the mode is not expensive here, it is inapplicable.

## 2. `graph-local` finds the right document twice as often as the right passage

20.8% success@5 against 45.8% document success. It reaches the right document about half the time and the
right *chunk* half as often again.

Reading the misses says why: **it ranks by graph connectivity, not by relevance to the question.**

```
rq-09 "how does a run survive the worker process being killed halfway through"
   wanted: docs/04-durable-runtime-and-hitl.md ~ "checkpoint"
   got:    docs/01-architecture.md, docs/04…, docs/04…, docs/05…, concepts/architecture.md
```

The right document is there twice and neither chunk is the one about checkpoints. An entity's provenance is
*every* chunk that mentioned it, and the scoring counts how many query entities touch a chunk — which does not
discriminate between two chunks of the same document.

`docs/01-architecture.md` and `concepts/architecture.md` appear in miss after miss. That is the signature of
**hub entities**: generic concepts like "run", "tool" and "platform" are extracted from nearly every chunk, link
to nearly everything, and drag the architecture overview into every traversal.

The one case where it is not close to the answer at all is instructive too:

```
rq-cl-01 "what are the main areas this documentation covers"
   got:    nothing
```

That question names no entity, so the n-gram sweep resolves nothing and the mode honestly returns empty. It is
the correct behaviour and it shows the limit: `graph-local` can only answer questions that name something.

**This is a fixable defect, not a verdict on GraphRAG.** Microsoft's local search ranks candidates by relevance;
ours does not. Using the graph for candidate *selection* and embeddings for *ranking* is the obvious next
version, and it is filed rather than done here — an unmeasured improvement written after reading a bad number
is how a harness gets tuned until it agrees. See
[#277](https://github.com/Rise-Experts/retinue/issues/277).

Note the one thing in its favour: **2 ms per query**, against semantic's 281 ms, because it is pure graph
traversal with no embedding call.

## 3. Multi-hop, the case GraphRAG was built for, still goes to semantic

Three queries whose answers are distributed across documents. Semantic got **100%**; `graph-local` got 66.7%.

Three queries is too few to conclude much, and it is stated as such. But the direction is the opposite of the
hypothesis, and the hypothesis was specific: these are the questions the graph was supposed to win.

One likely reason, visible in the corpus: this documentation *cross-references itself heavily*. A question
spanning two documents is often answerable from a chunk in one that mentions the other, which is exactly what
semantic similarity finds. A corpus of independent documents — incident reports, meeting notes, customer
records — would not have that property, and is where GraphRAG's case should be re-tested.

## How corpus-level questions are graded

`success@5` is meaningless for "what are the main areas this documentation covers": there is no single right
chunk. The grader is **document coverage** — of the documents a case names, how many did the answer reach —
computed from chunk provenance.

It is deterministic and needs no judge model. **Its limitation, stated plainly:** it measures whether the right
*areas* surfaced, not whether the summary of them is any good. A run could cover every expected document and
produce three useless sentences about each and score perfectly. Judging synthesis quality needs a model judge,
which costs a call per case and is not reproducible across model versions; worth adding when there is a reason
to trust one, and not worth pretending to now.

## Recommendation

**GraphRAG stays off by default, and this document is the reason.**

- Do not enable it for a documentation-shaped corpus. Semantic search is better on every class measured, costs
  two cents against thirty, and indexes in a minute against twenty-seven.
- `graph-global` should not be enabled at all until community detection produces a workable number of
  communities. Its ceiling correctly refuses, so the failure is safe rather than expensive — but a mode that
  always refuses is a mode nobody should switch on.
- `graph-local` has a **known, diagnosed defect** — connectivity ranking — and is worth re-measuring after
  [#277](https://github.com/Rise-Experts/retinue/issues/277). It should not be judged finally on this number.
- The corpus shape matters more than anything else here, and this measurement covers exactly one shape.

## Honest limits of this measurement

- **One corpus, and the wrong one for GraphRAG's case.** Self-referential technical documentation is close to
  the worst case for a knowledge graph: pages are self-contained and cross-linked, which is what semantic
  search is good at. GraphRAG's claimed strength is corpora of many small independent documents. This
  measurement does not test that and does not claim to.
- **Three multi-hop and three corpus-level queries.** Far too few to be conclusive. They were written by the
  person who wrote the retriever, which is `docs/26`'s weakness inherited.
- **The eighteen original queries were written for chunk retrieval.** They are the regression check, not a fair
  test of a graph.
- **`gpt-4o-mini` for extraction and summarisation.** A stronger model would extract a better graph. That would
  raise cost, which is already the losing side of the trade.
- **`graph-local` is measured with a known defect.** Its number is a floor, not a verdict.
- **`graph-global` produced no quality number at all.** Every query refused, so its row is a cost result, not a
  quality one.

## Two harness defects found while running this

Recorded because both would have produced a wrong number rather than an error, and the second cost real money.

**A `fetch` with no timeout hangs forever.** After ~750 of 768 extraction calls the process sat at 0% CPU with
no open sockets — a promise that never settled. Thirty-five minutes of a paid run were lost to one dropped
connection. Now bounded by `AbortSignal.timeout` with three attempts.

**Summarising every level costs several times what querying needs.** `graph-global` reads *one* level per
query, and the builder summarised all of them: 1,849 communities' worth of calls where 741 were wanted. The
builder gained a `summariseLevels` option, and the harness passes only the coarsest.

A third, found in the *unit* tests while wiring this up: `createMemoryVectorIndex()` takes no argument and
builds its own backend, so #273's test had been comparing against an empty index and "semantic finds fewer"
was passing vacuously. Fixed, and the claim narrowed — the details are on
[#273](https://github.com/Rise-Experts/retinue/issues/273).

## Re-running it

```bash
node evals/retrieval-quality.mjs --graph --graph-cache --arms semantic,hybrid,graph-local,graph-global
node evals/retrieval-quality.mjs --graph --graph-cache --arms graph-local --misses
```

`--graph-cache` reuses `evals/graphrag-graph-cache.json`; delete that file to rebuild the graph from scratch,
which is the twenty-seven minutes and thirty cents above. Without `--graph` the harness runs exactly as
`docs/26` describes and costs about two cents.

Needs `RETINUE_MODEL_API_KEY`. It is **not** in `ci:local`, for the same reason the other harnesses are not: a
gate that spends money on every run is a gate somebody switches off.
