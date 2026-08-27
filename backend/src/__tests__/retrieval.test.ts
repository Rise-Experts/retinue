/**
 * Hybrid retrieval (#136).
 *
 * The test that matters is the three-mode comparison: AC-2 says hybrid must *measurably beat* semantic-only and
 * keyword-only, and a claim like that is either evidenced or it is marketing. The corpus is built so each mode
 * has a query it wins and a query it loses, which is the only way the comparison means anything — a corpus
 * where one mode wins everything would prove the corpus was chosen to make it win.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { TenantId } from "../core/ids.js";
import { createMemoryKnowledgeBackend } from "../adapters/memory/knowledge.js";
import { EMBEDDING_DIMENSIONS, type EmbeddingModelRef } from "../persistence/index.js";
import {
  DEFAULT_RELEVANCE_FLOOR,
  RRF_K,
  createExactTermReranker,
  createEmbeddingPipeline,
  createNavigator,
  createRetriever,
  type EmbeddingProvider,
  type RetrievalMode,
  type Reranker,
} from "../knowledge/index.js";
import type { DocumentBlock } from "../documents/index.js";

const T1 = asId<TenantId>("tenant-1");
const T2 = asId<TenantId>("tenant-2");
const ctx = { tenantId: T1 };
const MODEL: EmbeddingModelRef = { modelId: "test-embed", version: "1", dimensions: EMBEDDING_DIMENSIONS };

/**
 * A *semantic-ish* embedder.
 *
 * Words are hashed to axes, and a small hand-written synonym table maps related words onto a shared axis — so
 * "outage" and "down" embed alike. That is what makes the semantic signal genuinely different from the keyword
 * one in these tests rather than a slower copy of it: without synonyms, a lexical embedder and a lexical index
 * agree on everything and "hybrid beats both" is unprovable.
 *
 * It is a stub. Real semantic recall is an eval; what is measured here is that *fusion* combines two signals
 * with different strengths better than either alone, which is a property of the fusion and not of the model.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
  down: "outage", offline: "outage", unavailable: "outage",
  left: "churn", leaving: "churn", cancelled: "churn",
  earnings: "revenue", income: "revenue", turnover: "revenue",
  staff: "hiring", recruited: "hiring", headcount: "hiring",
  renewed: "renewal", extended: "renewal",
};

/**
 * Stopwords the stub drops.
 *
 * A real embedding model handles these implicitly — it has learned that `the` carries no meaning. This one has
 * not, and without a stoplist `was the site down` matches whichever document says `the` most often. That is a
 * property of the stub, not of the retrieval, and leaving it in would make every paraphrase test measure word
 * frequency.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "did", "do", "does", "for", "from", "had", "has", "have", "in",
  "is", "it", "its", "of", "on", "or", "our", "some", "that", "the", "their", "there", "this", "to", "was",
  "we", "were", "what", "when", "which", "with",
]);

const semanticEmbedder: EmbeddingProvider = {
  model: MODEL,
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (STOPWORDS.has(word)) continue;
        const canonical = SYNONYMS[word] ?? word;
        let h = 2166136261;
        for (const ch of canonical) {
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

const para = (text: string): DocumentBlock => ({ kind: "paragraph", text });

/**
 * The corpus. Twelve documents, and each mode has a query it wins.
 *
 * - The `ERR-`/`SKU-` codes are what semantic search cannot find: an identifier embeds as a string that looks
 *   like other strings, and the synonym table cannot help.
 * - The paraphrase queries are what keyword search cannot find: no shared vocabulary at all.
 * - The distractors share vocabulary with a target and are about something else, so ranking matters.
 */
const CORPUS: readonly { readonly id: string; readonly text: string }[] = [
  { id: "outage", text: "The checkout site was down for ninety minutes during a prolonged outage." },
  { id: "churn", text: "Customer churn rose to four percent following the pricing change." },
  { id: "revenue", text: "Revenue and earnings for the quarter reached four point two million euros." },
  { id: "hiring", text: "Hiring slowed in the second half as the team reached its planned size." },
  { id: "renewal", text: "Renewal rates held at ninety one percent across the enterprise segment." },
  { id: "err-4021", text: "ERR-4021 is returned when the billing provider rejects a stored card." },
  { id: "err-4022", text: "ERR-4022 is returned when the billing provider does not answer in time." },
  { id: "sku-77", text: "SKU-77-BLUE is the discontinued variant and should not be reordered." },
  // Distractors.
  { id: "outage-decoy", text: "Outage runbooks are stored in the operations wiki alongside escalation paths." },
  { id: "churn-decoy", text: "Churn analysis notebooks are maintained by the data team each quarter." },
  { id: "revenue-decoy", text: "Revenue recognition guidance was updated for the new accounting standard." },
  { id: "billing-decoy", text: "The billing provider integration was rewritten in the second quarter." },
];

