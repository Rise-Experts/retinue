/**
 * The embedding pipeline (#135).
 *
 * Chunk, embed in batches, write. What makes it worth a module rather than a loop is the three properties the
 * ACs are actually about:
 *
 * - **Every chunk records the model that embedded it** (AC-1). Not a global "current model" setting: a setting
 *   cannot tell you which rows are stale, which makes incremental re-indexing impossible.
 * - **Re-indexing is derived from what is stored** (AC-5). `listStaleSources` asks the database which sources
 *   were embedded by something other than the current model, so an interrupted re-index resumes by asking
 *   again rather than by remembering where it was. There is no cursor to lose.
 * - **Freshness is a stated target, measured** (AC-4). `FRESHNESS_TARGET_MS` is the number, `indexSource`
 *   reports how long it took, and the test asserts the report against the target rather than against a hope.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { TenantId } from "../core/ids.js";
import type { DocumentBlock } from "../documents/index.js";
import type {
  EmbeddingModelRef,
  KnowledgeChunkWithEmbedding,
  KnowledgeSourceType,
  KnowledgeStore,
} from "../persistence/index.js";
import { DEFAULT_CHUNKING_LIMITS, chunkDocument, type ChunkingLimits } from "./chunking.js";

/**
 * How long newly added material may take to become findable — AC-4.
 *
 * Sixty seconds, and the number is a *commitment* rather than an observation: indexing runs on the worker tier,
 * so the delay is queue latency plus embedding time, and a target far below queue latency would be a promise
 * the architecture cannot keep. A user who attaches a document and asks about it immediately is the case this
 * bounds, and a minute is what "shortly" honestly means for a document that has to be read, chunked and
 * embedded.
 */
export const FRESHNESS_TARGET_MS = 60_000;

/** Chunks per embedding call. Providers cap batch size; 64 is comfortably inside every one of them. */
export const DEFAULT_EMBEDDING_BATCH = 64;

/**
 * Turns text into vectors.
 *
 * A port, because the provider differs and because a test needs a deterministic one. `model` is on the provider
 * rather than passed per call: a provider that could be asked for a different model per call would let two
 * chunks of one document be embedded differently, and nothing downstream could tell.
 */
export interface EmbeddingProvider {
  readonly model: EmbeddingModelRef;
  /** One vector per input, in order. A provider returning a different count is a bug worth catching loudly. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export type IndexSourceInput = {
  readonly sourceType: KnowledgeSourceType;
  readonly sourceId: string;
  readonly blocks: readonly DocumentBlock[];
  /**
   * Who may retrieve this source's chunks.
   *
   * Required. An optional subject would default to something, and the something would either be too narrow
   * (nothing retrievable) or too wide (everything retrievable by everyone) — and the second failure is silent.
   */
  readonly authSubject: string;
};

export type IndexResult = {
  readonly written: number;
  readonly removed: number;
  readonly batches: number;
  /** Wall-clock, so the freshness target can be measured rather than assumed. */
  readonly elapsedMs: number;
  readonly model: EmbeddingModelRef;
};

