/**
 * Postgres `GraphStore` — REQ-064 (#270), task #271.
 *
 * **Contributions are the stored truth; the entity and relationship tables are a cache of their merge.**
 *
 * That split is the whole design, and it is worth being explicit about why the obvious alternative is wrong.
 * Storing merged entities alone and mutating them per source needs reference counting — "how many sources still
 * name this entity" — and reference counting is the thing everybody gets wrong under concurrency. Storing what
 * each source asserted and rebuilding the merge makes pruning a consequence rather than a bookkeeping exercise:
 * an entity exists precisely while some contribution names it, and nothing has to remember why.
 *
 * The merge is recomputed in TypeScript rather than SQL. A `jsonb_array_elements` aggregation could do it, but
 * the merge rule — lexicographically-first canonical name, longest description, unioned surface forms, weight
 * as the provenance count — would then exist twice, in two languages, and the reference adapter's copy is the
 * one the conformance suite tests. One rule in one place is worth a round trip.
 *
 * Provenance is enforced by a `CHECK` constraint as well as here, deliberately. The application check gives a
 * message that explains itself; the constraint is what still holds when somebody writes to these tables from a
 * migration or a console.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type {
  GraphContribution,
  GraphSettings,
  GraphStore,
  KnowledgeEntity,
  KnowledgeRelationship,
  KnowledgeSourceType,
  StoredCommunity,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type SettingsRow = { enabled: boolean; updated_at: string | Date };
type ContributionRow = { entities: unknown; relationships: unknown };
type EntityRow = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  surface_forms: string[];
  provenance: string[];
};
type RelationshipRow = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  description: string | null;
  weight: number | string;
  provenance: string[];
};

type CommunityRow = {
  id: string;
  level: number | string;
  entity_ids: string[];
  relationship_ids: string[];
  chunk_ids: string[];
  fingerprint: string;
  summary: string | null;
  summary_fingerprint: string | null;
  summarised_at: string | Date | null;
};

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);

const toEntity = (row: EntityRow): KnowledgeEntity => ({
  id: row.id,
  name: row.name,
  type: row.type,
  ...(row.description === null ? {} : { description: row.description }),
  surfaceForms: row.surface_forms,
  provenance: row.provenance,
});

const toRelationship = (row: RelationshipRow): KnowledgeRelationship => ({
  id: row.id,
  fromId: row.from_id,
  toId: row.to_id,
  type: row.type,
  ...(row.description === null ? {} : { description: row.description }),
  weight: Number(row.weight),
  provenance: row.provenance,
});

const toCommunity = (row: CommunityRow): StoredCommunity => ({
  id: row.id,
  level: Number(row.level),
  entityIds: row.entity_ids,
  relationshipIds: row.relationship_ids,
  chunkIds: row.chunk_ids,
  fingerprint: row.fingerprint,
  ...(row.summary === null ? {} : { summary: row.summary }),
  ...(row.summary_fingerprint === null ? {} : { summaryFingerprint: row.summary_fingerprint }),
  ...(row.summarised_at === null ? {} : { summarisedAt: iso(row.summarised_at) }),
});

const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Rebuilds the merged graph from every contribution. Mirrors `mergeContributions` — see the header. */
const mergeAll = (
  contributions: readonly GraphContribution[],
): { entities: KnowledgeEntity[]; relationships: KnowledgeRelationship[] } => {
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
  const kept = [...relationships.values()].filter((edge) => entities.has(edge.fromId) && entities.has(edge.toId));
  return { entities: [...entities.values()].sort(byId), relationships: kept.sort(byId) };
};

const assertProvenance = (contribution: GraphContribution): void => {
  for (const row of [...contribution.entities, ...contribution.relationships]) {
    if (row.provenance.length === 0)
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `${row.id} has no provenance; a graph claim with no chunk behind it is one the model would cite`,
        retryable: false,
      });
  }
};

