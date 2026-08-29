/**
 * `graph-local` — entity-centric retrieval. REQ-064 (#270), task #273.
 *
 * The mode that answers *"which teams depend on the retry budget?"* — a question whose answer exists in no
 * single chunk. Semantic search finds chunks that look like the question; this finds the chunks that are
 * *connected to what the question is about*.
 *
 * Four steps, and the interesting decisions are in the first and the last:
 *
 * 1. **Resolve** the entities the question names.
 * 2. **Traverse** their neighbourhood, bounded.
 * 3. **Gather** the chunks those entities and edges came from.
 * 4. **Filter and rank**, returning ordinary `RetrievalHit`s.
 *
 * ## Why the query is swept for n-grams rather than read by a model
 *
 * The obvious way to find the entities in a question is to ask a model. It costs a call per query, it is not
 * reproducible across model versions, and #275 has to measure this against a fixed baseline.
 *
 * So instead every 1-to-4 word window of the question is normalised and looked up, and **the graph itself is
 * the filter** — a window that is not an entity simply matches nothing. That is deterministic, free, and uses
 * exactly the normalisation the index used, which is what makes AC-3 hold by construction rather than by two
 * functions agreeing.
 *
 * It will miss an entity the question refers to obliquely ("the budget thing"). That is a real limit, it is
 * measurable, and #275 is where it gets measured.
 *
 * ## Why there is no fallback to semantic search
 *
 * When nothing resolves, this returns an honest empty result. Falling back would mean a caller attributing
 * semantic results to `graph-local` — which is precisely why `not-configured` exists as its own reason rather
 * than as `no-match`, and the same reasoning applies one level down.
 */

import type { TenantId } from "../core/ids.js";
import type {
  GraphStore,
  KnowledgeChunk,
  KnowledgeRelationship,
  KnowledgeSourceType,
  KnowledgeStore,
} from "../persistence/index.js";
import { normaliseName } from "./graph.js";

/**
 * How far a traversal goes by default.
 *
 * One hop is often too few — "which teams depend on the retry budget" is one hop, but "what does the retry
 * budget affect downstream" is two. Three is a large fraction of a connected graph, and the cost is not the
 * traversal but the chunks it drags in. Two is the useful middle, and it is a parameter because the right
 * answer is corpus-shaped.
 */
export const DEFAULT_GRAPH_DEPTH = 2;

/** Edges considered per hop. A hub entity can have hundreds; taking all of them buries the specific ones. */
export const DEFAULT_NEIGHBOUR_LIMIT = 50;

/** The longest phrase treated as a possible entity name. Four words covers "the retry budget policy". */
export const MAX_ENTITY_NGRAM = 4;

/**
 * Words never worth looking up on their own.
 *
 * Not a linguistic stopword list — a *lookup* filter. Its only job is to stop the sweep asking the store about
 * "the" and "which" fifty times per query. A word here can still appear *inside* a longer n-gram, so "the
 * retry budget" resolves even though "the" does not.
 */
const SKIP_ALONE = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "by", "with", "and", "or", "is", "are", "was", "were",
  "be", "been", "do", "does", "did", "which", "what", "who", "whom", "whose", "when", "where", "why", "how",
  "that", "this", "these", "those", "it", "its", "we", "our", "you", "your", "they", "their", "from", "as",
]);

/**
 * Every phrase in the query that could name an entity, normalised and deduplicated.
 *
 * Longest first, which matters for ranking rather than correctness: "retry budget policy" is a more specific
 * match than "retry budget", and a caller that stops early should see the specific one.
 *
 * Exported for its own test — this is the function that decides whether a real question finds anything, and
 * its failure mode is silent (an empty result that looks like an empty corpus).
 */
