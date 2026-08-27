/**
 * Retrieval without vectors — REQ-050 (#209), task #219, AC-4.
 *
 * A **spike**, and the deliverable is a decision with numbers rather than a subsystem. See
 * `docs/26-retrieval-quality.md` for what it scored.
 *
 * ## The idea being tested
 *
 * Embedding-based retrieval matches a query against fragments of text and hopes the fragments it surfaces are the
 * ones that answer it. A person looking something up in a manual does something else entirely: they read the
 * table of contents, decide which chapter is relevant, and then read it. That needs no index, no embedding cost
 * and no re-indexing when a document changes — and its citations name a *document* somebody chose rather than a
 * fragment a cosine distance surfaced.
 *
 * The cost is a model call per query, and latency measured in seconds rather than milliseconds.
 *
 * ## Two things this prototype found immediately
 *
 * **`KnowledgeStore` cannot enumerate its sources.** There is `listBySource`, `get`, `deleteSource` and
 * `staleSources`, and no way to ask "what documents are in here". That is correct for a vector-based design —
 * nothing needed it — and it is exactly what a navigating retriever needs first. So the outline arrives through
 * a port the *host* supplies (`OutlineCatalogue`), which is honest but means this mode is not a drop-in for a
 * deployment that already has hybrid retrieval working.
 *
 * **It does fit behind `RetrievalMode`**, which the issue asked to test. `createRetriever` gains one optional
 * dependency and a fourth mode; every caller — `search_knowledge` included — is unchanged, and a deployment that
 * has not wired a navigator gets a named refusal rather than a silent fall back to semantic search. If it had
 * *not* fit, that would have been the finding; it fits.
 */

import type { ExecutionContext } from "../core/context.js";
import type { KnowledgeChunk, KnowledgeStore } from "../persistence/index.js";
import type { RetrievalHit, RetrievalOutcome, SourceReference } from "./retrieval.js";

/** What a chooser sees of one document: enough to decide, and not the document itself. */
export type SourceOutline = {
  readonly sourceType: KnowledgeChunk["sourceType"];
  readonly sourceId: string;
  readonly title: string;
  /** The heading trail, in document order. This is the table of contents a person would read. */
  readonly headings: readonly string[];
};

/**
 * Where the outline comes from.
 *
 * A port because the store cannot answer it (see the note above). A host that keeps documents in its own tables —
 * which most do, since `KnowledgeStore` holds *chunks* — already has this list.
 */
export interface OutlineCatalogue {
  list(context: { readonly tenantId: ExecutionContext["tenantId"]; readonly authSubjects: readonly string[] }): Promise<
    readonly SourceOutline[]
  >;
}

/**
 * Whatever decides which documents to read. A model, in practice.
 *
 * A port rather than a model call, for the reason every model call in this package is a port: the platform must
 * not acquire a provider, and a test must be able to pin the choice.
 */
export interface DocumentChooser {
  readonly id: string;
  choose(input: {
    readonly query: string;
    readonly catalogue: readonly SourceOutline[];
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export type NavigatorDeps = {
  readonly store: KnowledgeStore;
  readonly catalogue: OutlineCatalogue;
  readonly chooser: DocumentChooser;
  /** Documents the chooser may pick. More than a handful and the model is guessing rather than choosing. */
  readonly maxSources?: number;
  /** Chunks read per chosen document. A whole 200-page document would not fit the caller's context. */
  readonly maxChunksPerSource?: number;
};

export const DEFAULT_MAX_SOURCES = 3;
export const DEFAULT_MAX_CHUNKS_PER_SOURCE = 40;

export interface Navigator {
  readonly id: string;
  navigate(
    context: { readonly tenantId: ExecutionContext["tenantId"] },
    input: { readonly query: string; readonly authSubjects: readonly string[]; readonly limit: number },
  ): Promise<RetrievalOutcome>;
}

const reference = (chunk: KnowledgeChunk): SourceReference => ({
  sourceType: chunk.sourceType,
  sourceId: chunk.sourceId,
  chunkIndex: chunk.chunkIndex,
  chunkId: chunk.id,
  ...(chunk.locator === undefined ? {} : { locator: chunk.locator }),
});

/**
 * Query terms, for ordering chunks *within* the documents the chooser picked.
 *
 * Six lines of tokenisation rather than a second ranker: there is no fusion here and no relevance floor, because
 * the relevance decision was already made — by a model, over titles and headings. What remains is "which part of
 * this chapter", and term overlap answers that well enough to measure. If the eval had shown this mode worth
 * shipping, this is the first thing to replace.
 */
const terms = (text: string): readonly string[] => [
  ...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)),
];

export const createNavigator = (deps: NavigatorDeps): Navigator => {
  const maxSources = deps.maxSources ?? DEFAULT_MAX_SOURCES;
  const maxChunks = deps.maxChunksPerSource ?? DEFAULT_MAX_CHUNKS_PER_SOURCE;

  return {
    id: `navigate:${deps.chooser.id}`,

    async navigate(context, input) {
      if (input.authSubjects.length === 0)
        return { found: false, reason: "no-access", message: "There is no material you have access to.", mode: "navigate" };

      const catalogue = await deps.catalogue.list({ tenantId: context.tenantId, authSubjects: input.authSubjects });
      if (catalogue.length === 0)
        return { found: false, reason: "nothing-indexed", message: "There is no indexed material to search yet.", mode: "navigate" };

      const chosen = await deps.chooser.choose({ query: input.query, catalogue, limit: maxSources });
      /**
       * An empty choice is a real answer, and a distinct one.
       *
       * A model that has read the table of contents and concluded nothing there is relevant has told you
       * something a cosine distance cannot: `no-match` rather than the least-bad chapter. This is the mode's most
       * attractive property and the reason it is worth measuring at all.
       */
      if (chosen.length === 0)
        return { found: false, reason: "no-match", message: "Nothing in the available material covers that.", mode: "navigate" };

      const known = new Map(catalogue.map((outline) => [outline.sourceId, outline]));
      const wanted = input.query.toLowerCase();
      const queryTerms = terms(input.query);
      const hits: RetrievalHit[] = [];

      for (const sourceId of chosen.slice(0, maxSources)) {
        const outline = known.get(sourceId);
        // A chooser naming a document that is not in the catalogue it was given is a chooser that hallucinated
        // one. Skipped rather than fetched: fetching would be a model choosing which document to read.
        if (outline === undefined) continue;
        const page = await deps.store.listBySource({
          tenantId: context.tenantId,
          sourceType: outline.sourceType,
          sourceId,
          limit: maxChunks,
        });
        for (const chunk of page.items) {
          const content = chunk.content.toLowerCase();
          const overlap = queryTerms.filter((term) => content.includes(term)).length;
          hits.push({
            chunk,
            // Not comparable with a fused score, and deliberately so: this number orders chunks inside a chosen
            // document and means nothing outside one.
            score: queryTerms.length === 0 ? 0 : overlap / queryTerms.length + (content.includes(wanted) ? 1 : 0),
            signals: ["navigate"],
            reference: reference(chunk),
          });
        }
      }

      if (hits.length === 0)
        return { found: false, reason: "no-match", message: "The chosen documents had no readable content.", mode: "navigate" };

      const ordered = [...hits].sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.reference.chunkId.localeCompare(b.reference.chunkId),
      );
      return { found: true, hits: ordered.slice(0, input.limit), mode: "navigate" };
    },
  };
};
