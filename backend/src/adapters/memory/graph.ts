/**
 * In-memory `GraphStore` — the reference implementation (REQ-064 #270, task #271).
 *
 * The same standard the in-memory `KnowledgeStore` holds itself to: this is not a stub that makes tests pass,
 * it is the definition of the contract that the Postgres adapter is then held to by the same conformance suite.
 * Three things it takes as seriously as a database would:
 *
 * - **Tenant isolation is structural.** Every map is keyed by tenant first, so cross-tenant reads are not
 *   prevented by a filter somebody could forget — there is nowhere for another tenant's rows to be.
 * - **Provenance is enforced, not assumed.** A row with no chunks is refused here, so the refusal is part of
 *   the contract rather than a Postgres constraint that the reference adapter quietly tolerates.
 * - **A source's contribution is what is replaced.** Entities are shared between sources; re-indexing one
 *   document withdraws its claims and prunes only what nothing else asserts.
 */

import type { Page } from "../../core/context.js";
import { AgentPlatformError } from "../../core/errors.js";
import type {
  GraphContribution,
  GraphSettings,
  GraphStore,
  KnowledgeEntity,
  KnowledgeRelationship,
  KnowledgeSourceType,
} from "../../persistence/index.js";

const sourceKey = (sourceType: string, sourceId: string): string => `${sourceType} ${sourceId}`;

/**
 * One source's stored contribution.
 *
 * The entities and edges exactly as that source asserted them. The merged graph is *derived* from every
 * source's contribution rather than stored alongside them, which is what makes pruning correct with no
 * reference counting: an entity exists precisely while some contribution names it.
 */
type Contribution = { readonly entities: readonly KnowledgeEntity[]; readonly relationships: readonly KnowledgeRelationship[] };

type TenantGraph = {
  settings: GraphSettings;
  readonly sourceFlags: Map<string, boolean>;
  readonly contributions: Map<string, Contribution>;
};

const DEFAULT_SETTINGS: GraphSettings = { enabled: false, updatedAt: "1970-01-01T00:00:00.000Z" };

const uniqueSorted = (values: Iterable<string>): readonly string[] => [...new Set(values)].sort();
const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every contribution, merged into the graph a reader sees.
 *
 * Recomputed on read rather than maintained on write. That is the right trade for a reference adapter: the
 * merge rule then exists in exactly one place, and a bug in it cannot leave a stored graph subtly inconsistent
 * with the contributions it came from. Postgres maintains merged rows for query speed and is held to producing
 * the same answer by `fingerprint`.
 */
const mergeAll = (
  source: Iterable<Contribution>,
): { entities: KnowledgeEntity[]; relationships: KnowledgeRelationship[] } => {
  /**
   * Materialised, because this function walks it **twice** — entities, then relationships.
   *
   * The first version took the `Iterable` and looped it directly, which works for an array and is silently
   * wrong for `Map.values()`: an iterator is exhausted by the first pass, so the second saw nothing and *every
   * edge was dropped*. Entities were correct, so the graph looked plausible; only a traversal returned empty.
   * Found by the neighbour-ordering test, and worth the parameter rename so the two loops cannot drift back.
   */
  const contributions = [...source];
  const entities = new Map<string, KnowledgeEntity>();
  const relationships = new Map<string, KnowledgeRelationship>();

  for (const contribution of contributions) {
    for (const entity of contribution.entities) {
      const existing = entities.get(entity.id);
      if (existing === undefined) {
        entities.set(entity.id, entity);
        continue;
      }
      const description =
        (entity.description ?? "").length > (existing.description ?? "").length ? entity.description : existing.description;
      entities.set(entity.id, {
        id: entity.id,
        // Lexicographically first, matching `mergeContributions`. "First written" would depend on source order,
        // and source order is a thing that changes without the corpus changing.
        name: existing.name < entity.name ? existing.name : entity.name,
        type: existing.type,
        ...(description === undefined ? {} : { description }),
        surfaceForms: uniqueSorted([...existing.surfaceForms, ...entity.surfaceForms]),
        provenance: uniqueSorted([...existing.provenance, ...entity.provenance]),
      });
    }
  }

  for (const contribution of contributions) {
    for (const edge of contribution.relationships) {
      const existing = relationships.get(edge.id);
      if (existing === undefined) {
        relationships.set(edge.id, edge);
        continue;
      }
      const description =
        (edge.description ?? "").length > (existing.description ?? "").length ? edge.description : existing.description;
      const provenance = uniqueSorted([...existing.provenance, ...edge.provenance]);
      relationships.set(edge.id, {
        ...existing,
        ...(description === undefined ? {} : { description }),
        weight: provenance.length,
        provenance,
      });
    }
  }

  // An edge whose endpoints are gone goes with them — the state after a source is removed.
  const kept = [...relationships.values()].filter((edge) => entities.has(edge.fromId) && entities.has(edge.toId));
  return { entities: [...entities.values()].sort(byId), relationships: kept.sort(byId) };
};

/** Refuses an untraceable claim. See `GraphStore` — provenance is structural. */
const assertProvenance = (contribution: GraphContribution): void => {
  for (const entity of contribution.entities) {
    if (entity.provenance.length === 0)
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `entity ${entity.id} has no provenance; a graph claim with no chunk behind it is one the model would cite`,
        retryable: false,
      });
  }
  for (const edge of contribution.relationships) {
    if (edge.provenance.length === 0)
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `relationship ${edge.id} has no provenance; a graph claim with no chunk behind it is one the model would cite`,
        retryable: false,
      });
  }
};

