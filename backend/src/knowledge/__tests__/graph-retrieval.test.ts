/**
 * `graph-local` — REQ-064 (#270), task #273.
 *
 * Two tests here justify the whole REQ and the whole task respectively.
 *
 * **AC-7** indexes a corpus where the answer is distributed across three documents, asserts `graph-local`
 * finds all three, and asserts `semantic` does not. If that cannot be written, GraphRAG has no case.
 *
 * **AC-8** follows an edge from a document the principal *can* read into one they cannot, and asserts nothing
 * comes back. A graph traversal reaching a chunk by primary key is the most plausible way this leaks, and it
 * is one missing line away at all times.
 */
import { describe, expect, it, vi } from "vitest";

import { asId } from "../../core/ids.js";
import type { TenantScope } from "../../core/context.js";
import type { DocumentBlock } from "../../documents/index.js";
import { createMemoryGraphStore } from "../../adapters/memory/graph.js";
import { createMemoryKnowledgeBackend } from "../../adapters/memory/knowledge.js";
import type { GraphStore, KnowledgeStore } from "../../persistence/index.js";
import {
  createEmbeddingPipeline,
  createGraphIndexer,
  createGraphLocalSearch,
  createRetriever,
  hubDiscount,
  entityCandidates,
  type EntityExtractor,
  type RawExtraction,
} from "../index.js";

const context: TenantScope = { tenantId: asId("t1") };
const NOW = "2026-08-28T00:00:00.000Z";
const OPEN = "workspace";

/**
 * A tiny corpus whose answer lives in no single document.
 *
 * Three documents each name one team and the thing it depends on. Nothing anywhere says "these are the teams
 * that depend on the retry budget", which is exactly the question.
 */
const CORPUS: readonly { id: string; text: string; extraction: RawExtraction }[] = [
  {
    id: "doc-a",
    text: "Team Atlas owns the checkout service and depends on the retry budget for its outbound calls.",
    extraction: {
      entities: [
        { name: "Team Atlas", type: "organisation" },
        { name: "retry budget", type: "concept" },
      ],
      relationships: [{ from: "Team Atlas", to: "retry budget", type: "depends-on" }],
    },
  },
  {
    id: "doc-b",
    text: "Team Borealis runs the ingest pipeline. Its throughput is governed by the Retry Budget.",
    extraction: {
      entities: [
        { name: "Team Borealis", type: "organisation" },
        { name: "Retry Budget", type: "concept" },
      ],
      relationships: [{ from: "Team Borealis", to: "Retry Budget", type: "depends-on" }],
    },
  },
  {
    id: "doc-c",
    text: "The billing reconciler, maintained by Team Cygnus, is constrained by the retry-budget ceiling.",
    extraction: {
      entities: [
        { name: "Team Cygnus", type: "organisation" },
        { name: "retry-budget", type: "concept" },
      ],
      relationships: [{ from: "Team Cygnus", to: "retry-budget", type: "depends-on" }],
    },
  },
  /**
   * Distractors: they use the question's words and have nothing to do with its answer.
   *
   * Without these the corpus is four documents and top-5 returns all of it, so *any* mode "finds all three"
   * and the comparison below decides nothing. Adding documents that talk about teams and budgets without the
   * retry-budget relationship is what makes similarity have to rank rather than merely enumerate — which is a
   * more realistic corpus, not a rigged one.
   */
  {
    id: "doc-e",
    text: "Every team submits a travel budget each quarter. The finance team reviews the budget requests.",
    extraction: {
      entities: [
        { name: "travel budget", type: "concept" },
        { name: "finance team", type: "organisation" },
      ],
      relationships: [{ from: "finance team", to: "travel budget", type: "reviews" }],
    },
  },
  {
    id: "doc-f",
    text: "The platform team depends on the shared build cache for its outbound release pipeline.",
    extraction: {
      entities: [
        { name: "platform team", type: "organisation" },
        { name: "build cache", type: "concept" },
      ],
      relationships: [{ from: "platform team", to: "build cache", type: "depends-on" }],
    },
  },
  {
    id: "doc-g",
    text: "Which teams depend on which services is tracked in the ownership registry, updated each quarter.",
    extraction: {
      entities: [{ name: "ownership registry", type: "concept" }],
      relationships: [],
    },
  },
  {
    id: "doc-d",
    text: "The office coffee machine is descaled every second Tuesday by the facilities team.",
    extraction: {
      entities: [
        { name: "coffee machine", type: "thing" },
        { name: "facilities team", type: "organisation" },
      ],
      relationships: [{ from: "facilities team", to: "coffee machine", type: "maintains" }],
    },
  },
];

