#!/usr/bin/env node
/**
 * How good is retrieval, and is the reranker worth its cost? — REQ-050 (#209), task #219.
 *
 * There was no retrieval eval set. Every claim about hybrid retrieval in this repository rested on a unit test
 * over a nine-document corpus with a **hand-written stub embedder**, which measures the fusion arithmetic and
 * nothing about semantics. And one claim had never been tested at all: the reranker is a port *precisely* so its
 * value could be measured, and nothing had measured it. That alone justifies the dataset.
 *
 * ## The corpus is this repository's own documentation
 *
 * 89 markdown files, parsed by the platform's own `parseMarkdown` and chunked by its own `chunkDocument`, so the
 * thing being scored is the pipeline a deployment actually runs. Two consequences worth stating:
 *
 * - It is a **real corpus** — long technical prose with headings, tables and code — rather than a benchmark set
 *   chosen to make a retriever look good.
 * - The queries were written by the person who wrote the retriever, which is the dataset's main weakness. It is
 *   mitigated by judging on *substance* rather than on chunk ids (see below) and by the queries being questions
 *   a reader of these docs would actually ask, but it is not eliminated. A second author would improve it.
 *
 * ## Judgements are predicates, not chunk ids
 *
 * A relevant result is one whose chunk comes from a named document **and** contains a required phrase. Judging by
 * chunk id would make the dataset break every time the chunker changes its boundaries — which is exactly the
 * change somebody would want to evaluate. A predicate survives re-chunking, and it also states *why* a chunk is
 * relevant in a form a reader can check.
 *
 * Usage:
 *   node evals/retrieval-quality.mjs                     # every arm, live embeddings
 *   node evals/retrieval-quality.mjs --arms hybrid,rerank
 *   node evals/retrieval-quality.mjs --offline           # a smoke run; measures no semantics at all
 *   node evals/retrieval-quality.mjs --chunk 800x1600    # a different chunking, to answer AC-6 with a number
 *
 * Needs RETINUE_MODEL_API_KEY unless `--offline`. Embeddings cost about a cent for the whole corpus; the
 * `navigate` arm costs one chat call per query.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryKnowledgeBackend, createMemoryGraphStore } from "@retinue/agentkit/persistence";
import {
  createCommunityBuilder,
  createGraphGlobalSearch,
  createGraphIndexer,
  createGraphLocalSearch,
  createModelEntityExtractor,
  DEFAULT_EXTRACTION_PROMPT,
  createEmbeddingPipeline,
  createExactTermReranker,
  createNavigator,
  createOpenAiEmbeddings,
  createRetriever,
} from "@retinue/agentkit/knowledge";
import { chunkDocument } from "@retinue/agentkit/knowledge";
import { asId } from "@retinue/agentkit";

const CASES = "evals/cases/retrieval.json";
const OUT = "evals/retrieval-quality.json";
const CORPUS_DIRS = ["docs", "website/content"];
const TENANT = asId("eval-tenant");
const SUBJECT = "eval-corpus";
const LIMIT = 5;

/** Files that are indexes of other files rather than content. */
const SKIP = new Set(["README.md"]);

export const corpusFiles = (dirs = CORPUS_DIRS) => {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md") && !SKIP.has(name)) out.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
};

/**
 * Markdown → blocks, without the extraction pipeline's storage half.
 *
 * The platform's `parseMarkdown` is a pure function over bytes, which is what makes this harness able to use the
 * *real* parser rather than a markdown split of its own — a corpus chunked differently from production would make
 * every number here a number about the harness.
 */
const blocksOf = async (path) => {
  const { parseMarkdown } = await import("@retinue/agentkit/knowledge");
  const { DEFAULT_EXTRACTION_LIMITS } = await import("@retinue/agentkit/knowledge");
  const parsed = parseMarkdown(new Uint8Array(readFileSync(path)), {
    ...DEFAULT_EXTRACTION_LIMITS,
    // The specs are long; the default text ceiling truncates the largest of them, and a truncated corpus makes
    // recall look worse than it is for reasons that have nothing to do with retrieval.
    maxTextBytes: 4_000_000,
    maxBlocks: 20_000,
  });
  return parsed.blocks ?? [];
};

/**
 * A deterministic stand-in for an embedding model, for `--offline` only.
 *
 * It hashes words onto axes, so "the same words" is the only similarity it can see. That makes the semantic arm a
 * slower copy of the keyword arm, which is why an offline run prints a warning and refuses to write a report: a
 * number produced this way would be quoted later as if it meant something.
 *
 * 1536 dimensions because the platform's store pins that width and refuses anything else — which is the check
 * doing its job: a corpus embedded at two widths has two incomparable halves.
 */