export const createMemoryGraphStore = (): GraphStore => {
  const tenants = new Map<string, TenantGraph>();
  const graphOf = (tenantId: string): TenantGraph => {
    let graph = tenants.get(tenantId);
    if (!graph) {
      tenants.set(tenantId, (graph = { settings: DEFAULT_SETTINGS, sourceFlags: new Map(), contributions: new Map() }));
    }
    return graph;
  };

  const page = <T>(items: readonly T[], limit: number, cursor?: string): Page<T> => {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
    const slice = items.slice(offset, offset + limit);
    const next = offset + slice.length;
    return next < items.length ? { items: slice, nextCursor: String(next) } : { items: slice };
  };

  return {
    async getSettings({ tenantId }) {
      return graphOf(tenantId).settings;
    },

    async setEnabled({ tenantId, enabled, at }) {
      const graph = graphOf(tenantId);
      graph.settings = { enabled, updatedAt: at };
      return graph.settings;
    },

    async setSourceEnabled({ tenantId, sourceType, sourceId, enabled }) {
      // Stored regardless of the tenant switch — AC-2. Marking a handbook today and enabling the tenant next
      // week must not require re-marking anything, so this never consults `settings`.
      graphOf(tenantId).sourceFlags.set(sourceKey(sourceType, sourceId), enabled);
    },

    async isSourceEnabled({ tenantId, sourceType, sourceId }) {
      return graphOf(tenantId).sourceFlags.get(sourceKey(sourceType, sourceId)) === true;
    },

    async listEnabledSources({ tenantId, limit, cursor }) {
      const rows = [...graphOf(tenantId).sourceFlags.entries()]
        .filter(([, enabled]) => enabled)
        .map(([key]) => {
          const at = key.indexOf(" ");
          return { sourceType: key.slice(0, at) as KnowledgeSourceType, sourceId: key.slice(at + 1) };
        })
        .sort((a, b) => (sourceKey(a.sourceType, a.sourceId) < sourceKey(b.sourceType, b.sourceId) ? -1 : 1));
      return page(rows, limit, cursor);
    },

    async replaceSourceGraph({ tenantId, sourceType, sourceId, contribution }) {
      assertProvenance(contribution);
      const graph = graphOf(tenantId);
      const before = mergeAll(graph.contributions.values()).entities.length;
      const key = sourceKey(sourceType, sourceId);
      if (contribution.entities.length === 0 && contribution.relationships.length === 0) {
        graph.contributions.delete(key);
      } else {
        graph.contributions.set(key, { entities: contribution.entities, relationships: contribution.relationships });
      }
      const after = mergeAll(graph.contributions.values());
      return {
        entities: after.entities.length,
        relationships: after.relationships.length,
        // What this replacement removed from the graph, not what it removed from the source. An operator asking
        // "did re-indexing lose anything" is asking the first question.
        pruned: Math.max(0, before - after.entities.length),
      };
    },

    async deleteSourceGraph({ tenantId, sourceType, sourceId }) {
      const graph = graphOf(tenantId);
      const before = mergeAll(graph.contributions.values()).entities.length;
      graph.contributions.delete(sourceKey(sourceType, sourceId));
      const after = mergeAll(graph.contributions.values()).entities.length;
      return { pruned: Math.max(0, before - after) };
    },

    async getEntity({ tenantId, id }) {
      return mergeAll(graphOf(tenantId).contributions.values()).entities.find((entity) => entity.id === id) ?? null;
    },

    async getEntities({ tenantId, ids }) {
      const wanted = new Set(ids);
      return mergeAll(graphOf(tenantId).contributions.values()).entities.filter((entity) => wanted.has(entity.id));
    },

    async resolveEntities({ tenantId, normalisedNames }) {
      if (normalisedNames.length === 0) return [];
      // The name is everything after the first colon; `normaliseName` cannot produce one, so the split is safe.
      const wanted = new Set(normalisedNames);
      return mergeAll(graphOf(tenantId).contributions.values()).entities.filter((entity) =>
        wanted.has(entity.id.slice(entity.id.indexOf(":") + 1)),
      );
    },

    async listEntities({ tenantId, limit, cursor, type }) {
      const all = mergeAll(graphOf(tenantId).contributions.values()).entities;
      return page(type === undefined ? all : all.filter((entity) => entity.type === type), limit, cursor);
    },

    async neighbours({ tenantId, entityIds, limit }) {
      const wanted = new Set(entityIds);
      const { relationships } = mergeAll(graphOf(tenantId).contributions.values());
      return relationships
        .filter((edge) => wanted.has(edge.fromId) || wanted.has(edge.toId))
        // Heaviest first — the edge the most chunks asserted is the one most worth traversing. Ties broken by
        // id so the order is total, which is what makes a truncated traversal reproducible.
        .sort((a, b) => (b.weight - a.weight) || byId(a, b))
        .slice(0, Math.max(0, limit));
    },

    async fingerprint({ tenantId }) {
      const { entities, relationships } = mergeAll(graphOf(tenantId).contributions.values());
      /**
       * A stable serialisation, on the port rather than in a test — AC-6.
       *
       * Every field that a re-index could plausibly reorder is included: surface forms and provenance are the
       * two that actually caught bugs, because both are sets that arrive in whatever order extraction produced.
       * Leaving them out would let the fingerprint agree while the graph differed.
       */
      const lines = [
        ...entities.map((entity) =>
          [
            "E",
            entity.id,
            entity.name,
            entity.type,
            entity.description ?? "",
            entity.surfaceForms.join(","),
            entity.provenance.join(","),
          ].join(""),
        ),
        ...relationships.map((edge) =>
          ["R", edge.id, edge.type, String(edge.weight), edge.description ?? "", edge.provenance.join(",")].join(""),
        ),
      ];
      return lines.join("\n");
    },
  };
};
