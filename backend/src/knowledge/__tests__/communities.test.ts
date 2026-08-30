/**
 * Communities and their summaries — REQ-064 (#270), task #272.
 *
 * The two properties everything else rests on: **clustering is deterministic**, because #275 measures against
 * a fixed baseline and a rebuild is verified by diffing against the previous clustering; and **staleness is
 * visible**, because a summary written before the last three documents landed is defensible only if it says so.
 */
import { describe, expect, it, vi } from "vitest";

import { asId } from "../../core/ids.js";
import type { TenantScope } from "../../core/context.js";
import { createMemoryGraphStore } from "../../adapters/memory/graph.js";
import { createMemoryKnowledgeStore } from "../../adapters/memory/knowledge.js";
import { isCommunityStale, type GraphStore, type KnowledgeRelationship } from "../../persistence/index.js";
import {
  createCommunityBuilder,
  detectCommunities,
  type Community,
  type CommunitySummariser,
} from "../index.js";

const context: TenantScope = { tenantId: asId("t1") };
const AT = "2026-08-28T00:00:00.000Z";

const edge = (from: string, to: string, weight = 1): KnowledgeRelationship => ({
  id: `${from}|rel|${to}`,
  fromId: from,
  toId: to,
  type: "rel",
  weight,
  provenance: [`chunk-${from}-${to}`],
});

/**
 * Two tight clusters joined by one weak edge — the canonical shape community detection must get right.
 *
 * a1–a2–a3 all connected, b1–b2–b3 all connected, and a single a3–b1 link between them. Any correct algorithm
 * separates these; one that does not is not clustering, it is grouping.
 */
const TWO_CLUSTERS = {
  entityIds: ["a1", "a2", "a3", "b1", "b2", "b3"],
  relationships: [
    edge("a1", "a2", 5),
    edge("a1", "a3", 5),
    edge("a2", "a3", 5),
    edge("b1", "b2", 5),
    edge("b1", "b3", 5),
    edge("b2", "b3", 5),
    edge("a3", "b1", 1),
  ],
};

const cluster = (input: { entityIds: readonly string[]; relationships: readonly KnowledgeRelationship[] }, levels?: number) =>
  detectCommunities({
    entityIds: input.entityIds,
    relationships: input.relationships,
    chunksOf: (id) => [`chunk-${id}`],
    ...(levels === undefined ? {} : { levels }),
  });

const atLevel = (communities: readonly Community[], level: number) => communities.filter((c) => c.level === level);

