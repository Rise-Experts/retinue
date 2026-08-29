/**
 * The knowledge graph — REQ-064 (#270), task #271.
 *
 * Two of these carry most of the weight. **"Off costs nothing"** is asserted by counting calls, because it is a
 * promise about a bill and a promise about a bill cannot be verified by reading code. **Determinism** is
 * asserted by fingerprinting the store twice, because #275 measures GraphRAG against a fixed baseline and a
 * graph that shifts between runs is not measurable at all.
 */
import { describe, expect, it, vi } from "vitest";

import { asId } from "../../core/ids.js";
import type { DocumentBlock } from "../../documents/index.js";
import { createMemoryGraphStore } from "../../adapters/memory/graph.js";
import { createMemoryKnowledgeStore } from "../../adapters/memory/knowledge.js";
import type { GraphStore } from "../../persistence/index.js";
import {
  createEmbeddingPipeline,
  createGraphIndexer,
  entityId,
  mergeContributions,
  normaliseName,
  normaliseType,
  relationshipId,
  sanitiseExtraction,
  type EntityExtractor,
  type RawExtraction,
} from "../index.js";

const context = { tenantId: asId("t1") };
const other = { tenantId: asId("t2") };
const NOW = "2026-08-28T00:00:00.000Z";

/**
 * An extractor that answers from a fixed map and counts how often it was asked.
 *
 * Keyed by **substring**, not by exact chunk content. The chunker merges short paragraphs into one chunk — as
 * it should — so an exact-match script silently returned `{}` for everything and three tests failed for a
 * reason that had nothing to do with the graph. Matching on a phrase makes the fixture independent of chunking
 * decisions, which is what it was always trying to be.
 */