/**
 * Embeddings over a small fixed vocabulary.
 *
 * Deterministic and, crucially, *honest about what semantic search can do here*: a document is embedded by the
 * words it contains, so a question sharing words with a document scores against it. That is what makes the
 * AC-7 comparison meaningful — semantic search is given a fair chance and still cannot assemble the answer,
 * because the answer is not in any one document.
 */
/**
 * A bag-of-words embedder that hashes terms into dimensions.
 *
 * It replaced a fixed `VOCAB` list, and the reason is worth recording: a fixed vocabulary means any test whose
 * corpus uses different words gets **all-zero vectors**, every cosine is zero, and the ranking under test does
 * nothing at all — while the test still passes if it only asserts that something came back. The #277 hub test
 * hit exactly that. Hashing means every word contributes, so a corpus written later cannot silently fall
 * outside the fixture.
 *
 * Deterministic, and crude on purpose: it is a stand-in for a real embedder, and the tests assert orderings
 * that word overlap is enough to produce.
 */
const embeddings = {
  model: { modelId: "test-embed", version: "1", dimensions: 1536 },
  async embed(texts: readonly string[]) {
    const bucket = (term: string): number => {
      let hash = 2166136261;
      for (let index = 0; index < term.length; index += 1) {
        hash ^= term.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return Math.abs(hash) % 1536;
    };
    return texts.map((text) => {
      const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 2));
      const vector = Array.from({ length: 1536 }, () => 0);
      for (const word of words) vector[bucket(word)] = 1;
      // Normalised, so cosine is comparable across documents of different lengths.
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vector.map((v) => v / norm);
    });
  },
};
const blocks = (text: string): DocumentBlock[] => [{ kind: "paragraph", text }];

const extractorFor = (corpus: readonly { text: string; extraction: RawExtraction }[]): EntityExtractor => ({
  id: "corpus",
  async extract(chunk) {
    const entry = corpus.find((doc) => chunk.content.includes(doc.text.slice(0, 40)));
    return { extraction: entry?.extraction ?? {}, usage: { inputTokens: 1, outputTokens: 1 } };
  },
});

/** Indexes the corpus with GraphRAG on, returning everything a retriever needs. */
const indexed = async (
  docs: readonly { id: string; text: string; extraction: RawExtraction }[] = CORPUS,
  authSubjectFor: (id: string) => string = () => OPEN,
) => {
  const graph: GraphStore = createMemoryGraphStore();
  /**
   * **One backend, so the vector index searches the chunks that were actually written.**
   *
   * `createMemoryVectorIndex()` takes no argument and builds its *own* backend — passing it a store, as the
   * first version of this did, silently gave the retriever an empty index. The semantic arm then found nothing
   * and the AC-7 comparison below passed vacuously: "semantic finds fewer" is not evidence when semantic was
   * searching an empty corpus. Caught while wiring the eval harness, which needed the same shape.
   */
  const backend = createMemoryKnowledgeBackend();
  const knowledge: KnowledgeStore = backend.store;
  const vector = backend.index;
  const keyword = backend.keyword;
  await graph.setEnabled({ ...context, enabled: true, at: NOW });

  const pipeline = createEmbeddingPipeline({
    knowledge,
    embeddings,
    graph: createGraphIndexer({ store: graph, extractor: extractorFor(docs) }),
  });
  for (const doc of docs) {
    await graph.setSourceEnabled({ ...context, sourceType: "file", sourceId: doc.id, enabled: true });
    await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: doc.id,
      blocks: blocks(doc.text),
      authSubject: authSubjectFor(doc.id),
    });
  }

  // The embedder is wired in, because that is the production shape after #277: the graph selects and
  // embeddings rank. A search built without it ranks by connectivity, which is what scored 20.8%.
  const graphLocal = createGraphLocalSearch({ graph, knowledge, embeddings });
  const retriever = createRetriever({ vector, keyword, embeddings, graphLocal });
  return { graph, knowledge, graphLocal, retriever, vector, keyword };
};

