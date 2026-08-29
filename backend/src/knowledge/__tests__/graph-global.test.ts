/**
 * `graph-global` — REQ-064 (#270), task #274.
 *
 * The two tests that matter most are about **cost** and **honesty**: the ceiling must refuse before spending,
 * and coverage must let a caller tell "I read your corpus" from "I read 12 of 40 communities". The most
 * subtle case is the summary leak, because a summary is generated prose over every chunk in a community and
 * cannot be filtered after the fact.
 */
import { describe, expect, it } from "vitest";

import { asId } from "../../core/ids.js";
import { createMemoryGraphStore } from "../../adapters/memory/graph.js";
import { createMemoryKnowledgeStore, createMemoryVectorIndex, createMemoryKeywordIndex } from "../../adapters/memory/knowledge.js";
import type { GraphStore, KnowledgeStore, StoredCommunity } from "../../persistence/index.js";
import {
  chooseLevel,
  createGraphGlobalSearch,
  createRetriever,
  type CommunityMapper,
} from "../index.js";

const context = { tenantId: asId("t1") };
const AT = "2026-08-28T00:00:00.000Z";
const OPEN = "workspace";

const embeddings = {
  model: { modelId: "m", version: "1", dimensions: 1536 },
  async embed(texts: readonly string[]) {
    return texts.map(() => Array.from({ length: 1536 }, () => 0.1));
  },
};

const chunk = (id: string, content: string, authSubject = OPEN) => ({
  id,
  sourceType: "file" as const,
  sourceId: id.split(":")[0] as string,
  chunkIndex: 0,
  content,
  tokenCount: 10,
  authSubject,
  embeddingModel: embeddings.model,
  createdAt: AT,
  embedding: Array.from({ length: 1536 }, () => 0.1),
});

/**
 * A corpus of three themes, each a community with its own summary and chunks.
 *
 * `authSubjectFor` lets one theme be restricted, which is what the leak tests need.
 */
const seeded = async (options: { authSubjectFor?: (chunkId: string) => string; summarise?: boolean } = {}) => {
  const authSubjectFor = options.authSubjectFor ?? (() => OPEN);
  const graph: GraphStore = createMemoryGraphStore();
  const knowledge: KnowledgeStore = createMemoryKnowledgeStore();

  const themes = [
    { id: "retries", chunks: ["retries:0", "retries:1"], summary: "How the retry budget governs outbound calls." },
    { id: "billing", chunks: ["billing:0"], summary: "Invoice reconciliation and the monthly close." },
    { id: "onboard", chunks: ["onboard:0"], summary: "How new engineers are onboarded." },
  ];

  for (const theme of themes) {
    await knowledge.replaceSource({
      ...context,
      sourceType: "file",
      sourceId: theme.id,
      chunks: theme.chunks.map((id, i) => ({ ...chunk(id, `${theme.id} passage ${i}`, authSubjectFor(id)), chunkIndex: i })),
    });
  }

  const communities: StoredCommunity[] = themes.map((theme, i) => ({
    id: `L1:${theme.id}`,
    level: 1,
    entityIds: [`concept:${theme.id}`],
    relationshipIds: [],
    chunkIds: theme.chunks,
    fingerprint: `fp-${i}`,
    ...(options.summarise === false ? {} : { summary: theme.summary, summaryFingerprint: `fp-${i}`, summarisedAt: AT }),
  }));
  // A finer level too, so level selection has something to choose between.
  communities.push({
    id: "L0:retries",
    level: 0,
    entityIds: ["concept:retries"],
    relationshipIds: [],
    chunkIds: ["retries:0"],
    fingerprint: "fp-fine",
    summary: "Just the retry budget.",
    summaryFingerprint: "fp-fine",
    summarisedAt: AT,
  });
  await graph.replaceCommunities({ ...context, communities });
  return { graph, knowledge };
};

