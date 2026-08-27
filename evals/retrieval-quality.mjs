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
import { createMemoryKnowledgeBackend } from "@retinue/agentkit/persistence";
import {
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
  const cases = { cases: JSON.parse(readFileSync(CASES, "utf8")).map((entry) => ({ id: entry.id, query: entry.input.message, relevant: entry.expect.relevant })) };
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
    });

  const ARMS = {
    keyword: { mode: "keyword", reranker: false },
    semantic: { mode: "semantic", reranker: false },
    hybrid: { mode: "hybrid", reranker: false },
    rerank: { mode: "hybrid", reranker: true },
    navigate: { mode: "navigate", reranker: false },
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
    const retriever = retrieverFor(arm.reranker, name === "navigate");
    const results = [];
    let elapsed = 0;
    process.stdout.write(`\n${name.padEnd(9)}`);
    for (const testCase of cases.cases) {
      const started = Date.now();
      const outcome = await retriever.retrieve({ tenantId: TENANT }, {
        query: testCase.query,
        authSubjects: [SUBJECT],
        limit: LIMIT,
        mode: arm.mode,
      });
      elapsed += Date.now() - started;
      const hits = outcome.found ? outcome.hits : [];
      results.push({ hits, judgements: testCase.relevant });
      const relevant = hits.some((hit) => testCase.relevant.some((judgement) => satisfies(hit, judgement)));
      process.stdout.write(relevant ? "." : "✗");
    }
    const scored = score(results);
    report.push({ arm: name, ...scored, msPerQuery: Math.round(elapsed / cases.cases.length) });
    console.log(
      `  success@5 ${percent(scored.success5)}  doc ${percent(scored.docSuccess5)}  P@1 ${percent(scored.p1)}  ` +
        `recall ${percent(scored.recall)}  ` +
        `MRR ${scored.mrr.toFixed(3)}  ${Math.round(elapsed / cases.cases.length)} ms`,
    );
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
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${chunking === undefined ? OUT : OUT.replace(/\.json$/, `-chunk-${chunkArg}.json`)}`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
