/**
 * `graph-global` — map-reduce over community summaries. REQ-064 (#270), task #274.
 *
 * The mode that answers *"what are the main themes in our incident reports?"* — a question that requires having
 * read everything, which top-k retrieval by construction does not.
 *
 * ## The output shape, decided — AC-7
 *
 * The issue left this open, and it is the one real design question here. Three candidates:
 *
 * 1. **A synthesised answer** in a new shape. Most honest about what happened, and it breaks every existing
 *    consumer of `RetrievalOutcome` — citations, the empty-result union, the tools above.
 * 2. **Synthetic chunks** whose content is the community summary. Tempting and wrong: a `KnowledgeChunk` has an
 *    id that resolves and a source that exists, and a fabricated one produces a citation pointing at nothing.
 *    The model would present a generated summary as though a document said it, which is the failure provenance
 *    exists to prevent.
 * 3. **Real chunk hits from the communities the map phase selected.** Citations resolve, every consumer works
 *    unchanged, and the corpus-level reasoning is real — it happened in *choosing which communities matter*,
 *    which is what reading everything buys you.
 *
 * **Three**, and the summaries are not discarded: they come back on `GraphGlobalResult` alongside coverage, for
 * a caller that wants the thematic answer rather than the passages behind it. What this mode does *not* do is
 * hand the model a summary dressed as a source.
 *
 * ## The ceiling is the design, not a guard bolted on
 *
 * Cost scales with the number of communities, which scales with the corpus. A large tenant's global query could
 * issue hundreds of model calls. So the ceiling is checked **before spending**, from the community count — a
 * refusal that arrives after two hundred calls is not a ceiling, it is a bill with an apology.
 *
 * And it **refuses** rather than truncating. A partial map-reduce presented as a whole-corpus answer is a wrong
 * answer with a confident shape, which is worse than no answer: "the main themes are X and Y" is false if it
 * read a third of the corpus, and nothing in the sentence says so.
 */

import type { TenantId } from "../core/ids.js";
import { AgentPlatformError } from "../core/errors.js";
import {
  isCommunityStale,
  type GraphStore,
  type KnowledgeChunk,
  type KnowledgeSourceType,
  type KnowledgeStore,
  type StoredCommunity,
} from "../persistence/index.js";

/**
 * What the map phase says about one community.
 *
 * A score and the points that earned it. The score is the model's own judgement of relevance, which is the
 * only thing available — there is no embedding of "what are the main themes" that ranks a summary usefully.
 */
export type CommunityRelevance = {
  readonly communityId: string;
  /** 0–10, as the mapper reported it. Zero means the community has nothing to do with the question. */
  readonly score: number;
  /** What in this community bears on the question, in the mapper's words. Empty when nothing does. */
  readonly points: readonly string[];
};

/**
 * Scores one community summary against the question.
 *
 * A port, so the map phase can be a cheap model, a local one, or — for a test — a deterministic function. This
 * is the call that runs once per community per query, so it is the one worth making cheap.
 */
export interface CommunityMapper {
  readonly id: string;
  map(input: {
    readonly query: string;
    readonly community: StoredCommunity;
  }): Promise<{ readonly relevance: CommunityRelevance; readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } }>;
}

/**
 * How many model calls one global query may make, by default.
 *
 * Forty is a corpus of a few hundred documents at a coarse level. It is deliberately a number somebody has to
 * raise consciously: the failure this bounds is not a slow query, it is a tenant growing until one question
 * costs more than a day of ordinary use.
 */
export const DEFAULT_GLOBAL_CALL_CEILING = 40;

/** A companion ceiling, because a small number of enormous summaries costs as much as many small ones. */
export const DEFAULT_GLOBAL_TOKEN_CEILING = 120_000;

/** Below this the map phase considered the community irrelevant and its chunks are not gathered. */
export const DEFAULT_RELEVANCE_SCORE = 1;

export type GraphGlobalResult = {
  readonly hits: readonly { readonly chunk: KnowledgeChunk; readonly score: number; readonly communityId: string }[];
  /**
   * The thematic answer: the summaries the map phase kept, best first, with what it found in each.
   *
   * Returned rather than folded into the hits, for the reason in the header — a summary is generated text and
   * must never be dressed as a source.
   */
  readonly themes: readonly {
    readonly communityId: string;
    readonly summary: string;
    readonly score: number;
    readonly points: readonly string[];
    /** True when this summary predates the community's current membership — disclosed, never hidden. */
    readonly stale: boolean;
  }[];
  /** What was actually read, so "I read your corpus" and "I read 12 of 40 communities" are distinguishable. */
  readonly coverage: {
    readonly level: number;
    readonly communitiesTotal: number;
    readonly communitiesRead: number;
    readonly communitiesRelevant: number;
    /** Communities skipped because they have no summary yet — knowable, not silently absent. */
    readonly communitiesUnsummarised: number;
    readonly staleSummaries: number;
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly elapsedMs: number;
  };
};

