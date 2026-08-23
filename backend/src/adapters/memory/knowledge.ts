/**
 * In-memory `KnowledgeStore` and `VectorIndex` — the reference implementations (#135).
 *
 * The vector search is an exact brute-force scan, which is the right choice for a reference adapter: pgvector's
 * HNSW index is *approximate*, so a conformance test asserting "the nearest chunk is returned first" would be
 * asserting something the production adapter is allowed to miss. Making the reference exact means the harness
 * tests the **contract** — tenant isolation, permission filtering, score ordering, the limit — and recall is
 * measured separately against a fixed query set, which is what AC-2 actually asks for.
 *
 * Two things it takes as seriously as the pgvector adapter:
 *
 * - **Permission filtering happens during the scan**, not after. Filtering afterwards would satisfy every
 *   assertion about the results and still leak through counts in production.
 * - **`replaceSource` is a replace.** Appending would leave a changed document's old chunks searchable, and a
 *   stale chunk is a citation pointing at text that is no longer there.
 */

import type { Page } from "../../core/context.js";
import { AgentPlatformError } from "../../core/errors.js";
import { EMBEDDING_DIMENSIONS, stripStopwords } from "../../persistence/index.js";
import type {
  EmbeddingModelRef,
  KeywordIndex,
  KeywordSearchHit,
  KnowledgeChunk,
  KnowledgeChunkWithEmbedding,
  KnowledgeSourceType,
  KnowledgeStore,
  VectorIndex,
  VectorSearchHit,
} from "../../persistence/index.js";

const tenantMap = <V>(outer: Map<string, Map<string, V>>, tenantId: string): Map<string, V> => {
  let inner = outer.get(tenantId);
  if (!inner) outer.set(tenantId, (inner = new Map<string, V>()));
  return inner;
};

const sourceKey = (sourceType: string, sourceId: string): string => `${sourceType} ${sourceId}`;

/**
 * Cosine similarity, mapped to 0–1.
 *
 * Cosine rather than raw dot product, because an embedding's magnitude carries no meaning for most providers
 * and an unnormalised dot product would rank a long chunk above a relevant one. Mapped from [-1,1] to [0,1] so
 * a caller's `minScore` means the same thing whatever metric an adapter uses underneath.
 */
export const cosineScore = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return (dot / (Math.sqrt(na) * Math.sqrt(nb)) + 1) / 2;
};

type Stored = KnowledgeChunkWithEmbedding;

