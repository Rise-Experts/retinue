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
import { EMBEDDING_DIMENSIONS } from "../../persistence/index.js";
import type {
  EmbeddingModelRef,
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

  return { store, index };
};

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
