/**
 * `ArtifactExportStore` conformance (#134).
 *
 * Almost entirely about `claim`, because that is the method whose contract two adapters can plausibly get
 * differently and where differing is expensive: a claim that is not exclusive renders the same PDF twice and
 * leaves two rows pointing at two identical files, and a caller has no way to tell which is canonical.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { ArtifactId, ConversationId, FileId, PrincipalId, TenantId } from "../../core/ids.js";
import type { ArtifactExportStore } from "../../persistence/index.js";
import { openFixture, type Fixture, type FixtureOrStore } from "./parents.js";

const T1 = asId<TenantId>("conf-export-tenant-1");
const T2 = asId<TenantId>("conf-export-tenant-2");
const A1 = asId<ArtifactId>("conf-export-artifact-1");
const AT = "2026-08-23T12:00:00.000Z";
const USER = asId<PrincipalId>("conf-export-user");

/** The parent an adapter with a foreign key needs: an artifact, which itself needs a conversation. */
export type ExportFixture = Fixture<ArtifactExportStore> & {
  readonly seedArtifact?: (input: {
    readonly tenantId: TenantId;
    readonly artifactId: ArtifactId;
    readonly conversationId: ConversationId;
  }) => Promise<void>;
};

const requested = (overrides: { id?: string; version?: number; format?: "pdf" | "markdown" } = {}) => ({
  id: overrides.id ?? "e1",
  artifactId: A1,
  version: overrides.version ?? 1,
  format: overrides.format ?? ("pdf" as const),
  requestedBy: USER,
  createdAt: AT,
});

