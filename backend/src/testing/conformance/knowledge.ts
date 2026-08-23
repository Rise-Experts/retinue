/**
 * `KnowledgeStore` and `VectorIndex` conformance (#135) — AC-6.
 *
 * Two harnesses over one fixture, because on pgvector both ports are one table and a suite that opened them
 * separately would never exercise the case that matters: a search seeing what a write just wrote.
 *
 * Both harnesses are gated on the `vector-search` capability. An adapter that cannot hold vectors — Postgres
 * without pgvector installed, which includes the PGlite the suite runs on by default — declares nothing and
 * every case registers as a *named* skip rather than vanishing from the report. `gatedIt` exists for exactly
 * this: an invisible skip is indistinguishable from coverage.
 *
 * The search cases assert the **contract**, not recall. pgvector's HNSW index is *approximate*, so
 * "the nearest chunk comes first" is something the production adapter is permitted to miss on a large corpus —
 * asserting it here would make the harness fail for a reason that is not a bug. What is asserted is what must
 * hold exactly at any size: tenant isolation, permission filtering, the limit, score ordering among returned
 * hits, and that no vector ever comes back. Recall is measured separately against a fixed query set.
 */

import { describe, expect } from "vitest";
import { gatedIt, type AdapterDeclaration } from "./capability.js";
import type { TenantId } from "../../core/ids.js";
import { asId } from "../../core/ids.js";
import type {
  EmbeddingModelRef,
  KnowledgeChunkWithEmbedding,
  KnowledgeStore,
  VectorIndex,
} from "../../persistence/index.js";

const T1 = asId<TenantId>("conf-knowledge-tenant-1");
const T2 = asId<TenantId>("conf-knowledge-tenant-2");
const AT = "2026-08-23T12:00:00.000Z";

/** 1536, because that is what the pgvector schema declares and a vector of another length is rejected. */
export const CONFORMANCE_DIMENSIONS = 1536;

export const MODEL: EmbeddingModelRef = {
  modelId: "conf-embed",
  version: "1",
  dimensions: CONFORMANCE_DIMENSIONS,
};

/**
 * A deterministic vector pointing mostly along one axis.
 *
 * Deterministic because a recall figure that moves between runs is a figure nobody can act on, and axis-aligned
 * because it makes "closer" obvious: a query along axis 3 must rank the chunk built on axis 3 first, with no
 * dependence on floating-point luck.
 */
export const axisVector = (axis: number, magnitude = 1): readonly number[] => {
  const v = new Array<number>(CONFORMANCE_DIMENSIONS).fill(0.0001);
  v[axis % CONFORMANCE_DIMENSIONS] = magnitude;
  return v;
};

const chunk = (
  overrides: Partial<KnowledgeChunkWithEmbedding> & { readonly index: number },
): KnowledgeChunkWithEmbedding => ({
  id: overrides.id ?? `c${overrides.index}`,
  sourceType: overrides.sourceType ?? "file",
  sourceId: overrides.sourceId ?? "file-1",
  chunkIndex: overrides.chunkIndex ?? overrides.index,
  content: overrides.content ?? `chunk ${overrides.index}`,
  tokenCount: overrides.tokenCount ?? 10,
  authSubject: overrides.authSubject ?? "convo-1",
  embeddingModel: overrides.embeddingModel ?? MODEL,
  ...(overrides.locator === undefined ? {} : { locator: overrides.locator }),
  createdAt: overrides.createdAt ?? AT,
  embedding: overrides.embedding ?? axisVector(overrides.index),
});

/** Both ports over the same backing store, which is how pgvector provides them. */
export type KnowledgeFixture = {
  readonly store: KnowledgeStore;
  readonly index: VectorIndex;
};

