/**
 * `GraphStore` conformance — REQ-064 (#270), task #271.
 *
 * Every clause here is a defect somebody would otherwise ship, and three are the reason the port has the shape
 * it does:
 *
 * - **A source's contribution is what gets replaced.** Entities are shared between sources, so re-indexing one
 *   document must withdraw its claims and leave everything else standing. An adapter that deleted entities by
 *   source would erase a concept the rest of the corpus still talks about.
 * - **Provenance cannot be empty.** The retriever presents graph material as citable, so an untraceable claim
 *   is one the model states as though a document said it. Enforced here so it is a *contract*, not a Postgres
 *   constraint the reference adapter quietly tolerates.
 * - **`fingerprint` is on the port.** Determinism is what #275 measures against, and a test that serialised the
 *   graph itself would prove the reference adapter deterministic while saying nothing about Postgres — where
 *   row order is precisely the thing most likely to differ.
 *
 * Ungated: none of this needs pgvector. Entities and edges are ordinary rows, and a deployment without the
 * extension can still run `graph-local`.
 */

import { describe, expect, it } from "vitest";

import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import type { GraphContribution, GraphStore, KnowledgeEntity } from "../../persistence/index.js";

const T1 = asId<TenantId>("conf-graph-tenant-1");
const T2 = asId<TenantId>("conf-graph-tenant-2");
const AT = "2026-08-28T12:00:00.000Z";

const entity = (id: string, over: Partial<KnowledgeEntity> = {}): KnowledgeEntity => ({
  id,
  name: id.slice(id.indexOf(":") + 1),
  type: id.slice(0, id.indexOf(":")),
  surfaceForms: [id.slice(id.indexOf(":") + 1)],
  provenance: ["chunk-1"],
  ...over,
});

const contribution = (
  entities: readonly KnowledgeEntity[],
  edges: readonly { from: string; to: string; type?: string; provenance?: readonly string[] }[] = [],
): GraphContribution => ({
  entities,
  relationships: edges.map((edge) => ({
    id: `${edge.from}|${edge.type ?? "rel"}|${edge.to}`,
    fromId: edge.from,
    toId: edge.to,
    type: edge.type ?? "rel",
    weight: (edge.provenance ?? ["chunk-1"]).length,
    provenance: edge.provenance ?? ["chunk-1"],
  })),
});

