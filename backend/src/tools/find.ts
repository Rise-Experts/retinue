/**
 * `find_tools` — REQ-045 (#204), task #210, AC-1 and AC-2.
 *
 * Search over tool descriptors, so a catalogue can be *findable* rather than resident. The two-tier loading
 * already keeps schemas out of context; this keeps the compact entries out too, which is what makes a budget
 * (AC-3) something other than a way to hide tools from the model permanently.
 *
 * ## What is reused, and the one thing that is not
 *
 * **Fusion is `fuseByRank`** — the same reciprocal rank fusion, the same `K = 60`, the same normalisation and
 * the same relevance floor as knowledge retrieval. There is one implementation and both callers use it.
 *
 * **Embeddings are the same port.** `EmbeddingProvider`, injected. No second embedding path, no second client,
 * no second cache format.
 *
 * **The keyword signal is not `KeywordIndex`, and that is a finding rather than a shortcut.** `KeywordIndex` is
 * a Postgres full-text index over `knowledge_chunks`; tools are not rows in that table and putting them there
 * would mean a write path, a migration, and an index to keep in sync with a registry that is assembled per
 * request from providers. A corpus of a few hundred short documents that already lives in memory does not need
 * an index — it needs a scan, and the scan is deterministic and free. AC-2's "no second implementation" is about
 * not having two rankers; this is one ranker over a corpus the other one cannot hold.
 *
 * ## Why the semantic signal is optional
 *
 * Without an `EmbeddingProvider` this is keyword-only, and it says so in the result rather than pretending. Most
 * deployments will not wire embeddings *for tools*: #221 measured selection accuracy as flat from 20 to 200
 * tools, so the case for `find_tools` is context cost, not accuracy — and a deployment that pays for embeddings
 * to solve a problem it does not have is exactly the cost this repository keeps refusing to impose by default.
 */

import { DEFAULT_CANDIDATES, DEFAULT_RELEVANCE_FLOOR, fuseByRank } from "../knowledge/retrieval.js";
import { SEMANTIC_RELEVANCE_FLOOR } from "../persistence/index.js";
import type { EmbeddingProvider } from "../knowledge/index.js";
import type { ToolCatalogEntry, ToolDescriptor } from "./index.js";

/** Which signals found a tool. Reported, because "keyword only" is a different confidence from "both agreed". */
export type ToolSearchSignal = "semantic" | "keyword";

export type ToolSearchHit = {
  readonly entry: ToolCatalogEntry;
  /** 0–1 relative to the best hit for this query. Never comparable across queries. */
  readonly score: number;
  readonly signals: readonly ToolSearchSignal[];
};

export type ToolSearchOutcome = {
  readonly hits: readonly ToolSearchHit[];
  /** The signals actually used. Keyword-only when no embedding provider is wired. */
  readonly modes: readonly ToolSearchSignal[];
};

/**
 * The absolute floor, and why a relative one is not enough.
 *
 * Fused scores are normalised against the best hit, so a query that matched exactly one tool badly gives that
 * tool a score of 1.0 — the relative floor cannot reject a uniformly poor result set, because something is
 * always the best of it. Knowledge retrieval solves this with an absolute `semanticFloor` handed to the vector
 * index; this is the same idea for the keyword signal.
 *
 * **2 is one name or category hit, or two words of prose.** A single common word appearing somewhere in a
 * description is not evidence: "translate this into Welsh" found `parse_csv`, whose description happens to say
 * "into", and returned it with a perfect score. That was a real result from the first run of this file's tests,
 * and it is the least-bad-match failure the floor exists to prevent — a model handed the least-bad tool calls it.
 */
export const MIN_KEYWORD_SCORE = 2;

export type ToolSearchDeps = {
  /** Absent means keyword-only — see the note above on why that is the honest default. */
  readonly embeddings?: EmbeddingProvider;
  readonly candidates?: number;
  readonly relevanceFloor?: number;
  /** The absolute keyword floor. See `MIN_KEYWORD_SCORE`. */
  readonly minKeywordScore?: number;
  /** The absolute semantic floor, for the same reason. Defaults to the platform's `SEMANTIC_RELEVANCE_FLOOR`. */
  readonly minSimilarity?: number;
};

/** The compact entry a catalogue shows, derived once so search and catalogue cannot disagree about a tool. */
export const compactEntry = (d: ToolDescriptor): ToolCatalogEntry => ({
  name: d.name,
  label: d.label,
  description: d.description,
  category: d.category,
  effect: d.effect,
});

/**
 * Words too common to carry a signal.
 *
 * Short, and deliberately not a linguistic stopword list: a query is a *need* phrased by a model — "I need to
 * open an issue on a repository" — and the words worth dropping are the ones that appear in every such phrasing.
 * Dropping too many turns "list the files" into a query for nothing.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "for", "from", "get", "how", "i",
  "in", "is", "it", "me", "my", "need", "of", "on", "or", "please", "so", "that", "the", "then", "there",
  "this", "to", "use", "want", "was", "what", "which", "with", "would", "you",
]);

export const termsOf = (text: string): readonly string[] => {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
};

/** What a tool is embedded and matched as. One string, so both signals read the same document. */
export const documentFor = (entry: ToolCatalogEntry): string =>
  `${entry.name} ${entry.label} ${entry.category} ${entry.description}`;

/**
 * The keyword signal: how many of the query's terms this tool mentions, and where.
 *
 * Weighted by field, because a term in the *name* is a different claim from a term buried in prose — a query for
 * "issue" should rank `github_create_issue` above a tool whose description mentions issues in passing. Weights
 * are small integers rather than tuned constants: RRF uses only the rank, so their exact values decide ordering
 * and nothing else, and a fused score cannot be dominated by a badly chosen one.
 */