export function knowledgeStoreConformance(
  make: () => KnowledgeFixture | Promise<KnowledgeFixture>,
  declaration?: AdapterDeclaration,
): void {
  describe("KnowledgeStore conformance", () => {
    const it = (name: string, fn: () => Promise<void>) => gatedIt(declaration, "vector-search", name, fn);
    it("writes a source's chunks and reads them back in order", async () => {
      const { store } = await make();
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "file-1",
        chunks: [chunk({ index: 2 }), chunk({ index: 0 }), chunk({ index: 1 })],
      });
      const page = await store.listBySource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "file-1",
        limit: 10,
      });
      // Document order, not insertion order: reading around a hit depends on it being the document's order.
      expect(page.items.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    });

    it("never returns the embedding", async () => {
      // Nothing above this layer needs it, and it is by far the largest field -- returning it would make every
      // listing an order of magnitude more expensive for a value nobody reads.
      const { store } = await make();
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "file-1", chunks: [chunk({ index: 0 })] });
      const found = await store.get({ tenantId: T1, id: "c0" });
      expect(found).not.toBeNull();
      expect(Object.keys(found ?? {})).not.toContain("embedding");
    });

    it("records the model that produced each chunk", async () => {
      // AC-1. Per chunk, not per deployment: a global setting cannot tell you which rows are stale, which
      // makes incremental re-indexing impossible.
      const { store } = await make();
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "file-1", chunks: [chunk({ index: 0 })] });
      expect((await store.get({ tenantId: T1, id: "c0" }))?.embeddingModel).toEqual(MODEL);
    });

    it("replaces rather than appends", async () => {
      // A changed document's old chunks must stop being searchable: a stale chunk is a citation pointing at
      // text that is no longer there.
      const { store } = await make();
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "file-1",
        chunks: [chunk({ index: 0 }), chunk({ index: 1 }), chunk({ index: 2 })],
      });
      const result = await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "file-1",
        chunks: [chunk({ index: 0, content: "rewritten" })],
      });
      expect(result).toEqual({ written: 1, removed: 3 });
      const page = await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "file-1", limit: 10 });
      expect(page.items.map((c) => c.content)).toEqual(["rewritten"]);
    });

    it("does not touch another source when replacing one", async () => {
      const { store } = await make();
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "a", chunks: [chunk({ index: 0, id: "a0", sourceId: "a" })] });
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "b", chunks: [chunk({ index: 0, id: "b0", sourceId: "b" })] });
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "a", chunks: [] });
      expect((await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "b", limit: 10 })).items).toHaveLength(1);
    });

    it("treats the same id under a different source type as a different source", async () => {
      // A file and an artifact can share an id. Keying on the id alone would have one delete the other's chunks.
      const { store } = await make();
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "x", chunks: [chunk({ index: 0, id: "f0", sourceId: "x" })] });
      await store.replaceSource({
        tenantId: T1,
        sourceType: "artifact",
        sourceId: "x",
        chunks: [chunk({ index: 0, id: "a0", sourceType: "artifact", sourceId: "x" })],
      });
      expect((await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "x", limit: 10 })).items).toHaveLength(1);
      expect((await store.listBySource({ tenantId: T1, sourceType: "artifact", sourceId: "x", limit: 10 })).items).toHaveLength(1);
    });

    it("returns null for another tenant's chunk", async () => {
      const { store } = await make();
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "file-1", chunks: [chunk({ index: 0 })] });
      expect(await store.get({ tenantId: T2, id: "c0" })).toBeNull();
      expect((await store.listBySource({ tenantId: T2, sourceType: "file", sourceId: "file-1", limit: 10 })).items).toEqual([]);
    });

    it("refuses a vector whose length contradicts its declared dimensions", async () => {
      // A wrong-length vector would score against whatever prefix overlapped, which looks like bad relevance
      // rather than a bug.
      const { store } = await make();
      await expect(
        store.replaceSource({
          tenantId: T1,
          sourceType: "file",
          sourceId: "file-1",
          chunks: [chunk({ index: 0, embedding: [0.1, 0.2, 0.3] })],
        }),
      ).rejects.toThrow();
    });

    it("removes a source's chunks on delete", async () => {
      // A deleted document's content must stop being searchable.
      const { store } = await make();
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "file-1",
        chunks: [chunk({ index: 0 }), chunk({ index: 1 })],
      });
      expect(await store.deleteSource({ tenantId: T1, sourceType: "file", sourceId: "file-1" })).toEqual({ removed: 2 });
      expect((await store.listBySource({ tenantId: T1, sourceType: "file", sourceId: "file-1", limit: 10 })).items).toEqual([]);
    });

    it("does not delete another tenant's source", async () => {
      const { store } = await make();
      await store.replaceSource({ tenantId: T1, sourceType: "file", sourceId: "file-1", chunks: [chunk({ index: 0 })] });
      expect(await store.deleteSource({ tenantId: T2, sourceType: "file", sourceId: "file-1" })).toEqual({ removed: 0 });
      expect(await store.get({ tenantId: T1, id: "c0" })).not.toBeNull();
    });

    it("pages a source's chunks without repeating or skipping one", async () => {
      const { store } = await make();
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "file-1",
        chunks: [0, 1, 2, 3, 4].map((i) => chunk({ index: i })),
      });
      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listBySource({
          tenantId: T1,
          sourceType: "file",
          sourceId: "file-1",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((c) => c.chunkIndex));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toEqual([0, 1, 2, 3, 4]);
    });

    it("lists exactly the sources a model change made stale", async () => {
      // AC-5's basis: the work list is derived from what is stored, so an interrupted re-index resumes by
      // asking again rather than by remembering where it was.
      const { store } = await make();
      const older: EmbeddingModelRef = { ...MODEL, version: "0" };
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "stale-1",
        chunks: [chunk({ index: 0, id: "s0", sourceId: "stale-1", embeddingModel: older })],
      });
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "fresh-1",
        chunks: [chunk({ index: 0, id: "f0", sourceId: "fresh-1" })],
      });
      const page = await store.listStaleSources({ tenantId: T1, current: MODEL, limit: 10 });
      expect(page.items).toEqual([{ sourceType: "file", sourceId: "stale-1", chunkCount: 1 }]);
    });

    it("refuses a vector of a different size rather than storing two sizes at once", async () => {
      // A provider that keeps its model id and changes its *output size* is a different case from one that
      // changes its version, and it is not a re-index: a vector column has one width and an index cannot span
      // widths, so a size change is a **migration**. Asserted as a refusal rather than as staleness, because
      // the store genuinely cannot hold both — found by running this harness against real pgvector, which
      // rejected the 768-dimension write the earlier version of this case tried to make.
      const { store } = await make();
      await expect(
        store.replaceSource({
          tenantId: T1,
          sourceType: "file",
          sourceId: "resized",
          chunks: [
            chunk({
              index: 0,
              id: "r0",
              sourceId: "resized",
              embeddingModel: { ...MODEL, dimensions: 768 },
              embedding: new Array<number>(768).fill(0.1),
            }),
          ],
        }),
      ).rejects.toThrow();
    });

    it("lists no stale source for another tenant", async () => {
      const { store } = await make();
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "stale-1",
        chunks: [chunk({ index: 0, embeddingModel: { ...MODEL, version: "0" } })],
      });
      expect((await store.listStaleSources({ tenantId: T2, current: MODEL, limit: 10 })).items).toEqual([]);
    });
  });
}