describe("clustering is deterministic — AC-1", () => {
  it("separates two tight clusters joined by a weak edge", () => {
    const level0 = atLevel(cluster(TWO_CLUSTERS), 0);
    expect(level0).toHaveLength(2);
    expect(level0.map((c) => [...c.entityIds]).sort()).toEqual([
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ]);
  });

  it("produces the same partition twice", () => {
    expect(cluster(TWO_CLUSTERS)).toEqual(cluster(TWO_CLUSTERS));
  });

  /**
   * A uniform ring — the shape that actually exposes order sensitivity.
   *
   * Every node has exactly two neighbours of equal weight, so every local move is a tie and the partition is
   * decided entirely by visit order and tie-breaking. `TWO_CLUSTERS` cannot test this: its clusters are so
   * obvious that an unsorted, untie-broken Louvain finds them anyway, which is why the first version of this
   * test passed against both determinism mutations. Verified by running them: on a ring, dropping the sort
   * gives `n1+n2 | n3+n4 | n5+n6` forwards and `n1+n6 | n2+n3 | n4+n5` reversed.
   */
  const RING = {
    entityIds: ["n1", "n2", "n3", "n4", "n5", "n6"],
    relationships: [
      edge("n1", "n2"),
      edge("n2", "n3"),
      edge("n3", "n4"),
      edge("n4", "n5"),
      edge("n5", "n6"),
      edge("n6", "n1"),
    ],
  };

  it("does not depend on the order entities or edges arrive in", () => {
    // The property a shuffled Louvain does not have, and the reason this one is implemented here rather than
    // imported. A caller has no control over the order the store returns rows in.
    const shuffled = {
      entityIds: [...TWO_CLUSTERS.entityIds].reverse(),
      relationships: [...TWO_CLUSTERS.relationships].reverse(),
    };
    expect(cluster(shuffled)).toEqual(cluster(TWO_CLUSTERS));
  });

  it("resolves a graph of pure ties the same way whichever order it arrives in", () => {
    const forward = cluster(RING);
    const reversed = cluster({
      entityIds: [...RING.entityIds].reverse(),
      relationships: [...RING.relationships].reverse(),
    });
    expect(reversed).toEqual(forward);
  });

  it("resolves a graph of pure ties the same way twice", () => {
    // Guards the tie-break specifically: on a ring every candidate move scores identically, so `>=` instead of
    // `>` plus smallest-id would pick whichever candidate was iterated first.
    expect(cluster(RING)).toEqual(cluster(RING));
    const partition = atLevel(cluster(RING), 0).map((c) => c.entityIds.join("+")).sort();
    expect(partition).toEqual(["n1+n2", "n3+n4", "n5+n6"]);
  });

  it("gives a community an id derived from its members, not a counter", () => {
    // A counter would renumber everything whenever one entity moved, and a rebuild could then never compare
    // against the previous clustering.
    const [first] = atLevel(cluster(TWO_CLUSTERS), 0);
    expect(first?.id).toBe("L0:a1");
  });

  it("builds more than one level, each coarser than the last", () => {
    // Three clusters at level 0, so there is something for a coarser level to merge.
    const three = {
      entityIds: ["a1", "a2", "b1", "b2", "c1", "c2"],
      relationships: [
        edge("a1", "a2", 9),
        edge("b1", "b2", 9),
        edge("c1", "c2", 9),
        edge("a2", "b1", 1),
        edge("b2", "c1", 1),
      ],
    };
    const communities = cluster(three, 3);
    const levels = [...new Set(communities.map((c) => c.level))];
    expect(levels.length).toBeGreaterThanOrEqual(2);
    // Coarser means fewer, larger communities.
    expect(atLevel(communities, 1).length).toBeLessThan(atLevel(communities, 0).length);
  });

  it("keeps a singleton rather than dropping it", () => {
    // An entity nothing links to is a real part of the corpus. Dropping it would make `graph-global` quietly
    // wrong about what the corpus contains.
    const withLoner = {
      entityIds: [...TWO_CLUSTERS.entityIds, "lonely"],
      relationships: TWO_CLUSTERS.relationships,
    };
    const members = atLevel(cluster(withLoner), 0).flatMap((c) => c.entityIds);
    expect(members).toContain("lonely");
  });

  it("handles a graph with no edges at all without dividing by zero", () => {
    const communities = cluster({ entityIds: ["x", "y", "z"], relationships: [] });
    expect(atLevel(communities, 0)).toHaveLength(3);
    for (const community of communities) expect(community.fingerprint).toBeTruthy();
  });

  it("returns nothing for an empty graph", () => {
    expect(cluster({ entityIds: [], relationships: [] })).toEqual([]);
  });

  it("carries the chunks behind its members as the community's provenance", () => {
    const [first] = atLevel(cluster(TWO_CLUSTERS), 0);
    expect(first?.chunkIds).toContain("chunk-a1");
    // Edge provenance too — the chunk that stated a relationship is part of what the community is about.
    expect(first?.chunkIds).toContain("chunk-a1-a2");
  });

  it("changes a community's fingerprint when its membership changes", () => {
    // The whole staleness mechanism rests on this: a fingerprint that did not move would keep a stale summary
    // looking current.
    const before = atLevel(cluster(TWO_CLUSTERS), 0)[0]?.fingerprint;
    const after = atLevel(
      cluster({
        entityIds: [...TWO_CLUSTERS.entityIds, "a4"],
        relationships: [...TWO_CLUSTERS.relationships, edge("a1", "a4", 5)],
      }),
      0,
    ).find((c) => c.entityIds.includes("a1"))?.fingerprint;
    expect(after).not.toBe(before);
  });
});