export type GraphGlobalSearchDeps = {
  readonly graph: GraphStore;
  readonly knowledge: KnowledgeStore;
  readonly mapper: CommunityMapper;
  /** Which granularity to read. Absent means choose by question breadth — see `chooseLevel`. */
  readonly level?: number;
  readonly callCeiling?: number;
  readonly tokenCeiling?: number;
  readonly minScore?: number;
  /** Chunks gathered per relevant community. The reduce is over summaries; these are the passages behind them. */
  readonly chunksPerCommunity?: number;
  readonly now?: () => number;
};

export interface GraphGlobalSearch {
  search(
    context: { readonly tenantId: TenantId },
    input: {
      readonly query: string;
      readonly authSubjects: readonly string[];
      readonly limit: number;
      readonly sourceTypes?: readonly KnowledgeSourceType[];
      /** Overrides the configured level, for a caller that knows the question's breadth. */
      readonly level?: number;
    },
  ): Promise<GraphGlobalResult>;
}

/**
 * Which level of the hierarchy to read.
 *
 * The coarsest available, by default. Reading every level multiplies cost for largely repeated content — a
 * level-1 community contains the level-0 ones under it, so summarising both says the same thing twice at twice
 * the price. Coarse suits "what are the main themes"; a caller with a narrower question passes a finer level.
 *
 * Exported because the choice is worth testing on its own: picking the wrong level is the difference between
 * an answer about the corpus and an answer about one team.
 */
export const chooseLevel = (available: readonly number[], requested?: number): number => {
  if (available.length === 0) return 0;
  if (requested !== undefined && available.includes(requested)) return requested;
  return Math.max(...available);
};

