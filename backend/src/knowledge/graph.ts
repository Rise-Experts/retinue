/**
 * The knowledge graph — REQ-064 (#270), task #271.
 *
 * Retrieval finds the chunks that *look like* the question. That cannot answer "which teams depend on the retry
 * budget?", because no chunk says so: the fact is spread across a dozen documents, each naming one team and one
 * dependency. This module builds the structure that does — entities, the relationships between them, and where
 * each came from.
 *
 * Nothing here retrieves anything. #273 and #274 do that; this produces the graph and, just as importantly,
 * proves it costs nothing when nobody asked for it.
 *
 * ## Three properties everything else rests on
 *
 * **Off costs nothing.** The extractor is optional in the dependencies and gated twice more at run time. A
 * deployment that never enables GraphRAG supplies no extractor, makes no model calls, and writes no graph rows
 * — measured by a test that counts calls rather than by reading this paragraph.
 *
 * **Determinism.** The same corpus produces byte-identical graphs twice. This is not tidiness: #275 measures
 * GraphRAG against a fixed baseline, and a graph that shifts between runs cannot be measured, cannot be
 * debugged, and cannot have its incremental rebuild (#272) verified. Every ordering here is explicit, and
 * entity resolution is rule-based rather than similarity-based for exactly this reason — embedding similarity
 * is not stable across model versions.
 *
 * **Provenance.** Every entity and edge records its chunks. The retriever will present graph-derived material
 * as citable, so an untraceable claim is one the model states as though a document said it.
 *
 * ## What extraction is allowed to do to us
 *
 * Extraction is a model call, so it can return prose, malformed JSON, entities with no names, or an edge
 * between two things it never mentioned. **None of that may corrupt the graph or fail the index.** A chunk
 * whose extraction is unusable simply contributes nothing — it stays embedded and findable by every existing
 * mode, and the graph is the only thing missing. `sanitiseExtraction` is where that judgement lives, and it is
 * deliberately strict: an edge naming an entity that was not extracted is dropped rather than repaired,
 * because repairing it would invent a provenance nobody asserted.
 */

import type { TenantId } from "../core/ids.js";
import type {
  GraphContribution,
  GraphStore,
  KnowledgeEntity,
  KnowledgeRelationship,
  KnowledgeSourceType,
} from "../persistence/index.js";

/**
 * What an extractor returns for one chunk, before validation.
 *
 * Loose on purpose — it is the output of a language model, and typing it strictly here would only mean casting
 * somewhere less visible. `sanitiseExtraction` is the boundary where it becomes trustworthy.
 */
export type RawExtraction = {
  readonly entities?: readonly {
    readonly name?: unknown;
    readonly type?: unknown;
    readonly description?: unknown;
  }[];
  readonly relationships?: readonly {
    readonly from?: unknown;
    readonly to?: unknown;
    readonly type?: unknown;
    readonly description?: unknown;
  }[];
};

export type ExtractionChunk = {
  readonly id: string;
  readonly content: string;
};

/**
 * Turns a chunk into entities and relationships.
 *
 * A port separate from `EmbeddingProvider`, not a widening of it. Embedding is cheap, deterministic and
 * batchable; extraction is none of those. Keeping them apart is what lets a deployment with GraphRAG off supply
 * an embedder and nothing else — if this were one port, every deployment would have to configure a language
 * model to index a document.
 *
 * `usage` is optional and reported when the provider gives it, because AC-9 needs the bill to be visible before
 * it arrives rather than reconstructed from an invoice.
 */
export interface EntityExtractor {
  readonly id: string;
  extract(chunk: ExtractionChunk): Promise<{
    readonly extraction: RawExtraction;
    readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  }>;
}

/** Words dropped from the front of a name during normalisation. Articles only — see `normaliseName`. */
const LEADING_ARTICLES = ["the", "a", "an"] as const;

/**
 * A name reduced to what makes two spellings the same thing.
 *
 * Case, whitespace, separators and a leading article. That gets "the retry budget", "Retry Budget" and
 * "retry-budget" to one entity, which is the merge AC-4 names.
 *
 * **What it deliberately does not do** is anything cleverer. Stemming would merge "billing" with "bill";
 * embedding similarity would merge whatever the model of the week thinks is close and would stop being
 * reproducible the moment that model changed. Both would make the graph unmeasurable, and the second would
 * make it undebuggable too.
 *
 * Parenthetical qualifiers survive as words, so "Ana (engineering)" and "Ana (sales)" stay distinct — which
 * AC-4 asks for, and which a punctuation-stripping rule gets right only by accident. It is worth being explicit
 * that this is *why* punctuation becomes a space rather than nothing.
 */