export type EmbeddingPipelineDeps = {
  readonly knowledge: KnowledgeStore;
  readonly embeddings: EmbeddingProvider;
  readonly chunking?: ChunkingLimits;
  readonly batchSize?: number;
  readonly clock?: () => string;
  /** Injectable so a test measures elapsed time without waiting for it. */
  readonly now?: () => number;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

/** Deterministic chunk id, so re-indexing the same source overwrites its own rows rather than duplicating. */
export const chunkId = (sourceType: string, sourceId: string, index: number): string =>
  `${sourceType}:${sourceId}:${index}`;

export const createEmbeddingPipeline = (deps: EmbeddingPipelineDeps) => {
  const limits = deps.chunking ?? DEFAULT_CHUNKING_LIMITS;
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_EMBEDDING_BATCH);
  const clock = deps.clock ?? (() => new Date().toISOString());
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  return {
    model: deps.embeddings.model,
    freshnessTargetMs: FRESHNESS_TARGET_MS,

    /**
     * Index one source, replacing whatever was there.
     *
     * Replace rather than append: a changed document's old chunks must stop being searchable, because a stale
     * chunk is a citation pointing at text that is no longer in the document.
     */
    async indexSource(
      context: { readonly tenantId: TenantId },
      input: IndexSourceInput,
    ): Promise<IndexResult> {
      const started = now();
      const chunks = chunkDocument(input.blocks, limits);
      if (chunks.length === 0) {
        // An empty document still removes its old chunks: extracting a document down to nothing is a reason for
        // its previous content to stop being findable, not a reason to leave it.
        const cleared = await deps.knowledge.deleteSource({
          tenantId: context.tenantId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        });
        return {
          written: 0,
          removed: cleared.removed,
          batches: 0,
          elapsedMs: now() - started,
          model: deps.embeddings.model,
        };
      }

      const embedded: KnowledgeChunkWithEmbedding[] = [];
      let batches = 0;
      for (let offset = 0; offset < chunks.length; offset += batchSize) {
        const batch = chunks.slice(offset, offset + batchSize);
        const vectors = await deps.embeddings.embed(batch.map((c) => c.content));
        batches += 1;
        // A provider returning a different count has silently misaligned every vector with the wrong chunk,
        // which is unrecoverable and undetectable later. Caught here, loudly.
        if (vectors.length !== batch.length)
          throw new AgentPlatformError({
            code: "provider_unavailable",
            message: `the embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`,
            retryable: true,
          });
        batch.forEach((chunk, i) => {
          embedded.push({
            id: chunkId(input.sourceType, input.sourceId, chunk.index),
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            chunkIndex: chunk.index,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            authSubject: input.authSubject,
            embeddingModel: deps.embeddings.model,
            ...(chunk.locator === undefined ? {} : { locator: chunk.locator }),
            createdAt: clock(),
            embedding: vectors[i] ?? [],
          });
        });
      }

      const written = await deps.knowledge.replaceSource({
        tenantId: context.tenantId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        chunks: embedded,
      });
      const elapsedMs = now() - started;
      if (elapsedMs > FRESHNESS_TARGET_MS)
        // Reported rather than thrown: the material *is* indexed, and the useful action is to know the target
        // was missed rather than to fail a job that succeeded.
        log("indexing exceeded the freshness target", {
          sourceId: input.sourceId,
          elapsedMs,
          targetMs: FRESHNESS_TARGET_MS,
        });
      return { ...written, batches, elapsedMs, model: deps.embeddings.model };
    },

    /**
     * One page of a re-index — AC-5.
     *
     * Deliberately not a loop over everything. A caller runs this repeatedly and stops when `remaining` is
     * zero, which means an interruption at any point loses at most one page's work and no bookkeeping: the
     * next call re-derives the work list from what is stored. There is no cursor to persist and therefore no
     * cursor to lose.
     *
     * `reload` fetches a source's current blocks. It is the caller's, because where a source's content lives
     * differs by type — an attachment's is an extracted document, an artifact's is its content — and this
     * module has no business knowing all of them.
     */
    async reindexBatch(
      context: { readonly tenantId: TenantId },
      input: {
        readonly limit: number;
        readonly reload: (source: {
          readonly sourceType: KnowledgeSourceType;
          readonly sourceId: string;
        }) => Promise<{ readonly blocks: readonly DocumentBlock[]; readonly authSubject: string } | null>;
      },
    ): Promise<{
      readonly reindexed: number;
      readonly skipped: number;
      readonly remaining: number;
    }> {
      const stale = await deps.knowledge.listStaleSources({
        tenantId: context.tenantId,
        current: deps.embeddings.model,
        limit: input.limit,
      });

      let reindexed = 0;
      let skipped = 0;
      for (const source of stale.items) {
        const reloaded = await input.reload(source);
        if (reloaded === null) {
          // The source is gone. Its chunks go with it rather than staying stale forever, which would make the
          // work list never drain and the re-index never finish.
          await deps.knowledge.deleteSource({
            tenantId: context.tenantId,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
          });
          skipped += 1;
          continue;
        }
        await this.indexSource(context, {
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          blocks: reloaded.blocks,
          authSubject: reloaded.authSubject,
        });
        reindexed += 1;
      }

      // Asked again rather than computed, because sources may have been added or removed while this page ran —
      // and a stale "remaining" is how a loop stops early or never stops.
      const after = await deps.knowledge.listStaleSources({
        tenantId: context.tenantId,
        current: deps.embeddings.model,
        limit: 1,
      });
      return { reindexed, skipped, remaining: after.items.length };
    },
  };
};

export type EmbeddingPipeline = ReturnType<typeof createEmbeddingPipeline>;

export * from "./chunking.js";
export * from "./retrieval.js";
