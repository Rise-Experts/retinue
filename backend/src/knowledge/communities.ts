/**
 * Community detection — REQ-064 (#270), task #272.
 *
 * `graph-global` answers "what are the main themes?" by reducing over summaries of clusters. This produces the
 * clusters.
 *
 * ## Why this is implemented here rather than imported
 *
 * `backend` has exactly two runtime dependencies, `ai` and `zod`, and that is a property worth keeping. But the
 * dependency count is the smaller argument. The larger one is **determinism**: Microsoft's GraphRAG uses
 * hierarchical Leiden, and the widely-used implementations of Leiden and Louvain are seeded-random — they
 * shuffle node order to escape local optima, which is good for modularity and fatal here. #275 measures
 * GraphRAG against a fixed baseline, #272's own incremental rebuild is verified by comparing against a
 * previous clustering, and both need the same graph to cluster the same way twice.
 *
 * So this is Louvain with every source of nondeterminism removed:
 *
 * - Nodes are visited in **sorted id order**, never shuffled.
 * - A tie in modularity gain is broken by the **smallest community id**, so equal options resolve the same way.
 * - Aggregation preserves that ordering into the next level.
 *
 * The cost is some modularity — a shuffled Louvain finds slightly better partitions on average. That is a
 * trade worth making for a result that can be measured, diffed and debugged, and it is stated here rather than
 * discovered later by somebody wondering why two runs disagree.
 *
 * Louvain rather than label propagation, which was the other candidate: label propagation is simpler and
 * roughly as fast, but it produces one flat partition and #272 needs **hierarchy**. Louvain's aggregation
 * phases *are* the levels — level 0 is fine-grained, each subsequent level coarser — which is exactly the
 * granularity choice `graph-global` has to make between "what are the main themes" and "what are the themes in
 * observability".
 */

import type { TenantId } from "../core/ids.js";
import type {
  GraphStore,
  KnowledgeEntity,
  KnowledgeRelationship,
  KnowledgeStore,
} from "../persistence/index.js";

/** A cluster of entities at one level of the hierarchy. */
export type Community = {
  /**
   * Deterministic and readable: `L<level>:<smallest member id>`.
   *
   * Derived from the membership rather than assigned by a counter, so the same cluster keeps the same id
   * across runs — which is what lets a rebuild compare against the previous clustering at all. A counter would
   * renumber everything whenever one entity moved.
   */
  readonly id: string;
  readonly level: number;
  /** Sorted. */
  readonly entityIds: readonly string[];
  /** Edges with both endpoints inside this community, sorted. */
  readonly relationshipIds: readonly string[];
  /** Chunks behind those entities and edges, sorted. The provenance a summary inherits. */
  readonly chunkIds: readonly string[];
  /**
   * A fingerprint of exactly what this community contains.
   *
   * The mechanism behind incremental summarisation and visible staleness: a summary records the fingerprint it
   * was written against, and a community whose fingerprint no longer matches is stale — knowable without
   * re-reading the summary or trusting a timestamp.
   */
  readonly fingerprint: string;
};

type Edge = { readonly a: string; readonly b: string; readonly weight: number };

/**
 * One Louvain pass: move nodes between communities while modularity improves.
 *
 * Returns a map from node id to community label. Deterministic throughout — see the header.
 */
