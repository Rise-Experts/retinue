/**
 * pgvector `KnowledgeStore` and `VectorIndex` (#135).
 *
 * One table backs both ports, which is the point of splitting them: a deployment on pgvector answers both from
 * `knowledge_chunks`, and a deployment on a dedicated vector database answers them from two systems, with
 * nothing above changing.
 *
 * **AC-3 is a `WHERE` clause, and it is the reason this adapter exists rather than a filter above it.** The
 * permission predicate is in the same statement as the nearest-neighbour scan, so an unauthorised chunk is
 * never a candidate. Filtering afterwards leaks through result counts — ask for ten, get three, and you have
 * learned that seven exist you may not see. `EXPLAIN` shows the predicate inside the scan, which is what the
 * test asserts.
 *
 * **`replaceSource` is one transaction-shaped pair of statements.** Delete-then-insert, in that order, so a
 * changed document's old chunks are never searchable alongside its new ones. Appending would leave a stale
 * chunk that cites text no longer in the document.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type {
  EmbeddingModelRef,
  KeywordIndex,
  KeywordSearchHit,
  KnowledgeChunk,
  KnowledgeSourceType,
  KnowledgeStore,
  VectorIndex,
  VectorSearchHit,
} from "../../persistence/index.js";
import { stripStopwords } from "../../persistence/index.js";
import { VECTOR_DIMENSIONS } from "./migrations.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  id: string;
  source_type: string;
  source_id: string;
  chunk_index: number | string;
  content: string;
  token_count: number | string;
  auth_subject: string;
  embedding_model: string;
  embedding_version: string;
  embedding_dims: number | string;
  locator: string | null;
  created_at: string | Date;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

const toChunk = (r: Row): KnowledgeChunk => ({
  id: r.id,
  sourceType: r.source_type as KnowledgeSourceType,
  sourceId: r.source_id,
  chunkIndex: Number(r.chunk_index),
  content: r.content,
  tokenCount: Number(r.token_count),
  authSubject: r.auth_subject,
  embeddingModel: {
    modelId: r.embedding_model,
    version: r.embedding_version,
    dimensions: Number(r.embedding_dims),
  },
  ...(r.locator === null ? {} : { locator: r.locator }),
  createdAt: iso(r.created_at),
});

const COLUMNS = `id, source_type, source_id, chunk_index, content, token_count, auth_subject,
                 embedding_model, embedding_version, embedding_dims, locator, created_at`;

/**
 * pgvector's literal form: `[0.1,0.2,...]`.
 *
 * Built as a string rather than passed as an array, because node-postgres has no vector type and would send an
 * array as `{...}` — which pgvector rejects. `Number.isFinite` is checked because a `NaN` in a vector makes
 * every distance `NaN`, and the symptom is a search that returns nothing rather than an error.
 */
export const toVectorLiteral = (embedding: readonly number[]): string => {
  if (embedding.length !== VECTOR_DIMENSIONS)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `embedding has ${embedding.length} dimensions but the schema declares ${VECTOR_DIMENSIONS}`,
      retryable: false,
    });
  for (const value of embedding)
    if (!Number.isFinite(value))
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "embedding contains a non-finite value",
        retryable: false,
      });
  return `[${embedding.join(",")}]`;
};