export const createPostgresGraphStore = (sql: SqlExecutor): GraphStore => {
  /** Every contribution for a tenant, which is what the merge is derived from. */
  const contributionsOf = async (tenantId: string): Promise<GraphContribution[]> => {
    const rows = await sql.query<ContributionRow>(
      `SELECT entities, relationships FROM knowledge_graph_contributions
        WHERE tenant_id = $1 ORDER BY source_type, source_id`,
      [tenantId],
    );
    return rows.map((row) => ({
      entities: (row.entities ?? []) as KnowledgeEntity[],
      relationships: (row.relationships ?? []) as KnowledgeRelationship[],
    }));
  };

  /**
   * Rewrites the merged tables from the contributions.
   *
   * Delete-then-insert rather than an upsert-and-sweep, for the reason `replaceSource` is: a partial merge is a
   * graph that is half old and half new, and no reader can tell. Callers run this inside the same unit of work
   * as the contribution write.
   */
  const rebuild = async (tenantId: string): Promise<{ entities: number; relationships: number }> => {
    const merged = mergeAll(await contributionsOf(tenantId));
    await sql.query(`DELETE FROM knowledge_graph_relationships WHERE tenant_id = $1`, [tenantId]);
    await sql.query(`DELETE FROM knowledge_graph_entities WHERE tenant_id = $1`, [tenantId]);
    for (const entity of merged.entities) {
      await sql.query(
        `INSERT INTO knowledge_graph_entities
           (tenant_id, id, name, type, description, surface_forms, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, entity.id, entity.name, entity.type, entity.description ?? null, entity.surfaceForms, entity.provenance],
      );
    }
    for (const edge of merged.relationships) {
      await sql.query(
        `INSERT INTO knowledge_graph_relationships
           (tenant_id, id, from_id, to_id, type, description, weight, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, edge.id, edge.fromId, edge.toId, edge.type, edge.description ?? null, edge.weight, edge.provenance],
      );
    }
    return { entities: merged.entities.length, relationships: merged.relationships.length };
  };

  const countEntities = async (tenantId: string): Promise<number> => {
    const rows = await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM knowledge_graph_entities WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(rows[0]?.n ?? 0);
  };

  return {
    async getSettings({ tenantId }) {
      const rows = await sql.query<SettingsRow>(
        `SELECT enabled, updated_at FROM knowledge_graph_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = rows[0];
      // Absent means off. A tenant that has never been configured must not be able to start paying for
      // extraction because a row was missing rather than false.
      return row === undefined
        ? { enabled: false, updatedAt: "1970-01-01T00:00:00.000Z" }
        : { enabled: row.enabled, updatedAt: iso(row.updated_at) };
    },

    async setEnabled({ tenantId, enabled, at }) {
      await sql.query(
        `INSERT INTO knowledge_graph_settings (tenant_id, enabled, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
        [tenantId, enabled, at],
      );
      return { enabled, updatedAt: at };
    },

    async setSourceEnabled({ tenantId, sourceType, sourceId, enabled }) {
      // Never consults the tenant switch — AC-2. The flag outlives it in both directions.
      await sql.query(
        `INSERT INTO knowledge_graph_sources (tenant_id, source_type, source_id, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, source_type, source_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [tenantId, sourceType, sourceId, enabled],
      );
    },

    async isSourceEnabled({ tenantId, sourceType, sourceId }) {
      const rows = await sql.query<{ enabled: boolean }>(
        `SELECT enabled FROM knowledge_graph_sources
          WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
        [tenantId, sourceType, sourceId],
      );
      return rows[0]?.enabled === true;
    },

    async listEnabledSources({ tenantId, limit, cursor }) {
      const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
      const rows = await sql.query<{ source_type: string; source_id: string }>(
        `SELECT source_type, source_id FROM knowledge_graph_sources
          WHERE tenant_id = $1 AND enabled
          ORDER BY source_type, source_id
          LIMIT $2 OFFSET $3`,
        [tenantId, limit + 1, offset],
      );
      const items = rows.slice(0, limit).map((row) => ({
        sourceType: row.source_type as KnowledgeSourceType,
        sourceId: row.source_id,
      }));
      return rows.length > limit ? { items, nextCursor: String(offset + limit) } : { items };
    },

    async replaceSourceGraph({ tenantId, sourceType, sourceId, contribution }) {
      assertProvenance(contribution);
      const before = await countEntities(tenantId);
      if (contribution.entities.length === 0 && contribution.relationships.length === 0) {
        // An empty contribution is a withdrawal, not an empty row: leaving `{"entities":[]}` behind would make
        // every future merge read a row that says nothing.
        await sql.query(
          `DELETE FROM knowledge_graph_contributions WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
          [tenantId, sourceType, sourceId],
        );
      } else {
        await sql.query(
          `INSERT INTO knowledge_graph_contributions (tenant_id, source_type, source_id, entities, relationships)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
           ON CONFLICT (tenant_id, source_type, source_id)
           DO UPDATE SET entities = EXCLUDED.entities,
                         relationships = EXCLUDED.relationships,
                         updated_at = now()`,
          [tenantId, sourceType, sourceId, JSON.stringify(contribution.entities), JSON.stringify(contribution.relationships)],
        );
      }
      const rebuilt = await rebuild(tenantId);
      return { ...rebuilt, pruned: Math.max(0, before - rebuilt.entities) };
    },

    async deleteSourceGraph({ tenantId, sourceType, sourceId }) {
      const before = await countEntities(tenantId);
      await sql.query(
        `DELETE FROM knowledge_graph_contributions WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
        [tenantId, sourceType, sourceId],
      );
      const rebuilt = await rebuild(tenantId);
      return { pruned: Math.max(0, before - rebuilt.entities) };
    },

    async getEntity({ tenantId, id }) {
      const rows = await sql.query<EntityRow>(
        `SELECT id, name, type, description, surface_forms, provenance
           FROM knowledge_graph_entities WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = rows[0];
      return row === undefined ? null : toEntity(row);
    },

    async getEntities({ tenantId, ids }) {
      if (ids.length === 0) return [];
      const rows = await sql.query<EntityRow>(
        `SELECT id, name, type, description, surface_forms, provenance
           FROM knowledge_graph_entities WHERE tenant_id = $1 AND id = ANY($2) ORDER BY id`,
        [tenantId, [...ids]],
      );
      return rows.map(toEntity);
    },

    async resolveEntities({ tenantId, normalisedNames }) {
      if (normalisedNames.length === 0) return [];
      const rows = await sql.query<EntityRow>(
        `SELECT id, name, type, description, surface_forms, provenance
           FROM knowledge_graph_entities
          -- The id is \`type:normalisedName\`, and \`normaliseName\` cannot produce a colon, so everything after
          -- the first one is the name. Matching on that keeps query-side and index-side resolution identical
          -- without a second stored column to drift.
          WHERE tenant_id = $1 AND substring(id from position(':' in id) + 1) = ANY($2)
          ORDER BY id`,
        [tenantId, [...normalisedNames]],
      );
      return rows.map(toEntity);
    },

    async listEntities({ tenantId, limit, cursor, type }) {
      const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
      const rows = await sql.query<EntityRow>(
        `SELECT id, name, type, description, surface_forms, provenance
           FROM knowledge_graph_entities
          WHERE tenant_id = $1 AND ($2::text IS NULL OR type = $2)
          ORDER BY id
          LIMIT $3 OFFSET $4`,
        [tenantId, type ?? null, limit + 1, offset],
      );
      const items = rows.slice(0, limit).map(toEntity);
      return rows.length > limit ? { items, nextCursor: String(offset + limit) } : { items };
    },

    async neighbours({ tenantId, entityIds, limit }) {
      if (entityIds.length === 0 || limit <= 0) return [];
      const rows = await sql.query<RelationshipRow>(
        `SELECT id, from_id, to_id, type, description, weight, provenance
           FROM knowledge_graph_relationships
          WHERE tenant_id = $1 AND (from_id = ANY($2) OR to_id = ANY($2))
          -- Heaviest first, then by id: a total order, so a truncated traversal is reproducible.
          ORDER BY weight DESC, id
          LIMIT $3`,
        [tenantId, [...entityIds], limit],
      );
      return rows.map(toRelationship);
    },

    async replaceCommunities({ tenantId, communities }) {
      // Read before the delete, so summaries can be carried over. One query rather than per-community lookups.
      const previous = new Map(
        (
          await sql.query<{ id: string; summary: string | null; summary_fingerprint: string | null; summarised_at: string | Date | null }>(
            `SELECT id, summary, summary_fingerprint, summarised_at
               FROM knowledge_graph_communities WHERE tenant_id = $1`,
            [tenantId],
          )
        ).map((row) => [row.id, row]),
      );
      await sql.query(`DELETE FROM knowledge_graph_communities WHERE tenant_id = $1`, [tenantId]);
      let summariesKept = 0;
      for (const community of communities) {
        const before = previous.get(community.id);
        // Identical membership only — see the memory adapter for why an id match is not enough.
        const keep = before?.summary != null && before.summary_fingerprint === community.fingerprint;
        if (keep) summariesKept += 1;
        await sql.query(
          `INSERT INTO knowledge_graph_communities
             (tenant_id, id, level, entity_ids, relationship_ids, chunk_ids, fingerprint,
              summary, summary_fingerprint, summarised_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            tenantId,
            community.id,
            community.level,
            community.entityIds,
            community.relationshipIds,
            community.chunkIds,
            community.fingerprint,
            keep ? before?.summary ?? null : null,
            keep ? before?.summary_fingerprint ?? null : null,
            keep ? (before?.summarised_at === null || before?.summarised_at === undefined ? null : iso(before.summarised_at)) : null,
          ],
        );
      }
      return { written: communities.length, summariesKept };
    },

    async listCommunities({ tenantId, limit, cursor, level }) {
      const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
      const rows = await sql.query<CommunityRow>(
        `SELECT id, level, entity_ids, relationship_ids, chunk_ids, fingerprint, summary, summary_fingerprint, summarised_at
           FROM knowledge_graph_communities
          WHERE tenant_id = $1 AND ($2::int IS NULL OR level = $2)
          ORDER BY level, id
          LIMIT $3 OFFSET $4`,
        [tenantId, level ?? null, limit + 1, offset],
      );
      const items = rows.slice(0, limit).map(toCommunity);
      return rows.length > limit ? { items, nextCursor: String(offset + limit) } : { items };
    },

    async getCommunity({ tenantId, id }) {
      const rows = await sql.query<CommunityRow>(
        `SELECT id, level, entity_ids, relationship_ids, chunk_ids, fingerprint, summary, summary_fingerprint, summarised_at
           FROM knowledge_graph_communities WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = rows[0];
      return row === undefined ? null : toCommunity(row);
    },

    async setCommunitySummary({ tenantId, id, summary, fingerprint, at }) {
      await sql.query(
        `UPDATE knowledge_graph_communities
            SET summary = $3, summary_fingerprint = $4, summarised_at = $5
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, summary, fingerprint, at],
      );
    },

    async fingerprint({ tenantId }) {
      // Read from the merged tables, not recomputed — the point is to prove *this adapter's stored state*
      // matches, and recomputing would fingerprint the merge function instead of the database.
      const entities = await sql.query<EntityRow>(
        `SELECT id, name, type, description, surface_forms, provenance
           FROM knowledge_graph_entities WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      );
      const relationships = await sql.query<RelationshipRow>(
        `SELECT id, from_id, to_id, type, description, weight, provenance
           FROM knowledge_graph_relationships WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      );
      return [
        ...entities.map((row) =>
          [
            "E",
            row.id,
            row.name,
            row.type,
            row.description ?? "",
            [...row.surface_forms].sort().join(","),
            [...row.provenance].sort().join(","),
          ].join(""),
        ),
        ...relationships.map((row) =>
          ["R", row.id, row.type, String(Number(row.weight)), row.description ?? "", [...row.provenance].sort().join(",")].join(
            "",
          ),
        ),
      ].join("\n");
    },
  };
};