const localMoving = (nodes: readonly string[], edges: readonly Edge[]): Map<string, string> => {
  const community = new Map<string, string>(nodes.map((node) => [node, node]));
  const adjacency = new Map<string, { neighbour: string; weight: number }[]>(nodes.map((node) => [node, []]));
  const degree = new Map<string, number>(nodes.map((node) => [node, 0]));
  let totalWeight = 0;

  for (const edge of edges) {
    adjacency.get(edge.a)?.push({ neighbour: edge.b, weight: edge.weight });
    adjacency.get(edge.b)?.push({ neighbour: edge.a, weight: edge.weight });
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + edge.weight);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + edge.weight);
    totalWeight += edge.weight;
  }
  // A graph with no edges is a graph of singletons, and dividing by its total weight would be a NaN that
  // propagates into every gain comparison and produces an arbitrary partition.
  if (totalWeight === 0) return community;

  const m2 = 2 * totalWeight;
  const communityDegree = new Map<string, number>();
  for (const node of nodes) communityDegree.set(node, degree.get(node) ?? 0);

  // Bounded rather than "until no change": a cycle between two equal-gain configurations would otherwise spin
  // forever, and the bound costs at most a slightly worse partition.
  const MAX_PASSES = 20;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let moved = false;
    // Sorted order, every pass. This is the single most important line for determinism.
    for (const node of nodes) {
      const current = community.get(node) as string;
      const nodeDegree = degree.get(node) ?? 0;

      // Weight from this node into each candidate community.
      const into = new Map<string, number>();
      for (const { neighbour, weight } of adjacency.get(node) ?? []) {
        if (neighbour === node) continue;
        const target = community.get(neighbour) as string;
        into.set(target, (into.get(target) ?? 0) + weight);
      }

      // Remove the node from its own community before comparing, or it competes with itself.
      communityDegree.set(current, (communityDegree.get(current) ?? 0) - nodeDegree);

      let best = current;
      let bestGain = (into.get(current) ?? 0) - ((communityDegree.get(current) ?? 0) * nodeDegree) / m2;
      /**
       * Sorted, and **belt-and-braces rather than load-bearing** — worth saying, because a comment claiming
       * more than it does is how a redundant line survives a refactor that made it necessary.
       *
       * Given sorted nodes and sorted edges, adjacency lists are built in a deterministic order, so `into`
       * already iterates deterministically. Sorting here makes the tie-break independent of *that* fact, so a
       * future change to how adjacency is assembled cannot silently reintroduce order sensitivity. Removing it
       * today breaks no test, which is exactly what one would expect.
       */
      for (const target of [...into.keys()].sort()) {
        if (target === current) continue;
        const gain = (into.get(target) ?? 0) - ((communityDegree.get(target) ?? 0) * nodeDegree) / m2;
        // Strictly greater, then smallest id: an equal-gain move must resolve the same way every run, and
        // `>` alone would take whichever candidate happened to be visited first.
        if (gain > bestGain || (gain === bestGain && target < best)) {
          best = target;
          bestGain = gain;
        }
      }

      communityDegree.set(best, (communityDegree.get(best) ?? 0) + nodeDegree);
      if (best !== current) {
        community.set(node, best);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return community;
};

/** Relabels communities by their smallest member, so labels do not depend on which node was seen first. */
const canonicalise = (assignment: ReadonlyMap<string, string>): Map<string, string> => {
  const members = new Map<string, string[]>();
  for (const [node, label] of assignment) {
    const group = members.get(label);
    if (group === undefined) members.set(label, [node]);
    else group.push(node);
  }
  const canonical = new Map<string, string>();
  for (const [, group] of members) {
    const label = [...group].sort()[0] as string;
    for (const node of group) canonical.set(node, label);
  }
  return canonical;
};

const fingerprintOf = (level: number, entityIds: readonly string[], relationshipIds: readonly string[]): string =>
  `L${level}|${[...entityIds].sort().join(",")}|${[...relationshipIds].sort().join(",")}`;

/**
 * How many levels of hierarchy to build.
 *
 * Two is the minimum AC-1 asks for and the useful default: level 0 is fine-grained clusters and level 1 groups
 * them. More levels on a small graph collapse to the same partition repeated, which costs summarisation calls
 * for no new information — so the loop stops early when a level stops merging anything.
 */
export const DEFAULT_COMMUNITY_LEVELS = 2;

/**
 * Cluster a graph into a hierarchy of communities.
 *
 * Pure and deterministic: the same entities and relationships always produce the same result, which every test
 * of incremental rebuild depends on.
 *
 * Singletons are kept rather than dropped. An entity nothing links to is a real part of the corpus and a
 * `graph-global` answer that silently omitted every unconnected concept would be quietly wrong about what the
 * corpus contains.
 */
export const detectCommunities = (input: {
  readonly entityIds: readonly string[];
  readonly relationships: readonly KnowledgeRelationship[];
  readonly chunksOf: (entityId: string) => readonly string[];
  readonly levels?: number;
}): readonly Community[] => {
  const levels = Math.max(1, input.levels ?? DEFAULT_COMMUNITY_LEVELS);
  const out: Community[] = [];

  // Sorted once, and every derived list keeps that order.
  let nodes = [...input.entityIds].sort();
  if (nodes.length === 0) return [];

  const known = new Set(nodes);
  let edges: Edge[] = input.relationships
    .filter((edge) => known.has(edge.fromId) && known.has(edge.toId))
    // Undirected for clustering: "A depends on B" and "B is depended on by A" are the same association, and
    // direction would split a community that is obviously one.
    .map((edge) => ({ a: edge.fromId < edge.toId ? edge.fromId : edge.toId, b: edge.fromId < edge.toId ? edge.toId : edge.fromId, weight: edge.weight }))
    .sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));

  /** Which original entities each current node stands for. Grows as levels aggregate. */
  let expansion = new Map<string, string[]>(nodes.map((node) => [node, [node]]));

  for (let level = 0; level < levels; level += 1) {
    const assignment = canonicalise(localMoving(nodes, edges));

    const grouped = new Map<string, string[]>();
    for (const node of nodes) {
      const label = assignment.get(node) as string;
      const group = grouped.get(label);
      if (group === undefined) grouped.set(label, [node]);
      else group.push(node);
    }

    // A level that changed nothing adds no information and would cost a summarisation call per community.
    if (level > 0 && grouped.size === nodes.length) break;

    for (const [label, group] of [...grouped.entries()].sort()) {
      const entityIds = group.flatMap((node) => expansion.get(node) ?? [node]).sort();
      const inside = new Set(entityIds);
      const relationshipIds = input.relationships
        .filter((edge) => inside.has(edge.fromId) && inside.has(edge.toId))
        .map((edge) => edge.id)
        .sort();
      const chunkIds = [
        ...new Set([
          ...entityIds.flatMap((id) => input.chunksOf(id)),
          ...input.relationships.filter((edge) => relationshipIds.includes(edge.id)).flatMap((edge) => edge.provenance),
        ]),
      ].sort();
      out.push({
        // `label` is already the smallest member at this level, but the *expanded* smallest is what identifies
        // the cluster across levels — otherwise a level-1 community and the level-0 one it contains could
        // share an id.
        id: `L${level}:${entityIds[0] ?? label}`,
        level,
        entityIds,
        relationshipIds,
        chunkIds,
        fingerprint: fingerprintOf(level, entityIds, relationshipIds),
      });
    }

    if (grouped.size <= 1) break; // Everything is one community; there is nothing coarser to build.

    // Aggregate for the next level: each community becomes a node, edges between them are summed.
    const nextNodes = [...grouped.keys()].sort();
    const nextExpansion = new Map<string, string[]>(
      nextNodes.map((label) => [label, (grouped.get(label) ?? []).flatMap((node) => expansion.get(node) ?? [node]).sort()]),
    );
    const merged = new Map<string, number>();
    for (const edge of edges) {
      const a = assignment.get(edge.a) as string;
      const b = assignment.get(edge.b) as string;
      if (a === b) continue; // Internal edges do not connect communities.
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      merged.set(key, (merged.get(key) ?? 0) + edge.weight);
    }
    nodes = nextNodes;
    expansion = nextExpansion;
    edges = [...merged.entries()]
      .map(([key, weight]) => {
        const [a, b] = key.split(" ") as [string, string];
        return { a, b, weight };
      })
      .sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
  }

  return out;
};