export const entityCandidates = (query: string): readonly string[] => {
  const words = normaliseName(query).split(" ").filter((word) => word !== "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (let size = Math.min(MAX_ENTITY_NGRAM, words.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const phrase = words.slice(start, start + size).join(" ");
      if (size === 1 && SKIP_ALONE.has(phrase)) continue;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
};

/** A chunk reached through the graph, with the reason it was reached. */
export type GraphChunkHit = {
  readonly chunk: KnowledgeChunk;
  /** 0–1 relative to the best hit in this result, as every other mode's score is. */
  readonly score: number;
  /** The entities that led here, so the answer can say *why* this chunk is relevant. */
  readonly viaEntities: readonly string[];
};

export type GraphLocalResult = {
  readonly hits: readonly GraphChunkHit[];
  /** The entities the question resolved to. Empty means nothing matched — an honest empty result. */
  readonly matchedEntities: readonly string[];
  /**
   * The edges traversed, with their provenance — AC-6.
   *
   * Returned rather than folded into the chunks because "Team A depends on the retry budget" is a fact stored
   * on an *edge*, and a model handed two adjacent chunks would have to infer the connection. Handing it the
   * relationship lets it state one.
   */
  readonly relationships: readonly KnowledgeRelationship[];
  /** True when the traversal hit a bound. Reported, never silent — the same rule pagination follows. */
  readonly truncated: boolean;
};

export type GraphLocalSearchDeps = {
  readonly graph: GraphStore;
  readonly knowledge: KnowledgeStore;
  readonly depth?: number;
  readonly neighbourLimit?: number;
};

export interface GraphLocalSearch {
  search(
    context: { readonly tenantId: TenantId },
    input: {
      readonly query: string;
      readonly authSubjects: readonly string[];
      readonly limit: number;
      readonly sourceTypes?: readonly KnowledgeSourceType[];
    },
  ): Promise<GraphLocalResult>;
}

export const createGraphLocalSearch = (deps: GraphLocalSearchDeps): GraphLocalSearch => {
  const maxDepth = Math.max(1, deps.depth ?? DEFAULT_GRAPH_DEPTH);
  const neighbourLimit = Math.max(1, deps.neighbourLimit ?? DEFAULT_NEIGHBOUR_LIMIT);

  return {
    async search(context, input) {
      const empty: GraphLocalResult = { hits: [], matchedEntities: [], relationships: [], truncated: false };
      if (input.authSubjects.length === 0) return empty;

      const candidates = entityCandidates(input.query);
      if (candidates.length === 0) return empty;

      const matched = await deps.graph.resolveEntities({
        tenantId: context.tenantId,
        normalisedNames: candidates,
      });
      // No fallback. See the header: semantic results wearing this mode's label is the failure to avoid.
      if (matched.length === 0) return empty;

      /**
       * Breadth-first, bounded on both axes.
       *
       * `truncated` is set when a hop returned exactly its limit, which is the honest signal: the store
       * returned as much as it was allowed to, so there may be more. Inferring truncation from a short page
       * would be wrong in the other direction.
       */
      const seedIds = matched.map((entity) => entity.id);
      const reached = new Set<string>(seedIds);
      const edges = new Map<string, KnowledgeRelationship>();
      let frontier = seedIds;
      let truncated = false;

      for (let hop = 0; hop < maxDepth && frontier.length > 0; hop += 1) {
        const found = await deps.graph.neighbours({
          tenantId: context.tenantId,
          entityIds: frontier,
          limit: neighbourLimit,
        });
        if (found.length >= neighbourLimit) truncated = true;
        const next: string[] = [];
        for (const edge of found) {
          edges.set(edge.id, edge);
          for (const id of [edge.fromId, edge.toId]) {
            if (reached.has(id)) continue;
            reached.add(id);
            next.push(id);
          }
        }
        // Sorted so a traversal is reproducible: `neighbours` is ordered, but the set of *new* ids depends on
        // what was already reached, and an unsorted frontier makes the next hop's `limit` cut differently.
        frontier = next.sort();
      }

      /**
       * Chunks, and **which entities led to each** — the scoring signal.
       *
       * A chunk named by three of the question's entities is more relevant than one named by a single
       * neighbour two hops out, and that is knowable without embeddings. Seeds count for more than entities
       * discovered by traversal, because the question actually mentioned them.
       */
      const SEED_WEIGHT = 3;
      const chunkScores = new Map<string, { score: number; via: Set<string> }>();
      const credit = (chunkId: string, entityName: string, weight: number): void => {
        const existing = chunkScores.get(chunkId);
        if (existing === undefined) chunkScores.set(chunkId, { score: weight, via: new Set([entityName]) });
        else {
          existing.score += weight;
          existing.via.add(entityName);
        }
      };

      const seedIdSet = new Set(seedIds);
      const reachedEntities = await deps.graph.getEntities({ tenantId: context.tenantId, ids: [...reached].sort() });
      for (const entity of reachedEntities) {
        const weight = seedIdSet.has(entity.id) ? SEED_WEIGHT : 1;
        for (const chunkId of entity.provenance) credit(chunkId, entity.name, weight);
      }
      for (const edge of edges.values()) {
        // An edge's own provenance is where the *relationship* was stated, which is usually the chunk that
        // answers a "how are these connected" question — so it is credited too.
        for (const chunkId of edge.provenance) credit(chunkId, `${edge.fromId} → ${edge.toId}`, 1);
      }

      const wantedTypes = input.sourceTypes === undefined ? null : new Set(input.sourceTypes);
      const allowed = new Set(input.authSubjects);
      const gathered: { chunk: KnowledgeChunk; score: number; via: readonly string[] }[] = [];
      // Sorted before fetching, so the chunks fetched under a cap are the same ones every run.
      const ranked = [...chunkScores.entries()].sort(
        (a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      );
      for (const [chunkId, scored] of ranked) {
        const chunk = await deps.knowledge.get({ tenantId: context.tenantId, id: chunkId });
        if (chunk === null) continue;
        /**
         * **AC-8, and the whole reason this loop does not trust the graph.**
         *
         * `KnowledgeStore.get` returns a chunk by id with no permission filter — it is a primary-key read, and
         * the vector index is where filtering normally lives. A graph traversal can arrive at a chunk from an
         * entity mentioned by a document the principal *can* read, so without this check an edge becomes a way
         * to reach text they cannot. That is the most plausible way a graph leaks, and it is one line.
         */
        if (!allowed.has(chunk.authSubject)) continue;
        if (wantedTypes !== null && !wantedTypes.has(chunk.sourceType)) continue;
        gathered.push({ chunk, score: scored.score, via: [...scored.via].sort() });
        if (gathered.length >= input.limit) {
          if (ranked.length > gathered.length) truncated = true;
          break;
        }
      }

      if (gathered.length === 0) return { ...empty, matchedEntities: matched.map((entity) => entity.name) };

      // Normalised against the best, so the score means the same thing it does in every other mode.
      const best = gathered[0]?.score ?? 1;
      return {
        hits: gathered.map((entry) => ({
          chunk: entry.chunk,
          score: best === 0 ? 0 : entry.score / best,
          viaEntities: entry.via,
        })),
        matchedEntities: matched.map((entity) => entity.name),
        // Only the edges whose endpoints were both reached, sorted so the output is stable.
        relationships: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        truncated,
      };
    },
  };
};