export const normaliseName = (raw: string): string => {
  const collapsed = raw
    .normalize("NFKD")
    // Diacritics dropped so "Zurich" and "Zürich" meet. Same reasoning as case.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // A separator becomes a space, never nothing: joining "retry" and "budget" into "retrybudget" would fail to
    // match the spaced form, and dropping "(engineering)" entirely would merge two different people.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const words = collapsed.split(" ").filter((word) => word !== "");
  // Only when something follows it: "The" alone is a name, however unlikely, and stripping it leaves nothing.
  if (words.length > 1 && LEADING_ARTICLES.includes(words[0] as (typeof LEADING_ARTICLES)[number])) {
    return words.slice(1).join(" ");
  }
  return words.join(" ");
};

/** An entity type, normalised the same way but without the article rule — a type is one word in practice. */
export const normaliseType = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "unknown";

/**
 * The identity of an entity: its type and its normalised name.
 *
 * Readable rather than hashed, deliberately. `concept:retry budget` in a log, an error message or a database
 * row tells whoever is reading it what went wrong; `sha256:9f2a…` tells them to go and write a script. The id
 * is not a secret and its length is not a problem at this scale.
 *
 * Type participates because a person and a project can share a name and are not the same thing.
 */
export const entityId = (type: string, name: string): string => `${normaliseType(type)}:${normaliseName(name)}`;

/** The identity of an edge. Direction is part of it: "A depends on B" is not "B depends on A". */
export const relationshipId = (fromId: string, type: string, toId: string): string =>
  `${fromId}|${normaliseType(type)}|${toId}`;

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * How long a description may be before it is a chunk rather than a description.
 *
 * A model asked for a short description sometimes returns the paragraph. Truncating rather than refusing keeps
 * the entity — the name and the edges are the valuable part — and stops one verbose extraction from dominating
 * the storage of a whole corpus.
 */
export const MAX_DESCRIPTION_CHARS = 480;