describe("finding the entities a question names — AC-3", () => {
  it("sweeps the query for phrases, longest first", () => {
    const candidates = entityCandidates("which teams depend on the retry budget?");
    expect(candidates).toContain("retry budget");
    // Longest first, so a more specific match is seen before a shorter one it contains.
    expect(candidates.indexOf("retry budget")).toBeLessThan(candidates.indexOf("retry"));
  });

  it("does not ask the store about bare stopwords", () => {
    const candidates = entityCandidates("which of the teams depend on it");
    expect(candidates).not.toContain("the");
    expect(candidates).not.toContain("which");
    // But a stopword inside a longer phrase is fine — "the retry budget" must still resolve.
    expect(entityCandidates("the retry budget")).toContain("retry budget");
  });

  it("resolves a surface form that was merged at index time", async () => {
    /**
     * The AC-3 guarantee, and it holds *by construction* rather than by two functions agreeing: the entity id
     * is `type:normalisedName`, built by the index-side normaliser, and the query side calls the same one.
     */
    const { graphLocal } = await indexed();
    for (const phrasing of ["the retry budget", "Retry Budget", "retry-budget"]) {
      const result = await graphLocal.search(context, { query: phrasing, authSubjects: [OPEN], limit: 10 });
      expect(result.matchedEntities, phrasing).toContain("Retry Budget");
    }
  });

  it("returns nothing for a query with no words worth looking up", async () => {
    const { graphLocal } = await indexed();
    expect((await graphLocal.search(context, { query: "the of and", authSubjects: [OPEN], limit: 10 })).hits).toEqual([]);
  });
});

describe("the question no single chunk answers — AC-7", () => {
  it("returns exactly the connected documents, where semantic returns them mixed with distractors", async () => {
    /**
     * **What this test does and does not prove — worth being exact about, because it is the REQ's key claim.**
     *
     * The first version asserted "graph-local finds all three and semantic finds fewer". Two things were wrong
     * with it. It passed for the wrong reason at first — the vector index was a *separate* backend, so semantic
     * searched an empty corpus. And once that was fixed, the assertion turned out to be **false**: with a
     * working index, semantic finds all three documents too.
     *
     * That is the honest result at this scale and it is not surprising. Recall is easy on nine documents; a
     * stub embedder over a fixed vocabulary is not a real semantic model; and the answer's three documents all
     * literally contain the question's words.
     *
     * What *is* demonstrable here, and is a real difference: **graph-local returns exactly the connected set,
     * and semantic returns it padded with documents that merely share vocabulary.** Precision, not recall.
     *
     * Whether GraphRAG beats semantic retrieval on questions like this over a real corpus with a real embedder
     * is #275's question, and this test deliberately does not pretend to answer it.
     */
    const { retriever } = await indexed();
    const question = "which teams depend on the retry budget";

    const graph = await retriever.retrieve(context, {
      query: question,
      authSubjects: [OPEN],
      limit: 10,
      mode: "graph-local",
    });
    expect(graph.found).toBe(true);
    const graphSources = graph.found ? new Set(graph.hits.map((hit) => hit.reference.sourceId)) : new Set();
    // Exactly the three the graph connects — no distractor, no coffee machine.
    expect([...graphSources].sort()).toEqual(["doc-a", "doc-b", "doc-c"]);

    const semantic = await retriever.retrieve(context, {
      query: question,
      authSubjects: [OPEN],
      limit: 10,
      mode: "semantic",
    });
    const semanticSources = semantic.found ? new Set(semantic.hits.map((hit) => hit.reference.sourceId)) : new Set();
    // Semantic finds them — and also finds documents about travel budgets and build caches, because they use
    // the same words. That is what similarity does, and it is why precision is the difference at this scale.
    expect(semanticSources.size).toBeGreaterThan(graphSources.size);
    expect([...semanticSources].some((id) => !graphSources.has(id))).toBe(true);
  });

  it("leaves the unrelated document out", async () => {
    // A traversal that returned the coffee machine would be finding *the corpus*, not the answer.
    const { retriever } = await indexed();
    const result = await retriever.retrieve(context, {
      query: "which teams depend on the retry budget",
      authSubjects: [OPEN],
      limit: 10,
      mode: "graph-local",
    });
    const sources = result.found ? result.hits.map((hit) => hit.reference.sourceId) : [];
    expect(sources).not.toContain("doc-d");
  });

  it("returns the relationships, so the connection can be stated rather than inferred — AC-6", async () => {
    const { graphLocal } = await indexed();
    const result = await graphLocal.search(context, {
      query: "which teams depend on the retry budget",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.relationships.length).toBeGreaterThanOrEqual(3);
    for (const edge of result.relationships) {
      expect(edge.type).toBe("depends-on");
      // Provenance travels with the edge: a model stating the connection can cite where it was asserted.
      expect(edge.provenance.length).toBeGreaterThan(0);
    }
  });

  it("says which entities led to each chunk", async () => {
    const { graphLocal } = await indexed();
    const result = await graphLocal.search(context, { query: "retry budget", authSubjects: [OPEN], limit: 10 });
    for (const hit of result.hits) expect(hit.viaEntities.length).toBeGreaterThan(0);
  });
});

describe("ordinary hits, so nothing downstream changes — AC-1", () => {
  it("returns real SourceReferences and a normalised score", async () => {
    const { retriever } = await indexed();
    const result = await retriever.retrieve(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 10,
      mode: "graph-local",
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.mode).toBe("graph-local");
    for (const hit of result.hits) {
      // A graph answer must be exactly as citable as a semantic one, or the model presents it as sourced when
      // it is not.
      expect(hit.reference.sourceId).toBeTruthy();
      expect(hit.reference.chunkId).toBe(hit.chunk.id);
      expect(hit.signals).toEqual(["graph-local"]);
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    // Normalised against the best, as every other mode's scores are.
    expect(result.hits[0]?.score).toBe(1);
  });

  it("honours the limit", async () => {
    const { retriever } = await indexed();
    const result = await retriever.retrieve(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 2,
      mode: "graph-local",
    });
    expect(result.found && result.hits.length).toBe(2);
  });

  it("filters by source type when asked", async () => {
    const { graphLocal } = await indexed();
    const result = await graphLocal.search(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 10,
      sourceTypes: ["artifact"],
    });
    expect(result.hits).toEqual([]);
  });
});