export function artifactExportStoreConformance(
  make: () => FixtureOrStore<ArtifactExportStore> | Promise<FixtureOrStore<ArtifactExportStore>>,
): void {
  describe("ArtifactExportStore conformance", () => {
    const open = async (): Promise<ArtifactExportStore> => {
      const fixture = openFixture(await make()) as ExportFixture;
      // Both tenants, because every isolation case below needs the parent to exist on both sides — otherwise
      // a cross-tenant write would fail on the foreign key and look like isolation working.
      for (const tenantId of [T1, T2]) {
        await fixture.seedArtifact?.({
          tenantId,
          artifactId: A1,
          conversationId: asId<ConversationId>("conf-export-convo-1"),
        });
      }
      return fixture.store;
    };

    it("claims a slot and records it pending", async () => {
      const store = await open();
      const result = await store.claim({ tenantId: T1, export: requested() });
      expect(result.claimed).toBe(true);
      expect(result.export).toMatchObject({ id: "e1", version: 1, format: "pdf", state: "pending" });
    });

    it("lets exactly one of two racing claims win, and hands the loser the winner's row", async () => {
      // The property the whole port exists for. Both callers then read the same row, which is why the loser
      // gets it rather than an error: its next move is identical either way.
      const store = await open();
      const results = await Promise.all([
        store.claim({ tenantId: T1, export: requested({ id: "race-a" }) }),
        store.claim({ tenantId: T1, export: requested({ id: "race-b" }) }),
      ]);
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      const winner = results.find((r) => r.claimed)!.export;
      const loser = results.find((r) => !r.claimed)!.export;
      expect(loser.id).toBe(winner.id);
    });

    it("treats a different format as a different slot", async () => {
      const store = await open();
      await store.claim({ tenantId: T1, export: requested({ id: "e1", format: "pdf" }) });
      const second = await store.claim({ tenantId: T1, export: requested({ id: "e2", format: "markdown" }) });
      expect(second.claimed).toBe(true);
    });

    it("treats a different version as a different slot", async () => {
      // An export is of a *version*. Sharing one across versions would hand someone last week's document.
      const store = await open();
      await store.claim({ tenantId: T1, export: requested({ id: "e1", version: 1 }) });
      const second = await store.claim({ tenantId: T1, export: requested({ id: "e2", version: 2 }) });
      expect(second.claimed).toBe(true);
    });

    it("does not share a slot across tenants", async () => {
      const store = await open();
      await store.claim({ tenantId: T1, export: requested({ id: "e1" }) });
      const other = await store.claim({ tenantId: T2, export: requested({ id: "e2" }) });
      expect(other.claimed).toBe(true);
      expect(await store.get({ tenantId: T2, id: "e1" })).toBeNull();
    });

    it("records a rendered outcome with its file and checksum", async () => {
      const store = await open();
      await store.claim({ tenantId: T1, export: requested() });
      expect(
        await store.complete({
          tenantId: T1,
          id: "e1",
          state: "rendered",
          fileId: asId<FileId>("file-1"),
          byteSize: 2048,
          checksum: "abc",
          at: AT,
        }),
      ).toEqual({ recorded: true });
      expect(await store.get({ tenantId: T1, id: "e1" })).toMatchObject({
        state: "rendered",
        fileId: "file-1",
        byteSize: 2048,
        checksum: "abc",
        renderedAt: AT,
      });
    });

    it("records a failure with its reason and message", async () => {
      // AC-4 depends on both surviving storage: the reason drives behaviour and the message is what the user
      // reads, so a store keeping one and dropping the other would half-work.
      const store = await open();
      await store.claim({ tenantId: T1, export: requested() });
      await store.complete({
        tenantId: T1,
        id: "e1",
        state: "failed",
        failureReason: "render-failed",
        failureMessage: "That artifact could not be rendered.",
        at: AT,
      });
      expect(await store.get({ tenantId: T1, id: "e1" })).toMatchObject({
        state: "failed",
        failureReason: "render-failed",
        failureMessage: "That artifact could not be rendered.",
      });
    });

    it("does not complete another tenant's export", async () => {
      const store = await open();
      await store.claim({ tenantId: T1, export: requested() });
      // Reported rather than thrown: it is the same answer a deleted row gives, and a worker must be able to
      // tell "gone" from "broken".
      expect(
        await store.complete({ tenantId: T2, id: "e1", state: "rendered", fileId: asId<FileId>("f"), at: AT }),
      ).toEqual({ recorded: false });
      expect(await store.get({ tenantId: T1, id: "e1" })).toMatchObject({ state: "pending" });
    });

    it("finds an export by version and format, which is the cache lookup", async () => {
      const store = await open();
      await store.claim({ tenantId: T1, export: requested({ id: "e1" }) });
      expect(await store.find({ tenantId: T1, artifactId: A1, version: 1, format: "pdf" })).toMatchObject({
        id: "e1",
      });
      expect(await store.find({ tenantId: T1, artifactId: A1, version: 1, format: "markdown" })).toBeNull();
      expect(await store.find({ tenantId: T2, artifactId: A1, version: 1, format: "pdf" })).toBeNull();
    });

    it("lists an artifact's exports, paging on a keyset cursor", async () => {
      // Two formats requested together share a timestamp, so a cursor on the timestamp alone would skip or
      // repeat -- which is the normal case here rather than a rare one.
      const store = await open();
      for (const n of [1, 2, 3, 4, 5]) {
        await store.claim({
          tenantId: T1,
          export: { ...requested({ id: `e${n}`, version: n }), createdAt: AT },
        });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listByArtifact({
          tenantId: T1,
          artifactId: A1,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen.sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    });

    it("lists nothing for another tenant", async () => {
      const store = await open();
      await store.claim({ tenantId: T1, export: requested() });
      expect((await store.listByArtifact({ tenantId: T2, artifactId: A1, limit: 10 })).items).toEqual([]);
    });

    it("rejects a non-timestamp `at` rather than storing it", async () => {
      // The lesson from #129: a reference adapter laxer than the real one turns a production write failure
      // into a passing test.
      const store = await open();
      await store.claim({ tenantId: T1, export: requested() });
      await expect(
        store.complete({ tenantId: T1, id: "e1", state: "rendered", fileId: asId<FileId>("f"), at: "t" }),
      ).rejects.toThrow();
    });
  });
}