// `export function`, not an arrow const: the isolation guard in `conformance-coverage.test.ts` splits
// harness sources on that exact form to find each harness body. An arrow const is invisible to it, and
// the harness would then be registered but never checked for a cross-tenant assertion.
export function graphStoreConformance(make: () => GraphStore): void {
  describe("GraphStore conformance", () => {
    describe("the two-level switch", () => {
      it("is off for a tenant nobody configured", async () => {
        // Absent must mean off. A tenant that has never been configured must not start paying for extraction
        // because a row was missing rather than false.
        expect((await make().getSettings({ tenantId: T1 })).enabled).toBe(false);
      });

      it("remembers being switched on, and off again", async () => {
        const store = make();
        expect((await store.setEnabled({ tenantId: T1, enabled: true, at: AT })).enabled).toBe(true);
        expect((await store.getSettings({ tenantId: T1 })).enabled).toBe(true);
        await store.setEnabled({ tenantId: T1, enabled: false, at: AT });
        expect((await store.getSettings({ tenantId: T1 })).enabled).toBe(false);
      });

      it("keeps one tenant's switch away from another's", async () => {
        const store = make();
        await store.setEnabled({ tenantId: T1, enabled: true, at: AT });
        expect((await store.getSettings({ tenantId: T2 })).enabled).toBe(false);
      });

      it("stores a source flag independently of the tenant switch", async () => {
        /**
         * The scenario the two levels exist for: mark the handbook today, enable the tenant next week, re-mark
         * nothing. An adapter that refused or dropped the flag while the tenant switch was off would make that
         * impossible and the failure would only appear weeks later.
         */
        const store = make();
        await store.setSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "handbook", enabled: true });
        expect((await store.getSettings({ tenantId: T1 })).enabled).toBe(false);
        expect(await store.isSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "handbook" })).toBe(true);
      });

      it("reports an unflagged source as off rather than absent", async () => {
        expect(
          await make().isSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "never-mentioned" }),
        ).toBe(false);
      });

      it("lists only the flagged sources, and only this tenant's", async () => {
        const store = make();
        await store.setSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "a", enabled: true });
        await store.setSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "b", enabled: false });
        await store.setSourceEnabled({ tenantId: T2, sourceType: "file", sourceId: "c", enabled: true });
        expect((await store.listEnabledSources({ tenantId: T1, limit: 10 })).items).toEqual([
          { sourceType: "file", sourceId: "a" },
        ]);
      });

      it("un-flags a source without forgetting it", async () => {
        const store = make();
        await store.setSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "a", enabled: true });
        await store.setSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "a", enabled: false });
        expect(await store.isSourceEnabled({ tenantId: T1, sourceType: "file", sourceId: "a" })).toBe(false);
        expect((await store.listEnabledSources({ tenantId: T1, limit: 10 })).items).toEqual([]);
      });
    });

    describe("contributions and pruning", () => {
      it("merges what two sources say about the same entity", async () => {
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:shared", { surfaceForms: ["Shared"], provenance: ["a1"] })]),
        });
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "b",
          contribution: contribution([entity("concept:shared", { surfaceForms: ["shared"], provenance: ["b1"] })]),
        });
        const merged = await store.getEntity({ tenantId: T1, id: "concept:shared" });
        expect(merged?.provenance).toEqual(["a1", "b1"]);
        expect(merged?.surfaceForms).toEqual(["Shared", "shared"]);
      });

      it("prunes only what no other source still names", async () => {
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:shared"), entity("concept:only-a")]),
        });
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "b",
          contribution: contribution([entity("concept:shared")]),
        });
        await store.deleteSourceGraph({ tenantId: T1, sourceType: "file", sourceId: "a" });

        const left = (await store.listEntities({ tenantId: T1, limit: 50 })).items.map((e) => e.id);
        // `shared` survives because B still names it; `only-a` goes because nothing does.
        expect(left).toEqual(["concept:shared"]);
      });

      it("reports the counts of the whole graph, not just the source that was written", async () => {
        /**
         * The returned counts are what an operator reads to see whether a re-index lost anything, so they have
         * to describe the graph rather than the call. An implementation that counted only the incoming
         * contribution would report "1 entity" for a corpus of thousands — and every assertion about a
         * single-source graph would still pass, which is why this needs two sources.
         */
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:a"), entity("concept:b")], [{ from: "concept:a", to: "concept:b" }]),
        });
        const second = await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "b",
          contribution: contribution([entity("concept:c")]),
        });
        expect(second.entities).toBe(3);
        expect(second.relationships).toBe(1);
      });

      it("replaces a source's contribution rather than appending to it", async () => {
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:old")]),
        });
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:new")]),
        });
        // A re-indexed document must not leave its old claims standing.
        expect((await store.listEntities({ tenantId: T1, limit: 50 })).items.map((e) => e.id)).toEqual(["concept:new"]);
      });

      it("treats an empty contribution as a withdrawal", async () => {
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:x")]),
        });
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: { entities: [], relationships: [] },
        });
        expect(await store.fingerprint({ tenantId: T1 })).toBe("");
      });

      it("drops an edge when an endpoint stops existing", async () => {
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:a"), entity("concept:b")], [{ from: "concept:a", to: "concept:b" }]),
        });
        expect(await store.neighbours({ tenantId: T1, entityIds: ["concept:a"], limit: 10 })).toHaveLength(1);

        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:a")]),
        });
        // An edge pointing at nothing is worse than no edge: a traversal would follow it and find a hole.
        expect(await store.neighbours({ tenantId: T1, entityIds: ["concept:a"], limit: 10 })).toEqual([]);
      });

      it("refuses an entity with no provenance", async () => {
        await expect(
          make().replaceSourceGraph({
            tenantId: T1,
            sourceType: "file",
            sourceId: "a",
            contribution: contribution([entity("concept:x", { provenance: [] })]),
          }),
        ).rejects.toThrow();
      });

      it("refuses a relationship with no provenance", async () => {
        await expect(
          make().replaceSourceGraph({
            tenantId: T1,
            sourceType: "file",
            sourceId: "a",
            contribution: contribution(
              [entity("concept:a"), entity("concept:b")],
              [{ from: "concept:a", to: "concept:b", provenance: [] }],
            ),
          }),
        ).rejects.toThrow();
      });
    });

    describe("reading", () => {
      const seeded = async (): Promise<GraphStore> => {
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution(
            [entity("concept:hub"), entity("concept:light"), entity("person:heavy", { provenance: ["c1", "c2"] })],
            [
              { from: "concept:hub", to: "concept:light", provenance: ["c1"] },
              { from: "concept:hub", to: "person:heavy", provenance: ["c1", "c2"] },
            ],
          ),
        });
        return store;
      };

      it("returns null for an entity that does not exist", async () => {
        expect(await (await seeded()).getEntity({ tenantId: T1, id: "concept:nope" })).toBeNull();
      });

      it("fetches entities by id and ignores the ones that are not there", async () => {
        const found = await (await seeded()).getEntities({ tenantId: T1, ids: ["concept:hub", "concept:nope"] });
        expect(found.map((e) => e.id)).toEqual(["concept:hub"]);
      });

      it("returns nothing for an empty id list rather than everything", async () => {
        // The `authSubjects: []` lesson from `VectorIndex`: an empty filter must mean "none", never "all".
        expect(await (await seeded()).getEntities({ tenantId: T1, ids: [] })).toEqual([]);
        expect(await (await seeded()).neighbours({ tenantId: T1, entityIds: [], limit: 10 })).toEqual([]);
      });

      it("filters entities by type", async () => {
        const found = await (await seeded()).listEntities({ tenantId: T1, limit: 50, type: "person" });
        expect(found.items.map((e) => e.id)).toEqual(["person:heavy"]);
      });

      it("lists entities in a stable order and pages through them", async () => {
        const store = await seeded();
        const first = await store.listEntities({ tenantId: T1, limit: 2 });
        expect(first.items.map((e) => e.id)).toEqual(["concept:hub", "concept:light"]);
        expect(first.nextCursor).toBeDefined();
        const second = await store.listEntities({ tenantId: T1, limit: 2, cursor: first.nextCursor });
        expect(second.items.map((e) => e.id)).toEqual(["person:heavy"]);
        expect(second.nextCursor).toBeUndefined();
      });

      it("finds edges in either direction", async () => {
        // Traversal reads by both endpoints. An adapter indexing only `from_id` would make half of every
        // neighbourhood query return nothing.
        const store = await seeded();
        expect(await store.neighbours({ tenantId: T1, entityIds: ["concept:light"], limit: 10 })).toHaveLength(1);
      });

      it("orders neighbours heaviest first, so a truncated traversal keeps the best edges", async () => {
        const store = await seeded();
        const [first] = await store.neighbours({ tenantId: T1, entityIds: ["concept:hub"], limit: 1 });
        expect(first?.toId).toBe("person:heavy");
      });

      it("honours the neighbour limit", async () => {
        expect(await (await seeded()).neighbours({ tenantId: T1, entityIds: ["concept:hub"], limit: 1 })).toHaveLength(1);
        expect(await (await seeded()).neighbours({ tenantId: T1, entityIds: ["concept:hub"], limit: 0 })).toEqual([]);
      });
    });

    describe("tenant isolation", () => {
      it("keeps every read away from another tenant's graph", async () => {
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:secret"), entity("concept:other")], [
            { from: "concept:secret", to: "concept:other" },
          ]),
        });
        // Every read path, not a sample: a graph leaks through whichever one somebody forgot to scope.
        expect((await store.listEntities({ tenantId: T2, limit: 50 })).items).toEqual([]);
        expect(await store.getEntity({ tenantId: T2, id: "concept:secret" })).toBeNull();
        expect(await store.getEntities({ tenantId: T2, ids: ["concept:secret"] })).toEqual([]);
        expect(await store.neighbours({ tenantId: T2, entityIds: ["concept:secret"], limit: 10 })).toEqual([]);
        expect(await store.fingerprint({ tenantId: T2 })).toBe("");
      });

      it("does not let one tenant's replacement prune another's entities", async () => {
        const store = make();
        for (const tenantId of [T1, T2]) {
          await store.replaceSourceGraph({
            tenantId,
            sourceType: "file",
            sourceId: "a",
            contribution: contribution([entity("concept:shared")]),
          });
        }
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: { entities: [], relationships: [] },
        });
        expect((await store.listEntities({ tenantId: T2, limit: 50 })).items.map((e) => e.id)).toEqual(["concept:shared"]);
      });
    });

    describe("fingerprint", () => {
      it("is empty for an empty graph", async () => {
        expect(await make().fingerprint({ tenantId: T1 })).toBe("");
      });

      it("is identical for the same graph written twice", async () => {
        const build = async (): Promise<string> => {
          const store = make();
          await store.replaceSourceGraph({
            tenantId: T1,
            sourceType: "file",
            sourceId: "a",
            contribution: contribution(
              [entity("concept:a", { provenance: ["c2", "c1"] }), entity("concept:b")],
              [{ from: "concept:a", to: "concept:b", provenance: ["c2", "c1"] }],
            ),
          });
          return store.fingerprint({ tenantId: T1 });
        };
        const first = await build();
        expect(await build()).toBe(first);
        expect(first).not.toBe("");
      });

      it("does not depend on the order sources were written in", async () => {
        // Re-indexing visits sources in whatever order the work list produced. A fingerprint that changed with
        // it would make #275's baseline unusable and every rebuild look like a diff.
        const build = async (order: readonly string[]): Promise<string> => {
          const store = make();
          for (const sourceId of order) {
            await store.replaceSourceGraph({
              tenantId: T1,
              sourceType: "file",
              sourceId,
              contribution: contribution([entity(`concept:${sourceId}`), entity("concept:shared")]),
            });
          }
          return store.fingerprint({ tenantId: T1 });
        };
        expect(await build(["a", "b"])).toBe(await build(["b", "a"]));
      });

      it("changes when the graph does", async () => {
        // A fingerprint that never changed would satisfy every assertion above and detect nothing.
        const store = make();
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "a",
          contribution: contribution([entity("concept:a")]),
        });
        const before = await store.fingerprint({ tenantId: T1 });
        await store.replaceSourceGraph({
          tenantId: T1,
          sourceType: "file",
          sourceId: "b",
          contribution: contribution([entity("concept:b")]),
        });
        expect(await store.fingerprint({ tenantId: T1 })).not.toBe(before);
      });

      it("notices a difference in provenance alone", async () => {
        /**
         * The clause that caught a real bug elsewhere: provenance and surface forms are *sets*, arriving in
         * whatever order extraction produced. Leaving them out of the fingerprint would let it agree while the
         * graph differed — which is worse than no fingerprint, because it would be trusted.
         */
        const build = async (provenance: readonly string[]): Promise<string> => {
          const store = make();
          await store.replaceSourceGraph({
            tenantId: T1,
            sourceType: "file",
            sourceId: "a",
            contribution: contribution([entity("concept:a", { provenance })]),
          });
          return store.fingerprint({ tenantId: T1 });
        };
        expect(await build(["c1"])).not.toBe(await build(["c1", "c2"]));
      });
    });
  });
}
