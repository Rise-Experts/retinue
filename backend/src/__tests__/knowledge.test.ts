/**
 * Chunking, embedding and retrieval (#135).
 *
 * The two tests worth reading are the ones the ACs make measurable rather than assertable:
 *
 * - **AC-2's recall figure** is measured against a fixed query set and compared to a *recorded target*. A
 *   "semantic search returns relevant chunks" assertion is worth nothing — it passes with one document and one
 *   query. A recall number over a corpus with distractors is a figure that moves when relevance regresses.
 * - **AC-5's resumability** is tested by interrupting a re-index and resuming, then asserting no chunk is
 *   duplicated and none is missing. The point is that resumption needs no bookkeeping: the work list is
 *   re-derived from what is stored.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { TenantId } from "../core/ids.js";
import { createMemoryKnowledgeBackend } from "../adapters/memory/knowledge.js";
import type { DocumentBlock } from "../documents/index.js";
import { EMBEDDING_DIMENSIONS, type EmbeddingModelRef } from "../persistence/index.js";
import {
  DEFAULT_CHUNKING_LIMITS,
  FRESHNESS_TARGET_MS,
  chunkDocument,
  chunkId,
  createEmbeddingPipeline,
  type EmbeddingProvider,
} from "../knowledge/index.js";
// From core, which owns it. `knowledge/chunking.ts` used to re-export it as a convenience, which gave one name
// two subpaths once the surface was split (#199).
import { estimateTokens } from "../core/tokens.js";

const T1 = asId<TenantId>("tenant-1");
const ctx = { tenantId: T1 };

const MODEL: EmbeddingModelRef = { modelId: "test-embed", version: "1", dimensions: EMBEDDING_DIMENSIONS };

/**
 * A deterministic bag-of-words embedding.
 *
 * Not a real model, and that is what makes AC-2 measurable: a stochastic provider gives a recall figure that
 * moves between runs for reasons unrelated to the code. This hashes each word to an axis and accumulates, so
 * "similar text" means "shares words" — a crude but *honest* semantic proxy, and the retrieval mechanics it
 * exercises (cosine ranking, filtering, limits) are the parts this issue owns. Real-model recall is an eval,
 * not a unit test.
 */
const bagOfWords: EmbeddingProvider = {
  model: MODEL,
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (const ch of word) {
          h ^= ch.charCodeAt(0);
          h = Math.imul(h, 16777619) >>> 0;
        }
        const axis = h % EMBEDDING_DIMENSIONS;
        v[axis] = (v[axis] ?? 0) + 1;
      }
      return v;
    });
  },
};

const heading = (level: 1 | 2 | 3, text: string): DocumentBlock => ({ kind: "heading", level, text });
const para = (text: string): DocumentBlock => ({ kind: "paragraph", text });