const scriptedExtractor = (byPhrase: Readonly<Record<string, RawExtraction>>) => {
  const calls: string[] = [];
  const extractor: EntityExtractor = {
    id: "scripted",
    async extract(chunk) {
      calls.push(chunk.id);
      const merged: RawExtraction = { entities: [], relationships: [] };
      for (const [phrase, extraction] of Object.entries(byPhrase)) {
        if (!chunk.content.includes(phrase)) continue;
        (merged.entities as unknown[]).push(...(extraction.entities ?? []));
        (merged.relationships as unknown[]).push(...(extraction.relationships ?? []));
      }
      return { extraction: merged, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { extractor, calls };
};

/**
 * Paragraphs long enough that the chunker keeps them apart.
 *
 * The chunker packs small blocks together to avoid one-sentence chunks, so "two paragraphs" is not "two
 * chunks" unless they are substantial. Padding is the honest way to get a multi-chunk fixture — the
 * alternative is asserting a chunk count the chunker never promised.
 */
const padded = (text: string): string => {
  // Filler derived from the text, not a constant. The chunker overlaps adjacent chunks, so identical padding
  // carried the *previous* paragraph's phrase into the next chunk and a substring script matched both — a
  // fixture that quietly tested nothing.
  const filler = `Context about ${text.slice(0, 24)} continues. `;
  return `${text} ${filler.repeat(40)}`;
};

const embeddings = {
  model: { modelId: "test-embed", version: "1", dimensions: 1536 },
  async embed(texts: readonly string[]) {
    // Deterministic and cheap. What is being tested is the graph, not similarity.
    return texts.map((text) => Array.from({ length: 1536 }, (_, i) => ((text.charCodeAt(i % text.length) || 1) % 17) / 17));
  },
};

// `kind`, not `type` — a `DocumentBlock` is discriminated on `kind`, and the first version of this helper
// used the wrong field. It compiled here only because test files are not typechecked (#276).
const blocks = (...paragraphs: string[]): DocumentBlock[] =>
  paragraphs.map((text) => ({ kind: "paragraph" as const, text }));

describe("normalisation and identity — AC-6", () => {
  it("merges the spellings that are the same thing", () => {
    // The merge AC-4 names, spelled out.
    for (const form of ["the retry budget", "Retry Budget", "retry-budget", "  RETRY   BUDGET  ", "retry_budget"]) {
      expect(normaliseName(form), form).toBe("retry budget");
    }
  });

  it("keeps apart the things that are not", () => {
    // A parenthetical qualifier survives as a word, which is *why* punctuation becomes a space rather than
    // nothing. Dropping it entirely would merge two different people.
    expect(normaliseName("Ana (engineering)")).not.toBe(normaliseName("Ana (sales)"));
    expect(normaliseName("billing")).not.toBe(normaliseName("bill"));
  });

  it("folds diacritics, because case and accent are the same kind of difference", () => {
    expect(normaliseName("Zürich")).toBe(normaliseName("Zurich"));
  });

  it("does not strip a leading article that is the whole name", () => {
    expect(normaliseName("The")).toBe("the");
  });

  it("distinguishes a person from a project with the same name", () => {
    expect(entityId("person", "Atlas")).not.toBe(entityId("project", "Atlas"));
  });

  it("makes a readable id rather than a hash", () => {
    // Deliberate: an id in a log or an error should say what it is without a lookup script.
    expect(entityId("Concept", "The Retry Budget")).toBe("concept:retry budget");
  });

  it("treats direction as part of an edge's identity", () => {
    expect(relationshipId("a", "depends-on", "b")).not.toBe(relationshipId("b", "depends-on", "a"));
  });

  it("falls back to a type rather than an empty one", () => {
    expect(normaliseType("!!!")).toBe("unknown");
  });
});

describe("extraction is untrusted — AC-7", () => {
  it("drops an edge naming an entity that was not extracted, rather than inventing it", () => {
    /**
     * The strictness that matters. An extractor routinely names an endpoint it did not extract, and creating
     * the missing entity would give it a provenance nobody asserted — the exact failure provenance exists to
     * prevent.
     */
    const contribution = sanitiseExtraction("c1", {
      entities: [{ name: "Retry Budget", type: "concept" }],
      relationships: [{ from: "Retry Budget", to: "Some Team Nobody Extracted", type: "used-by" }],
    });
    expect(contribution.entities).toHaveLength(1);
    expect(contribution.relationships).toHaveLength(0);

    // Both directions, because a mutation that only repaired `from` would leave this passing while the
    // invention it introduced went uncaught.
    const reversed = sanitiseExtraction("c1", {
      entities: [{ name: "Retry Budget", type: "concept" }],
      relationships: [{ from: "Some Team Nobody Extracted", to: "Retry Budget", type: "uses" }],
    });
    expect(reversed.relationships).toHaveLength(0);
    expect(reversed.entities.map((e) => e.id)).toEqual(["concept:retry budget"]);
  });

  it("matches an edge endpoint by name across types, because extractors do not repeat the type", () => {
    const contribution = sanitiseExtraction("c1", {
      entities: [
        { name: "Team A", type: "organisation" },
        { name: "Retry Budget", type: "concept" },
      ],
      relationships: [{ from: "team a", to: "the retry budget", type: "Depends On" }],
    });
    expect(contribution.relationships).toHaveLength(1);
    expect(contribution.relationships[0]).toMatchObject({
      fromId: "organisation:team a",
      toId: "concept:retry budget",
      type: "depends-on",
    });
  });

  it("drops a self-edge, which carries no information and clutters every traversal", () => {
    const contribution = sanitiseExtraction("c1", {
      entities: [{ name: "A", type: "concept" }],
      relationships: [{ from: "A", to: "a", type: "related-to" }],
    });
    expect(contribution.relationships).toHaveLength(0);
  });

  it("survives every shape a model can return", () => {
    for (const raw of [
      {},
      { entities: null },
      { entities: "nope" },
      { entities: [{}] },
      { entities: [{ name: 42 }] },
      { entities: [{ name: "   " }] },
      { entities: [{ name: "!!!" }] },
      { relationships: [{ from: "a", to: "b" }] },
    ] as unknown as RawExtraction[]) {
      expect(() => sanitiseExtraction("c1", raw)).not.toThrow();
    }
    expect(sanitiseExtraction("c1", { entities: [{ name: "!!!" }] } as RawExtraction).entities).toHaveLength(0);
  });

  it("gives every row provenance, always", () => {
    const contribution = sanitiseExtraction("chunk-9", {
      entities: [
        { name: "A", type: "concept" },
        { name: "B", type: "concept" },
      ],
      relationships: [{ from: "A", to: "B", type: "x" }],
    });
    for (const row of [...contribution.entities, ...contribution.relationships]) {
      expect(row.provenance).toEqual(["chunk-9"]);
    }
  });

  it("truncates a description that is really a paragraph", () => {
    const long = "x".repeat(2000);
    const [entity] = sanitiseExtraction("c1", { entities: [{ name: "A", type: "c", description: long }] }).entities;
    expect((entity?.description ?? "").length).toBeLessThanOrEqual(480);
  });
});

describe("merging is deterministic — AC-6", () => {
  it("unions surface forms and counts weight from provenance", () => {
    const merged = mergeContributions([
      sanitiseExtraction("c1", {
        entities: [
          { name: "Retry Budget", type: "concept" },
          { name: "Team A", type: "organisation" },
        ],
        relationships: [{ from: "Retry Budget", to: "Team A", type: "used-by" }],
      }),
      sanitiseExtraction("c2", {
        entities: [
          { name: "the retry budget", type: "concept" },
          { name: "Team A", type: "organisation" },
        ],
        relationships: [{ from: "the retry budget", to: "Team A", type: "used-by" }],
      }),
    ]);
    const budget = merged.entities.find((e) => e.id === "concept:retry budget");
    // Both spellings recorded, so a wrong merge is a lookup rather than an archaeology problem.
    expect(budget?.surfaceForms).toEqual(["Retry Budget", "the retry budget"]);
    expect(budget?.provenance).toEqual(["c1", "c2"]);
    // Weight counts the chunks that asserted the edge, so re-reading one chunk cannot inflate it.
    expect(merged.relationships[0]?.weight).toBe(2);
  });

  it("picks the canonical name by sort order, not by which chunk came first", () => {
    /**
     * Two *spellings of one entity*, which the first version of this test got wrong: it used "Zeta" and
     * "Alpha", which normalise to different ids and therefore never merge — so the branch under test never
     * ran and the assertion passed against a mutation that broke it. Both forms here resolve to
     * `concept:retry budget`, which is what forces the canonical-name choice.
     */
    const zetaFirst = mergeContributions([
      sanitiseExtraction("c1", { entities: [{ name: "Zzz Retry Budget", type: "c" }] }),
      sanitiseExtraction("c2", { entities: [{ name: "Aaa Retry Budget", type: "c" }] }),
    ]);
    const alphaFirst = mergeContributions([
      sanitiseExtraction("c2", { entities: [{ name: "Aaa Retry Budget", type: "c" }] }),
      sanitiseExtraction("c1", { entities: [{ name: "Zzz Retry Budget", type: "c" }] }),
    ]);
    // Chunk order can change without the document changing, so "first seen" would not be stable.
    expect(zetaFirst).toEqual(alphaFirst);
    expect(zetaFirst.entities).toHaveLength(2);
  });

  it("chooses the same canonical name whichever spelling arrived first", () => {
    const pick = (order: readonly string[]) =>
      mergeContributions(order.map((name, i) => sanitiseExtraction(`c${i}`, { entities: [{ name, type: "concept" }] })))
        .entities[0]?.name;
    // One entity, two spellings. Lexicographically first wins, and it does so regardless of order.
    expect(pick(["Retry Budget", "retry budget"])).toBe("Retry Budget");
    expect(pick(["retry budget", "Retry Budget"])).toBe("Retry Budget");
  });

  it("drops an edge whose endpoint did not survive the merge", () => {
    const merged = mergeContributions([
      { entities: [], relationships: [{ id: "a|x|b", fromId: "a", toId: "b", type: "x", weight: 1, provenance: ["c1"] }] },
    ]);
    expect(merged.relationships).toHaveLength(0);
  });
});

describe("the store keeps a source's contribution separate", () => {
  const contribution = (chunkId: string, names: readonly string[]) =>
    sanitiseExtraction(chunkId, { entities: names.map((name) => ({ name, type: "concept" })) });

  it("prunes only what no other source still names", async () => {
    const store = createMemoryGraphStore();
    await store.replaceSourceGraph({ ...context, sourceType: "file", sourceId: "a", contribution: contribution("a1", ["Shared", "OnlyA"]) });
    await store.replaceSourceGraph({ ...context, sourceType: "file", sourceId: "b", contribution: contribution("b1", ["Shared", "OnlyB"]) });
    expect((await store.listEntities({ ...context, limit: 50 })).items.map((e) => e.id)).toEqual([
      "concept:onlya",
      "concept:onlyb",
      "concept:shared",
    ]);

    await store.deleteSourceGraph({ ...context, sourceType: "file", sourceId: "a" });
    const left = (await store.listEntities({ ...context, limit: 50 })).items.map((e) => e.id);
    // `Shared` survives because B still names it. No reference counting for anybody to get wrong.
    expect(left).toEqual(["concept:onlyb", "concept:shared"]);
  });

  it("replaces rather than appends, so a re-index withdraws the old claims", async () => {
    const store = createMemoryGraphStore();
    await store.replaceSourceGraph({ ...context, sourceType: "file", sourceId: "a", contribution: contribution("a1", ["Old"]) });
    await store.replaceSourceGraph({ ...context, sourceType: "file", sourceId: "a", contribution: contribution("a1", ["New"]) });
    expect((await store.listEntities({ ...context, limit: 50 })).items.map((e) => e.id)).toEqual(["concept:new"]);
  });

  it("refuses a claim with no chunk behind it — AC-5", async () => {
    const store = createMemoryGraphStore();
    await expect(
      store.replaceSourceGraph({
        ...context,
        sourceType: "file",
        sourceId: "a",
        contribution: {
          entities: [{ id: "concept:x", name: "X", type: "concept", surfaceForms: ["X"], provenance: [] }],
          relationships: [],
        },
      }),
    ).rejects.toThrow(/provenance/);
  });

  it("keeps one tenant's graph unreachable from another — AC-8", async () => {
    const store = createMemoryGraphStore();
    await store.replaceSourceGraph({ ...context, sourceType: "file", sourceId: "a", contribution: contribution("a1", ["Secret"]) });
    expect((await store.listEntities({ ...other, limit: 50 })).items).toEqual([]);
    expect(await store.getEntity({ ...other, id: "concept:secret" })).toBeNull();
    expect(await store.getEntities({ ...other, ids: ["concept:secret"] })).toEqual([]);
    expect(await store.neighbours({ ...other, entityIds: ["concept:secret"], limit: 10 })).toEqual([]);
    expect(await store.fingerprint(other)).toBe("");
  });

  it("orders neighbours heaviest first, with a total order so truncation is reproducible", async () => {
    const store = createMemoryGraphStore();
    const built = mergeContributions([
      sanitiseExtraction("c1", {
        entities: [
          { name: "Hub", type: "c" },
          { name: "Light", type: "c" },
          { name: "Heavy", type: "c" },
        ],
        relationships: [
          { from: "Hub", to: "Light", type: "x" },
          { from: "Hub", to: "Heavy", type: "x" },
        ],
      }),
      sanitiseExtraction("c2", {
        entities: [
          { name: "Hub", type: "c" },
          { name: "Heavy", type: "c" },
        ],
        relationships: [{ from: "Hub", to: "Heavy", type: "x" }],
      }),
    ]);
    await store.replaceSourceGraph({ ...context, sourceType: "file", sourceId: "a", contribution: built });
    const [first] = await store.neighbours({ ...context, entityIds: ["c:hub"], limit: 1 });
    expect(first?.toId).toBe("c:heavy");
  });
});

describe("the switch has two levels — AC-2, AC-3", () => {
  const setup = async (opts: { tenantEnabled: boolean; sourceEnabled: boolean }) => {
    const store: GraphStore = createMemoryGraphStore();
    if (opts.tenantEnabled) await store.setEnabled({ ...context, enabled: true, at: NOW });
    if (opts.sourceEnabled)
      await store.setSourceEnabled({ ...context, sourceType: "file", sourceId: "doc", enabled: true });
    const { extractor, calls } = scriptedExtractor({
      "Team A depends on the retry budget.": {
        entities: [
          { name: "Team A", type: "organisation" },
          { name: "retry budget", type: "concept" },
        ],
        relationships: [{ from: "Team A", to: "retry budget", type: "depends-on" }],
      },
    });
    const pipeline = createEmbeddingPipeline({
      knowledge: createMemoryKnowledgeStore(),
      embeddings,
      graph: createGraphIndexer({ store, extractor }),
    });
    return { store, calls, pipeline };
  };

  it("does not extract when the tenant switch is off, even for a flagged source", async () => {
    const { calls, pipeline, store } = await setup({ tenantEnabled: false, sourceEnabled: true });
    const result = await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks("Team A depends on the retry budget."),
      authSubject: "w1",
    });
    expect(result.graph.ran).toBe(false);
    expect(calls).toEqual([]);
    expect(await store.fingerprint(context)).toBe("");
  });

  it("does not extract when the source is not flagged, even with the tenant switch on", async () => {
    const { calls, pipeline } = await setup({ tenantEnabled: true, sourceEnabled: false });
    const result = await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks("Team A depends on the retry budget."),
      authSubject: "w1",
    });
    expect(result.graph.ran).toBe(false);
    expect(calls).toEqual([]);
  });

  it("keeps a source flag set while the tenant switch is off, and picks it up later — AC-3", async () => {
    // The scenario the two-level switch exists for: mark the handbook today, enable the tenant next week,
    // re-mark nothing.
    const { store, calls, pipeline } = await setup({ tenantEnabled: false, sourceEnabled: true });
    expect(await store.isSourceEnabled({ ...context, sourceType: "file", sourceId: "doc" })).toBe(true);

    await store.setEnabled({ ...context, enabled: true, at: NOW });
    const result = await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks("Team A depends on the retry budget."),
      authSubject: "w1",
    });
    expect(result.graph.ran).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("lists the flagged sources regardless of the tenant switch", async () => {
    const { store } = await setup({ tenantEnabled: false, sourceEnabled: true });
    expect((await store.listEnabledSources({ ...context, limit: 10 })).items).toEqual([
      { sourceType: "file", sourceId: "doc" },
    ]);
  });
});