/** Shared state, so the two ports can be backed by one table the way pgvector backs them. */
export const createMemoryKnowledgeBackend = () => {
  const byTenant = new Map<string, Map<string, Stored>>();

  const store: KnowledgeStore = {
    async replaceSource({ tenantId, sourceType, sourceId, chunks }) {
      const rows = tenantMap(byTenant, tenantId);
      const key = sourceKey(sourceType, sourceId);
      let removed = 0;
      for (const [id, chunk] of rows) {
        if (sourceKey(chunk.sourceType, chunk.sourceId) === key) {
          rows.delete(id);
          removed += 1;
        }
      }
      for (const chunk of chunks) {
        // Two checks, and they catch different mistakes: a vector whose length contradicts its own declared
        // dimensions is a caller bug, and a vector of a width this platform does not store is a *configuration*
        // one. The reference adapter enforces both so it is exactly as strict as pgvector -- it previously
        // accepted 768 while pgvector refused it, which is the laxness #129 named.
        if (chunk.embedding.length !== EMBEDDING_DIMENSIONS)
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `chunk ${chunk.id} has ${chunk.embedding.length} dimensions but this platform stores ${EMBEDDING_DIMENSIONS}`,
            retryable: false,
          });
        if (chunk.embedding.length !== chunk.embeddingModel.dimensions)
          // Caught here rather than at search time: a vector of the wrong length would silently score against
          // whatever prefix happened to overlap, which looks like bad relevance rather than a bug.
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `chunk ${chunk.id} has ${chunk.embedding.length} dimensions but its model declares ${chunk.embeddingModel.dimensions}`,
            retryable: false,
          });
        rows.set(chunk.id, { ...chunk, sourceType, sourceId });
      }
      return { written: chunks.length, removed };
    },

    async listBySource({ tenantId, sourceType, sourceId, limit, cursor }) {
      const key = sourceKey(sourceType, sourceId);
      const rows = [...tenantMap(byTenant, tenantId).values()]
        .filter((c) => sourceKey(c.sourceType, c.sourceId) === key)
        // By chunk index, because "the chunks of this document" is an ordered thing and reading around a hit
        // depends on that order being the document's.
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const after = cursor === undefined ? -1 : Number.parseInt(cursor, 10);
      const from = Number.isSafeInteger(after) ? after : -1;
      const items = rows.filter((c) => c.chunkIndex > from).slice(0, limit).map(withoutEmbedding);
      const last = items[items.length - 1];
      return last !== undefined && rows.some((c) => c.chunkIndex > last.chunkIndex)
        ? { items, nextCursor: String(last.chunkIndex) }
        : { items };
    },

    async get({ tenantId, id }) {
      // Absent from *this tenant's* map, so a foreign id is null without a comparison anyone could get wrong.
      const found = tenantMap(byTenant, tenantId).get(id);
      return found === undefined ? null : withoutEmbedding(found);
    },

    async deleteSource({ tenantId, sourceType, sourceId }) {
      const rows = tenantMap(byTenant, tenantId);
      const key = sourceKey(sourceType, sourceId);
      let removed = 0;
      for (const [id, chunk] of rows) {
        if (sourceKey(chunk.sourceType, chunk.sourceId) === key) {
          rows.delete(id);
          removed += 1;
        }
      }
      return { removed };
    },

    async listStaleSources({ tenantId, current, limit, cursor }) {
      const grouped = new Map<string, { sourceType: KnowledgeSourceType; sourceId: string; chunkCount: number }>();
      for (const chunk of tenantMap(byTenant, tenantId).values()) {
        if (sameModel(chunk.embeddingModel, current)) continue;
        const key = sourceKey(chunk.sourceType, chunk.sourceId);
        const entry = grouped.get(key);
        if (entry === undefined)
          grouped.set(key, { sourceType: chunk.sourceType, sourceId: chunk.sourceId, chunkCount: 1 });
        else entry.chunkCount += 1;
      }
      // Sorted so a resumed re-index sees a stable order; an unstable one would revisit sources it had done
      // and skip ones it had not.
      const sorted = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const from = cursor === undefined ? 0 : sorted.findIndex(([k]) => k > cursor);
      const start = from < 0 ? sorted.length : from;
      const items = sorted.slice(start, start + limit).map(([, v]) => v);
      const lastKey = sorted[start + items.length - 1]?.[0];
      return start + limit < sorted.length && lastKey !== undefined
        ? { items, nextCursor: lastKey }
        : ({ items } satisfies Page<{ sourceType: KnowledgeSourceType; sourceId: string; chunkCount: number }>);
    },
  };

  const index: VectorIndex = {
    async search({ tenantId, embedding, authSubjects, limit, minScore, sourceTypes }) {
      const allowed = new Set(authSubjects);
      const types = sourceTypes === undefined ? null : new Set(sourceTypes);
      const hits: VectorSearchHit[] = [];
      for (const chunk of tenantMap(byTenant, tenantId).values()) {
        // Filtered *during* the scan. Filtering the result set afterwards satisfies every assertion about the
        // results and still leaks through counts, which is the failure AC-3 names.
        if (!allowed.has(chunk.authSubject)) continue;
        if (types !== null && !types.has(chunk.sourceType)) continue;
        const score = cosineScore(embedding, chunk.embedding);
        if (minScore !== undefined && score < minScore) continue;
        hits.push({ chunk: withoutEmbedding(chunk), score });
      }
      // Ties broken by id, so two chunks with identical scores come back in a stable order — otherwise a
      // recall measurement moves between runs for reasons unrelated to relevance.
      return hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.chunk.id.localeCompare(b.chunk.id))).slice(0, limit);
    },
  };

  /**
   * BM25 over the same rows.
   *
   * A real ranking function rather than a substring match, because the whole point of #136 is that keyword and
   * semantic retrieval have *different* strengths — and a substring matcher has none. BM25 gives rarer terms
   * more weight and saturates on repetition, which is what makes `ERR-4021` beat a document that says
   * "error" forty times.
   *
   * `k1 = 1.2, b = 0.75` are the standard parameters and the same operating point Postgres's `ts_rank_cd`
   * approximates, so the reference adapter and the production one rank alike on the cases that matter.
   */
  const keyword: KeywordIndex = {
    async search({ tenantId, query, authSubjects, limit, minScore, sourceTypes }) {
      const allowed = new Set(authSubjects);
      const types = sourceTypes === undefined ? null : new Set(sourceTypes);
      // Filtered *before* scoring, so an excluded chunk never enters the corpus statistics either — otherwise
      // it would shift every other document's IDF and influence ranking without appearing.
      const corpus = [...tenantMap(byTenant, tenantId).values()].filter(
        (c) => allowed.has(c.authSubject) && (types === null || types.has(c.sourceType)),
      );
      if (corpus.length === 0) return [];

      // Stopwords come off the *query*, not the index: the index keeps everything so an exact identifier is
      // still findable, and the query drops the terms that carry no signal. See `KEYWORD_STOPWORDS`.
      const terms = tokenize(stripStopwords(query));
      if (terms.length === 0) return [];

      const docs = corpus.map((chunk) => ({ chunk, tokens: tokenize(chunk.content) }));
      const avgLength = docs.reduce((n, d) => n + d.tokens.length, 0) / docs.length;
      const documentFrequency = new Map<string, number>();
      for (const term of new Set(terms)) {
        documentFrequency.set(term, docs.filter((d) => d.tokens.includes(term)).length);
      }

      const K1 = 1.2;
      const B = 0.75;
      const raw = docs.map(({ chunk, tokens }) => {
        let score = 0;
        for (const term of new Set(terms)) {
          const tf = tokens.filter((t) => t === term).length;
          if (tf === 0) continue;
          const df = documentFrequency.get(term) ?? 0;
          // The +0.5/+0.5 smoothing is Robertson's; without it a term present in every document gets a
          // negative weight and a matching document scores *worse* than a non-matching one.
          const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
          const norm = tf * (K1 + 1);
          const denom = tf + K1 * (1 - B + (B * tokens.length) / (avgLength || 1));
          score += idf * (norm / denom);
        }
        return { chunk, score };
      });

      const best = Math.max(...raw.map((r) => r.score), 0);
      // Normalised against the best hit in this result set, so `minScore` means "relative to the best match
      // here" for both signals. An absolute BM25 threshold would be meaningless: the scale depends on the
      // corpus.
      const hits: KeywordSearchHit[] = raw
        .filter((r) => r.score > 0)
        .map((r) => ({ chunk: withoutEmbedding(r.chunk), score: best === 0 ? 0 : r.score / best }))
        .filter((h) => minScore === undefined || h.score >= minScore);

      return hits
        // Ties broken by id, so two equally-matching chunks come back in a stable order and a measured figure
        // does not move between runs.
        .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.chunk.id.localeCompare(b.chunk.id)))
        .slice(0, limit);
    },
  };

  return { store, index, keyword };
};

/**
 * Tokens for BM25.
 *
 * Lowercased, split on non-alphanumerics, and **`-` is kept inside a token** — `ERR-4021` and `Q3-2026` are
 * single terms, and splitting them is how an exact-code query stops matching the document containing that
 * exact code. That is the one case keyword retrieval exists for.
 */
export const tokenize = (text: string): readonly string[] =>
  (text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter((t) => t.length > 1 || /[0-9]/.test(t));

const sameModel = (a: EmbeddingModelRef, b: EmbeddingModelRef): boolean =>
  a.modelId === b.modelId && a.version === b.version && a.dimensions === b.dimensions;

/** Read paths never return the vector: nothing above this layer needs it, and it is by far the largest field. */
const withoutEmbedding = (chunk: Stored): KnowledgeChunk => {
  const { embedding, ...rest } = chunk;
  void embedding;
  return rest;
};

export const createMemoryKnowledgeStore = (): KnowledgeStore => createMemoryKnowledgeBackend().store;
export const createMemoryVectorIndex = (): VectorIndex => createMemoryKnowledgeBackend().index;
export const createMemoryKeywordIndex = (): KeywordIndex => createMemoryKnowledgeBackend().keyword;