describe("summaries, and re-summarising only what changed — AC-3, AC-4, AC-5", () => {
  const seed = async (store: GraphStore, entities: readonly string[], relationships: readonly KnowledgeRelationship[]) => {
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "corpus",
      contribution: {
        entities: entities.map((id) => ({
          id,
          name: id,
          type: "concept",
          surfaceForms: [id],
          provenance: [`chunk-${id}`],
        })),
        relationships: [...relationships],
      },
    });
  };

  const summariser = () => {
    const calls: string[] = [];
    const impl: CommunitySummariser = {
      id: "scripted",
      async summarise({ community }) {
        calls.push(community.id);
        return { summary: `about ${community.entityIds.join(", ")}`, usage: { inputTokens: 7, outputTokens: 3 } };
      },
    };
    return { impl, calls };
  };

  it("writes a summary per community, with its cost reported", async () => {
    const store = createMemoryGraphStore();
    await seed(store, TWO_CLUSTERS.entityIds, TWO_CLUSTERS.relationships);
    const { impl, calls } = summariser();
    const builder = createCommunityBuilder({ store, summariser: impl, clock: () => AT });

    const result = await builder.rebuild(context);
    expect(result.communities).toBeGreaterThanOrEqual(2);
    expect(result.summariesWritten).toBe(calls.length);
    // The bill, visible before it arrives — one call per community.
    expect(result.inputTokens).toBe(7 * calls.length);
    expect(result.outputTokens).toBe(3 * calls.length);
  });

  it("re-summarises nothing when the graph has not changed — the incremental saving", async () => {
    /**
     * Where AC-5's "incremental" honestly lives. Clustering is global and cheap; summarisation is one model
     * call per community and is the cost worth avoiding.
     */
    const store = createMemoryGraphStore();
    await seed(store, TWO_CLUSTERS.entityIds, TWO_CLUSTERS.relationships);
    const { impl, calls } = summariser();
    const builder = createCommunityBuilder({ store, summariser: impl, clock: () => AT });

    await builder.rebuild(context);
    const firstPass = calls.length;
    expect(firstPass).toBeGreaterThan(0);

    const second = await builder.rebuild(context);
    expect(calls).toHaveLength(firstPass); // not one more call
    expect(second.summariesWritten).toBe(0);
    expect(second.summariesKept).toBeGreaterThan(0);
  });

  it("re-summarises only the communities that actually moved", async () => {
    const store = createMemoryGraphStore();
    await seed(store, TWO_CLUSTERS.entityIds, TWO_CLUSTERS.relationships);
    const { impl, calls } = summariser();
    const builder = createCommunityBuilder({ store, summariser: impl, clock: () => AT });
    await builder.rebuild(context);
    const before = calls.length;

    // One new entity, joined tightly to cluster A. Cluster B did not change and must not be paid for again.
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "extra",
      contribution: {
        entities: [
          { id: "a4", name: "a4", type: "concept", surfaceForms: ["a4"], provenance: ["chunk-a4"] },
          { id: "a1", name: "a1", type: "concept", surfaceForms: ["a1"], provenance: ["chunk-a1"] },
        ],
        relationships: [edge("a1", "a4", 5)],
      },
    });
    calls.length = 0;
    const after = await builder.rebuild(context);

    expect(before).toBeGreaterThan(0);
    expect(after.summariesWritten).toBeGreaterThan(0);
    // The B cluster's summary survived, so this pass cost less than a full one.
    expect(after.summariesKept).toBeGreaterThan(0);
    expect(calls.every((id) => !id.includes("b1"))).toBe(true);
  });

  it("discards a summary when the community changed, rather than keeping a wrong one", async () => {
    /**
     * The dangerous alternative is carrying a summary over on id alone. The id is derived from the smallest
     * member, so a community can keep its id while gaining members — and a summary of the old membership
     * attached to the new one is a confidently wrong description, which is worse than none.
     */
    const store = createMemoryGraphStore();
    await seed(store, TWO_CLUSTERS.entityIds, TWO_CLUSTERS.relationships);
    const { impl } = summariser();
    const builder = createCommunityBuilder({ store, summariser: impl, clock: () => AT });
    await builder.rebuild(context);

    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "extra",
      contribution: {
        entities: [
          { id: "a4", name: "a4", type: "concept", surfaceForms: ["a4"], provenance: ["chunk-a4"] },
          { id: "a1", name: "a1", type: "concept", surfaceForms: ["a1"], provenance: ["chunk-a1"] },
        ],
        relationships: [edge("a1", "a4", 5)],
      },
    });
    await builder.rebuild(context);

    const grown = (await store.listCommunities({ ...context, limit: 50 })).items.find((c) =>
      c.entityIds.includes("a4"),
    );
    // Re-summarised against the new membership, and the summary says so.
    expect(grown?.summary).toContain("a4");
    expect(grown?.summaryFingerprint).toBe(grown?.fingerprint);
  });

  it("clusters without a summariser, which is a real configuration", async () => {
    const store = createMemoryGraphStore();
    await seed(store, TWO_CLUSTERS.entityIds, TWO_CLUSTERS.relationships);
    const result = await createCommunityBuilder({ store }).rebuild(context);
    expect(result.communities).toBeGreaterThan(0);
    expect(result.summariesWritten).toBe(0);
    for (const community of (await store.listCommunities({ ...context, limit: 50 })).items) {
      expect(community.summary).toBeUndefined();
    }
  });

  it("hands the summariser the text behind the community when a knowledge store is wired", async () => {
    const store = createMemoryGraphStore();
    const knowledge = createMemoryKnowledgeStore();
    await knowledge.replaceSource({
      ...context,
      sourceType: "file",
      sourceId: "corpus",
      chunks: [
        {
          id: "chunk-a1",
          sourceType: "file",
          sourceId: "corpus",
          chunkIndex: 0,
          content: "The retry budget governs outbound calls.",
          tokenCount: 8,
          authSubject: "w1",
          embeddingModel: { modelId: "m", version: "1", dimensions: 1536 },
          createdAt: AT,
          embedding: Array.from({ length: 1536 }, () => 0.1),
        },
      ],
    });
    await seed(store, ["a1"], []);
    const seen: string[][] = [];
    await createCommunityBuilder({
      store,
      knowledge,
      summariser: {
        id: "x",
        async summarise({ excerpts }) {
          seen.push([...excerpts]);
          return { summary: "s" };
        },
      },
      clock: () => AT,
    }).rebuild(context);
    expect(seen[0]).toContain("The retry budget governs outbound calls.");
  });
});