export const createPostgresKnowledgeStore = (sql: SqlExecutor): KnowledgeStore => ({
  async replaceSource({ tenantId, sourceType, sourceId, chunks }) {
    for (const chunk of chunks) {
      if (chunk.embedding.length !== chunk.embeddingModel.dimensions)
        // Caught before the write: a vector of the wrong length would score against whatever prefix overlapped,
        // which looks like bad relevance rather than a bug.
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `chunk ${chunk.id} has ${chunk.embedding.length} dimensions but its model declares ${chunk.embeddingModel.dimensions}`,
          retryable: false,
        });
    }

    // Delete first. Old chunks must never be searchable next to new ones: a stale chunk cites text that is no
    // longer in the document, which is worse than the document being briefly absent.
    const removedRows = await sql.query<{ id: string }>(
      `DELETE FROM knowledge_chunks
        WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3
        RETURNING id`,
      [tenantId, sourceType, sourceId],
    );

    for (const chunk of chunks) {
      await sql.query(
        `INSERT INTO knowledge_chunks (tenant_id, id, source_type, source_id, chunk_index, content,
                                        token_count, auth_subject, embedding, embedding_model,
                                        embedding_version, embedding_dims, locator, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12,$13,$14)
         -- A re-run of the same batch overwrites its own rows rather than failing: an interrupted re-index is
         -- resumed by running it again, and that has to be safe (AC-5).
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           chunk_index = EXCLUDED.chunk_index,
           content = EXCLUDED.content,
           token_count = EXCLUDED.token_count,
           auth_subject = EXCLUDED.auth_subject,
           embedding = EXCLUDED.embedding,
           embedding_model = EXCLUDED.embedding_model,
           embedding_version = EXCLUDED.embedding_version,
           embedding_dims = EXCLUDED.embedding_dims,
           locator = EXCLUDED.locator`,
        [
          tenantId,
          chunk.id,
          sourceType,
          sourceId,
          chunk.chunkIndex,
          chunk.content,
          chunk.tokenCount,
          chunk.authSubject,
          toVectorLiteral(chunk.embedding),
          chunk.embeddingModel.modelId,
          chunk.embeddingModel.version,
          chunk.embeddingModel.dimensions,
          chunk.locator ?? null,
          chunk.createdAt,
        ],
      );
    }
    return { written: chunks.length, removed: removedRows.length };
  },

  async listBySource({ tenantId, sourceType, sourceId, limit, cursor }) {
    // Cursored on `chunk_index`, which is contiguous within a source and therefore exact -- and "the chunks of
    // this document" is an ordered thing, so the order must be the document's.
    const after = cursor === undefined ? -1 : Number.parseInt(cursor, 10);
    const from = Number.isSafeInteger(after) ? after : -1;
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM knowledge_chunks
        WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3 AND chunk_index > $4
        ORDER BY chunk_index
        LIMIT $5`,
      [tenantId, sourceType, sourceId, from, limit + 1],
    );
    const items = rows.slice(0, limit).map(toChunk);
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: String(last.chunkIndex) }
      : ({ items } satisfies Page<KnowledgeChunk>);
  },

  async get({ tenantId, id }) {
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM knowledge_chunks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    // A foreign id yields no row, so it is null without a comparison anyone could get wrong.
    return rows[0] === undefined ? null : toChunk(rows[0]);
  },

  async deleteSource({ tenantId, sourceType, sourceId }) {
    const rows = await sql.query<{ id: string }>(
      `DELETE FROM knowledge_chunks
        WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3
        RETURNING id`,
      [tenantId, sourceType, sourceId],
    );
    return { removed: rows.length };
  },

  async listStaleSources({ tenantId, current, limit, cursor }) {
    const rows = await sql.query<{ source_type: string; source_id: string; chunk_count: number | string }>(
      `SELECT source_type, source_id, COUNT(*) AS chunk_count
         FROM knowledge_chunks
        WHERE tenant_id = $1
          -- Anything not embedded by exactly this model. Derived from what is *stored*, which is what makes an
          -- interrupted re-index resumable: it asks again rather than remembering where it was.
          AND NOT (embedding_model = $2 AND embedding_version = $3 AND embedding_dims = $4)
          AND ($5::text IS NULL OR (source_type || ' ' || source_id) > $5::text)
        GROUP BY source_type, source_id
        -- Stable order, so a resumed re-index does not revisit sources it finished and skip ones it did not.
        ORDER BY source_type, source_id
        LIMIT $6`,
      [tenantId, current.modelId, current.version, current.dimensions, cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => ({
      sourceType: r.source_type as KnowledgeSourceType,
      sourceId: r.source_id,
      chunkCount: Number(r.chunk_count),
    }));
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: `${last.sourceType} ${last.sourceId}` }
      : { items };
  },
});

export const createPostgresVectorIndex = (sql: SqlExecutor): VectorIndex => ({
  async search({ tenantId, embedding, authSubjects, limit, minScore, sourceTypes }) {
    // An empty subject list means "no subjects", which correctly returns nothing. Short-circuited so the
    // database is not asked a question whose answer is already known -- and so `= ANY('{}')` semantics are
    // never relied on.
    if (authSubjects.length === 0) return [];
    const rows = await sql.query<Row & { score: number | string }>(
      `SELECT ${COLUMNS},
              -- Cosine *distance* is 0 (identical) to 2 (opposite); the ports normalise to a 0-1 score where
              -- higher is closer, so a caller never has to know the metric.
              1 - (embedding <=> $2::vector) / 2 AS score
         FROM knowledge_chunks
        WHERE tenant_id = $1
          -- AC-3: the permission predicate is in the same statement as the scan, so an unauthorised chunk is
          -- never a candidate. EXPLAIN shows it inside the scan, which is what the test asserts.
          AND auth_subject = ANY($3::text[])
          AND ($4::text[] IS NULL OR source_type = ANY($4::text[]))
          AND ($5::float8 IS NULL OR 1 - (embedding <=> $2::vector) / 2 >= $5::float8)
        ORDER BY embedding <=> $2::vector, id
        LIMIT $6`,
      [
        tenantId,
        toVectorLiteral(embedding),
        authSubjects,
        sourceTypes === undefined ? null : [...sourceTypes],
        minScore ?? null,
        limit,
      ],
    );
    return rows.map((r) => ({ chunk: toChunk(r), score: Number(r.score) }) satisfies VectorSearchHit);
  },
});

/** Re-exported so a caller comparing a stored chunk's model to the current one does it the same way. */
export const sameEmbeddingModel = (a: EmbeddingModelRef, b: EmbeddingModelRef): boolean =>
  a.modelId === b.modelId && a.version === b.version && a.dimensions === b.dimensions;

/**
 * Postgres full-text `KeywordIndex` (#136).
 *
 * Over `knowledge_chunks.content_tsv`, the same rows the vector index searches, so a chunk cannot be visible to
 * one signal and invisible to the other.
 *
 * **`websearch_to_tsquery`, not `to_tsquery`.** The latter throws on ordinary user input — an unbalanced quote,
 * a bare `&`, a trailing operator — and a search box that errors on a stray character is a search box that
 * errors. `websearch_to_tsquery` accepts anything and interprets quotes and `or` the way a person expects.
 *
 * **The score is normalised against the best hit in the result set**, not against an absolute. `ts_rank_cd`
 * has no upper bound and its scale depends on the corpus, so an absolute threshold would mean different things
 * in different tenants — and fusing an unbounded score with a bounded cosine similarity would let the
 * unbounded one dominate whenever it happened to be larger.
 */
export const createPostgresKeywordIndex = (sql: SqlExecutor): KeywordIndex => ({
  async search({ tenantId, query, authSubjects, limit, minScore, sourceTypes }) {
    // "No subjects" means nothing, not everything. Short-circuited so the database is never asked a question
    // whose answer is already known.
    if (authSubjects.length === 0) return [];
    // Stopwords come off the query, not the index. `simple` is chosen over `english` so identifiers survive
    // (`english` stems, which destroys `ERR-4021`), and the price of `simple` is that it keeps stopwords —
    // paid here rather than by matching every document that says "the".
    const terms = stripStopwords(query);
    if (terms === "") return [];

    const rows = await sql.query<Row & { rank: number | string }>(
      `WITH q AS (SELECT websearch_to_tsquery('simple', $2) AS tsq),
            scored AS (
              SELECT ${COLUMNS},
                     -- cd = cover density: it rewards query terms appearing close together, which is what
                     -- distinguishes a chunk *about* the terms from one that mentions them separately.
                     ts_rank_cd(content_tsv, q.tsq) AS rank
                FROM knowledge_chunks, q
               WHERE tenant_id = $1
                 -- AC-3, for the keyword signal too: the permission predicate is in the same statement as the
                 -- match, so an excluded chunk is never a candidate and never influences the ranking of the
                 -- ones that are.
                 AND auth_subject = ANY($3::text[])
                 AND ($4::text[] IS NULL OR source_type = ANY($4::text[]))
                 AND content_tsv @@ q.tsq
            )
       SELECT *, rank / NULLIF(MAX(rank) OVER (), 0) AS normalised
         FROM scored
        ORDER BY rank DESC, id
        LIMIT $5`,
      [tenantId, terms, authSubjects, sourceTypes === undefined ? null : [...sourceTypes], limit],
    );

    return rows
      .map((r) => {
        const normalised = (r as unknown as { normalised: number | string | null }).normalised;
        return {
          chunk: toChunk(r),
          // `NULLIF(...,0)` yields null when every rank is zero, which cannot happen for a matching row but is
          // cheaper to handle than to prove impossible.
          score: normalised === null ? 0 : Number(normalised),
        } satisfies KeywordSearchHit;
      })
      .filter((h) => minScore === undefined || h.score >= minScore);
  },
});