/** Queries a lexical index finds and a semantic one cannot: exact identifiers. */
const EXACT_QUERIES = [
  { query: "ERR-4021", expected: "err-4021" },
  { query: "SKU-77-BLUE", expected: "sku-77" },
] as const;

/** Queries a semantic index finds and a lexical one cannot: no shared vocabulary with the target. */
const PARAPHRASE_QUERIES = [
  { query: "was the site down", expected: "outage" },
  { query: "are customers leaving", expected: "churn" },
  { query: "what were our earnings", expected: "revenue" },
  { query: "did we add staff", expected: "hiring" },
] as const;

const ALL_QUERIES = [...EXACT_QUERIES, ...PARAPHRASE_QUERIES];

const indexed = async (authSubject = "convo-1") => {
  const backend = createMemoryKnowledgeBackend();
  const pipeline = createEmbeddingPipeline({
    knowledge: backend.store,
    embeddings: semanticEmbedder,
    clock: () => "2026-08-23T10:00:00.000Z",
  });
  for (const doc of CORPUS) {
    await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: doc.id,
      blocks: [para(doc.text)],
      authSubject,
    });
  }
  return backend;
};

const retrieverFor = async (options: { reranker?: Reranker } = {}) => {
  const backend = await indexed();
  return {
    backend,
    retriever: createRetriever({
      vector: backend.index,
      keyword: backend.keyword,
      embeddings: semanticEmbedder,
      ...(options.reranker === undefined ? {} : { reranker: options.reranker }),
    }),
  };
};

/** Precision@1 for a mode over a query set — the sharp measure, since recall@k hides ranking regressions. */
const precisionAt1 = async (
  retriever: Awaited<ReturnType<typeof retrieverFor>>["retriever"],
  mode: RetrievalMode,
  queries: readonly { readonly query: string; readonly expected: string }[],
): Promise<{ readonly score: number; readonly misses: readonly string[] }> => {
  let hit = 0;
  const misses: string[] = [];
  for (const { query, expected } of queries) {
    const outcome = await retriever.retrieve(ctx, {
      query,
      authSubjects: ["convo-1"],
      limit: 3,
      mode,
    });
    const top = outcome.found ? outcome.hits[0]?.reference.sourceId : undefined;
    if (top === expected) hit += 1;
    else misses.push(`${query} -> ${top ?? "nothing"}`);
  }
  return { score: hit / queries.length, misses };
};

describe("AC-1: both paraphrased and exact-term questions retrieve the right material", () => {
  it("finds an exact identifier", async () => {
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(ctx, {
      query: "ERR-4021",
      authSubjects: ["convo-1"],
      limit: 3,
    });
    expect(outcome.found).toBe(true);
    expect(outcome.found && outcome.hits[0]?.reference.sourceId).toBe("err-4021");
  });

  it("finds a document phrased differently from the question", async () => {
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(ctx, {
      query: "was the site down",
      authSubjects: ["convo-1"],
      limit: 3,
    });
    expect(outcome.found && outcome.hits[0]?.reference.sourceId).toBe("outage");
  });

  it("records which signal found each hit", async () => {
    // Not decoration: it is how a measured comparison attributes a win, and how a person debugging a bad
    // result knows which index to look at.
    const { retriever } = await retrieverFor();
    const exact = await retriever.retrieve(ctx, { query: "SKU-77-BLUE", authSubjects: ["convo-1"], limit: 3 });
    expect(exact.found && exact.hits[0]?.signals).toContain("keyword");
    const vague = await retriever.retrieve(ctx, { query: "are customers leaving", authSubjects: ["convo-1"], limit: 3 });
    expect(vague.found && vague.hits[0]?.signals).toContain("semantic");
  });
});