/**
 * Writes a community's summary — REQ-064 (#270), task #272.
 *
 * A port, like `EntityExtractor`, and optional for the same reason: a deployment that clusters but never runs
 * `graph-global` needs no language model for it. Given the community's entities, its relationships and the
 * text behind them, and asked for a short description of what this cluster is *about*.
 */
export interface CommunitySummariser {
  readonly id: string;
  summarise(input: {
    readonly community: Community;
    /** The chunk text behind the community, already permission-free — it is all one tenant's own material. */
    readonly excerpts: readonly string[];
    readonly entityNames: readonly string[];
    readonly relationshipDescriptions: readonly string[];
  }): Promise<{ readonly summary: string; readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } }>;
}

export type CommunityRebuildResult = {
  readonly communities: number;
  readonly levels: number;
  /** Communities whose summary was reused because their membership did not change. The incremental saving. */
  readonly summariesKept: number;
  readonly summariesWritten: number;
  /** Summarisation calls that failed. The community survives without a summary — AC-7. */
  readonly summariesFailed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type CommunityBuilderDeps = {
  readonly store: GraphStore;
  /** Absent means cluster but do not summarise. Useful, and the honest default for a deployment without `graph-global`. */
  readonly summariser?: CommunitySummariser;
  readonly knowledge?: KnowledgeStore;
  readonly levels?: number;
  /** Chunk excerpts handed to the summariser per community. A ceiling, because a community can span hundreds. */
  readonly maxExcerpts?: number;
  /**
   * Which levels to summarise. Absent means all of them.
   *
   * **Worth setting, because summarising a level nobody queries is pure cost.** `graph-global` reads *one*
   * level per query — the coarsest by default — and a two-level hierarchy over a real corpus has far more
   * fine-grained communities than coarse ones. Summarising every level can therefore multiply the bill several
   * times over for content no query will ever reduce across.
   *
   * Not defaulted to the coarsest, deliberately: a deployment that lets callers ask at a finer granularity
   * needs those summaries, and silently not writing them would make `graph-global` at that level return
   * nothing with no explanation. The cost is real either way; this makes it a decision.
   */
  readonly summariseLevels?: readonly number[];
  readonly clock?: () => string;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

export const DEFAULT_MAX_EXCERPTS = 20;

/**
 * Rebuilds the community hierarchy, and re-summarises **only what changed**.
 *
 * This is where AC-5's "incremental" honestly lives, and it is worth being precise about the split rather than
 * claiming more than is true:
 *
 * - **Clustering is global and cheap.** Community detection is global by nature — one entity moving can change
 *   every level — so the whole graph is re-clustered. It is arithmetic over ids, with no model calls, and
 *   pretending to do it incrementally would mean a partition that disagrees with itself.
 * - **Summarisation is incremental and expensive.** One model call per community, and that is the cost worth
 *   avoiding. A community whose membership fingerprint is unchanged keeps its summary untouched.
 *
 * So changing one source re-clusters everything and re-summarises the handful of communities that actually
 * moved. The staleness window is therefore *zero for structure* and *one rebuild for summaries*, and a
 * community caught between the two is visibly stale rather than silently wrong.
 */
export const createCommunityBuilder = (deps: CommunityBuilderDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});
  const maxExcerpts = Math.max(1, deps.maxExcerpts ?? DEFAULT_MAX_EXCERPTS);

  return {
    summariserId: deps.summariser?.id ?? null,

    async rebuild(context: { readonly tenantId: TenantId }): Promise<CommunityRebuildResult> {
      // Everything, because clustering is global. Paged out rather than assumed to fit in one call.
      const entities: KnowledgeEntity[] = [];
      let cursor: string | undefined;
      do {
        const page = await deps.store.listEntities({
          tenantId: context.tenantId,
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        entities.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      const empty: CommunityRebuildResult = {
        communities: 0,
        levels: 0,
        summariesKept: 0,
        summariesWritten: 0,
        summariesFailed: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      if (entities.length === 0) {
        await deps.store.replaceCommunities({ tenantId: context.tenantId, communities: [] });
        return empty;
      }

      const entityIds = entities.map((entity) => entity.id).sort();
      const relationships = await deps.store.neighbours({
        tenantId: context.tenantId,
        entityIds,
        // Every edge, because clustering on a sample of the graph would produce a partition of a graph that
        // does not exist. The bound is generous rather than absent so a runaway corpus fails loudly.
        limit: Math.max(1000, entityIds.length * 20),
      });

      const chunksByEntity = new Map(entities.map((entity) => [entity.id, entity.provenance]));
      const communities = detectCommunities({
        entityIds,
        relationships,
        chunksOf: (id) => chunksByEntity.get(id) ?? [],
        ...(deps.levels === undefined ? {} : { levels: deps.levels }),
      });

      const written = await deps.store.replaceCommunities({ tenantId: context.tenantId, communities });
      const levels = new Set(communities.map((community) => community.level)).size;

      if (deps.summariser === undefined) {
        return { ...empty, communities: communities.length, levels, summariesKept: written.summariesKept };
      }

      const namesById = new Map(entities.map((entity) => [entity.id, entity.name]));
      const byId = new Map(relationships.map((edge) => [edge.id, edge]));
      let summariesWritten = 0;
      let summariesFailed = 0;
      let inputTokens = 0;
      let outputTokens = 0;

      const wantedLevels = deps.summariseLevels === undefined ? null : new Set(deps.summariseLevels);
      for (const community of communities) {
        // A level nobody queries costs nothing — see `summariseLevels`.
        if (wantedLevels !== null && !wantedLevels.has(community.level)) continue;
        // Only what changed. `replaceCommunities` already carried over the summaries that survived, so a
        // community that still has one is one this pass must not pay for again.
        const stored = await deps.store.getCommunity({ tenantId: context.tenantId, id: community.id });
        if (stored?.summary !== undefined && stored.summaryFingerprint === community.fingerprint) continue;

        const excerpts: string[] = [];
        if (deps.knowledge !== undefined) {
          for (const chunkId of community.chunkIds.slice(0, maxExcerpts)) {
            const chunk = await deps.knowledge.get({ tenantId: context.tenantId, id: chunkId });
            if (chunk !== null) excerpts.push(chunk.content);
          }
        }
        try {
          const { summary, usage } = await deps.summariser.summarise({
            community,
            excerpts,
            entityNames: community.entityIds.map((id) => namesById.get(id) ?? id),
            relationshipDescriptions: community.relationshipIds.map((id) => {
              const edge = byId.get(id);
              return edge === undefined
                ? id
                : `${namesById.get(edge.fromId) ?? edge.fromId} ${edge.type} ${namesById.get(edge.toId) ?? edge.toId}`;
            }),
          });
          inputTokens += usage?.inputTokens ?? 0;
          outputTokens += usage?.outputTokens ?? 0;
          if (summary.trim() === "") {
            // An empty summary is a failure wearing a success's shape: `graph-global` would reduce over it and
            // silently under-report the corpus.
            summariesFailed += 1;
            continue;
          }
          await deps.store.setCommunitySummary({
            tenantId: context.tenantId,
            id: community.id,
            summary,
            fingerprint: community.fingerprint,
            at: clock(),
          });
          summariesWritten += 1;
        } catch (error) {
          /**
           * AC-7. A failed summarisation leaves the community **without** a summary, never with a wrong one.
           *
           * Swallowed rather than propagated because the clustering succeeded and is useful on its own —
           * failing the rebuild would discard a correct hierarchy over one model call. `graph-global` sees a
           * community with no summary and can say so.
           */
          summariesFailed += 1;
          log("community summarisation failed", {
            communityId: community.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (summariesFailed > 0)
        log("some communities have no summary", { failed: summariesFailed, of: communities.length });

      return {
        communities: communities.length,
        levels,
        summariesKept: written.summariesKept,
        summariesWritten,
        summariesFailed,
        inputTokens,
        outputTokens,
      };
    },
  };
};

export type CommunityBuilder = ReturnType<typeof createCommunityBuilder>;