describe("off costs nothing — AC-4", () => {
  it("makes no extraction call and writes no graph rows when GraphRAG is disabled", async () => {
    /**
     * The promise this AC is about is a *bill*, so it is asserted by counting calls. Reading the code and
     * concluding it is fine is exactly what would miss a `shouldIndex` that ran extraction before checking.
     */
    const store = createMemoryGraphStore();
    const { extractor, calls } = scriptedExtractor({});
    const pipeline = createEmbeddingPipeline({
      knowledge: createMemoryKnowledgeStore(),
      embeddings,
      graph: createGraphIndexer({ store, extractor }),
    });
    for (let i = 0; i < 5; i += 1) {
      await pipeline.indexSource(context, {
        sourceType: "file",
        sourceId: `doc-${i}`,
        blocks: blocks("Some content here.", "And more of it."),
        authSubject: "w1",
      });
    }
    expect(calls).toEqual([]);
    expect(await store.fingerprint(context)).toBe("");
  });

  it("costs nothing at all when no graph indexer is supplied", async () => {
    // The outermost gate: a deployment that never enables GraphRAG configures no language model to index a
    // document, because `graph` is absent from the dependencies entirely.
    const pipeline = createEmbeddingPipeline({ knowledge: createMemoryKnowledgeStore(), embeddings });
    const result = await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks("Content."),
      authSubject: "w1",
    });
    expect(result.graph.ran).toBe(false);
    expect(result.graph.extractionCalls).toBe(0);
  });

  it("reports `ran: false` rather than omitting the field, so 'off' and 'nothing found' differ", async () => {
    const pipeline = createEmbeddingPipeline({ knowledge: createMemoryKnowledgeStore(), embeddings });
    const result = await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks("Content."),
      authSubject: "w1",
    });
    expect(result.graph).toMatchObject({ ran: false, entities: 0, relationships: 0, extractionCalls: 0 });
  });
});