export const keywordScore = (entry: ToolCatalogEntry, queryTerms: readonly string[]): number => {
  if (queryTerms.length === 0) return 0;
  const name = termsOf(`${entry.name} ${entry.label}`);
  const category = termsOf(entry.category);
  const description = termsOf(entry.description);
  let score = 0;
  for (const term of queryTerms) {
    if (name.includes(term)) score += 3;
    else if (category.includes(term)) score += 2;
    else if (description.includes(term)) score += 1;
  }
  return score;
};

/**
 * The same score, divided by document length — and this is what fixed a real ranking defect.
 *
 * The 200-tool measurement found `find_tools` returning `archive_post_metrics` above `get_post_metrics`. Both
 * match the query's terms identically, so the raw scores tied and the tie-break — alphabetical by name — decided
 * it. Alphabetical order is arbitrary with respect to relevance, and in a catalogue whose near-duplicates are
 * `<verb>_<object>` it is *systematically* wrong: it prefers whichever verb sorts earliest.
 *
 * Length normalisation is the standard answer and it is the correct one here rather than a fitted one: the
 * distractors are the base tool's description **plus** a qualifier, so they say the same thing less densely. A
 * short, focused description that matches your query is a better match than a long one that matches it
 * incidentally. `sqrt` rather than a linear divisor, as in BM25, so a genuinely detailed description is not
 * punished out of contention.
 *
 * The raw score still decides the *floor* (see `MIN_KEYWORD_SCORE`); this decides the *order*. Two values,
 * because "is this a match at all" and "which match is better" are different questions.
 */
export const weightedKeywordScore = (entry: ToolCatalogEntry, queryTerms: readonly string[]): number => {
  const raw = keywordScore(entry, queryTerms);
  if (raw === 0) return 0;
  const length = termsOf(documentFor(entry)).length;
  return raw / Math.sqrt(Math.max(1, length));
};

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / (Math.sqrt(aa) * Math.sqrt(bb));
};

export type ToolSearch = {
  search(input: {
    readonly query: string;
    readonly tools: readonly ToolDescriptor[];
    readonly limit: number;
  }): Promise<ToolSearchOutcome>;
};

export const createToolSearch = (deps: ToolSearchDeps = {}): ToolSearch => {
  const candidateCount = deps.candidates ?? DEFAULT_CANDIDATES;
  const floor = deps.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR;
  const minKeyword = deps.minKeywordScore ?? MIN_KEYWORD_SCORE;
  const minSimilarity = deps.minSimilarity ?? SEMANTIC_RELEVANCE_FLOOR;

  /**
   * Embeddings, cached by the document text.
   *
   * Keyed on the text rather than on the tool name, so a tool whose description changed is re-embedded instead
   * of answering from a vector for prose that no longer exists. That failure would be invisible: the search
   * would keep working and keep ranking by the old description.
   */
  const vectors = new Map<string, readonly number[]>();

  const embedMissing = async (documents: readonly string[]): Promise<void> => {
    if (deps.embeddings === undefined) return;
    const missing = [...new Set(documents.filter((document) => !vectors.has(document)))];
    if (missing.length === 0) return;
    const embedded = await deps.embeddings.embed(missing);
    missing.forEach((document, index) => {
      const vector = embedded[index];
      if (vector !== undefined) vectors.set(document, vector);
    });
  };

  return {
    async search({ query, tools, limit }) {
      const entries = tools.map(compactEntry);
      const queryTerms = termsOf(query);
      if (query.trim() === "" || entries.length === 0)
        return { hits: [], modes: deps.embeddings === undefined ? ["keyword"] : ["semantic", "keyword"] };

      const keyword = entries
        // Floored on the raw score, ordered by the length-normalised one — see `weightedKeywordScore`.
        .map((entry) => ({ entry, raw: keywordScore(entry, queryTerms), weighted: weightedKeywordScore(entry, queryTerms) }))
        .filter((scored) => scored.raw >= minKeyword)
        .sort((a, b) => (b.weighted !== a.weighted ? b.weighted - a.weighted : a.entry.name.localeCompare(b.entry.name)))
        .slice(0, candidateCount)
        .map((scored) => scored.entry);

      let semantic: readonly ToolCatalogEntry[] = [];
      if (deps.embeddings !== undefined) {
        const documents = entries.map(documentFor);
        await embedMissing([query, ...documents]);
        const queryVector = vectors.get(query);
        if (queryVector !== undefined) {
          semantic = entries
            .map((entry) => ({ entry, similarity: cosine(queryVector, vectors.get(documentFor(entry)) ?? []) }))
            .filter((scored) => scored.similarity >= minSimilarity)
            .sort((a, b) =>
              b.similarity !== a.similarity ? b.similarity - a.similarity : a.entry.name.localeCompare(b.entry.name),
            )
            .slice(0, candidateCount)
            .map((scored) => scored.entry);
        }
      }

      const fused = fuseByRank<ToolCatalogEntry, ToolSearchSignal>({
        lists: [
          { signal: "semantic", items: semantic },
          { signal: "keyword", items: keyword },
        ],
        keyOf: (entry) => entry.name,
      });

      // The same relative floor as knowledge retrieval, and for the same reason: without one, every query
      // returns *something*, and a model handed the least-bad tool calls it.
      const hits = fused
        .filter((entry) => entry.score >= floor)
        .slice(0, limit)
        .map((entry) => ({ entry: entry.item, score: entry.score, signals: entry.signals }));

      return { hits, modes: deps.embeddings === undefined ? ["keyword"] : ["semantic", "keyword"] };
    },
  };
};