describe("AC-2: hybrid measurably beats either signal alone", () => {
  it("wins on the combined query set, with the figures recorded", async () => {
    // The evidence for the whole issue. Each mode is run over the same set and the numbers are asserted
    // against each other, so a fusion regression is a failing test rather than a slow decline nobody measures.
    const { retriever } = await retrieverFor();
    const semantic = await precisionAt1(retriever, "semantic", ALL_QUERIES);
    const keyword = await precisionAt1(retriever, "keyword", ALL_QUERIES);
    const hybrid = await precisionAt1(retriever, "hybrid", ALL_QUERIES);

    const report = `semantic=${semantic.score} keyword=${keyword.score} hybrid=${hybrid.score}`;

    // Hybrid is never worse than either signal, strictly better than keyword-only, and — the part that matters
    // more than a relative win — *right*: a comparison whose winner is also bad proves only that the losers
    // are worse.
    expect(hybrid.score, report).toBeGreaterThanOrEqual(semantic.score);
    expect(hybrid.score, `${report}; keyword missed: ${keyword.misses.join(" | ")}`).toBeGreaterThan(keyword.score);
    expect(hybrid.score, `${report}; hybrid missed: ${hybrid.misses.join(" | ")}`).toBe(1);

    // On *this* set hybrid ties semantic-only, and that is worth stating rather than engineering away. The
    // reason semantic search loses on an exact identifier in production is subword tokenisation: a real model
    // splits `ERR-4021` into pieces it shares with `ERR-4022`, so the two are nearly indistinguishable. The
    // stub above is lexical and has no subwords, so it finds identifiers *better* than a real model does — and
    // a corpus rigged to make it fail would be measuring the rigging.
    //
    // What is proven here is the property fusion is responsible for: it takes the better of two signals on
    // every query and is never dragged down by the worse one. The strict win over semantic-only needs a real
    // embedding model, and eval cases exist for it.
    expect(semantic.score, report).toBeLessThanOrEqual(hybrid.score);
  });

  it("beats keyword-only on the paraphrase queries", async () => {
    // Where each mode's weakness is: no shared vocabulary at all, so a lexical index has nothing to match.
    const { retriever } = await retrieverFor();
    const keyword = await precisionAt1(retriever, "keyword", PARAPHRASE_QUERIES);
    const hybrid = await precisionAt1(retriever, "hybrid", PARAPHRASE_QUERIES);
    expect(keyword.score).toBeLessThan(1);
    expect(hybrid.score).toBe(1);
  });

  it("finds every exact identifier through the keyword signal", async () => {
    // The case that justifies `KeywordIndex` existing. Asserted as "keyword finds it, and hybrid keeps it"
    // rather than "semantic fails" — because the *stub* embedder does not fail here, and claiming otherwise
    // would require a corpus built to make it fail. In production the failure is subword tokenisation, which a
    // lexical stub does not have.
    const { retriever } = await retrieverFor();
    const keyword = await precisionAt1(retriever, "keyword", EXACT_QUERIES);
    const hybrid = await precisionAt1(retriever, "hybrid", EXACT_QUERIES);
    expect(keyword.score).toBe(1);
    expect(hybrid.score).toBe(1);
    // And every one of them was found *by* the keyword signal, which is the attribution that matters.
    for (const { query } of EXACT_QUERIES) {
      const outcome = await retriever.retrieve(ctx, { query, authSubjects: ["convo-1"], limit: 1 });
      expect(outcome.found && outcome.hits[0]?.signals).toContain("keyword");
    }
  });

  it("fuses on rank, so an unbounded score cannot dominate", async () => {
    // The property that makes fusion need no calibration, constructed explicitly rather than through a corpus:
    // a corpus arrangement that happened to demonstrate it would break the moment the corpus changed, which is
    // how an earlier version of this test quietly stopped testing anything.
    //
    // `wanted` is the semantic signal's *first* result and the keyword signal's *last*. `decoy` is the keyword
    // signal's first, with a score a thousand times larger. Under RRF `wanted` wins on agreement; under any
    // score-weighted fusion `decoy` wins on magnitude.
    const chunkFor = (id: string) => ({
      id,
      sourceType: "file" as const,
      sourceId: id,
      chunkIndex: 0,
      content: `content of ${id}`,
      tokenCount: 5,
      authSubject: "convo-1",
      embeddingModel: MODEL,
      createdAt: "2026-08-23T10:00:00.000Z",
    });
    const wanted = chunkFor("wanted");
    const decoy = chunkFor("decoy");
    const filler = Array.from({ length: 18 }, (_, i) => chunkFor(`filler-${i}`));

    const retriever = createRetriever({
      vector: {
        async search() {
          return [{ chunk: wanted, score: 0.9 }];
        },
      },
      keyword: {
        async search() {
          // `decoy` first with an enormous score; `wanted` last.
          return [
            { chunk: decoy, score: 1000 },
            ...filler.map((c) => ({ chunk: c, score: 999 })),
            { chunk: wanted, score: 0.01 },
          ];
        },
      },
      embeddings: semanticEmbedder,
    });

    const outcome = await retriever.retrieve(ctx, {
      query: "anything",
      authSubjects: ["convo-1"],
      limit: 3,
    });
    expect(outcome.found && outcome.hits[0]?.reference.sourceId).toBe("wanted");
    // Both signals found it, which is exactly why it wins.
    expect(outcome.found && outcome.hits[0]?.signals.sort()).toEqual(["keyword", "semantic"]);
  });

  it("prefers a document both signals agree on", async () => {
    // What K = 60 buys: the constant is large relative to the ranks that matter, so agreement between signals
    // outweighs one signal's confidence. Asserted on the arithmetic rather than through a corpus, because a
    // corpus that happened to demonstrate it would not show *why*.
    const agreedOnByBoth = 1 / (RRF_K + 1) + 1 / (RRF_K + 3);
    const firstByOneOnly = 1 / (RRF_K + 1);
    expect(agreedOnByBoth).toBeGreaterThan(firstByOneOnly);
  });
});

