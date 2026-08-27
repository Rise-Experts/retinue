/**
 * Hybrid retrieval (#136).
 *
 * Semantic search misses what it was never trained on — a product code, an error number, a campaign
 * identifier. An embedding of `ERR-4021` is an embedding of a string that looks like other strings. Keyword
 * search misses everything phrased differently from the document. Neither is sufficient, which is why docs/05
 * specifies both.
 *
 * **Fusion is reciprocal rank fusion, not weighted score addition**, and the reason is that the two scores are
 * not comparable. A cosine similarity is bounded and roughly linear in relevance; `ts_rank_cd` is unbounded and
 * corpus-dependent. Adding them with weights means choosing a constant that is wrong for some corpus, and the
 * failure is silent — one signal quietly dominates and the hybrid is the worse of the two. RRF uses only the
 * *rank*, so it needs no calibration and cannot be dominated:
 *
 *     score(d) = Σ over signals of 1 / (K + rank(d))
 *
 * A document ranked first by one signal and absent from the other still beats one ranked fifth by both, which
 * is the behaviour that makes hybrid better than either — the exact-term hit surfaces even though the semantic
 * signal never saw it.
 *
 * **`K = 60`** is the value from Cormack, Clarke and Buettcher's original TREC work and the one every
 * implementation since has used. It is large relative to the ranks that matter, which flattens the difference
 * between rank 1 and rank 2 and lets *agreement between signals* outweigh a single signal's confidence.
 *
 * **The empty answer is a distinct shape.** `RetrievalOutcome` is a union, so "found nothing" has no success
 * shape to hide in: a caller cannot accidentally treat an empty hit list as a weak answer, and the model is
 * told there is nothing rather than handed the least-bad match — which it would cite. AC-4 is a type here, not
 * a convention.
 */

import type { TenantId } from "../core/ids.js";
import { SEMANTIC_RELEVANCE_FLOOR } from "../persistence/index.js";
import type {
  KeywordIndex,
  KnowledgeChunk,
  KnowledgeSourceType,
  VectorIndex,
} from "../persistence/index.js";
import type { EmbeddingProvider } from "./index.js";

/** The rank-fusion constant. See the note above on why 60 and why rank rather than score. */
export const RRF_K = 60;

/** How many candidates each signal contributes before fusion. */
export const DEFAULT_CANDIDATES = 20;

/**
 * Below this fused score, relative to the best result, nothing is returned.
 *
 * The floor that makes AC-4 real. Without one, every query returns *something* — the least-bad match — and a
 * model handed the least-bad match cites it. 0.4 of the best score is loose enough not to discard a genuine
 * second-best answer and tight enough to reject a corpus that simply has nothing to say.
 */
export const DEFAULT_RELEVANCE_FLOOR = 0.4;

export type RetrievalMode = "semantic" | "keyword" | "hybrid";

/** What a citation needs, derived from a hit so there is one shape rather than each caller's own (AC-6). */
export type SourceReference = {
  readonly sourceType: KnowledgeSourceType;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly chunkId: string;
  /** The heading path, when the chunker found one. What makes a citation point at a place, not a document. */
  readonly locator?: string;
};

export type RetrievalHit = {
  readonly chunk: KnowledgeChunk;
  /** The fused score, 0–1 relative to the best hit. Not comparable across queries, only within one. */
  readonly score: number;
  /** Which signals found it, for explaining a result and for measuring the fusion. */
  readonly signals: readonly RetrievalMode[];
  readonly reference: SourceReference;
};

/**
 * Why retrieval returned nothing.
 *
 * Separate values because the assistant's sentence differs: "nothing in your documents mentions that" is a
 * different answer from "you have no indexed documents", and telling a user the first when the second is true
 * sends them looking for content they never uploaded.
 */
export const NO_RESULT_REASONS = ["nothing-indexed", "no-match", "below-threshold", "no-access"] as const;
export type NoResultReason = (typeof NO_RESULT_REASONS)[number];

export type RetrievalOutcome =
  | { readonly found: true; readonly hits: readonly RetrievalHit[]; readonly mode: RetrievalMode }
  | { readonly found: false; readonly reason: NoResultReason; readonly message: string; readonly mode: RetrievalMode };

/**
 * Reorders a fused candidate set — AC-5.
 *
 * A port, and **switchable**, because a reranker's value is a claim that has to be provable. A cross-encoder is
 * materially more expensive than the retrieval it reorders, so "we rerank" without a measured contribution is
 * a cost nobody justified. Absent means fusion order stands, which is the honest default.
 */
export interface Reranker {
  readonly id: string;
  rerank(input: {
    readonly query: string;
    readonly candidates: readonly RetrievalHit[];
    readonly limit: number;
  }): Promise<readonly RetrievalHit[]>;
}