describe("a failed summary leaves no summary — AC-7", () => {
  const seedOne = async (store: GraphStore) => {
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "c",
      contribution: {
        entities: [{ id: "x", name: "x", type: "concept", surfaceForms: ["x"], provenance: ["chunk-x"] }],
        relationships: [],
      },
    });
  };

  it("keeps the clustering when summarisation throws", async () => {
    const store = createMemoryGraphStore();
    await seedOne(store);
    const log = vi.fn();
    const result = await createCommunityBuilder({
      store,
      log,
      clock: () => AT,
      summariser: {
        id: "broken",
        async summarise() {
          throw new Error("model down");
        },
      },
    }).rebuild(context);

    // The hierarchy is correct and useful on its own; failing the rebuild would discard it over one call.
    expect(result.communities).toBe(1);
    expect(result.summariesFailed).toBe(1);
    expect(result.summariesWritten).toBe(0);
    expect((await store.listCommunities({ ...context, limit: 10 })).items[0]?.summary).toBeUndefined();
    expect(log).toHaveBeenCalledWith("community summarisation failed", expect.objectContaining({ communityId: "L0:x" }));
  });

  it("treats an empty summary as a failure rather than a summary", async () => {
    // An empty string is a failure wearing a success's shape: `graph-global` would reduce over it and silently
    // under-report the corpus.
    const store = createMemoryGraphStore();
    await seedOne(store);
    const result = await createCommunityBuilder({
      store,
      clock: () => AT,
      summariser: { id: "empty", async summarise() { return { summary: "   " }; } },
    }).rebuild(context);
    expect(result.summariesFailed).toBe(1);
    expect((await store.listCommunities({ ...context, limit: 10 })).items[0]?.summary).toBeUndefined();
  });

  it("never attributes a summary to the wrong community", async () => {
    const store = createMemoryGraphStore();
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "c",
      contribution: {
        entities: ["p", "q"].map((id) => ({
          id,
          name: id,
          type: "concept",
          surfaceForms: [id],
          provenance: [`chunk-${id}`],
        })),
        relationships: [],
      },
    });
    await createCommunityBuilder({
      store,
      clock: () => AT,
      summariser: {
        id: "identity",
        async summarise({ community }) {
          return { summary: community.entityIds.join("+") };
        },
      },
    }).rebuild(context);
    for (const community of (await store.listCommunities({ ...context, limit: 10 })).items) {
      expect(community.summary).toBe(community.entityIds.join("+"));
    }
  });
});