export function vectorIndexConformance(
  make: () => KnowledgeFixture | Promise<KnowledgeFixture>,
  declaration?: AdapterDeclaration,
): void {
  describe("VectorIndex conformance", () => {
    const it = (name: string, fn: () => Promise<void>) => gatedIt(declaration, "vector-search", name, fn);
    const seeded = async (): Promise<KnowledgeFixture> => {
      const fixture = await make();
      await fixture.store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "file-1",
        chunks: [
          chunk({ index: 0, id: "own-0", authSubject: "convo-1", embedding: axisVector(0) }),
          chunk({ index: 1, id: "own-1", authSubject: "convo-1", embedding: axisVector(1) }),
          chunk({ index: 2, id: "other-2", authSubject: "convo-2", embedding: axisVector(0) }),
        ],
      });
      await fixture.store.replaceSource({
        tenantId: T2,
        sourceType: "file",
        sourceId: "file-1",
        chunks: [chunk({ index: 0, id: "foreign-0", authSubject: "convo-1", embedding: axisVector(0) })],
      });
      return fixture;
    };

    it("returns the chunk nearest the query", async () => {
      const { index } = await seeded();
      const hits = await index.search({
        tenantId: T1,
        embedding: axisVector(1),
        authSubjects: ["convo-1"],
        limit: 1,
      });
      expect(hits.map((h) => h.chunk.id)).toEqual(["own-1"]);
      expect(hits[0]?.score).toBeGreaterThan(0.5);
    });

    it("excludes a chunk whose subject was not asked for", async () => {
      // AC-3. `other-2` sits on the same axis as `own-0`, so it *would* be a top hit if the filter were
      // applied after retrieval -- which is exactly the leak this asserts against.
      const { index } = await seeded();
      const hits = await index.search({
        tenantId: T1,
        embedding: axisVector(0),
        authSubjects: ["convo-1"],
        limit: 10,
      });
      expect(hits.map((h) => h.chunk.id)).not.toContain("other-2");
    });

    it("returns nothing for an empty subject list", async () => {
      // "No subjects" must mean nothing, not everything. The opposite reading is the worst possible default.
      const { index } = await seeded();
      expect(
        await index.search({ tenantId: T1, embedding: axisVector(0), authSubjects: [], limit: 10 }),
      ).toEqual([]);
    });

    it("does not return another tenant's chunk however close it is", async () => {
      const { index } = await seeded();
      const hits = await index.search({
        tenantId: T1,
        embedding: axisVector(0),
        authSubjects: ["convo-1"],
        limit: 10,
      });
      expect(hits.map((h) => h.chunk.id)).not.toContain("foreign-0");
    });

    it("honours the limit", async () => {
      const { index } = await seeded();
      expect(
        await index.search({ tenantId: T1, embedding: axisVector(0), authSubjects: ["convo-1", "convo-2"], limit: 1 }),
      ).toHaveLength(1);
    });

    it("returns hits in descending score order", async () => {
      const { index } = await seeded();
      const hits = await index.search({
        tenantId: T1,
        embedding: axisVector(0),
        authSubjects: ["convo-1", "convo-2"],
        limit: 10,
      });
      const scores = hits.map((h) => h.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it("drops hits below the minimum score", async () => {
      // Prevents a query with no good answer returning noise, which a model then cites.
      const { index } = await seeded();
      const hits = await index.search({
        tenantId: T1,
        embedding: axisVector(1),
        authSubjects: ["convo-1"],
        limit: 10,
        minScore: 0.9,
      });
      expect(hits.map((h) => h.chunk.id)).toEqual(["own-1"]);
    });

    it("filters by source type when asked", async () => {
      const { index } = await seeded();
      expect(
        await index.search({
          tenantId: T1,
          embedding: axisVector(0),
          authSubjects: ["convo-1"],
          limit: 10,
          sourceTypes: ["artifact"],
        }),
      ).toEqual([]);
    });

    it("never returns a vector with a hit", async () => {
      const { index } = await seeded();
      const hits = await index.search({
        tenantId: T1,
        embedding: axisVector(0),
        authSubjects: ["convo-1"],
        limit: 10,
      });
      for (const hit of hits) expect(Object.keys(hit.chunk)).not.toContain("embedding");
    });

    it("finds a chunk written a moment ago", async () => {
      // AC-4's mechanism at the store level: an index that needed a refresh step would fail here, and the
      // freshness target would be unmeetable however fast the pipeline ran.
      const { store, index } = await seeded();
      await store.replaceSource({
        tenantId: T1,
        sourceType: "file",
        sourceId: "brand-new",
        chunks: [chunk({ index: 7, id: "new-7", sourceId: "brand-new", authSubject: "convo-1", embedding: axisVector(7) })],
      });
      const hits = await index.search({
        tenantId: T1,
        embedding: axisVector(7),
        authSubjects: ["convo-1"],
        limit: 1,
      });
      expect(hits.map((h) => h.chunk.id)).toEqual(["new-7"]);
    });
  });
}