export type RetrieverDeps = {
  readonly vector: VectorIndex;
  readonly keyword: KeywordIndex;
  readonly embeddings: EmbeddingProvider;
  readonly reranker?: Reranker;
  readonly candidates?: number;
  /** Relative: how much worse than the best hit is still worth returning. */
  readonly relevanceFloor?: number;
  /**
   * Absolute: how similar a vector hit must be to be a candidate at all.
   *
   * Two floors because they answer different questions, and one cannot do both — a *relative* floor can never
   * reject a uniformly poor result set, because something is always the best of it. This is what makes AC-4
   * possible: without it the vector index returns every chunk it is asked for (0.5 is orthogonal, not
   * "no match"), the best of them normalises to 1.0, and every query finds something.
   */
  readonly semanticFloor?: number;
};

export type RetrieveInput = {
  readonly query: string;
  /**
   * The subjects this caller may read.
   *
   * Required, and passed to *both* signals. A filter applied to one and not the other is a filter that does not
   * exist — the unfiltered signal would surface the chunk and fusion would rank it.
   */
  readonly authSubjects: readonly string[];
  readonly limit: number;
  readonly sourceTypes?: readonly KnowledgeSourceType[];
  /** Defaults to `hybrid`. The other two exist so the hybrid claim can be measured against them. */
  readonly mode?: RetrievalMode;
};

/**
 * Reciprocal rank fusion, extracted so there is exactly one of it — REQ-045 (#204), task #210, AC-2.
 *
 * `find_tools` fuses two signals over tool descriptors and this fuses two signals over knowledge chunks. Those
 * are the same algorithm with a different corpus, and writing it twice is the shape this repository keeps
 * finding defects in: the second copy drifts, usually in the tie-break or the normalisation, and the drift
 * shows up as one ranker being subtly worse with nothing pointing at why.
 *
 * Generic over the item and its key. The **key** is what merges an item found by both signals; without it a
 * chunk in both lists would fuse with itself and score twice.
 *
 * Scores come back normalised against the best fused score, because a raw RRF sum means nothing on its own —
 * `2/61` is not "poor", it is "found first by both signals". Normalising is what lets one relevance floor apply
 * to any corpus, tools included.
 */
export type FusedEntry<T, S extends string> = {
  readonly item: T;
  /** 0–1, relative to the best entry in this fusion. Comparable within one query, never across two. */
  readonly score: number;
  readonly signals: readonly S[];
};

export const fuseByRank = <T, S extends string>(input: {
  readonly lists: readonly { readonly signal: S; readonly items: readonly T[] }[];
  readonly keyOf: (item: T) => string;
  /** The rank-fusion constant. Defaults to `RRF_K`; a caller changing it should say why. */
  readonly k?: number;
}): readonly FusedEntry<T, S>[] => {
  const k = input.k ?? RRF_K;
  const fused = new Map<string, { item: T; key: string; score: number; signals: Set<S> }>();

  for (const list of input.lists) {
    list.items.forEach((item, rank) => {
      const key = input.keyOf(item);
      const increment = 1 / (k + rank + 1);
      const existing = fused.get(key);
      if (existing === undefined) fused.set(key, { item, key, score: increment, signals: new Set([list.signal]) });
      else {
        existing.score += increment;
        existing.signals.add(list.signal);
      }
    });
  }

  // Key order breaks ties, so two runs over the same corpus produce the same ranking. A `Map` iteration order
  // tie-break would depend on which signal happened to return first.
  const ordered = [...fused.values()].sort((a, b) => (b.score !== a.score ? b.score - a.score : a.key.localeCompare(b.key)));
  const best = ordered[0]?.score ?? 0;
  return ordered.map((entry) => ({
    item: entry.item,
    score: best === 0 ? 0 : entry.score / best,
    signals: [...entry.signals],
  }));
};

const referenceFor = (chunk: KnowledgeChunk): SourceReference => ({
  sourceType: chunk.sourceType,
  sourceId: chunk.sourceId,
  chunkIndex: chunk.chunkIndex,
  chunkId: chunk.id,
  ...(chunk.locator === undefined ? {} : { locator: chunk.locator }),
});

const NO_RESULT_MESSAGES: Readonly<Record<NoResultReason, string>> = {
  "nothing-indexed": "There is no indexed material to search yet.",
  "no-match": "Nothing in the available material matches that.",
  "below-threshold": "Nothing in the available material is a close enough match to rely on.",
  "no-access": "There is no material you have access to that matches that.",
};