const offlineEmbedder = (dimensions = 1536) => ({
  model: { modelId: "offline-hash", version: "1", dimensions },
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Array(dimensions).fill(0);
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word.length < 3) continue;
        let hash = 0;
        for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) % dimensions;
        vector[hash] += 1;
      }
      const length = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
      return vector.map((value) => value / length);
    });
  },
});

/** The chooser for the `navigate` arm: one chat call, asked for document ids and nothing else. */
/**
 * One JSON-mode chat call — REQ-064 (#270), task #275.
 *
 * Raw fetch, like `openAiChooser` below, because this harness deliberately imports no model provider: it runs
 * from a checkout with an API key and nothing else. `extractGraph` in the runtime takes a `LanguageModel` from
 * the AI SDK, which would pull a provider package in here for no benefit.
 */
const openAiJson = async (config) => {
  /**
   * **A timeout and a retry, because a run of this length will otherwise hang.**
   *
   * The first version had neither, and it hung: after ~750 of 768 extraction calls the process sat at 0% CPU
   * with no open sockets — a `fetch` promise that never settled, which `await` waits on forever. Thirty-five
   * minutes of a paid run were lost to one dropped connection.
   *
   * `AbortSignal.timeout` bounds each call and the retries absorb the transient failures that are *expected*
   * across a thousand requests. Three attempts with a widening pause; a call that fails all three throws, and
   * the extractor above turns that into a chunk that contributes nothing rather than a failed run.
   */
  const attempt = async (signal) => {
    const response = await fetch(`${config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: config.modelId,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: config.maxTokens ?? 800,
        messages: [{ role: "user", content: config.prompt }],
      }),
    });
    if (!response.ok) throw new Error(`${config.modelId} returned ${response.status}: ${await response.text()}`);
    return response.json();
  };

  let body;
  let lastError;
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      body = await attempt(AbortSignal.timeout(config.timeoutMs ?? 60_000));
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (tries + 1)));
    }
  }
  if (body === undefined) throw lastError ?? new Error("the model call failed");
  const usage = body.usage ?? {};
  let parsed = {};
  try {
    parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
  } catch {
    // A chunk that produced unparseable output contributes nothing — the same rule the runtime applies.
  }
  return {
    extraction: parsed,
    usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 },
  };
};

const openAiChooser = (config) => ({
  id: config.modelId,
  async choose({ query, catalogue, limit }) {
    const menu = catalogue
      .map((outline) => `${outline.sourceId}: ${outline.title} — ${outline.headings.slice(0, 12).join("; ")}`)
      .join("\n");
    const response = await fetch(`${config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.modelId,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are choosing which documents to read to answer a question. You see only titles and headings. " +
              `Reply with JSON: {"documents": ["id", …]} naming at most ${limit} document ids from the list, most ` +
              'relevant first. If none of them covers the question, reply {"documents": []}.',
          },
          { role: "user", content: `Question: ${query}\n\nDocuments:\n${menu}` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`chooser returned ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    config.usage.prompt += payload.usage?.prompt_tokens ?? 0;
    config.usage.completion += payload.usage?.completion_tokens ?? 0;
    try {
      const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
      return Array.isArray(parsed.documents) ? parsed.documents.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  },
});

/** Whether a hit satisfies a judgement: the right document, containing the phrase that makes it relevant. */
export const satisfies = (hit, judgement) =>
  hit.reference.sourceId === judgement.source &&
  hit.chunk.content.toLowerCase().includes(judgement.mustContain.toLowerCase());

/**
 * Five measures, because they answer different questions — and one of them needs a caveat.
 *
 * `success@5` — was there a relevant hit anywhere in the top five — is the headline: it is what a reader of an
 * assistant's answer experiences, since the model reads all five.
 *
 * **`p5` is bounded above by the judgement count.** Most queries here have one judged document, so a perfect
 * retriever asked for five hits scores 20% precision on them. The absolute level therefore means nothing and only
 * the comparison between arms does — stated here rather than in a footnote, because a 21% that looks like a
 * failure is exactly the number somebody quotes later.
 */
export const score = (results) => {
  const total = results.length;
  let atOne = 0;
  let anyInTop = 0;
  let anyDocInTop = 0;
  let precisionSum = 0;
  let recallSum = 0;
  let reciprocalSum = 0;
  for (const { hits, judgements } of results) {
    const relevant = hits.map((hit) => judgements.some((judgement) => satisfies(hit, judgement)));
    if (relevant[0] === true) atOne += 1;
    if (relevant.includes(true)) anyInTop += 1;
    /**
     * The looser question: did a hit come from a judged *document*, phrase or not.
     *
     * Reported alongside the strict measure because the gap between them is informative rather than noise. It
     * separates "found the right document" from "found the right passage", which is the distinction a citation
     * cares about — a citation that names the correct 700-line specification is not much of a citation.
     *
     * It also caught a defect in this dataset: on the first run, five of the seven strict misses were hits from
     * the right document whose chunk did not happen to contain a phrase used once elsewhere in it. The phrases
     * were the problem, not the retriever.
     */
    if (hits.some((hit) => judgements.some((judgement) => hit.reference.sourceId === judgement.source)))
      anyDocInTop += 1;
    precisionSum += hits.length === 0 ? 0 : relevant.filter(Boolean).length / hits.length;
    const foundDocs = new Set(
      hits.filter((hit, at) => relevant[at]).map((hit) => hit.reference.sourceId),
    );
    const wantedDocs = new Set(judgements.map((judgement) => judgement.source));
    recallSum += wantedDocs.size === 0 ? 0 : [...wantedDocs].filter((doc) => foundDocs.has(doc)).length / wantedDocs.size;
    const firstRelevant = relevant.indexOf(true);
    reciprocalSum += firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1);
  }
  return {
    cases: total,
    success5: total === 0 ? 0 : anyInTop / total,
    docSuccess5: total === 0 ? 0 : anyDocInTop / total,
    p1: total === 0 ? 0 : atOne / total,
    p5: total === 0 ? 0 : precisionSum / total,
    recall: total === 0 ? 0 : recallSum / total,
    mrr: total === 0 ? 0 : reciprocalSum / total,
  };
};

const percent = (value) => `${(value * 100).toFixed(1)}%`;
/**
 * Coverage over documents, which is how a corpus-level question is graded — AC-3.
 *
 * `success@5` does not apply: "what are the main areas this documentation covers" has no single right chunk,
 * and asking whether a relevant one appeared in the top five measures the wrong thing entirely.
 *
 * So the metric is **which documents the answer reached**, as a fraction of the documents the case expects. It
 * is deterministic, needs no judge model, and grades the thing that is actually checkable.
 *
 * **Its limitation, stated rather than left for a reader to find:** it measures whether the right *areas*
 * surfaced, not whether the summary of them is any good. A run could cover every expected document and produce
 * three useless sentences about each, and this would score it perfectly. Judging synthesis quality needs a
 * model judge, which costs a call per case and is not reproducible across model versions — worth adding when
 * there is a reason to trust one, and not worth pretending to now.
 */
export const themeCoverage = (results) => {
  let sum = 0;
  for (const { hits, judgements } of results) {
    const reached = new Set(hits.map((hit) => hit.reference.sourceId));
    const wanted = new Set(judgements.map((judgement) => judgement.source));
    sum += wanted.size === 0 ? 0 : [...wanted].filter((doc) => reached.has(doc)).length / wanted.size;
  }
  return results.length === 0 ? 0 : sum / results.length;
};

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const main = async () => {
  const offline = process.argv.includes("--offline");
  const apiKey = process.env.RETINUE_MODEL_API_KEY;
  if (!offline && !apiKey) {
    console.error("✗ RETINUE_MODEL_API_KEY is unset. Retrieval quality is a property of a real embedding model,");
    console.error("  and the offline embedder hashes words onto axes — it would measure the keyword arm twice.");
    console.error("  Pass --offline for a smoke run that deliberately writes no report.");
    return 2;
  }

  /**
   * The cases, through the dataset's own loader shape.
   *
   * `evals/cases/retrieval.json` is a flat array like every other case file — same schema, same validator, same
   * coverage gate — so `input.message` is the query and `expect.relevant` the judgements. A bespoke file shape
   * would have been shorter here and would have left the dataset uncounted, which is how one goes stale.
   */
  /**
   * The class comes off the tags, so the case file's schema is unchanged — REQ-064 (#270), task #275.
   *
   * The eighteen original cases were written for chunk-level retrieval: each has an answer that lives
   * *somewhere*. GraphRAG exists for questions whose answers do not, so the new ones are kept in their own
   * classes and **reported separately**. Averaging them together would let a gain on three multi-hop questions
   * hide a regression on eighteen ordinary ones, which is the comparison that actually matters.
   */
  const cases = {
    cases: JSON.parse(readFileSync(CASES, "utf8")).map((entry) => ({
      id: entry.id,
      query: entry.input.message,
      relevant: entry.expect.relevant,
      klass: entry.tags?.includes("corpus-level") ? "corpus" : entry.tags?.includes("multihop") ? "multihop" : "chunk",
    })),
  };
  const arms = (arg("--arms", "keyword,semantic,hybrid,rerank,navigate") ?? "").split(",");

  /**
   * The chunking under test — AC-6.
   *
   * The defaults are 400 target / 800 max, chosen from the literature rather than from this corpus. AC-6 says to
   * add per-collection overrides *if the eval shows the defaults are wrong for a corpus type*, so the first step
   * is measuring rather than adding the knob.
   */
  const chunkArg = arg("--chunk", undefined);
  const chunking =
    chunkArg === undefined
      ? undefined
      : (() => {
          const [target, max] = chunkArg.split("x").map(Number);
          if (!Number.isFinite(target) || !Number.isFinite(max)) throw new Error("--chunk wants targetxmax, e.g. 800x1600");
          return { targetTokens: target, maxTokens: max, overlapBlocks: 1 };
        })();

  const embeddings = offline
    ? offlineEmbedder()
    : createOpenAiEmbeddings({
        apiKey,
        ...(process.env.RETINUE_EMBEDDING_MODEL === undefined ? {} : { modelId: process.env.RETINUE_EMBEDDING_MODEL }),
      });

  // ── the corpus ────────────────────────────────────────────────────────────────────────────────────────────
  const backend = createMemoryKnowledgeBackend();
  // `createMemoryKnowledgeBackend` predates the graph, so its store is built separately rather than pretending
  // the backend has a fourth member it does not.
  const graphStore = createMemoryGraphStore();
  const pipeline = createEmbeddingPipeline({
    knowledge: backend.store,
    embeddings,
    ...(chunking === undefined ? {} : { chunking }),
  });
  const outlines = [];
  let chunkCount = 0;
  let charCount = 0;

  const files = corpusFiles();
  process.stdout.write(`indexing ${files.length} documents`);
  for (const path of files) {
    const blocks = await blocksOf(path);
    if (blocks.length === 0) continue;
    const sourceId = path.replace(/\\/g, "/");
    await pipeline.indexSource({ tenantId: TENANT }, { sourceType: "file", sourceId, blocks, authSubject: SUBJECT });
    const chunks = chunkDocument(blocks, chunking);
    chunkCount += chunks.length;
    charCount += chunks.reduce((total, chunk) => total + chunk.content.length, 0);
    outlines.push({
      sourceType: "file",
      sourceId,
      title: blocks.find((block) => block.kind === "heading")?.text ?? relative(".", path),
      headings: blocks.filter((block) => block.kind === "heading").map((block) => block.text),
    });
    process.stdout.write(".");
  }
  console.log(`\n  ${chunkCount} chunks, ~${Math.round(charCount / 4).toLocaleString()} tokens embedded`);

  /**
   * The graph, built only when asked — task #275.
   *
   * Off by default because it is the expensive half of this harness by two orders of magnitude: one extraction
   * call per chunk, against a corpus of several hundred. A baseline run must stay cheap enough that somebody
   * actually runs it.
   */
  const withGraph = process.argv.includes("--graph");
  const graphCost = { calls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0, communities: 0, summaryCalls: 0 };
  let graphLocal;
  let graphGlobal;
  const mapperUsage = { calls: 0, prompt: 0, completion: 0 };
  const mapperFailures = [];

  if (withGraph && !offline) {
    const graphModel = arg("--graph-model", "gpt-4o-mini");
    const started = Date.now();
    /**
     * The extracted graph, cached on disk — task #275.
     *
     * Extraction is one call per chunk: 768 calls and about twenty minutes for this corpus, paid again on every
     * iteration of the harness. That is a strong disincentive to re-run a measurement, which is the opposite of
     * what a measurement harness should be. The cache is keyed by nothing clever — delete the file to rebuild —
     * because the corpus and the prompt are the only inputs and both change deliberately.
     */
    const CACHE = "evals/graphrag-graph-cache.json";
    /**
     * Six levels, not the runtime default of two.
     *
     * Measured, and it is a finding rather than a knob: two levels over this corpus left **741 communities at
     * the coarsest level**, which is barely aggregated at all. A `graph-global` query reads one call per
     * community, so 741 × 24 queries is ~17,800 calls — the mode is unusable at that shape, and the ceiling
     * correctly refuses it.
     *
     * The cause is a sparse graph: most entities appear in one chunk and link to few others, so each Louvain
     * pass merges only a little. More passes keep aggregating until they stop merging, which the loop detects.
     */
    const GRAPH_LEVELS = 6;
    const { existsSync } = await import("node:fs");
    const cached = process.argv.includes("--graph-cache") && existsSync(CACHE)
      ? JSON.parse(readFileSync(CACHE, "utf8"))
      : null;
    if (cached !== null) console.log(`\nreusing the cached graph (${CACHE}) — delete it to rebuild`);
    else process.stdout.write(`\nbuilding the graph with ${graphModel}`);
    await graphStore.setEnabled({ tenantId: TENANT, enabled: true, at: new Date().toISOString() });
    for (const outline of outlines) {
      await graphStore.setSourceEnabled({
        tenantId: TENANT,
        sourceType: "file",
        sourceId: outline.sourceId,
        enabled: true,
      });
    }
    const extractor = createModelEntityExtractor({
      id: graphModel,
      extract: async (text) => {
        const result = await openAiJson({
          apiKey,
          modelId: graphModel,
          maxTokens: 900,
          prompt: `${DEFAULT_EXTRACTION_PROMPT}\n\n---\n\n${text}`,
        });
        graphCost.calls += 1;
        graphCost.inputTokens += result.usage.inputTokens;
        graphCost.outputTokens += result.usage.outputTokens;
        if (graphCost.calls % 25 === 0) process.stdout.write(".");
        return result;
      },
    });
    const indexer = createGraphIndexer({ store: graphStore, extractor });
    if (cached !== null) {
      await graphStore.replaceSourceGraph({
        tenantId: TENANT,
        sourceType: "file",
        sourceId: "__cached__",
        contribution: { entities: cached.entities, relationships: cached.relationships },
      });
      Object.assign(graphCost, cached.cost ?? {});
    }
    for (const outline of cached === null ? outlines : []) {
      const chunks = (
        await backend.store.listBySource({
          tenantId: TENANT,
          sourceType: "file",
          sourceId: outline.sourceId,
          limit: 1000,
        })
      ).items;
      // Concurrency 8: the default of 1 is right for a production re-index and would make this harness take an
      // hour. Stated rather than silently raised.
      await indexer.indexSource({ tenantId: TENANT }, {
        sourceType: "file",
        sourceId: outline.sourceId,
        chunks: chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
        concurrency: 8,
      });
    }

    /**
     * Cluster first with no summariser, then summarise **only the coarsest level**.
     *
     * `graph-global` reads one level per query and defaults to the coarsest, so summarising the fine-grained
     * ones is money spent on content no query in this dataset will ever reduce across. A first attempt without
     * this sat for eighteen minutes writing summaries the harness never asked for, and was killed.
     *
     * Two passes rather than one because the level numbers are not known until the graph is clustered, and
     * clustering is free — it is arithmetic over ids with no model calls.
     */
    const summariser = {
      id: graphModel,
      async summarise({ excerpts, entityNames, relationshipDescriptions }) {
        const result = await openAiJson({
          apiKey,
          modelId: graphModel,
          maxTokens: 400,
          prompt: [
            "Summarise what this group of related things is about, in three sentences. Answer with JSON:",
            '{"summary":"<your three sentences>"}',
            "",
            `Things: ${entityNames.slice(0, 60).join(", ")}`,
            `Connections: ${relationshipDescriptions.slice(0, 40).join("; ")}`,
            `Text: ${excerpts.slice(0, 6).join("\n---\n").slice(0, 6000)}`,
          ].join("\n"),
        });
        graphCost.summaryCalls += 1;
        graphCost.inputTokens += result.usage.inputTokens;
        graphCost.outputTokens += result.usage.outputTokens;
        if (graphCost.summaryCalls % 10 === 0) process.stdout.write("s");
        return {
          summary: typeof result.extraction.summary === "string" ? result.extraction.summary : "",
          usage: result.usage,
        };
      },
    };

    if (cached?.communities !== undefined) {
      // Summaries are the expensive half; restoring them is what makes an iteration minutes rather than an hour.
      await graphStore.replaceCommunities({ tenantId: TENANT, communities: cached.communities });
      for (const community of cached.communities) {
        if (community.summary === undefined) continue;
        await graphStore.setCommunitySummary({
          tenantId: TENANT,
          id: community.id,
          summary: community.summary,
          fingerprint: community.fingerprint,
          at: community.summarisedAt ?? new Date().toISOString(),
        });
      }
    }
    const shape =
      cached?.communities !== undefined
        ? { communities: cached.communities.length, levels: new Set(cached.communities.map((c) => c.level)).size }
        : await createCommunityBuilder({
            store: graphStore,
            knowledge: backend.store,
            levels: GRAPH_LEVELS,
          }).rebuild({ tenantId: TENANT });
    const levels = (await graphStore.listCommunities({ tenantId: TENANT, limit: 20_000 })).items;
    const coarsest = levels.length === 0 ? 0 : Math.max(...levels.map((community) => community.level));
    const atCoarsest = levels.filter((community) => community.level === coarsest).length;
    console.log(
      `\n  ${shape.communities} communities across ${shape.levels} level(s); ` +
        `summarising ${atCoarsest} at level ${coarsest}`,
    );

    const built = await createCommunityBuilder({
      store: graphStore,
      knowledge: backend.store,
      levels: GRAPH_LEVELS,
      summariseLevels: [coarsest],
      summariser,
    }).rebuild({ tenantId: TENANT });
    graphCost.communities = built.communities;

    // Cache the extracted graph, so the next iteration of this harness is minutes rather than an afternoon.
    const { writeFileSync: writeCache } = await import("node:fs");
    if (cached === null) {
      const allEntities = [];
      let entityCursor;
      do {
        const page = await graphStore.listEntities({
          tenantId: TENANT,
          limit: 1000,
          ...(entityCursor === undefined ? {} : { cursor: entityCursor }),
        });
        allEntities.push(...page.items);
        entityCursor = page.nextCursor;
      } while (entityCursor !== undefined);
      const allEdges = await graphStore.neighbours({
        tenantId: TENANT,
        entityIds: allEntities.map((entity) => entity.id),
        limit: 100_000,
      });
      const allCommunities = (await graphStore.listCommunities({ tenantId: TENANT, limit: 20_000 })).items;
      writeCache(
        CACHE,
        `${JSON.stringify(
          { entities: allEntities, relationships: allEdges, communities: allCommunities, cost: graphCost },
          null,
          0,
        )}\n`,
      );
      console.log(`  cached the graph to ${CACHE}`);
    }
    graphCost.elapsedMs = Date.now() - started;
    console.log(
      `\n  ${built.communities} communities at ${built.levels} level(s); ` +
        `${graphCost.calls} extraction + ${graphCost.summaryCalls} summary calls, ` +
        `${(graphCost.inputTokens + graphCost.outputTokens).toLocaleString()} tokens, ` +
        `${Math.round(graphCost.elapsedMs / 1000)}s`,
    );

    graphLocal = createGraphLocalSearch({ graph: graphStore, knowledge: backend.store });
    graphGlobal = createGraphGlobalSearch({
      graph: graphStore,
      knowledge: backend.store,
      // Generous, so the ceiling does not become the thing being measured. The real default is 40.
      callCeiling: 200,
      tokenCeiling: 2_000_000,
      mapper: {
        id: graphModel,
        async map({ query, community }) {
          /**
           * A map failure scores zero rather than killing the arm.
           *
           * `graph-global` propagates a mapper error, which is right in production — a partial map-reduce must
           * not be reported as a whole-corpus answer. In a measurement run over a thousand calls it would mean
           * one transient failure discarding twenty minutes of work, so the harness absorbs it here and the
           * coverage numbers below record what was actually read.
           */
          const result = await openAiJson({
            apiKey,
            modelId: graphModel,
            maxTokens: 200,
            prompt: [
              `Question: ${query}`,
              "",
              "How relevant is the summary below to that question? Answer with JSON:",
              '{"score": <0-10>, "point": "<one sentence on what in it bears on the question>"}',
              "",
              community.summary ?? "",
            ].join("\n"),
          }).catch((error) => {
            mapperFailures.push(String(error).slice(0, 120));
            return { extraction: {}, usage: { inputTokens: 0, outputTokens: 0 } };
          });
          mapperUsage.calls += 1;
          mapperUsage.prompt += result.usage.inputTokens;
          mapperUsage.completion += result.usage.outputTokens;
          const score = Number(result.extraction.score) || 0;
          return {
            relevance: {
              communityId: community.id,
              score,
              points: typeof result.extraction.point === "string" ? [result.extraction.point] : [],
            },
            usage: result.usage,
          };
        },
      },
    });
  }

  const chooserUsage = { prompt: 0, completion: 0 };
  const navigator = offline
    ? undefined
    : createNavigator({
        store: backend.store,
        catalogue: { list: async () => outlines },
        chooser: openAiChooser({
          apiKey,
          modelId: process.env.RETINUE_MODEL_ID ?? "gpt-4o",
          usage: chooserUsage,
        }),
      });

  const retrieverFor = (withReranker, withNavigator) =>
    createRetriever({
      vector: backend.index,
      keyword: backend.keyword,
      embeddings,
      ...(withReranker ? { reranker: createExactTermReranker() } : {}),
      ...(withNavigator && navigator !== undefined ? { navigator } : {}),
      ...(graphLocal === undefined ? {} : { graphLocal }),
      ...(graphGlobal === undefined ? {} : { graphGlobal }),
    });

  const ARMS = {
    keyword: { mode: "keyword", reranker: false },
    semantic: { mode: "semantic", reranker: false },
    hybrid: { mode: "hybrid", reranker: false },
    rerank: { mode: "hybrid", reranker: true },
    navigate: { mode: "navigate", reranker: false },
    "graph-local": { mode: "graph-local", reranker: false, needsGraph: true },
    "graph-global": { mode: "graph-global", reranker: false, needsGraph: true },
  };

  const report = [];
  for (const name of arms) {
    const arm = ARMS[name];
    if (arm === undefined) {
      console.error(`✗ no arm named ${name}. One of: ${Object.keys(ARMS).join(", ")}`);
      return 2;
    }
    if (name === "navigate" && navigator === undefined) {
      console.log(`\n  navigate: skipped — it needs a model, and this is an offline run`);
      continue;
    }
    if (arm.needsGraph && graphLocal === undefined) {
      // Named rather than silently absent: a missing arm in the table must not read as a zero.
      console.log(`\n  ${name}: skipped — pass --graph to build the graph first (it costs one call per chunk)`);
      continue;
    }
    const retriever = retrieverFor(arm.reranker, name === "navigate");
    const results = [];
    const refusals = [];
    let elapsed = 0;
    process.stdout.write(`\n${name.padEnd(9)}`);
    for (const testCase of cases.cases) {
      const started = Date.now();
      /**
       * A refusal is a *result*, not a crash.
       *
       * `graph-global` throws when a query would pass its cost ceiling — correctly, since a partial map-reduce
       * must not be reported as a whole-corpus answer. In a measurement run that would abort the arm and lose
       * every other query's number, so it is recorded and counted instead.
       */
      let outcome;
      try {
        outcome = await retriever.retrieve({ tenantId: TENANT }, {
          query: testCase.query,
          authSubjects: [SUBJECT],
          limit: LIMIT,
          mode: arm.mode,
        });
      } catch (error) {
        refusals.push(`${testCase.id}: ${String(error).slice(0, 140)}`);
        outcome = { found: false };
      }
      elapsed += Date.now() - started;
      const hits = outcome.found ? outcome.hits : [];
      void started;
      results.push({ hits, judgements: testCase.relevant });
      const relevant = hits.some((hit) => testCase.relevant.some((judgement) => satisfies(hit, judgement)));
      process.stdout.write(relevant ? "." : "✗");
    }
    const scored = score(results);
    /**
     * Per class, kept apart — AC-2, AC-4.
     *
     * The eighteen original cases are the regression check: a mode that gains on multi-hop questions and loses
     * on ordinary ones has not improved retrieval, and one average would hide exactly that.
     */
    const byClass = {};
    for (const klass of ["chunk", "multihop", "corpus"]) {
      const subset = results.filter((_, at) => cases.cases[at].klass === klass);
      if (subset.length === 0) continue;
      byClass[klass] =
        klass === "corpus"
          ? { cases: subset.length, coverage: themeCoverage(subset) }
          : { cases: subset.length, ...score(subset) };
    }
    report.push({ arm: name, ...scored, byClass, msPerQuery: Math.round(elapsed / cases.cases.length) });
    console.log(
      `  success@5 ${percent(scored.success5)}  doc ${percent(scored.docSuccess5)}  P@1 ${percent(scored.p1)}  ` +
        `recall ${percent(scored.recall)}  ` +
        `MRR ${scored.mrr.toFixed(3)}  ${Math.round(elapsed / cases.cases.length)} ms`,
    );
    if (refusals.length > 0) {
      // Named, and counted into the report — an arm that refused every query has a real number of zero, and it
      // must not be readable as "found nothing".
      console.log(`    ⚠ ${refusals.length}/${cases.cases.length} queries refused: ${refusals[0]}`);
      report[report.length - 1].refused = refusals.length;
      report[report.length - 1].refusalExample = refusals[0];
    }
    for (const [klass, stats] of Object.entries(byClass)) {
      console.log(
        stats.coverage === undefined
          ? `    ${klass.padEnd(9)} n=${stats.cases}  success@5 ${percent(stats.success5)}  recall ${percent(stats.recall)}`
          : `    ${klass.padEnd(9)} n=${stats.cases}  document coverage ${percent(stats.coverage)}`,
      );
    }
    if (process.argv.includes("--misses")) {
      for (const [at, { hits, judgements }] of results.entries()) {
        if (hits.some((hit) => judgements.some((judgement) => satisfies(hit, judgement)))) continue;
        const testCase = cases.cases[at];
        console.log(`    ✗ ${testCase.id} "${testCase.query}"`);
        console.log(`       wanted: ${judgements.map((j) => `${j.source} ~ "${j.mustContain}"`).join(" | ")}`);
        console.log(`       got:    ${hits.map((hit) => hit.reference.sourceId).join(", ") || "nothing"}`);
      }
    }
  }

  console.log(`\n| arm | success@5 | right document | P@1 | recall | MRR | ms/query |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const row of report) {
    console.log(
      `| ${row.arm} | ${percent(row.success5)} | ${percent(row.docSuccess5)} | ${percent(row.p1)} | ` +
        `${percent(row.recall)} | ${row.mrr.toFixed(3)} | ${row.msPerQuery} |`,
    );
  }
  /**
   * Cost, printed beside quality rather than below it — AC-5.
   *
   * A mode that gains five points for six hundred index-time calls and four-second queries is a *different
   * decision* from one that gains five points for free, and a quality-only table hides which one this is.
   */
  if (graphCost.calls > 0) {
    const price = (input, output) => (input / 1e6) * 0.15 + (output / 1e6) * 0.6; // gpt-4o-mini list
    console.log(`\nGraphRAG index-time cost`);
    console.log(`  ${graphCost.calls} extraction calls + ${graphCost.summaryCalls} summary calls`);
    console.log(
      `  ${graphCost.inputTokens.toLocaleString()} in + ${graphCost.outputTokens.toLocaleString()} out ` +
        `≈ $${price(graphCost.inputTokens, graphCost.outputTokens).toFixed(4)}`,
    );
    console.log(`  ${Math.round(graphCost.elapsedMs / 1000)}s wall clock, ${graphCost.communities} communities`);
    if (mapperFailures.length > 0) {
      // Named, not swallowed: a run with failures read less of the corpus than the coverage suggests.
      console.log(`\n⚠ ${mapperFailures.length} map call(s) failed and scored zero: ${mapperFailures[0]}`);
    }
    if (mapperUsage.calls > 0) {
      console.log(`\ngraph-global query-time cost`);
      console.log(
        `  ${mapperUsage.calls} map calls across the run, ` +
          `${(mapperUsage.prompt + mapperUsage.completion).toLocaleString()} tokens ` +
          `≈ $${price(mapperUsage.prompt, mapperUsage.completion).toFixed(4)}`,
      );
    }
  }
  if (chooserUsage.prompt > 0) {
    // gpt-4o list pricing, so the number is comparable with docs/24's.
    const cost = (chooserUsage.prompt / 1e6) * 2.5 + (chooserUsage.completion / 1e6) * 10;
    console.log(
      `\nnavigate cost: ${chooserUsage.prompt.toLocaleString()} prompt + ${chooserUsage.completion.toLocaleString()} ` +
        `completion tokens ≈ $${cost.toFixed(4)} for ${cases.cases.length} queries ($${(cost / cases.cases.length).toFixed(5)} each)`,
    );
  }

  if (offline) {
    console.log("\n⚠ offline run: no report written. The hash embedder measures the keyword arm twice.");
    return 0;
  }

  const { writeFileSync } = await import("node:fs");
  // One file per chunking, so a variant run never overwrites the baseline it is compared against.
  writeFileSync(
    chunking === undefined ? OUT : OUT.replace(/\.json$/, `-chunk-${chunkArg}.json`),
    `${JSON.stringify(
      {
        corpus: {
          documents: outlines.length,
          chunks: chunkCount,
          embeddingModel: embeddings.model,
          chunking: chunking ?? "default (400/800/1)",
        },
        cases: cases.cases.length,
        arms: report,
        navigateCost: chooserUsage,
        graphCost: graphCost.calls > 0 ? graphCost : null,
        graphGlobalQueryCost: mapperUsage.calls > 0 ? mapperUsage : null,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${chunking === undefined ? OUT : OUT.replace(/\.json$/, `-chunk-${chunkArg}.json`)}`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