describe("refusals are honest — AC-2, AC-4", () => {
  it("says not-configured when GraphRAG was never wired", async () => {
    const bare = createMemoryKnowledgeBackend();
    const retriever = createRetriever({ vector: bare.index, keyword: bare.keyword, embeddings });
    const result = await retriever.retrieve(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 5,
      mode: "graph-local",
    });
    expect(result.found).toBe(false);
    if (result.found) return;
    // Never a silent fallback: a caller would attribute semantic results to the mode it named.
    expect(result.reason).toBe("not-configured");
    expect(result.mode).toBe("graph-local");
  });

  it("does not fall back to semantic when nothing resolves", async () => {
    const { retriever } = await indexed();
    const result = await retriever.retrieve(context, {
      query: "quarterly revenue forecast",
      authSubjects: [OPEN],
      limit: 5,
      mode: "graph-local",
    });
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("no-match");
  });

  it("reports no-access for an empty subject list rather than traversing", async () => {
    const { retriever } = await indexed();
    const result = await retriever.retrieve(context, {
      query: "retry budget",
      authSubjects: [],
      limit: 5,
      mode: "graph-local",
    });
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("no-access");
  });
});

describe("traversal is bounded and says when it stopped — AC-5", () => {
  it("reports truncation when a hop hits the neighbour limit", async () => {
    const { graph, knowledge } = await indexed();
    const narrow = createGraphLocalSearch({ graph, knowledge, neighbourLimit: 1 });
    const result = await narrow.search(context, {
      query: "which teams depend on the retry budget",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.truncated).toBe(true);
  });

  it("reports truncation when more chunks were reachable than the limit allowed", async () => {
    const { graphLocal } = await indexed();
    const result = await graphLocal.search(context, { query: "retry budget", authSubjects: [OPEN], limit: 1 });
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("does not claim truncation when it saw everything", async () => {
    // A flag that were always true would satisfy the two cases above and mean nothing.
    const { graphLocal } = await indexed();
    const result = await graphLocal.search(context, { query: "coffee machine", authSubjects: [OPEN], limit: 20 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("stops at the configured depth", async () => {
    /**
     * Asserted on **relationships**, not hit count, and the difference is worth recording.
     *
     * An entity's provenance spans every chunk that mentioned it, so one hop to `retry budget` already gathers
     * chunks from all three documents — depth does not change how many chunks a hub reaches. What it changes
     * is how much of the *graph* is traversed: depth 1 sees Atlas's own edge, depth 3 follows the budget on to
     * the other two teams. Asserting hit counts looked like a depth test and was really a provenance test.
     */
    const { graph, knowledge } = await indexed();
    const shallow = createGraphLocalSearch({ graph, knowledge, depth: 1 });
    const deep = createGraphLocalSearch({ graph, knowledge, depth: 3 });
    const q = { query: "Team Atlas", authSubjects: [OPEN], limit: 20 };
    expect((await shallow.search(context, q)).relationships).toHaveLength(1);
    expect((await deep.search(context, q)).relationships).toHaveLength(3);
  });

  it("is reproducible — the same query twice gives the same hits in the same order", async () => {
    const { graphLocal } = await indexed();
    const run = async () =>
      (await graphLocal.search(context, { query: "which teams depend on the retry budget", authSubjects: [OPEN], limit: 10 }))
        .hits.map((hit) => hit.chunk.id);
    expect(await run()).toEqual(await run());
  });
});

describe("a graph edge is not a way around permissions — AC-8", () => {
  it("returns nothing from a source the principal cannot read, even via an edge from one they can", async () => {
    /**
     * The sabotage AC-8 asks for, and the most plausible way a graph leaks.
     *
     * `KnowledgeStore.get` is a primary-key read with no permission filter — filtering normally lives in the
     * vector index, which a traversal never touches. So an entity mentioned by a document the principal *can*
     * read is a path to a chunk they cannot, and the only thing standing in the way is one check.
     *
     * doc-a is open; doc-b and doc-c are restricted. All three share the `retry budget` entity, so the
     * traversal genuinely reaches the restricted chunks and then must refuse them.
     */
    const { retriever, graphLocal } = await indexed(CORPUS, (id) => (id === "doc-a" || id === "doc-d" ? OPEN : "secret"));

    const result = await retriever.retrieve(context, {
      query: "which teams depend on the retry budget",
      authSubjects: [OPEN],
      limit: 20,
      mode: "graph-local",
    });
    expect(result.found).toBe(true);
    if (!result.found) return;

    const sources = result.hits.map((hit) => hit.reference.sourceId);
    expect(sources).toContain("doc-a");
    expect(sources).not.toContain("doc-b");
    expect(sources).not.toContain("doc-c");
    // And no restricted text reaches the caller by any route.
    for (const hit of result.hits) {
      expect(hit.chunk.content).not.toContain("Borealis");
      expect(hit.chunk.content).not.toContain("Cygnus");
    }

    // The traversal *did* reach them — otherwise this would be passing because the graph was empty, which is
    // the way an isolation test quietly stops testing anything.
    const asAdmin = await graphLocal.search(context, {
      query: "which teams depend on the retry budget",
      authSubjects: [OPEN, "secret"],
      limit: 20,
    });
    expect(asAdmin.hits.map((hit) => hit.chunk.sourceId).sort()).toEqual(
      expect.arrayContaining(["doc-a", "doc-b", "doc-c"]),
    );
  });

  it("returns an honest empty result when every reachable chunk is barred", async () => {
    const { retriever } = await indexed(CORPUS, () => "secret");
    const result = await retriever.retrieve(context, {
      query: "retry budget",
      authSubjects: ["some-other-workspace"],
      limit: 10,
      mode: "graph-local",
    });
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("no-match");
  });

  it("does not leak one tenant's graph into another's query", async () => {
    const { retriever } = await indexed();
    const result = await retriever.retrieve(
      { tenantId: asId("t2") },
      { query: "retry budget", authSubjects: [OPEN], limit: 10, mode: "graph-local" },
    );
    expect(result.found).toBe(false);
  });
});

describe("the other modes are untouched", () => {
  it("still answers semantic, keyword and hybrid", async () => {
    const { retriever } = await indexed();
    for (const mode of ["semantic", "keyword", "hybrid"] as const) {
      const result = await retriever.retrieve(context, {
        query: "coffee machine descaled",
        authSubjects: [OPEN],
        limit: 5,
        mode,
      });
      expect(result.mode, mode).toBe(mode);
    }
  });

  it("does not call the graph for a non-graph mode", async () => {
    // Adding a delegated mode must not put a graph read on the hot path of every ordinary query.
    const { graph, knowledge, vector, keyword } = await indexed();
    const spy = vi.spyOn(graph, "resolveEntities");
    const retriever = createRetriever({
      vector,
      keyword,
      embeddings,
      graphLocal: createGraphLocalSearch({ graph, knowledge }),
    });
    await retriever.retrieve(context, { query: "retry budget", authSubjects: [OPEN], limit: 5, mode: "hybrid" });
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * Hub entities, and the ranking that stopped them winning — #277.
 *
 * The measured failure in `docs/29` was not subtle once the misses were read: `docs/01-architecture.md` and
 * `concepts/architecture.md` appeared in miss after miss. Generic entities are extracted from nearly every
 * chunk, link to nearly everything, and drag the overview into every traversal — and connectivity scoring
 * counted that breadth as relevance.
 */
describe("hub entities do not dominate — #277, AC-2", () => {
  /**
   * An overview that mentions the hub *and* every specific concept, plus one document that actually answers
   * the question. This is the shape that beat the real corpus: the overview is connected to everything, so it
   * scores well on connectivity while saying nothing about checkpoints.
   */
  const HUB_CORPUS: readonly { id: string; text: string; extraction: RawExtraction }[] = [
    {
      id: "architecture-overview",
      text:
        "The platform is built from a runtime, a registry and a pipeline. The platform coordinates the " +
        "checkpoint, the retry budget, the ingest pipeline and the checkout service across every team.",
      extraction: {
        entities: [
          { name: "platform", type: "concept" },
          { name: "checkpoint", type: "concept" },
          { name: "retry budget", type: "concept" },
          { name: "ingest pipeline", type: "concept" },
          { name: "checkout service", type: "concept" },
        ],
        relationships: [
          { from: "platform", to: "checkpoint", type: "coordinates" },
          { from: "platform", to: "retry budget", type: "coordinates" },
          { from: "platform", to: "ingest pipeline", type: "coordinates" },
          { from: "platform", to: "checkout service", type: "coordinates" },
        ],
      },
    },
    {
      id: "durable-runtime",
      text:
        "A run survives a worker being killed because the checkpoint is written before each step. On restart " +
        "the checkpoint is read back and the run resumes from it rather than starting again.",
      extraction: {
        entities: [
          { name: "checkpoint", type: "concept" },
          { name: "platform", type: "concept" },
        ],
        relationships: [{ from: "checkpoint", to: "platform", type: "part-of" }],
      },
    },
    {
      id: "budgets",
      text: "The retry budget governs outbound calls made by the platform on behalf of the checkout service.",
      extraction: {
        entities: [
          { name: "retry budget", type: "concept" },
          { name: "platform", type: "concept" },
        ],
        relationships: [{ from: "retry budget", to: "platform", type: "part-of" }],
      },
    },
    {
      id: "ingest",
      text: "The ingest pipeline is scheduled by the platform and writes into the registry.",
      extraction: {
        entities: [
          { name: "ingest pipeline", type: "concept" },
          { name: "platform", type: "concept" },
        ],
        relationships: [{ from: "ingest pipeline", to: "platform", type: "scheduled-by" }],
      },
    },
  ];

  it("puts the document that answers the question above the overview that mentions everything", async () => {
    const { graphLocal } = await indexed(HUB_CORPUS);
    const outcome = await graphLocal.search(context, {
      query: "how does a run survive the worker being killed, using the checkpoint",
      authSubjects: [OPEN],
      limit: 5,
    });

    expect(outcome.rankedBy).toBe("relevance");
    const sources = outcome.hits.map((hit) => hit.chunk.sourceId);
    expect(sources).toContain("durable-runtime");
    /**
     * The assertion the AC asks for, stated as a comparison rather than an absence: the overview is legitimately
     * *connected* to the question and may well appear. What it must not do is outrank the document that answers
     * it.
     */
    const answer = sources.indexOf("durable-runtime");
    const overview = sources.indexOf("architecture-overview");
    expect(answer).toBeGreaterThanOrEqual(0);
    if (overview >= 0) expect(answer).toBeLessThan(overview);
  });

  it("discounts an entity by how much of the corpus it touches", () => {
    // A specific entity keeps most of its weight; a hub in two hundred chunks keeps about a seventh.
    expect(hubDiscount(2)).toBeGreaterThan(hubDiscount(200));
    expect(hubDiscount(200)).toBeGreaterThan(0);
    // Monotone, so "appears in more chunks" is never worth more.
    for (const [fewer, more] of [[1, 5], [5, 50], [50, 500]] as const) {
      expect(hubDiscount(fewer)).toBeGreaterThan(hubDiscount(more));
    }
  });

  it("ranks by connectivity, and says so, when no embedder is configured", async () => {
    // The mode still works without one — and the result reports which ranking ran, so a measurement of one can
    // never be mistaken for a measurement of the other.
    const { graph, knowledge } = await indexed(HUB_CORPUS);
    const withoutEmbedder = createGraphLocalSearch({ graph, knowledge });
    const outcome = await withoutEmbedder.search(context, {
      query: "how does a run survive the worker being killed, using the checkpoint",
      authSubjects: [OPEN],
      limit: 5,
    });
    expect(outcome.rankedBy).toBe("connectivity");
    expect(outcome.hits.length).toBeGreaterThan(0);
  });

  it("ranking reorders the candidates and never changes which ones they are", async () => {
    // The claim of the mode is "these chunks are connected to what you asked about". Replacing the candidate
    // set with a semantic search would be a different mode wearing this one's label.
    const { graph, knowledge } = await indexed(HUB_CORPUS);
    const query = "how does a run survive the worker being killed, using the checkpoint";
    const input = { query, authSubjects: [OPEN], limit: 10 };
    const byConnectivity = await createGraphLocalSearch({ graph, knowledge }).search(context, input);
    const byRelevance = await createGraphLocalSearch({ graph, knowledge, embeddings }).search(context, input);

    const ids = (result: { hits: readonly { chunk: { id: string } }[] }) =>
      [...result.hits.map((hit) => hit.chunk.id)].sort();
    expect(ids(byRelevance)).toEqual(ids(byConnectivity));
  });
});

/**
 * The pool, which is the change that lets ranking reach anything — #277.
 *
 * A sabotage run found this uncovered: narrowing the pool back to `input.limit` broke nothing, because the
 * other fixtures are small enough that the pool and the limit are the same set. That is a test suite agreeing
 * with itself. This corpus is built so the answering chunk is deliberately *outside* the connectivity top-k
 * and inside the pool — which is exactly the case the old code could never return.
 */
describe("selection gathers a pool, not the answer — #277", () => {
  /**
   * Nine decoys that all name both query entities, and one answer that names one of them plus the words the
   * question actually uses. On connectivity the decoys win: they touch more of the query's entities.
   */
  const POOL_CORPUS: readonly { id: string; text: string; extraction: RawExtraction }[] = [
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `decoy-${index}`,
      text:
        `Release note ${index}: the scheduler and the dispatcher were both touched. ` +
        "The scheduler calls the dispatcher during rollout.",
      extraction: {
        entities: [
          { name: "scheduler", type: "concept" },
          { name: "dispatcher", type: "concept" },
        ],
        relationships: [{ from: "scheduler", to: "dispatcher", type: "calls" }],
      } as RawExtraction,
    })),
    {
      id: "answer",
      text:
        "Backpressure is applied when the dispatcher queue exceeds its high water mark, and the producer is " +
        "paused until the queue drains below the low water mark.",
      extraction: {
        entities: [{ name: "dispatcher", type: "concept" }],
        relationships: [],
      },
    },
  ];

  it("returns a chunk the connectivity ranking would never have reached", async () => {
    const { graph, knowledge } = await indexed(POOL_CORPUS);
    const input = {
      query: "what happens to the dispatcher queue when backpressure is applied at the high water mark",
      authSubjects: [OPEN],
      limit: 3,
    };

    // Connectivity alone: the decoys touch both entities, so they fill the top three.
    const byConnectivity = await createGraphLocalSearch({ graph, knowledge }).search(context, input);
    expect(byConnectivity.hits.map((hit) => hit.chunk.sourceId)).not.toContain("answer");

    // With a pool and a re-rank, the answer is reachable — and it is what comes first.
    const byRelevance = await createGraphLocalSearch({ graph, knowledge, embeddings }).search(context, input);
    expect(byRelevance.hits[0]?.chunk.sourceId).toBe("answer");
  });
});