const clamp = (text: string): string =>
  text.length <= MAX_DESCRIPTION_CHARS ? text : `${text.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;

/**
 * One chunk's raw extraction, turned into rows that can be trusted — or into nothing.
 *
 * Total: any input produces a valid contribution, possibly empty. That is what makes AC-7 hold everywhere at
 * once rather than at each call site.
 *
 * The strict part is edges. An extractor routinely names an endpoint it did not extract — a pronoun it
 * resolved, a thing it inferred — and the tempting fix is to create the missing entity. That invents an entity
 * with a provenance nobody asserted, which is the exact failure provenance exists to prevent. So the edge is
 * dropped, and the chunk keeps whatever else it gave us.
 */
export const sanitiseExtraction = (chunkId: string, raw: RawExtraction): GraphContribution => {
  const entities = new Map<string, { name: string; type: string; description?: string }>();
  for (const candidate of Array.isArray(raw.entities) ? raw.entities : []) {
    const name = asText(candidate?.name);
    const type = asText(candidate?.type) || "concept";
    if (name === "" || normaliseName(name) === "") continue;
    const id = entityId(type, name);
    const description = clamp(asText(candidate?.description));
    const existing = entities.get(id);
    if (existing === undefined) {
      entities.set(id, { name, type, ...(description === "" ? {} : { description }) });
      continue;
    }
    // The same entity named twice in one chunk: keep the longer description, and the name that sorts first so
    // the choice does not depend on extraction order.
    const better = description.length > (existing.description ?? "").length ? description : existing.description;
    entities.set(id, {
      name: existing.name < name ? existing.name : name,
      type: existing.type,
      ...(better === undefined || better === "" ? {} : { description: better }),
    });
  }

  const relationships = new Map<string, { fromId: string; toId: string; type: string; description?: string }>();
  for (const candidate of Array.isArray(raw.relationships) ? raw.relationships : []) {
    const from = asText(candidate?.from);
    const to = asText(candidate?.to);
    const type = asText(candidate?.type) || "related-to";
    if (from === "" || to === "") continue;
    // Endpoints are matched by *normalised name across any type*, because an extractor names an entity in a
    // relationship without repeating its type and a type-qualified lookup would then miss every edge.
    const fromId = [...entities.keys()].find((id) => id.slice(id.indexOf(":") + 1) === normaliseName(from));
    const toId = [...entities.keys()].find((id) => id.slice(id.indexOf(":") + 1) === normaliseName(to));
    if (fromId === undefined || toId === undefined) continue; // See the note above: dropped, never invented.
    if (fromId === toId) continue; // A self-edge carries no information and clutters every traversal.
    const description = clamp(asText(candidate?.description));
    const id = relationshipId(fromId, type, toId);
    const existing = relationships.get(id);
    if (existing === undefined) {
      relationships.set(id, { fromId, toId, type, ...(description === "" ? {} : { description }) });
    } else if (description.length > (existing.description ?? "").length) {
      relationships.set(id, { ...existing, description });
    }
  }

  return {
    entities: [...entities.entries()]
      .map(([id, entity]) => ({
        id,
        name: entity.name,
        type: normaliseType(entity.type),
        ...(entity.description === undefined ? {} : { description: entity.description }),
        surfaceForms: [entity.name],
        provenance: [chunkId],
      }))
      // Sorted here, not by the caller: determinism is a property of this function's output, so it cannot be
      // forgotten at one of several call sites.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    relationships: [...relationships.entries()]
      .map(([id, edge]) => ({
        id,
        fromId: edge.fromId,
        toId: edge.toId,
        type: normaliseType(edge.type),
        ...(edge.description === undefined ? {} : { description: edge.description }),
        weight: 1,
        provenance: [chunkId],
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
};

const uniqueSorted = (values: Iterable<string>): readonly string[] => [...new Set(values)].sort();

/**
 * Many chunks' contributions, merged into one source's contribution.
 *
 * Where surface forms accumulate and edge weights are counted. The canonical `name` is the one that sorts
 * first among everything merged — an arbitrary rule, chosen because it is *stable*: "first seen" would depend
 * on chunk order, and chunk order is a thing that can change without the document changing.
 */
export const mergeContributions = (parts: readonly GraphContribution[]): GraphContribution => {
  const entities = new Map<string, KnowledgeEntity>();
  for (const part of parts) {
    for (const entity of part.entities) {
      const existing = entities.get(entity.id);
      if (existing === undefined) {
        entities.set(entity.id, entity);
        continue;
      }
      const description =
        (entity.description ?? "").length > (existing.description ?? "").length ? entity.description : existing.description;
      entities.set(entity.id, {
        id: entity.id,
        name: existing.name < entity.name ? existing.name : entity.name,
        type: existing.type,
        ...(description === undefined ? {} : { description }),
        surfaceForms: uniqueSorted([...existing.surfaceForms, ...entity.surfaceForms]),
        provenance: uniqueSorted([...existing.provenance, ...entity.provenance]),
      });
    }
  }

  const relationships = new Map<string, KnowledgeRelationship>();
  for (const part of parts) {
    for (const edge of part.relationships) {
      const existing = relationships.get(edge.id);
      if (existing === undefined) {
        relationships.set(edge.id, edge);
        continue;
      }
      const description =
        (edge.description ?? "").length > (existing.description ?? "").length ? edge.description : existing.description;
      const provenance = uniqueSorted([...existing.provenance, ...edge.provenance]);
      relationships.set(edge.id, {
        ...existing,
        ...(description === undefined ? {} : { description }),
        // Chunks that asserted it, not times it was seen — so re-reading one chunk cannot inflate a weight.
        weight: provenance.length,
        provenance,
      });
    }
  }

  // An edge whose endpoints did not survive the merge is dropped, for the same reason `sanitiseExtraction`
  // drops one: the alternative is an edge pointing at nothing.
  const kept = [...relationships.values()].filter((edge) => entities.has(edge.fromId) && entities.has(edge.toId));

  return {
    entities: [...entities.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    relationships: kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
};

/** What indexing a source into the graph cost and produced — AC-9. */
export type GraphIndexResult = {
  /** `false` when GraphRAG is off for the tenant or the source is not flagged. Nothing was called. */
  readonly ran: boolean;
  readonly entities: number;
  readonly relationships: number;
  readonly pruned: number;
  /** Model calls made. The number an operator needs before enabling this on a large corpus. */
  readonly extractionCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Chunks whose extraction was unusable. Nonzero is a signal about the extractor, not a failure. */
  readonly unusableChunks: number;
  readonly elapsedMs: number;
};

export type GraphIndexerDeps = {
  readonly store: GraphStore;
  readonly extractor: EntityExtractor;
  readonly now?: () => number;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

/**
 * Extraction runs one chunk at a time by default.
 *
 * Sequential rather than parallel because the cost is the point: a corpus of 603 chunks is 603 model calls, and
 * firing them concurrently is how a re-index becomes a rate-limit incident. A deployment that wants throughput
 * raises this deliberately, having read the number.
 */
export const DEFAULT_EXTRACTION_CONCURRENCY = 1;

export const createGraphIndexer = (deps: GraphIndexerDeps) => {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  return {
    extractorId: deps.extractor.id,

    /**
     * Whether this source would be graph-indexed — both switches, in the cheap order.
     *
     * The tenant switch first, so a deployment with GraphRAG off does one settings read and stops, rather than
     * one read per source. AC-2's "flag is inert while the tenant switch is off" is this ordering: the source
     * flag is never even consulted, and it stays stored for the day the tenant switch flips.
     */
    async shouldIndex(
      context: { readonly tenantId: TenantId },
      source: { readonly sourceType: KnowledgeSourceType; readonly sourceId: string },
    ): Promise<boolean> {
      const settings = await deps.store.getSettings({ tenantId: context.tenantId });
      if (!settings.enabled) return false;
      return deps.store.isSourceEnabled({ tenantId: context.tenantId, ...source });
    },

    /**
     * Extract one source's chunks into the graph, replacing whatever that source contributed before.
     *
     * The caller has already decided this should run — `indexSource` calls `shouldIndex` first — so this does
     * not re-check. Keeping the decision in one place is what makes "off costs nothing" a property of one
     * function rather than a convention two functions share.
     */
    async indexSource(
      context: { readonly tenantId: TenantId },
      input: {
        readonly sourceType: KnowledgeSourceType;
        readonly sourceId: string;
        readonly chunks: readonly ExtractionChunk[];
        readonly concurrency?: number;
      },
    ): Promise<GraphIndexResult> {
      const started = now();
      const concurrency = Math.max(1, input.concurrency ?? DEFAULT_EXTRACTION_CONCURRENCY);
      const parts: GraphContribution[] = [];
      let extractionCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let unusableChunks = 0;

      const runOne = async (chunk: ExtractionChunk): Promise<GraphContribution> => {
        extractionCalls += 1;
        try {
          const { extraction, usage } = await deps.extractor.extract(chunk);
          inputTokens += usage?.inputTokens ?? 0;
          outputTokens += usage?.outputTokens ?? 0;
          const contribution = sanitiseExtraction(chunk.id, extraction ?? {});
          if (contribution.entities.length === 0) unusableChunks += 1;
          return contribution;
        } catch (error) {
          /**
           * AC-7. A model call can fail or return prose, and neither may fail the index.
           *
           * Swallowed here rather than propagated because the chunk is *already embedded and findable* — every
           * existing retrieval mode works on it, and the graph is the only thing missing. Failing the index
           * would take the working part down with the optional one.
           */
          unusableChunks += 1;
          log("graph extraction failed for a chunk", {
            chunkId: chunk.id,
            reason: error instanceof Error ? error.message : String(error),
          });
          return { entities: [], relationships: [] };
        }
      };

      for (let offset = 0; offset < input.chunks.length; offset += concurrency) {
        const window = input.chunks.slice(offset, offset + concurrency);
        // Order-independent by construction — `mergeContributions` sorts — but collected in order anyway, so a
        // log read alongside the corpus makes sense.
        parts.push(...(await Promise.all(window.map(runOne))));
      }

      const contribution = mergeContributions(parts);
      const written = await deps.store.replaceSourceGraph({
        tenantId: context.tenantId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        contribution,
      });

      const result: GraphIndexResult = {
        ran: true,
        entities: written.entities,
        relationships: written.relationships,
        pruned: written.pruned,
        extractionCalls,
        inputTokens,
        outputTokens,
        unusableChunks,
        elapsedMs: now() - started,
      };
      if (unusableChunks > 0)
        log("some chunks contributed nothing to the graph", {
          sourceId: input.sourceId,
          unusableChunks,
          of: input.chunks.length,
        });
      return result;
    },
  };
};

export type GraphIndexer = ReturnType<typeof createGraphIndexer>;

/** What `indexSource` reports when the graph was not touched. Every counter zero, and `ran` says why. */
export const GRAPH_NOT_RUN: GraphIndexResult = {
  ran: false,
  entities: 0,
  relationships: 0,
  pruned: 0,
  extractionCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  unusableChunks: 0,
  elapsedMs: 0,
};

/**
 * The default `EntityExtractor`: one model call per chunk — AC-2.
 *
 * Thin on purpose. The provider call lives in `models/extraction.ts` behind boundary rule R3, so this is the
 * adapter between that function and the port — which means a deployment can replace the extractor entirely
 * (a smaller model, a local one, a rules-based one for a known corpus) without touching the pipeline.
 *
 * `model` is a factory rather than a value because a `LanguageModel` is resolved from a policy per tenant, and
 * a single resolved model captured at construction would be the same one for every tenant in the deployment.
 */
export const createModelEntityExtractor = (deps: {
  readonly id?: string;
  readonly extract: (text: string) => Promise<{
    readonly extraction: RawExtraction;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }>;
}): EntityExtractor => ({
  id: deps.id ?? "model",
  async extract(chunk) {
    const { extraction, usage } = await deps.extract(chunk.content);
    return { extraction, usage };
  },
});