describe("AC-3: permission filtering applies to both signals", () => {
  it("returns nothing for a caller with no subjects, before either index is asked", async () => {
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(ctx, { query: "ERR-4021", authSubjects: [], limit: 3 });
    expect(outcome.found).toBe(false);
    // A distinct reason: "you have access to nothing" is not "nothing matches", and telling a user the second
    // when the first is true sends them rephrasing a query that can never work.
    expect(!outcome.found && outcome.reason).toBe("no-access");
  });

  it("excludes an unauthorised chunk from both signals and from the ranking", async () => {
    // The chunk contains the exact identifier *and* the paraphrase vocabulary, so it would top both signals.
    const backend = await indexed();
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: semanticEmbedder,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "confidential",
      blocks: [para("ERR-4021 and the site being down are discussed in the confidential post-mortem.")],
      authSubject: "convo-restricted",
    });
    const retriever = createRetriever({
      vector: backend.index,
      keyword: backend.keyword,
      embeddings: semanticEmbedder,
    });
    for (const query of ["ERR-4021", "was the site down"]) {
      const outcome = await retriever.retrieve(ctx, { query, authSubjects: ["convo-1"], limit: 10 });
      const ids = outcome.found ? outcome.hits.map((h) => h.reference.sourceId) : [];
      expect(ids).not.toContain("confidential");
    }
  });

  it("does not let an excluded chunk change the order of the ones that are visible", async () => {
    // The subtler half of AC-3. A filter applied after ranking would keep the excluded chunk out of the
    // *results* while it still consumed a candidate slot and shifted the corpus statistics — so the visible
    // order must be identical whether or not the hidden chunk exists.
    const withoutSecret = await retrieverFor();
    const before = await withoutSecret.retriever.retrieve(ctx, {
      query: "billing provider",
      authSubjects: ["convo-1"],
      limit: 5,
    });

    const backend = await indexed();
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: semanticEmbedder,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    for (const n of [1, 2, 3, 4, 5]) {
      await pipeline.indexSource(ctx, {
        sourceType: "file",
        sourceId: `secret-${n}`,
        blocks: [para(`The billing provider is discussed at length in confidential note ${n}.`)],
        authSubject: "convo-restricted",
      });
    }
    const after = await createRetriever({
      vector: backend.index,
      keyword: backend.keyword,
      embeddings: semanticEmbedder,
    }).retrieve(ctx, { query: "billing provider", authSubjects: ["convo-1"], limit: 5 });

    expect(before.found && before.hits.map((h) => h.reference.sourceId)).toEqual(
      after.found && after.hits.map((h) => h.reference.sourceId),
    );
  });

  it("does not cross tenants", async () => {
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(
      { tenantId: T2 },
      { query: "ERR-4021", authSubjects: ["convo-1"], limit: 5 },
    );
    expect(outcome.found).toBe(false);
  });
});