/** Scores a community by whether its summary shares a word with the question. Deterministic, no model. */
const wordMapper = () => {
  const calls: string[] = [];
  const mapper: CommunityMapper = {
    id: "words",
    async map({ query, community }) {
      calls.push(community.id);
      const asked = new Set(query.toLowerCase().split(/[^a-z]+/).filter(Boolean));
      const words = (community.summary ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
      const overlap = words.filter((word) => asked.has(word)).length;
      return {
        relevance: {
          communityId: community.id,
          score: overlap,
          points: overlap > 0 ? [`mentions ${[...new Set(words.filter((w) => asked.has(w)))].join(", ")}`] : [],
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
  return { mapper, calls };
};

describe("choosing a granularity — AC-2", () => {
  it("reads the coarsest level by default", () => {
    // Reading every level multiplies cost for largely repeated content: a level-1 community contains the
    // level-0 ones under it.
    expect(chooseLevel([0, 1, 2])).toBe(2);
  });

  it("honours a requested level that exists", () => {
    expect(chooseLevel([0, 1, 2], 0)).toBe(0);
  });

  it("falls back to the coarsest when the requested level does not exist", () => {
    expect(chooseLevel([0, 1], 5)).toBe(1);
  });

  it("reports which level it read", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.coverage.level).toBe(1);
  });

  it("can be asked for a finer level", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper, calls } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 10,
      level: 0,
    });
    expect(result.coverage.level).toBe(0);
    // Only the finer community was read, not both levels — that is the whole cost saving.
    expect(calls).toEqual(["L0:retries"]);
  });
});

describe("map-reduce over summaries — AC-2, AC-7", () => {
  it("reads every community at the level and reports coverage", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper, calls } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(calls).toHaveLength(3);
    expect(result.coverage).toMatchObject({ communitiesTotal: 3, communitiesRead: 3, calls: 3 });
    // "I read 12 of 40" is a materially different claim from "I read your corpus".
    expect(result.coverage.communitiesRelevant).toBe(1);
  });

  it("returns real chunk hits, not summaries dressed as sources — AC-7", async () => {
    /**
     * The decided output shape. A synthetic chunk whose content is a community summary would produce a
     * citation pointing at nothing, and the model would present generated text as though a document said it.
     */
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      // Every hit resolves to a chunk that actually exists.
      expect(await knowledge.get({ ...context, id: hit.chunk.id })).not.toBeNull();
      expect(hit.chunk.content).not.toContain("How the retry budget governs");
    }
  });

  it("returns the thematic answer separately, with the mapper's points", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0]?.summary).toContain("retry budget");
    expect(result.themes[0]?.points[0]).toContain("mentions");
  });

  it("orders themes best first, reproducibly", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const search = createGraphGlobalSearch({ graph, knowledge, mapper });
    const run = async () =>
      (await search.search(context, { query: "retry budget invoice monthly", authSubjects: [OPEN], limit: 20 })).themes.map(
        (theme) => theme.communityId,
      );
    const first = await run();
    expect(first.length).toBeGreaterThan(1);
    expect(await run()).toEqual(first);
  });

  it("skips a community the question has nothing to do with", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.hits.every((hit) => hit.chunk.sourceId === "retries")).toBe(true);
  });

  it("counts the unsummarised ones on a partly summarised corpus", async () => {
    /**
     * The realistic case, and the one the count exists for — a rebuild that has summarised some communities
     * and not yet reached the rest.
     *
     * The fully-unsummarised test below returns early on a different code path, so it passed against a
     * mutation that zeroed this counter in the normal path. A partial corpus is what actually exercises it.
     */
    const { graph, knowledge } = await seeded();
    /**
     * The fingerprint has to move, and that is the store working correctly rather than an inconvenience.
     *
     * Omitting `summary` alone does not un-summarise a community: `replaceCommunities` carries the summary
     * over when the fingerprint is unchanged, which is the incremental saving #272 exists for. A community can
     * only *lose* its summary by changing membership — which is exactly the state being modelled here: it
     * moved, and the rebuild has not re-summarised it yet.
     */
    const stripped = (await graph.listCommunities({ ...context, limit: 20 })).items.map((community) =>
      community.id === "L1:onboard"
        ? {
            id: community.id,
            level: community.level,
            entityIds: [...community.entityIds, "concept:new"],
            relationshipIds: community.relationshipIds,
            chunkIds: community.chunkIds,
            fingerprint: "moved-on",
          }
        : community,
    );
    await graph.replaceCommunities({ ...context, communities: stripped });

    const { mapper, calls } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });
    // Two of the three were readable, and the answer says so rather than implying it read everything.
    expect(calls).toHaveLength(2);
    expect(result.coverage.communitiesTotal).toBe(3);
    expect(result.coverage.communitiesRead).toBe(2);
    expect(result.coverage.communitiesUnsummarised).toBe(1);
  });

  it("counts unsummarised communities rather than silently omitting them", async () => {
    // A corpus that is half unsummarised produces a partial answer, and the caller has to be able to see it.
    const { graph, knowledge } = await seeded({ summarise: false });
    const { mapper, calls } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(calls).toEqual([]);
    expect(result.coverage.communitiesUnsummarised).toBe(3);
    expect(result.hits).toEqual([]);
  });
});