describe("indexing into the graph", () => {
  const enabled = async () => {
    const store = createMemoryGraphStore();
    await store.setEnabled({ ...context, enabled: true, at: NOW });
    await store.setSourceEnabled({ ...context, sourceType: "file", sourceId: "doc", enabled: true });
    return store;
  };

  it("extracts, merges and reports what it cost — AC-9", async () => {
    const store = await enabled();
    const { extractor, calls } = scriptedExtractor({
      "Team A depends on the retry budget.": {
        entities: [
          { name: "Team A", type: "organisation" },
          { name: "retry budget", type: "concept" },
        ],
        relationships: [{ from: "Team A", to: "retry budget", type: "depends-on" }],
      },
      "Team B also depends on the retry budget.": {
        entities: [
          { name: "Team B", type: "organisation" },
          { name: "Retry Budget", type: "concept" },
        ],
        relationships: [{ from: "Team B", to: "Retry Budget", type: "depends-on" }],
      },
    });
    const pipeline = createEmbeddingPipeline({
      knowledge: createMemoryKnowledgeStore(),
      embeddings,
      graph: createGraphIndexer({ store, extractor }),
    });
    const result = await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks(padded("Team A depends on the retry budget."), padded("Team B also depends on the retry budget.")),
      authSubject: "w1",
    });

    expect(calls).toHaveLength(2);
    expect(result.graph.ran).toBe(true);
    expect(result.graph.entities).toBe(3);
    expect(result.graph.relationships).toBe(2);
    // The bill, visible before it arrives.
    expect(result.graph.extractionCalls).toBe(2);
    expect(result.graph.inputTokens).toBe(20);
    expect(result.graph.outputTokens).toBe(10);

    // The thing the whole REQ is for: two chunks, neither of which says it, and the graph now does.
    const budget = await store.getEntity({ ...context, id: "concept:retry budget" });
    expect(budget?.provenance).toHaveLength(2);
    const edges = await store.neighbours({ ...context, entityIds: ["concept:retry budget"], limit: 10 });
    expect(edges.map((e) => e.fromId).sort()).toEqual(["organisation:team a", "organisation:team b"]);
  });

  it("keeps the index working when extraction throws — AC-7", async () => {
    const store = await enabled();
    const extractor: EntityExtractor = {
      id: "broken",
      async extract() {
        throw new Error("the model is down");
      },
    };
    const knowledge = createMemoryKnowledgeStore();
    const pipeline = createEmbeddingPipeline({ knowledge, embeddings, graph: createGraphIndexer({ store, extractor }) });
    const result = await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks(padded("Content one."), padded("Content two.")),
      authSubject: "w1",
    });

    // The index succeeded and the chunks are embedded — every existing retrieval mode still works on them.
    expect(result.written).toBe(2);
    expect((await knowledge.listBySource({ ...context, sourceType: "file", sourceId: "doc", limit: 10 })).items).toHaveLength(2);
    // Only the graph is missing.
    expect(result.graph.unusableChunks).toBe(2);
    expect(result.graph.entities).toBe(0);
    expect(await store.fingerprint(context)).toBe("");
  });

  it("removes a source's graph when its content is extracted down to nothing", async () => {
    const store = await enabled();
    const { extractor } = scriptedExtractor({
      "Team A depends on the retry budget.": { entities: [{ name: "Team A", type: "organisation" }] },
    });
    const pipeline = createEmbeddingPipeline({
      knowledge: createMemoryKnowledgeStore(),
      embeddings,
      graph: createGraphIndexer({ store, extractor }),
    });
    await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks("Team A depends on the retry budget."),
      authSubject: "w1",
    });
    expect(await store.fingerprint(context)).not.toBe("");

    // An empty document must not leave entities asserting what it used to say.
    await pipeline.indexSource(context, { sourceType: "file", sourceId: "doc", blocks: [], authSubject: "w1" });
    expect(await store.fingerprint(context)).toBe("");
  });

  it("produces an identical graph twice — AC-6", async () => {
    /**
     * The determinism assertion, via `fingerprint` on the port so every adapter is held to it. #275 measures
     * against a fixed baseline, and a graph that shifts between runs cannot be measured or debugged.
     */
    const script = {
      "Team A depends on the retry budget.": {
        entities: [
          { name: "Team A", type: "organisation" },
          { name: "the retry budget", type: "concept" },
        ],
        relationships: [{ from: "Team A", to: "the retry budget", type: "depends-on" }],
      },
      "Retry Budget is owned by Platform.": {
        entities: [
          { name: "Retry Budget", type: "concept" },
          { name: "Platform", type: "organisation" },
        ],
        relationships: [{ from: "Platform", to: "Retry Budget", type: "owns" }],
      },
    } satisfies Record<string, RawExtraction>;

    const run = async () => {
      const store = await enabled();
      const { extractor } = scriptedExtractor(script);
      const pipeline = createEmbeddingPipeline({
        knowledge: createMemoryKnowledgeStore(),
        embeddings,
        graph: createGraphIndexer({ store, extractor }),
      });
      await pipeline.indexSource(context, {
        sourceType: "file",
        sourceId: "doc",
        blocks: blocks(padded("Team A depends on the retry budget."), padded("Retry Budget is owned by Platform.")),
        authSubject: "w1",
      });
      return store.fingerprint(context);
    };

    const first = await run();
    expect(await run()).toBe(first);
    expect(first).not.toBe("");
  });

  it("is unaffected by the order the chunks were extracted in", async () => {
    // Concurrency reorders completions, and a fingerprint that depended on arrival order would make the
    // determinism assertion above pass only at concurrency 1.
    const script = {
      A: { entities: [{ name: "Alpha", type: "c" }] },
      B: { entities: [{ name: "Beta", type: "c" }] },
    } satisfies Record<string, RawExtraction>;
    const fingerprintAt = async (concurrency: number) => {
      const store = await enabled();
      const { extractor } = scriptedExtractor(script);
      const pipeline = createEmbeddingPipeline({
        knowledge: createMemoryKnowledgeStore(),
        embeddings,
        graph: createGraphIndexer({ store, extractor }),
        graphConcurrency: concurrency,
      });
      await pipeline.indexSource(context, { sourceType: "file", sourceId: "doc", blocks: blocks("A", "B"), authSubject: "w1" });
      return store.fingerprint(context);
    };
    expect(await fingerprintAt(4)).toBe(await fingerprintAt(1));
  });

  it("extracts one chunk at a time by default, because the cost is the point", async () => {
    const store = await enabled();
    let inFlight = 0;
    let peak = 0;
    const extractor: EntityExtractor = {
      id: "counting",
      async extract() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { extraction: {} };
      },
    };
    const pipeline = createEmbeddingPipeline({
      knowledge: createMemoryKnowledgeStore(),
      embeddings,
      graph: createGraphIndexer({ store, extractor }),
    });
    await pipeline.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      blocks: blocks("a", "b", "c", "d"),
      authSubject: "w1",
    });
    // Firing 600 calls at once is how a re-index becomes a rate-limit incident.
    expect(peak).toBe(1);
  });

  it("logs which chunks contributed nothing, rather than reporting a clean run", async () => {
    /**
     * Driven through the indexer rather than the pipeline, deliberately.
     *
     * Going through `indexSource` means going through the chunker, whose overlap window carries a whole
     * previous block into the next chunk — so a two-paragraph fixture produced two chunks that both contained
     * the first paragraph's phrase, and the "unusable" chunk was not unusable. The behaviour under test is the
     * indexer's, and handing it explicit chunks tests exactly that.
     */
    const store = createMemoryGraphStore();
    const log = vi.fn();
    const { extractor } = scriptedExtractor({ good: { entities: [{ name: "A", type: "c" }] } });
    const indexer = createGraphIndexer({ store, extractor, log });
    const result = await indexer.indexSource(context, {
      sourceType: "file",
      sourceId: "doc",
      chunks: [
        { id: "c1", content: "good" },
        { id: "c2", content: "prose the extractor could not use" },
      ],
    });
    expect(result.unusableChunks).toBe(1);
    expect(result.entities).toBe(1);
    expect(log).toHaveBeenCalledWith(
      "some chunks contributed nothing to the graph",
      expect.objectContaining({ unusableChunks: 1, of: 2 }),
    );
  });
});