export const createRetriever = (deps: RetrieverDeps) => {
  const candidateCount = deps.candidates ?? DEFAULT_CANDIDATES;
  const floor = deps.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR;
  const semanticFloor = deps.semanticFloor ?? SEMANTIC_RELEVANCE_FLOOR;

  return {
    rerankerId: deps.reranker?.id ?? null,

    async retrieve(
      context: { readonly tenantId: TenantId },
      input: RetrieveInput,
    ): Promise<RetrievalOutcome> {
      const mode = input.mode ?? "hybrid";
      // Checked before either index is asked. An empty subject list is not a query with no results — it is a
      // caller with no access, and the two want different sentences.
      if (input.authSubjects.length === 0)
        return { found: false, reason: "no-access", message: NO_RESULT_MESSAGES["no-access"], mode };
      if (input.query.trim() === "")
        return { found: false, reason: "no-match", message: NO_RESULT_MESSAGES["no-match"], mode };

      const scope = {
        tenantId: context.tenantId,
        authSubjects: input.authSubjects,
        limit: candidateCount,
        ...(input.sourceTypes === undefined ? {} : { sourceTypes: input.sourceTypes }),
      };

      const semantic =
        mode === "keyword"
          ? []
          : await (async () => {
              const [embedding] = await deps.embeddings.embed([input.query]);
              // The absolute floor goes to the index, not applied afterwards: a chunk that shares nothing with
              // the query must not be a candidate, because fusion would rank it first in a result set where
              // nothing is good.
              return deps.vector.search({ ...scope, embedding: embedding ?? [], minScore: semanticFloor });
            })();
      const lexical = mode === "semantic" ? [] : await deps.keyword.search({ ...scope, query: input.query });

      if (semantic.length === 0 && lexical.length === 0)
        return { found: false, reason: "no-match", message: NO_RESULT_MESSAGES["no-match"], mode };

      // RRF, through the shared implementation. Rank, not score: see the note at the top on why adding two
      // incomparable scales fails silently, and `fuseByRank` on why there is only one of these.
      const candidates: RetrievalHit[] = fuseByRank<{ chunk: KnowledgeChunk }, RetrievalMode>({
        lists: [
          { signal: "semantic", items: semantic },
          { signal: "keyword", items: lexical },
        ],
        keyOf: (hit) => hit.chunk.id,
      }).map((entry) => ({
        chunk: entry.item.chunk,
        score: entry.score,
        signals: entry.signals,
        reference: referenceFor(entry.item.chunk),
      }));

      const relevant = candidates.filter((hit) => hit.score >= floor);
      if (relevant.length === 0)
        // Something was found and none of it was good enough. A distinct reason from "no match", because the
        // useful answer differs: one says rephrase, the other says there is nothing there.
        return { found: false, reason: "below-threshold", message: NO_RESULT_MESSAGES["below-threshold"], mode };

      const hits =
        deps.reranker === undefined
          ? relevant.slice(0, input.limit)
          : await deps.reranker.rerank({ query: input.query, candidates: relevant, limit: input.limit });

      // A reranker that returned nothing is a reranker that broke; fusion order is a better answer than an
      // empty one, and a silent empty result here would look like AC-4 working.
      return hits.length === 0
        ? { found: true, hits: relevant.slice(0, input.limit), mode }
        : { found: true, hits: hits.slice(0, input.limit), mode };
    },
  };
};

export type Retriever = ReturnType<typeof createRetriever>;

/**
 * A reranker that promotes chunks matching the query's rare exact terms.
 *
 * Deliberately simple and deliberately *not* a model: this exists so AC-5's "switchable and measured" has
 * something real to switch on, and so the measurement harness has a baseline that is better than nothing and
 * obviously cheaper than a cross-encoder. It promotes a candidate containing a query term verbatim, which is
 * the signal fusion is weakest on — a rank-based fusion cannot know that one of the two signals matched an
 * exact identifier rather than a common word.
 */
export const createExactTermReranker = (): Reranker => ({
  id: "exact-term",
  async rerank({ query, candidates, limit }) {
    const terms = (query.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter(
      // Only terms that look like identifiers: containing a digit or a hyphen. A common word appearing
      // verbatim is not evidence of anything, and boosting on it would just re-rank by word frequency.
      (t) => /[0-9]/.test(t) || t.includes("-"),
    );
    if (terms.length === 0) return candidates.slice(0, limit);
    const boosted = candidates.map((hit) => {
      const content = hit.chunk.content.toLowerCase();
      const matched = terms.filter((t) => content.includes(t)).length;
      return { hit, matched };
    });
    return boosted
      .sort((a, b) =>
        b.matched !== a.matched
          ? b.matched - a.matched
          : // Fusion order within a tier, so reranking only ever *promotes* on evidence and never reshuffles
            // arbitrarily.
            b.hit.score - a.hit.score,
      )
      .map((b) => b.hit)
      .slice(0, limit);
  },
});