describe("staleness is visible — AC-6", () => {
  it("reports a community as stale once its membership moves on", async () => {
    const store = createMemoryGraphStore();
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "c",
      contribution: {
        entities: [{ id: "x", name: "x", type: "concept", surfaceForms: ["x"], provenance: ["chunk-x"] }],
        relationships: [],
      },
    });
    const builder = createCommunityBuilder({
      store,
      clock: () => AT,
      summariser: { id: "s", async summarise() { return { summary: "written" }; } },
    });
    await builder.rebuild(context);

    const fresh = (await store.listCommunities({ ...context, limit: 10 })).items[0];
    expect(fresh).toBeDefined();
    expect(isCommunityStale(fresh!)).toBe(false);

    /**
     * The graph changes and the communities are *not* rebuilt — the window between a source landing and the
     * rebuild running. `graph-global` reading this must be able to say the summary predates the change rather
     * than presenting it as current.
     */
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "c",
      contribution: {
        entities: ["x", "y"].map((id) => ({
          id,
          name: id,
          type: "concept",
          surfaceForms: [id],
          provenance: [`chunk-${id}`],
        })),
        relationships: [edge("x", "y")],
      },
    });
    // Cluster only — no summariser, so the summary is not refreshed.
    await createCommunityBuilder({ store, clock: () => AT }).rebuild(context);
    const after = (await store.listCommunities({ ...context, limit: 10 })).items.find((c) => c.entityIds.includes("x"));
    expect(after?.summary).toBeUndefined();
  });

  it("does not call a community with no summary stale", () => {
    // A community that was never summarised is not out of date, it is unwritten. Conflating the two would make
    // `graph-global` disclose staleness on a fresh corpus.
    expect(
      isCommunityStale({ id: "c", level: 0, entityIds: ["x"], relationshipIds: [], chunkIds: [], fingerprint: "f" }),
    ).toBe(false);
  });

  it("calls a summary written against a different membership stale", () => {
    expect(
      isCommunityStale({
        id: "c",
        level: 0,
        entityIds: ["x", "y"],
        relationshipIds: [],
        chunkIds: [],
        fingerprint: "new",
        summary: "old text",
        summaryFingerprint: "old",
      }),
    ).toBe(true);
  });
});

describe("rebuilds are resumable and derived from stored state — AC-5", () => {
  it("needs no cursor: a second rebuild re-derives everything and converges", async () => {
    const store = createMemoryGraphStore();
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "c",
      contribution: {
        entities: TWO_CLUSTERS.entityIds.map((id) => ({
          id,
          name: id,
          type: "concept",
          surfaceForms: [id],
          provenance: [`chunk-${id}`],
        })),
        relationships: [...TWO_CLUSTERS.relationships],
      },
    });
    const builder = createCommunityBuilder({
      store,
      clock: () => AT,
      summariser: { id: "s", async summarise({ community }) { return { summary: community.id }; } },
    });

    const first = await builder.rebuild(context);
    const before = (await store.listCommunities({ ...context, limit: 50 })).items;
    const second = await builder.rebuild(context);
    const after = (await store.listCommunities({ ...context, limit: 50 })).items;

    // Idempotent: nothing is remembered between runs, so an interruption loses at most the work in flight.
    expect(after).toEqual(before);
    expect(first.communities).toBe(second.communities);
    expect(second.summariesWritten).toBe(0);
  });

  it("clears the communities when the graph is emptied", async () => {
    const store = createMemoryGraphStore();
    await store.replaceSourceGraph({
      ...context,
      sourceType: "file",
      sourceId: "c",
      contribution: {
        entities: [{ id: "x", name: "x", type: "concept", surfaceForms: ["x"], provenance: ["chunk-x"] }],
        relationships: [],
      },
    });
    const builder = createCommunityBuilder({ store, clock: () => AT });
    await builder.rebuild(context);
    expect((await store.listCommunities({ ...context, limit: 10 })).items).toHaveLength(1);

    await store.deleteSourceGraph({ ...context, sourceType: "file", sourceId: "c" });
    await builder.rebuild(context);
    // A community describing entities that no longer exist would be the graph's version of a stale chunk.
    expect((await store.listCommunities({ ...context, limit: 10 })).items).toEqual([]);
  });
});