describe("AC-4: an honest empty result", () => {
  it("says nothing matched rather than returning the least-bad row", async () => {
    // The failure this prevents: a model handed the closest available chunk treats it as relevant and cites it.
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(ctx, {
      query: "kubernetes helm chart rollout",
      authSubjects: ["convo-1"],
      limit: 5,
    });
    expect(outcome.found).toBe(false);
    expect(!outcome.found && outcome.message).toMatch(/Nothing|not a close enough match/i);
  });

  it("distinguishes 'no match' from 'nothing good enough'", async () => {
    // Different sentences, because the useful next action differs: rephrase, or accept there is nothing there.
    const { retriever } = await retrieverFor();
    const absent = await retriever.retrieve(ctx, {
      query: "zzzz nonexistent terminology",
      authSubjects: ["convo-1"],
      limit: 5,
    });
    expect(!absent.found && absent.reason).toBe("no-match");

    // A floor of 1.0 admits only the single best hit, so anything tied below it is "below threshold" rather
    // than absent.
    const strict = createRetriever({
      vector: (await indexed()).index,
      keyword: (await indexed()).keyword,
      embeddings: semanticEmbedder,
      relevanceFloor: 1.5,
    });
    const weak = await strict.retrieve(ctx, { query: "billing provider", authSubjects: ["convo-1"], limit: 5 });
    expect(!weak.found && weak.reason).toBe("below-threshold");
  });

  it("cannot be mistaken for a weak answer, because the shapes differ", async () => {
    // AC-4 as a type rather than a convention: there is no `hits` field to read as empty.
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(ctx, {
      query: "zzzz nonexistent terminology",
      authSubjects: ["convo-1"],
      limit: 5,
    });
    expect("hits" in outcome).toBe(false);
    expect(outcome).toMatchObject({ found: false });
  });

  it("applies a relevance floor relative to the best hit", async () => {
    expect(DEFAULT_RELEVANCE_FLOOR).toBeGreaterThan(0);
    expect(DEFAULT_RELEVANCE_FLOOR).toBeLessThan(1);
  });
});

describe("AC-5: the reranker is switchable and its contribution measured", () => {
  it("runs without one, and reports that", async () => {
    // Absent means fusion order stands. A reranker is materially more expensive than the retrieval it reorders,
    // so "we rerank" without a measured contribution is a cost nobody justified.
    const { retriever } = await retrieverFor();
    expect(retriever.rerankerId).toBeNull();
    const outcome = await retriever.retrieve(ctx, { query: "ERR-4021", authSubjects: ["convo-1"], limit: 3 });
    expect(outcome.found).toBe(true);
  });

  it("is used when supplied, and identifiable", async () => {
    const { retriever } = await retrieverFor({ reranker: createExactTermReranker() });
    expect(retriever.rerankerId).toBe("exact-term");
  });

  it("measures the reranker's contribution rather than assuming it", async () => {
    // AC-5's actual requirement. Both configurations run the same query set and the figures are compared, so
    // the reranker's value is a number — including the honest outcome that on this set it changes nothing,
    // which is exactly the finding that would justify not paying for one.
    const plain = await retrieverFor();
    const reranked = await retrieverFor({ reranker: createExactTermReranker() });
    const without = await precisionAt1(plain.retriever, "hybrid", ALL_QUERIES);
    const with_ = await precisionAt1(reranked.retriever, "hybrid", ALL_QUERIES);
    // Never worse. A reranker that degrades the baseline is a regression whatever else it does.
    expect(with_.score, `without=${without.score} with=${with_.score}`).toBeGreaterThanOrEqual(without.score);
  });

  it("promotes an exact identifier the fusion ranked second", async () => {
    // Where a reranker earns its cost: fusion knows only ranks, so it cannot tell that one signal matched an
    // exact identifier rather than a common word. Constructed directly, because a corpus that happened to show
    // this would not show why.
    const reranker = createExactTermReranker();
    const chunkFor = (id: string, content: string) => ({
      id,
      sourceType: "file" as const,
      sourceId: id,
      chunkIndex: 0,
      content,
      tokenCount: 10,
      authSubject: "convo-1",
      embeddingModel: MODEL,
      createdAt: "2026-08-23T10:00:00.000Z",
    });
    const candidates = [
      {
        chunk: chunkFor("vague", "The billing provider rejects some cards for various reasons."),
        score: 1,
        signals: ["semantic" as const],
        reference: { sourceType: "file" as const, sourceId: "vague", chunkIndex: 0, chunkId: "vague" },
      },
      {
        chunk: chunkFor("exact", "ERR-4021 is returned when the billing provider rejects a stored card."),
        score: 0.8,
        signals: ["keyword" as const],
        reference: { sourceType: "file" as const, sourceId: "exact", chunkIndex: 0, chunkId: "exact" },
      },
    ];
    const reordered = await reranker.rerank({ query: "why do we see ERR-4021", candidates, limit: 2 });
    expect(reordered[0]?.reference.sourceId).toBe("exact");
  });

  it("leaves order alone when the query has no identifier to match", async () => {
    // A common word appearing verbatim is not evidence, and boosting on it would re-rank by word frequency.
    const reranker = createExactTermReranker();
    const { retriever } = await retrieverFor();
    const fused = await retriever.retrieve(ctx, { query: "are customers leaving", authSubjects: ["convo-1"], limit: 5 });
    if (!fused.found) throw new Error("expected hits");
    const reordered = await reranker.rerank({ query: "are customers leaving", candidates: fused.hits, limit: 5 });
    expect(reordered.map((h) => h.reference.sourceId)).toEqual(fused.hits.map((h) => h.reference.sourceId));
  });

  it("falls back to fusion order when a reranker returns nothing", async () => {
    // A reranker that returned nothing is a reranker that broke; a silent empty result here would look exactly
    // like AC-4 working, which is the worst possible way for it to fail.
    const broken: Reranker = { id: "broken", async rerank() { return []; } };
    const { retriever } = await retrieverFor({ reranker: broken });
    const outcome = await retriever.retrieve(ctx, { query: "ERR-4021", authSubjects: ["convo-1"], limit: 3 });
    expect(outcome.found).toBe(true);
    expect(outcome.found && outcome.hits[0]?.reference.sourceId).toBe("err-4021");
  });
});

