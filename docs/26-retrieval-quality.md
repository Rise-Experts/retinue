# Retrieval Quality, Measured

Status: measured, 27 Aug 2026 · REQ-050 ([#209](https://github.com/Rise-Experts/retinue/issues/209)), task
[#219](https://github.com/Rise-Experts/retinue/issues/219)
Harness: `evals/retrieval-quality.mjs` · dataset: `evals/cases/retrieval.json` · raw output:
`evals/retrieval-quality.json`

There was no retrieval eval set. Every claim about retrieval in this repository rested on a unit test over a
nine-document corpus with a **hand-written stub embedder**, which measures the fusion arithmetic and nothing about
semantics. And one claim had never been tested at all: the reranker is a port *precisely* so its value could be
measured, and nothing had measured it.

**Two of the three headline results contradict what this repository believed.**

## The corpus and the dataset

56 documents — this repository's own specifications and documentation site — parsed by the platform's own
`parseMarkdown` and chunked by its own `chunkDocument`, giving 603 chunks and ~114,000 embedded tokens. So the
thing being scored is the pipeline a deployment actually runs, over long technical prose with headings, tables and
code rather than a benchmark set chosen to flatter a retriever.

18 queries, each judged by a **predicate**: a relevant hit is a chunk from a named document that contains a
required phrase. Judging by chunk id would break the dataset every time the chunker changed its boundaries —
exactly the change somebody would want to evaluate — and a predicate also states *why* a chunk is relevant in a
form a reader can check.

## Result

`text-embedding-3-small`, five arms, top 5:

| Arm | success@5 | Right document | P@1 | Recall | MRR | ms/query |
|---|---|---|---|---|---|---|
| keyword | 61.1% | 83.3% | 33.3% | 61.1% | 0.432 | 6 |
| **semantic** | **83.3%** | **94.4%** | 27.8% | **77.8%** | 0.493 | 188 |
| hybrid (the default) | 72.2% | 88.9% | 33.3% | 72.2% | 0.474 | 196 |
| hybrid + exact-term reranker | 66.7% | 83.3% | 33.3% | 66.7% | 0.446 | 182 |
| navigate (no vectors) | 66.7% | 77.8% | **44.4%** | 61.1% | **0.520** | 1,297 |

Re-run after [#220](https://github.com/Rise-Experts/retinue/issues/220) stopped YAML front matter reaching the
block stream as content — 18 fewer chunks, and no more chunk whose text is a `sidebar_position`. Every arm moved
by **at most one case** (keyword +1, semantic −1, navigate +1), which is the noise floor stated below arriving
as evidence rather than as a caveat.

**success@5** — a relevant hit anywhere in the top five — is the headline, because the model reads all five.
**Right document** ignores the phrase and asks only whether a hit came from a judged document; the gap between the
two columns is the difference between finding the right specification and finding the right paragraph, which is
what a citation cares about.

### 1. Hybrid is worse than semantic alone on this corpus

−11.1 points of success@5 and −5.6 of recall against the semantic arm. The platform's own comments have said for
months that hybrid "measurably beats" both parts; on a real corpus of technical prose it does not.

The mechanism is not mysterious. RRF fuses **ranks**, weighting both signals equally by construction. The lexical
signal is weaker here (61.1%), and fusing a weak list with a strong one demotes the strong list's top hits
wherever the weak one disagrees. Hybrid's advantage is supposed to appear on *identifier* queries — an error code,
a SKU, a campaign id — where an embedding of `ERR-4021` is an embedding of a string that looks like other strings.
**This dataset has no identifier queries**, because its questions are the ones a reader of these documents would
actually ask. So the finding is precise: hybrid does not help on natural-language questions over prose, and the
case for it rests on a query type this dataset does not contain.

### 2. The reranker's contribution is negative

AC-3 asked for a number, and the number has a minus sign: **−5.6 points of success@5, −5.6 of recall, −0.028 MRR,
and no latency saving.** `createExactTermReranker` promotes chunks containing query terms verbatim, which on prose
queries promotes chunks that happen to repeat a common word.

That does not mean reranking is a bad idea — a cross-encoder is a different mechanism and might well earn its
cost. It means **this** reranker, which exists so that "switchable and measured" had something to switch, is not
worth turning on. It is off by default and should stay off, and its port comment now says so with the number.

### 3. Retrieval without vectors ranks its first hit best, and finds less

`navigate` reads a table of contents, asks a model which documents are relevant, and then ranks chunks inside
them. It has the **best P@1 (44.4%) and the best MRR (0.509)** of any arm — when a model picks the document, its
first hit is more often the right passage — and the **worst-but-one recall**, because it reads at most three
documents.

The cost is the story: **1,538 ms and $0.0085 per query**, against 207 ms and effectively nothing per query after
indexing. That is 7× the latency and roughly 4,000× the marginal cost.

Two properties are genuinely attractive and neither is a score. It can say **"nothing here covers that"** — a
model that has read the table of contents and concluded the corpus is silent has told you something a cosine
distance cannot. And it needs **no index**: nothing to keep in sync, no re-embedding when a document changes, no
embedding bill.

## Recommendation

**Do nothing to the default, and add the eval to the release path.** Specifically:

1. **Keep `hybrid` as the default.** The 11.1-point gap is two cases out of eighteen, from a dataset with one
   author and no identifier queries — which is precisely the query type hybrid exists for. Changing a platform
   default on that evidence would be replacing a decision from the literature with a decision from a small
   dataset that happens to disagree with it. What the number *does* justify is a larger dataset with identifier
   queries in it, and a re-run before anyone defends hybrid again.
2. **Leave the exact-term reranker off**, and record the measurement where somebody reaching for it will read it.
   The port stays: measuring a cross-encoder is now a one-line change and there is a baseline to measure against.
3. **Do not ship `navigate`.** It is a spike and it answered its question. Revisit it for a corpus where "the
   right chapter" is the unit a reader wants and the query volume is low enough for $0.0085 each — a handbook, a
   policy set, a legal corpus. It stays behind `RetrievalMode` as one optional dependency; a deployment that has
   not wired a navigator gets a named refusal rather than a silent fall back to embeddings.
4. **Re-run this before every release that touches retrieval.** It costs about two cents of embeddings, and it is
   now the only thing standing between a plausible-looking change and a quiet regression.

## Chunking: the defaults hold — AC-6

AC-6 says to add per-collection chunking overrides *if the eval shows 400/800 is wrong for a corpus type*. It does
not, so they are not added. Same corpus, same semantic arm, three chunkings:

| Target / max tokens | Chunks | success@5 | Recall | MRR |
|---|---|---|---|---|
| 200 / 400 | 858 | 77.8% | 75.0% | 0.481 |
| **400 / 800 (default)** | **621** | **88.9%** | **83.3%** | 0.504 |
| 800 / 1600 | 572 | 88.9% | 83.3% | 0.513 |

*(Chunking arms were measured before the front-matter fix, on the 621-chunk corpus. The comparison between them
is unaffected — all three shared the same corpus — and re-running them would cost three more embedding passes to
move each row by at most a case.)*

Smaller chunks are clearly worse: 11 points of success@5, and the reason is visible in the corpus — a 200-token
chunk of technical prose often splits a claim from the sentence that qualifies it. Larger chunks are
indistinguishable from the default on this corpus, with a marginally better MRR and 8% fewer chunks to store.

So the default is right for *this* corpus type, and the knob would be a parameter nobody had a reason to set. The
finding to keep is that the direction of risk is asymmetric: **too small is expensive, too large is nearly free.**
A corpus where that reverses — short records, FAQ entries, log lines — is where the override earns its place, and
this table is the baseline to argue against when somebody has one.

## Honest limits of this measurement

**18 queries.** One case is 5.6 points. Only the largest gap — keyword versus semantic (22 points, four cases) —
is comfortably outside plausible noise; semantic versus hybrid is two cases, and the reranker's −5.6 is *exactly
one case*. The re-run above is the demonstration: a change to the *corpus* that touched no retrieval code moved
three of the five arms by one case each. It is reported as a
finding because it is a consistent direction across three metrics with no offsetting benefit, not because one case
is significant on its own.

**One author.** The queries were written by the person who wrote the retriever. Mitigated by judging on substance
and by the questions being ones a reader would ask, not eliminated. A second author would improve the dataset more
than any change to the harness.

**No identifier queries**, which is the gap that matters most for interpreting result 1 above.

**The dataset had a defect on its first run, and the audit is why the numbers above are different.** Seven of the
strict misses turned out to be hits from the *right document* whose chunk did not contain a phrase used once
elsewhere in it: the judgements named terms rather than answers. Fixing the phrases moved semantic's success@5 from
22.2% to 88.9% (83.3% after the front-matter fix). A harness reporting a bad number is a claim about the harness until somebody has read the misses —
which is the second time in this sprint that turned out to be true.

## Re-running it

```bash
node evals/retrieval-quality.mjs                          # every arm
node evals/retrieval-quality.mjs --arms semantic,hybrid   # the comparison that matters
node evals/retrieval-quality.mjs --misses                 # what each arm returned when it failed
node evals/retrieval-quality.mjs --chunk 800x1600         # a different chunking
node evals/retrieval-quality.mjs --offline                # a smoke run; writes no report, by design
```

Needs `RETINUE_MODEL_API_KEY`. The embeddings cost about two cents; the `navigate` arm costs about fifteen. It is
**not** in `ci:local`, for the same reason the tool-selection harness is not: a gate that spends money on every
run is a gate somebody switches off.