describe("the ceiling refuses before spending — AC-3, AC-4", () => {
  it("refuses when the corpus needs more calls than the ceiling allows, having called nothing", async () => {
    /**
     * The whole point of checking from the community count. A refusal that arrives after two hundred calls is
     * not a ceiling, it is a bill with an apology.
     */
    const { graph, knowledge } = await seeded();
    const { mapper, calls } = wordMapper();
    const search = createGraphGlobalSearch({ graph, knowledge, mapper, callCeiling: 2 });
    await expect(search.search(context, { query: "retry budget", authSubjects: [OPEN], limit: 10 })).rejects.toThrow(
      /would read 3 community summaries/,
    );
    expect(calls).toEqual([]);
  });

  it("says what it would have cost and what to change", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const search = createGraphGlobalSearch({ graph, knowledge, mapper, callCeiling: 1 });
    const error = await search
      .search(context, { query: "retry budget", authSubjects: [OPEN], limit: 10 })
      .catch((e: unknown) => e as Error);
    expect(error.message).toContain("ceiling is 1 model calls");
    expect(error.message).toContain("coarser level");
    expect(error.message).toContain("Nothing was spent");
  });

  it("refuses rather than truncating when the token ceiling is passed mid-flight", async () => {
    // A partial map-reduce presented as a whole-corpus answer is a wrong answer with a confident shape.
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const search = createGraphGlobalSearch({ graph, knowledge, mapper, tokenCeiling: 150 });
    await expect(search.search(context, { query: "retry budget", authSubjects: [OPEN], limit: 10 })).rejects.toThrow(
      // 120 tokens a call, so the 150 ceiling is passed on the second — not the first, which was my arithmetic
      // rather than the code's.
      /token ceiling after 2 of 3/,
    );
  });

  it("is a budget failure, not a retryable one", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const search = createGraphGlobalSearch({ graph, knowledge, mapper, callCeiling: 1 });
    const error = (await search
      .search(context, { query: "retry budget", authSubjects: [OPEN], limit: 10 })
      .catch((e: unknown) => e)) as { code?: string; retryable?: boolean };
    // Retrying the identical query costs the same and fails the same way.
    expect(error.code).toBe("budget_exceeded");
    expect(error.retryable).toBe(false);
  });

  it("proceeds when the corpus fits", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper, calls } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper, callCeiling: 3 }).search(context, {
      query: "retry budget",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(calls).toHaveLength(3);
    expect(result.coverage.calls).toBe(3);
  });

  it("reports latency, since a map-reduce is seconds rather than milliseconds", async () => {
    // AC-9, and #275 needs the number.
    let clock = 1000;
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({
      graph,
      knowledge,
      mapper,
      now: () => (clock += 500),
    }).search(context, { query: "retry budget", authSubjects: [OPEN], limit: 10 });
    expect(result.coverage.elapsedMs).toBeGreaterThan(0);
    expect(result.coverage.inputTokens).toBe(300);
    expect(result.coverage.outputTokens).toBe(60);
  });
});

describe("staleness is disclosed — AC-6", () => {
  it("says when a summary predates the community's membership", async () => {
    const { graph, knowledge } = await seeded();
    // The graph moved on and the community was not re-summarised — the window between a source landing and the
    // rebuild running.
    const stale = (await graph.listCommunities({ ...context, limit: 10, level: 1 })).items.map((community) =>
      community.id === "L1:retries" ? { ...community, fingerprint: "moved-on" } : community,
    );
    await graph.replaceCommunities({ ...context, communities: stale });

    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.themes[0]?.stale).toBe(true);
    expect(result.coverage.staleSummaries).toBe(1);
  });

  it("does not claim staleness on a fresh corpus", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });
    expect(result.coverage.staleSummaries).toBe(0);
    expect(result.themes.every((theme) => !theme.stale)).toBe(true);
  });
});