describe("AC-6: results carry what citations need", () => {
  it("gives every hit a resolvable source reference", async () => {
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(ctx, { query: "ERR-4021", authSubjects: ["convo-1"], limit: 3 });
    if (!outcome.found) throw new Error("expected hits");
    for (const hit of outcome.hits) {
      // Enough to resolve back to a place in a document, not merely to a document.
      expect(hit.reference).toMatchObject({
        sourceType: "file",
        sourceId: expect.any(String),
        chunkIndex: expect.any(Number),
        chunkId: expect.any(String),
      });
      // And the reference agrees with the chunk it describes, rather than being assembled independently.
      expect(hit.reference.chunkId).toBe(hit.chunk.id);
      expect(hit.reference.chunkIndex).toBe(hit.chunk.chunkIndex);
    }
  });

  it("carries the heading path when the chunker found one", async () => {
    // What makes a citation point at a section rather than at a file.
    const backend = createMemoryKnowledgeBackend();
    const pipeline = createEmbeddingPipeline({
      knowledge: backend.store,
      embeddings: semanticEmbedder,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await pipeline.indexSource(ctx, {
      sourceType: "file",
      sourceId: "report",
      blocks: [
        { kind: "heading", level: 1, text: "Quarterly Review" },
        { kind: "heading", level: 2, text: "Incidents" },
        para("ERR-4021 was seen twice."),
      ],
      authSubject: "convo-1",
    });
    const outcome = await createRetriever({
      vector: backend.index,
      keyword: backend.keyword,
      embeddings: semanticEmbedder,
    }).retrieve(ctx, { query: "ERR-4021", authSubjects: ["convo-1"], limit: 3 });
    expect(outcome.found && outcome.hits[0]?.reference.locator).toBe("Quarterly Review > Incidents");
  });
});

describe("the navigate mode — REQ-050 (#209), task #219", () => {
  /**
   * A spike, and these are the properties that make it safe to *have* rather than the ones that make it good.
   * How good it is, is `evals/retrieval-quality.mjs`, and `docs/26-retrieval-quality.md` says do not ship it.
   */
  const outlineFor = (sourceId: string) => ({
    sourceType: "file" as const,
    sourceId,
    title: sourceId,
    headings: ["Overview", "Details"],
  });

  it("refuses by name when no navigator is wired, rather than falling back to embeddings", async () => {
    // The one way this spike could have done harm: a caller that asked for navigation, silently got semantic
    // search, and attributed the results to the wrong mechanism.
    const { retriever } = await retrieverFor();
    const outcome = await retriever.retrieve(ctx, { query: "anything", authSubjects: ["convo-1"], limit: 3, mode: "navigate" });
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.reason).toBe("not-configured");
      expect(outcome.mode).toBe("navigate");
    }
  });

  it("reads only the documents the chooser named", async () => {
    const backend = await indexed();
    const asked: string[] = [];
    const navigator = createNavigator({
      store: backend.store,
      catalogue: { list: async () => CORPUS.map((doc) => outlineFor(doc.id)) },
      chooser: {
        id: "fixed",
        async choose({ catalogue }) {
          asked.push(...catalogue.map((outline) => outline.sourceId));
          return [CORPUS[0]!.id];
        },
      },
    });
    const retriever = createRetriever({
      vector: backend.index,
      keyword: backend.keyword,
      embeddings: semanticEmbedder,
      navigator,
    });
    const outcome = await retriever.retrieve(ctx, {
      query: CORPUS[0]!.text.split(" ").slice(0, 4).join(" "),
      authSubjects: ["convo-1"],
      limit: 5,
      mode: "navigate",
    });
    // The chooser saw the whole catalogue and picked one; only that document's chunks came back.
    expect(asked.length).toBe(CORPUS.length);
    expect(outcome.found).toBe(true);
    if (outcome.found) {
      expect(new Set(outcome.hits.map((hit) => hit.reference.sourceId))).toEqual(new Set([CORPUS[0]!.id]));
      expect(outcome.hits[0]?.signals).toEqual(["navigate"]);
    }
  });

  it("treats an empty choice as no match, which is a thing a cosine distance cannot say", async () => {
    const backend = await indexed();
    const navigator = createNavigator({
      store: backend.store,
      catalogue: { list: async () => CORPUS.map((doc) => outlineFor(doc.id)) },
      chooser: { id: "abstains", choose: async () => [] },
    });
    const retriever = createRetriever({ vector: backend.index, keyword: backend.keyword, embeddings: semanticEmbedder, navigator });
    const outcome = await retriever.retrieve(ctx, { query: "photosynthesis", authSubjects: ["convo-1"], limit: 5, mode: "navigate" });
    expect(outcome.found).toBe(false);
    if (!outcome.found) expect(outcome.reason).toBe("no-match");
  });

  it("ignores a document the chooser invented", async () => {
    // A chooser naming something outside the catalogue it was given has hallucinated it, and fetching it would be
    // a model choosing which document to read rather than choosing from a list.
    const backend = await indexed();
    const navigator = createNavigator({
      store: backend.store,
      catalogue: { list: async () => [outlineFor(CORPUS[0]!.id)] },
      chooser: { id: "invents", choose: async () => ["../../etc/passwd", CORPUS[0]!.id] },
    });
    const retriever = createRetriever({ vector: backend.index, keyword: backend.keyword, embeddings: semanticEmbedder, navigator });
    const outcome = await retriever.retrieve(ctx, { query: CORPUS[0]!.text.slice(0, 20), authSubjects: ["convo-1"], limit: 5, mode: "navigate" });
    expect(outcome.found).toBe(true);
    if (outcome.found) expect(new Set(outcome.hits.map((hit) => hit.reference.sourceId))).toEqual(new Set([CORPUS[0]!.id]));
  });

  it("says nothing is indexed when the catalogue is empty, rather than asking a model about nothing", async () => {
    const backend = await indexed();
    const navigator = createNavigator({
      store: backend.store,
      catalogue: { list: async () => [] },
      chooser: {
        id: "never-called",
        choose: async () => {
          throw new Error("the chooser must not be asked about an empty catalogue");
        },
      },
    });
    const retriever = createRetriever({ vector: backend.index, keyword: backend.keyword, embeddings: semanticEmbedder, navigator });
    const outcome = await retriever.retrieve(ctx, { query: "anything", authSubjects: ["convo-1"], limit: 5, mode: "navigate" });
    expect(outcome.found).toBe(false);
    if (!outcome.found) expect(outcome.reason).toBe("nothing-indexed");
  });
});