export const createGraphGlobalSearch = (deps: GraphGlobalSearchDeps): GraphGlobalSearch => {
  const callCeiling = Math.max(1, deps.callCeiling ?? DEFAULT_GLOBAL_CALL_CEILING);
  const tokenCeiling = Math.max(1, deps.tokenCeiling ?? DEFAULT_GLOBAL_TOKEN_CEILING);
  const minScore = deps.minScore ?? DEFAULT_RELEVANCE_SCORE;
  const chunksPerCommunity = Math.max(1, deps.chunksPerCommunity ?? 3);
  const now = deps.now ?? (() => Date.now());

  const allCommunities = async (tenantId: TenantId): Promise<StoredCommunity[]> => {
    const out: StoredCommunity[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.graph.listCommunities({
        tenantId,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  };

  return {
    async search(context, input) {
      const started = now();
      const everything = await allCommunities(context.tenantId);
      const level = chooseLevel([...new Set(everything.map((c) => c.level))], input.level ?? deps.level);
      const atLevel = everything.filter((community) => community.level === level);

      const empty: GraphGlobalResult = {
        hits: [],
        themes: [],
        coverage: {
          level,
          communitiesTotal: atLevel.length,
          communitiesRead: 0,
          communitiesRelevant: 0,
          communitiesUnsummarised: atLevel.filter((c) => c.summary === undefined).length,
          staleSummaries: 0,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          elapsedMs: now() - started,
        },
      };
      if (input.authSubjects.length === 0 || atLevel.length === 0) return empty;

      // Only summarised communities can be mapped. Counted rather than quietly skipped — a corpus that is half
      // unsummarised produces a partial answer, and the caller has to be able to see that.
      const readable = atLevel.filter((community) => community.summary !== undefined);
      if (readable.length === 0) return empty;

      /**
       * **The ceiling, checked before spending.** AC-3, AC-4.
       *
       * From the community count, which is known without calling anything. A check after the loop, or inside
       * it, would refuse having already spent most of what it was refusing.
       */
      if (readable.length > callCeiling) {
        throw new AgentPlatformError({
          code: "budget_exceeded",
          message:
            `A corpus-wide answer at level ${level} would read ${readable.length} community summaries, and the ` +
            `ceiling is ${callCeiling} model calls. Raise the ceiling, ask at a coarser level, or narrow the ` +
            "question so graph-local can answer it. Nothing was spent.",
          retryable: false,
        });
      }

      let calls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      const scored: { community: StoredCommunity; relevance: CommunityRelevance }[] = [];

      // Sorted, so a run is reproducible and a token-ceiling stop cuts at the same place.
      for (const community of [...readable].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const { relevance, usage } = await deps.mapper.map({ query: input.query, community });
        calls += 1;
        inputTokens += usage?.inputTokens ?? 0;
        outputTokens += usage?.outputTokens ?? 0;
        scored.push({ community, relevance });

        /**
         * The token ceiling can only be checked *during* the loop — summary sizes are not knowable up front —
         * so unlike the call ceiling this one can be reached mid-flight. It still refuses rather than
         * returning what it has, for the same reason: a partial map-reduce presented as a whole-corpus answer
         * is confidently wrong.
         */
        if (inputTokens + outputTokens > tokenCeiling) {
          throw new AgentPlatformError({
            code: "budget_exceeded",
            message:
              `A corpus-wide answer at level ${level} passed the ${tokenCeiling}-token ceiling after ` +
              `${calls} of ${readable.length} community summaries. Raise the ceiling or ask at a coarser level. ` +
              "A partial reading is not reported as a whole-corpus answer.",
            retryable: false,
          });
        }
      }

      const relevant = scored
        .filter((entry) => entry.relevance.score >= minScore)
        // Best first; ties by id so the order is total and the result reproducible.
        .sort((a, b) => b.relevance.score - a.relevance.score || (a.community.id < b.community.id ? -1 : 1));

      const allowed = new Set(input.authSubjects);
      const wantedTypes = input.sourceTypes === undefined ? null : new Set(input.sourceTypes);
      // Mutable locals, widened from the readonly result type — the arrays are built here and frozen by
      // the return type, which is the shape every other result in this module uses.
      const hits: { chunk: KnowledgeChunk; score: number; communityId: string }[] = [];
      const best = relevant[0]?.relevance.score ?? 1;

      for (const entry of relevant) {
        let taken = 0;
        for (const chunkId of entry.community.chunkIds) {
          if (taken >= chunksPerCommunity || hits.length >= input.limit) break;
          const chunk = await deps.knowledge.get({ tenantId: context.tenantId, id: chunkId });
          if (chunk === null) continue;
          /**
           * AC-8. The same primary-key read `graph-local` guards, and the same reasoning: a community spans
           * whatever its entities span, including sources this principal cannot read.
           *
           * The *summary* is the harder half of AC-8 and is handled below — see `themes`.
           */
          if (!allowed.has(chunk.authSubject)) continue;
          if (wantedTypes !== null && !wantedTypes.has(chunk.sourceType)) continue;
          hits.push({
            chunk,
            score: best === 0 ? 0 : entry.relevance.score / best,
            communityId: entry.community.id,
          });
          taken += 1;
        }
        if (hits.length >= input.limit) break;
      }

      /**
       * **The summary leak, and what is actually done about it — AC-8.**
       *
       * A community summary is generated text over every chunk in the community, so it can paraphrase a
       * document this principal cannot read. Filtering the summary is not possible: it is prose, and there is
       * no way to remove one source's contribution from a sentence after the fact.
       *
       * So a theme is returned **only when the principal can read every chunk behind it**. That is stricter
       * than necessary — a summary may not in fact mention the restricted source — and it is the only rule
       * that cannot leak. The alternative, returning it and hoping, is exactly the kind of "probably fine" that
       * a permission boundary must not be built on.
       *
       * The cost is real and worth naming: on a corpus with mixed permissions, a principal sees fewer themes
       * than a colleague, and the coverage numbers say how many. That is a comprehensible answer. A summary
       * quoting a document they were never allowed to open is not.
       */
      const themes: { communityId: string; summary: string; score: number; points: readonly string[]; stale: boolean }[] = [];
      for (const entry of relevant) {
        const chunks = await Promise.all(
          entry.community.chunkIds.map((id) => deps.knowledge.get({ tenantId: context.tenantId, id })),
        );
        const readableToCaller = chunks.every((chunk) => chunk === null || allowed.has(chunk.authSubject));
        if (!readableToCaller) continue;
        themes.push({
          communityId: entry.community.id,
          summary: entry.community.summary as string,
          score: entry.relevance.score,
          points: entry.relevance.points,
          // Disclosed rather than hidden: an answer built on summaries written before the last three documents
          // landed is defensible; presenting it as current is not.
          stale: isCommunityStale(entry.community),
        });
      }

      return {
        hits,
        themes,
        coverage: {
          level,
          communitiesTotal: atLevel.length,
          communitiesRead: calls,
          communitiesRelevant: relevant.length,
          communitiesUnsummarised: atLevel.length - readable.length,
          staleSummaries: themes.filter((theme) => theme.stale).length,
          calls,
          inputTokens,
          outputTokens,
          elapsedMs: now() - started,
        },
      };
    },
  };
};