describe("a summary must not leak what the principal cannot read — AC-8", () => {
  it("withholds a theme whose community spans a source the principal is barred from", async () => {
    /**
     * The subtlest case in this REQ, and the one the issue flagged.
     *
     * A community summary is generated prose over *every* chunk in the community, so it can paraphrase a
     * document this principal cannot read. There is no way to remove one source's contribution from a sentence
     * after the fact — so the rule is that a theme is returned only when every chunk behind it is readable.
     *
     * Stricter than strictly necessary: the summary may not in fact mention the restricted source. It is the
     * only rule that cannot leak, and "probably fine" is not a basis for a permission boundary.
     */
    const { graph, knowledge } = await seeded({
      // `retries` spans two chunks; one of them is restricted.
      authSubjectFor: (id) => (id === "retries:1" ? "secret" : OPEN),
    });
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
    });

    // The summary of that community is withheld entirely.
    expect(result.themes.map((theme) => theme.communityId)).not.toContain("L1:retries");
    // And no restricted chunk reaches the caller either.
    expect(result.hits.map((hit) => hit.chunk.id)).not.toContain("retries:1");
  });

  it("returns the theme to a principal who can read all of it", async () => {
    // Without this the test above would pass against a version that returns no themes at all — which is how an
    // isolation test quietly stops testing anything.
    const { graph, knowledge } = await seeded({ authSubjectFor: (id) => (id === "retries:1" ? "secret" : OPEN) });
    const { mapper } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN, "secret"],
      limit: 10,
    });
    expect(result.themes.map((theme) => theme.communityId)).toContain("L1:retries");
  });

  it("returns nothing at all for an empty subject list", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper, calls } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(context, {
      query: "retry budget",
      authSubjects: [],
      limit: 10,
    });
    expect(result.hits).toEqual([]);
    expect(result.themes).toEqual([]);
    // And it did not spend a single call working that out.
    expect(calls).toEqual([]);
  });

  it("does not read another tenant's communities", async () => {
    const { graph, knowledge } = await seeded();
    const { mapper, calls } = wordMapper();
    const result = await createGraphGlobalSearch({ graph, knowledge, mapper }).search(
      { tenantId: asId("t2") },
      { query: "retry budget", authSubjects: [OPEN], limit: 10 },
    );
    expect(result.hits).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("through the retriever — AC-1", () => {
  const retrieverFor = async (over: Parameters<typeof createGraphGlobalSearch>[0] | null = null) => {
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    return createRetriever({
      vector: createMemoryVectorIndex(knowledge),
      keyword: createMemoryKeywordIndex(knowledge),
      embeddings,
      ...(over === null ? { graphGlobal: createGraphGlobalSearch({ graph, knowledge, mapper }) } : { graphGlobal: createGraphGlobalSearch(over) }),
    });
  };

  it("returns ordinary hits with resolvable references", async () => {
    const retriever = await retrieverFor();
    const result = await retriever.retrieve(context, {
      query: "retry budget outbound",
      authSubjects: [OPEN],
      limit: 10,
      mode: "graph-global",
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.mode).toBe("graph-global");
    for (const hit of result.hits) {
      expect(hit.signals).toEqual(["graph-global"]);
      expect(hit.reference.chunkId).toBe(hit.chunk.id);
    }
  });

  it("says not-configured when the mode was never wired", async () => {
    const knowledge = createMemoryKnowledgeStore();
    const retriever = createRetriever({
      vector: createMemoryVectorIndex(knowledge),
      keyword: createMemoryKeywordIndex(knowledge),
      embeddings,
    });
    const result = await retriever.retrieve(context, {
      query: "themes",
      authSubjects: [OPEN],
      limit: 5,
      mode: "graph-global",
    });
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("not-configured");
  });

  it("lets the ceiling throw rather than reporting it as an empty corpus", async () => {
    /**
     * Deliberate: exceeding a ceiling is "this question is too expensive to answer this way", not "found
     * nothing", and `RetrievalOutcome`'s reasons are all about the corpus. Flattening it into `no-match` would
     * tell a user their documents say nothing about a subject they are full of.
     */
    const { graph, knowledge } = await seeded();
    const { mapper } = wordMapper();
    const retriever = createRetriever({
      vector: createMemoryVectorIndex(knowledge),
      keyword: createMemoryKeywordIndex(knowledge),
      embeddings,
      graphGlobal: createGraphGlobalSearch({ graph, knowledge, mapper, callCeiling: 1 }),
    });
    await expect(
      retriever.retrieve(context, { query: "retry budget", authSubjects: [OPEN], limit: 5, mode: "graph-global" }),
    ).rejects.toThrow(/ceiling/);
  });

  it("leaves the other modes working", async () => {
    const retriever = await retrieverFor();
    for (const mode of ["semantic", "keyword", "hybrid"] as const) {
      const result = await retriever.retrieve(context, {
        query: "retries passage",
        authSubjects: [OPEN],
        limit: 5,
        mode,
      });
      expect(result.mode, mode).toBe(mode);
    }
  });
});