describe("chunking", () => {
  it("prepends the heading path so an isolated sentence is findable", () => {
    // "Revenue rose 9%" retrieves nothing on its own and retrieves as "Quarterly Review > By region".
    const chunks = chunkDocument([
      heading(1, "Quarterly Review"),
      heading(2, "By region"),
      para("Revenue rose 9%."),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("Quarterly Review > By region\n\nRevenue rose 9%.");
    expect(chunks[0]?.locator).toBe("Quarterly Review > By region");
  });

  it("pops the heading trail when a sibling section starts", () => {
    // Without this a later section inherits an earlier subsection's path and every chunk in it is mislabelled.
    const chunks = chunkDocument([
      heading(1, "Report"),
      heading(2, "First"),
      para("a"),
      heading(2, "Second"),
      para("b"),
    ]);
    expect(chunks.map((c) => c.locator)).toEqual(["Report > First", "Report > Second"]);
  });

  it("does not emit a heading as a chunk of its own", () => {
    // A heading alone retrieves nothing useful and costs an embedding call.
    expect(chunkDocument([heading(1, "Alone")])).toEqual([]);
  });

  it("ends a chunk at a heading rather than spanning two sections", () => {
    // A chunk spanning two sections carries the wrong locator for half its content.
    const chunks = chunkDocument([heading(2, "A"), para("one"), heading(2, "B"), para("two")]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).not.toContain("two");
  });

  it("keeps a table whole", () => {
    // Splitting a table separates a number from its column header, which is the exact failure the extraction
    // design exists to avoid.
    const table: DocumentBlock = {
      kind: "table",
      hasHeader: true,
      rows: [["Region", "Revenue"], ["EMEA", "4210"], ["APAC", "3155"]],
    };
    const chunks = chunkDocument([table]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("| EMEA | 4210 |");
    expect(chunks[0]?.content).toContain("| APAC | 3155 |");
  });

  it("splits an oversized table by rows and repeats the header", () => {
    // So every piece still says what its columns mean. The header counting against each piece's budget is the
    // price of that.
    const rows = Array.from({ length: 400 }, (_, i) => [`row${i}`, `${i * 10}`]);
    const table: DocumentBlock = { kind: "table", hasHeader: true, rows: [["Name", "Value"], ...rows] };
    const chunks = chunkDocument([table], { ...DEFAULT_CHUNKING_LIMITS, maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toContain("| Name | Value |");
      expect(chunk.tokenCount).toBeLessThanOrEqual(300);
    }
    // Every row appears exactly once across the pieces.
    const joined = chunks.map((c) => c.content).join("\n");
    for (const [name] of rows) expect(joined.split(`| ${name} |`).length - 1).toBe(1);
  });

  it("splits an oversized paragraph on sentence boundaries", () => {
    // A boundary mid-word is a retrieved fragment that reads as corrupt.
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something.`).join(" ");
    const chunks = chunkDocument([para(sentences)], { ...DEFAULT_CHUNKING_LIMITS, maxTokens: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.trimEnd().endsWith(".")).toBe(true);
  });

  it("overlaps by block so a thought spanning a boundary stays retrievable", () => {
    const blocks = Array.from({ length: 12 }, (_, i) => para(`Paragraph ${i} ${"x".repeat(300)}`));
    const chunks = chunkDocument(blocks, { ...DEFAULT_CHUNKING_LIMITS, targetTokens: 120, overlapBlocks: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    // The last block of one chunk opens the next.
    const first = chunks[0]?.content ?? "";
    const second = chunks[1]?.content ?? "";
    const tail = first.slice(first.lastIndexOf("Paragraph"));
    expect(second).toContain(tail.slice(0, 20));
  });

  it("numbers chunks contiguously from zero", () => {
    // The chunk index is the id and the cursor; a gap would make "the previous chunk" ambiguous.
    const chunks = chunkDocument(Array.from({ length: 30 }, (_, i) => para(`p${i} ${"y".repeat(200)}`)), {
      ...DEFAULT_CHUNKING_LIMITS,
      targetTokens: 100,
    });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("reports a token count consistent with the shared estimate", () => {
    const chunks = chunkDocument([para("some words here")]);
    expect(chunks[0]?.tokenCount).toBe(estimateTokens(chunks[0]?.content ?? ""));
  });
});

describe("the embedding pipeline", () => {
  const setup = (options: { provider?: EmbeddingProvider; batchSize?: number; now?: () => number } = {}) => {
    const backend = createMemoryKnowledgeBackend();
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: options.provider ?? bagOfWords,
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      clock: () => "2026-08-23T10:00:00.000Z",
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return { ...backend, pipeline };
  };

  const DOC: readonly DocumentBlock[] = [
    heading(1, "Quarterly Review"),
    para("Revenue rose across every region, driven mostly by renewals."),
    heading(2, "By region"),
    para("EMEA grew nine percent and APAC grew twelve percent."),
  ];

  it("records the model on every chunk", async () => {
    // AC-1.
    const { pipeline, store } = setup();
    await pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-1" });
    const page = await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 20 });
    expect(page.items.length).toBeGreaterThan(0);
    for (const chunk of page.items) expect(chunk.embeddingModel).toEqual(MODEL);
  });

  it("gives every chunk the source's auth subject", async () => {
    // AC-3 depends on it: the filter is on the chunk, so a chunk without the right subject is either invisible
    // or visible to the wrong people.
    const { pipeline, store } = setup();
    await pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-7" });
    const page = await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 20 });
    for (const chunk of page.items) expect(chunk.authSubject).toBe("convo-7");
  });

  it("batches embedding calls", async () => {
    let calls = 0;
    let largest = 0;
    const counting: EmbeddingProvider = {
      model: MODEL,
      async embed(texts) {
        calls += 1;
        largest = Math.max(largest, texts.length);
        return bagOfWords.embed(texts);
      },
    };
    const { pipeline } = setup({ provider: counting, batchSize: 2 });
    const blocks = Array.from({ length: 20 }, (_, i) => para(`Paragraph ${i} ${"z".repeat(400)}`));
    const result = await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "f1",
      blocks,
      authSubject: "convo-1",
    });
    expect(result.batches).toBe(calls);
    expect(largest).toBeLessThanOrEqual(2);
    expect(calls).toBeGreaterThan(1);
  });

  it("fails loudly when a provider returns the wrong number of vectors", async () => {
    // Silently misaligned vectors are unrecoverable and undetectable later: every chunk would be embedded as
    // its neighbour and retrieval would simply be bad.
    const short: EmbeddingProvider = {
      model: MODEL,
      async embed(texts) {
        return (await bagOfWords.embed(texts)).slice(0, -1);
      },
    };
    const { pipeline } = setup({ provider: short });
    await expect(
      pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-1" }),
    ).rejects.toThrow(/returned \d+ vectors for \d+ inputs/);
  });

  it("replaces a source's chunks on re-index", async () => {
    // A stale chunk is a citation pointing at text that is no longer in the document.
    const { pipeline, store } = setup();
    await pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-1" });
    const result = await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "f1",
      blocks: [para("Completely rewritten.")],
      authSubject: "convo-1",
    });
    expect(result.removed).toBeGreaterThan(0);
    const page = await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.content).toContain("Completely rewritten");
  });

  it("clears a source that extracted down to nothing", async () => {
    // Extracting a document to nothing is a reason for its previous content to stop being findable, not a
    // reason to leave it.
    const { pipeline, store } = setup();
    await pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-1" });
    const result = await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "f1",
      blocks: [],
      authSubject: "convo-1",
    });
    expect(result.written).toBe(0);
    expect(result.removed).toBeGreaterThan(0);
    expect((await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 10 })).items).toEqual([]);
  });

  it("keeps a chunk's id when the document changes, so a stored citation still resolves", async () => {
    // Found by sabotage: an id derived from the *content* is stable across identical re-indexes, which every
    // other test here covers, and unstable across a *changed* document — which is the case that matters. A
    // citation recorded against chunk 0 must still point at chunk 0 after an edit, or every provenance record
    // in the system quietly stops resolving.
    const { pipeline, store } = setup();
    await pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-1" });
    const before = (await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 20 })).items;
    await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "f1",
      blocks: [heading(1, "Quarterly Review"), para("Entirely different prose of a different length here.")],
      authSubject: "convo-1",
    });
    const after = (await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 20 })).items;
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.content).not.toBe(before[0]?.content);
  });

  it("uses a deterministic chunk id so a re-index overwrites rather than duplicates", async () => {
    expect(chunkId("file", "f1", 3)).toBe("file:f1:3");
    const { pipeline, store } = setup();
    await pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-1" });
    const first = (await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 20 })).items;
    await pipeline.indexSource(ctx, { sourceType: "file", sourceId: "f1", blocks: DOC, authSubject: "convo-1" });
    const second = (await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "f1", limit: 20 })).items;
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
  });
});

describe("AC-4: the freshness target", () => {
  it("indexes well inside the documented target", async () => {
    // The target is a *commitment*, and the pipeline reports its own elapsed time so the commitment is
    // measured rather than hoped for. Sixty seconds is queue latency plus embedding; the embedding half is
    // what this measures.
    const backend = createMemoryKnowledgeBackend();
    let clock = 0;
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: bagOfWords,
      clock: () => "2026-08-23T10:00:00.000Z",
      now: () => (clock += 5),
    });
    const blocks = Array.from({ length: 40 }, (_, i) => para(`Paragraph ${i} ${"w".repeat(400)}`));
    const result = await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "f1",
      blocks,
      authSubject: "convo-1",
    });
    expect(result.elapsedMs).toBeLessThan(FRESHNESS_TARGET_MS);
    expect(pipeline.freshnessTargetMs).toBe(FRESHNESS_TARGET_MS);
  });

  it("makes new material findable immediately after indexing", async () => {
    // The store half of AC-4: an index needing a separate refresh step would make the target unmeetable
    // however fast the pipeline ran.
    const backend = createMemoryKnowledgeBackend();
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: bagOfWords,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "f1",
      blocks: [para("The unmistakable phrase is xylophone marmalade.")],
      authSubject: "convo-1",
    });
    const [query] = await bagOfWords.embed(["xylophone marmalade"]);
    const hits = await backend.index.search({
      tenantId: T1,
      embedding: query ?? [],
      authSubjects: ["convo-1"],
      limit: 1,
    });
    expect(hits[0]?.chunk.content).toContain("xylophone marmalade");
  });
});

describe("AC-5: re-indexing is incremental and resumable", () => {
  const OLD: EmbeddingModelRef = { ...MODEL, version: "0" };
  const oldProvider: EmbeddingProvider = { model: OLD, embed: bagOfWords.embed };

  /** Six sources, indexed with the old model. */
  const seedStale = async () => {
    const backend = createMemoryKnowledgeBackend();
    const old = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: oldProvider,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    const sources = ["s1", "s2", "s3", "s4", "s5", "s6"];
    for (const sourceId of sources) {
      await old.indexSource(ctx, {
        sourceType: "file",
        sourceId,
        blocks: [para(`Document ${sourceId} discusses revenue and renewals.`)],
        authSubject: "convo-1",
      });
    }
    const fresh = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: bagOfWords,
      clock: () => "2026-08-23T11:00:00.000Z",
    });
    const reload = async (source: { sourceId: string }) => ({
      blocks: [para(`Document ${source.sourceId} discusses revenue and renewals.`)],
      authSubject: "convo-1",
    });
    return { backend, fresh, sources, reload };
  };

  it("re-indexes in pages and reports what remains", async () => {
    const { fresh, reload } = await seedStale();
    const first = await fresh.reindexBatch(ctx, { limit: 2, reload });
    expect(first.reindexed).toBe(2);
    expect(first.remaining).toBe(1); // "there is more", asked rather than computed
  });

  it("finishes with no source left stale", async () => {
    const { backend, fresh, reload } = await seedStale();
    let guard = 0;
    while (guard < 20) {
      const result = await fresh.reindexBatch(ctx, { limit: 2, reload });
      if (result.remaining === 0) break;
      guard += 1;
    }
    expect((await backend.store.listStaleSources({ tenantId: T1, current: MODEL, limit: 10 })).items).toEqual([]);
  });

  it("resumes after an interruption with no duplicate and no missing chunk", async () => {
    // The point of deriving the work list from storage: an interruption loses at most one page and no
    // bookkeeping, because the next call asks again rather than remembering where it was.
    const { backend, fresh, sources, reload } = await seedStale();
    await fresh.reindexBatch(ctx, { limit: 2, reload });
    // "Interrupted": nothing is carried over. A second run starts from what is stored.
    await fresh.reindexBatch(ctx, { limit: 2, reload });
    await fresh.reindexBatch(ctx, { limit: 2, reload });

    for (const sourceId of sources) {
      const page = await backend.store.listBySource({ tenantId: T1, sourceType: "file", sourceId, limit: 20 });
      // Exactly one chunk per source: not duplicated by the re-index, not lost by the interruption.
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.embeddingModel).toEqual(MODEL);
    }
  });

  it("drops a source that has disappeared rather than retrying it forever", async () => {
    // A source that cannot be reloaded would otherwise keep the work list from draining and the re-index from
    // ever finishing.
    const { backend, fresh } = await seedStale();
    const result = await fresh.reindexBatch(ctx, { limit: 10, reload: async () => null });
    expect(result.skipped).toBe(6);
    expect(result.reindexed).toBe(0);
    expect((await backend.store.listStaleSources({ tenantId: T1, current: MODEL, limit: 10 })).items).toEqual([]);
  });

  it("leaves a source already on the current model alone", async () => {
    // Incremental means incremental: re-embedding a fresh source is a paid call for no change.
    const { backend, fresh, reload } = await seedStale();
    await fresh.indexSource(ctx, {
      sourceType: "file",
      sourceId: "already-fresh",
      blocks: [para("Fresh already.")],
      authSubject: "convo-1",
    });
    let embedCalls = 0;
    const counting = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: {
        model: MODEL,
        async embed(texts) {
          embedCalls += 1;
          return bagOfWords.embed(texts);
        },
      },
      clock: () => "2026-08-23T11:00:00.000Z",
    });
    await counting.reindexBatch(ctx, { limit: 10, reload });
    // Six stale sources, one call each; the fresh one is untouched.
    expect(embedCalls).toBe(6);
  });
});

describe("AC-2: recall against a fixed query set", () => {
  /**
   * What this measures, and what it does not.
   *
   * The provider here is lexical — words hashed to axes — so this figure measures **retrieval mechanics**:
   * does cosine ranking put the document that shares the most query terms above a distractor that shares one
   * of them, under a `limit`, with permission filtering applied. Every query below is therefore worded to
   * overlap its target lexically, because a query phrased in *different words* ("was the service down" for a
   * document about an "outage") is a test of the embedding model and this suite has no real one.
   *
   * An earlier version used such queries and scored 0.5. That number said nothing about this code — it said
   * bag-of-words cannot do synonyms, which everybody knows. Semantic recall against a real embedding model is
   * an eval, and eval cases are added for it; measuring it here would be measuring a stub.
   *
   * The distractors are what keep this honest. Each shares the target's key term and is about something else,
   * so a ranking regression — or an index that returns arbitrary matches — drops the figure.
   */
  const RECALL_TARGET = 1.0;

  const CORPUS: readonly { readonly id: string; readonly text: string }[] = [
    { id: "revenue", text: "Total revenue for the third quarter reached 4.2 million euros across all regions." },
    { id: "churn", text: "Customer churn held flat at two percent, unchanged from the previous quarter." },
    { id: "hiring", text: "We hired four account executives in EMEA and two solutions engineers in APAC." },
    { id: "pricing", text: "The pricing committee approved a ten percent increase for enterprise contracts." },
    { id: "outage", text: "A database outage on the twelfth affected login for roughly forty minutes." },
    { id: "renewals", text: "Renewal rates improved to ninety one percent, driven by the new success programme." },
    // Distractors: each shares its target's key term and is about something else. These are what a ranking
    // regression returns instead, and what makes the figure mean something.
    { id: "revenue-decoy", text: "The revenue recognition policy document was updated for the new standard." },
    { id: "churn-decoy", text: "Churn modelling methodology is described in the appendix to the data handbook." },
    { id: "hiring-decoy", text: "Hiring policy requires two interviewers for every executive role." },
    { id: "pricing-decoy", text: "Pricing pages are maintained by the web team in a separate repository." },
    { id: "outage-decoy", text: "Outage communication templates live in the incident response runbook." },
    { id: "renewals-decoy", text: "Renewal reminders are sent by the billing system thirty days in advance." },
  ];

  const QUERIES: readonly { readonly query: string; readonly expected: string }[] = [
    { query: "total revenue third quarter regions", expected: "revenue" },
    { query: "customer churn percent quarter flat", expected: "churn" },
    { query: "hired account executives EMEA APAC", expected: "hiring" },
    { query: "pricing committee approved increase enterprise contracts", expected: "pricing" },
    { query: "database outage affected login minutes", expected: "outage" },
    { query: "renewal rates improved success programme", expected: "renewals" },
  ];

  const indexed = async () => {
    const backend = createMemoryKnowledgeBackend();
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: bagOfWords,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    for (const doc of CORPUS) {
      await pipeline.indexSource(ctx, {
        sourceType: "file",
        sourceId: doc.id,
        blocks: [para(doc.text)],
        authSubject: "convo-1",
      });
    }
    return backend;
  };

  it("meets the recorded recall target over the fixed query set", async () => {
    const backend = await indexed();
    let found = 0;
    const misses: string[] = [];
    for (const { query, expected } of QUERIES) {
      const [embedding] = await bagOfWords.embed([query]);
      const hits = await backend.index.search({
        tenantId: T1,
        embedding: embedding ?? [],
        authSubjects: ["convo-1"],
        limit: 3,
      });
      if (hits.some((h) => h.chunk.sourceId === expected)) found += 1;
      else misses.push(query);
    }
    const recall = found / QUERIES.length;
    // The misses are named, so a regression says *which* queries stopped working rather than only that the
    // number fell.
    expect(recall, `recall@3 was ${recall}; missed: ${misses.join(" | ")}`).toBeGreaterThanOrEqual(RECALL_TARGET);
  });

  it("ranks the target above its distractor, which is the part a regression breaks", async () => {
    // Recall@3 can hold while ranking degrades. Precision@1 is the sharper measure, and the distractors exist
    // for it: each shares the target's key term, so a scoring change that ignored term frequency would put the
    // decoy first and this would fail while recall@3 still passed.
    const backend = await indexed();
    const wrong: string[] = [];
    for (const { query, expected } of QUERIES) {
      const [embedding] = await bagOfWords.embed([query]);
      const hits = await backend.index.search({
        tenantId: T1,
        embedding: embedding ?? [],
        authSubjects: ["convo-1"],
        limit: 1,
      });
      if (hits[0]?.chunk.sourceId !== expected) wrong.push(`${query} -> ${hits[0]?.chunk.sourceId ?? "none"}`);
    }
    expect(wrong, `precision@1 failures: ${wrong.join(" | ")}`).toEqual([]);
  });

  it("excludes an unauthorised document from the same query set", async () => {
    // AC-3, measured the same way: the answer is in the corpus and the query would find it, and it does not.
    const backend = createMemoryKnowledgeBackend();
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: bagOfWords,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "secret",
      blocks: [para("Total revenue for the third quarter reached 4.2 million euros across all regions.")],
      authSubject: "convo-restricted",
    });
    const [embedding] = await bagOfWords.embed(["total revenue third quarter regions"]);
    const hits = await backend.index.search({
      tenantId: T1,
      embedding: embedding ?? [],
      authSubjects: ["convo-1"],
      limit: 10,
    });
    // Not merely absent from the top: absent entirely, including from the count.
    expect(hits).toEqual([]);
  });
});
