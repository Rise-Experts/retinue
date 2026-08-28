/**
 * `ArtifactStore` conformance (#133) — AC-6.
 *
 * The cases are mostly about **versioning**, because that is the part where two adapters can plausibly
 * disagree and where disagreeing is expensive: an earlier version that stops resolving is a shared link that
 * 404s, and a race that silently collapses two regenerations into one is data loss that looks like success.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { ArtifactId, ArtifactVersionId, BlobRef, ConversationId, PrincipalId, RunId, TenantId } from "../../core/ids.js";
import type { ArtifactStore, ArtifactVersion } from "../../persistence/index.js";
import { withConversation, type FixtureOrStore } from "./parents.js";

const T1 = asId<TenantId>("conf-artifact-tenant-1");
const T2 = asId<TenantId>("conf-artifact-tenant-2");
const C1 = asId<ConversationId>("conf-artifact-convo-1");
const C2 = asId<ConversationId>("conf-artifact-convo-2");
const AT = "2026-08-23T12:00:00.000Z";
const USER = asId<PrincipalId>("conf-artifact-user");

const version = (
  overrides: Partial<Omit<ArtifactVersion, "artifactId" | "version">> = {},
): Omit<ArtifactVersion, "artifactId" | "version"> => ({
  id: asId<ArtifactVersionId>(`v-${Math.abs(hash(JSON.stringify(overrides)))}`),
  contentRef: asId<BlobRef>("blob-1"),
  byteSize: 128,
  provenance: { producedBy: "create_artifact", inputs: { topic: "q3" } },
  createdBy: USER,
  createdAt: AT,
  ...overrides,
});

/** Deterministic, because `Math.random` in a fixture makes a failure unreproducible. */
const hash = (s: string): number => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
};

const artifact = (overrides: { id?: string; conversationId?: ConversationId; name?: string } = {}) => ({
  id: asId<ArtifactId>(overrides.id ?? "a1"),
  conversationId: overrides.conversationId ?? C1,
  kind: "markdown" as const,
  name: overrides.name ?? "Q3 summary",
  createdAt: AT,
});

export function artifactStoreConformance(
  make: () => FixtureOrStore<ArtifactStore> | Promise<FixtureOrStore<ArtifactStore>>,
): void {
  describe("ArtifactStore conformance", () => {
    const open = async (conversations: readonly ConversationId[] = [C1]) =>
      withConversation(
        await make(),
        conversations.flatMap((conversationId) => [
          { tenantId: T1, conversationId },
          { tenantId: T2, conversationId },
        ]),
      );

    it("creates an artifact at version 1 with its content by reference", async () => {
      // AC-1 and AC-5 together: the row carries a ref, and there is no field content could live in.
      const store = await open();
      const created = await store.create({
        tenantId: T1,
        artifact: artifact(),
        version: version({ id: asId<ArtifactVersionId>("v1"), contentRef: asId<BlobRef>("blob-a") }),
      });
      expect(created).toMatchObject({ id: "a1", name: "Q3 summary", kind: "markdown", latestVersion: 1 });

      const v1 = await store.getVersion({ tenantId: T1, id: asId<ArtifactId>("a1") });
      expect(v1).toMatchObject({ version: 1, contentRef: "blob-a", byteSize: 128 });
      // Nothing resembling content on the version row itself.
      expect(Object.keys(v1 ?? {})).not.toContain("content");
    });

    it("refuses to create the same id twice", async () => {
      // Overwriting would repoint a name at different content while leaving the old versions attached to it.
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      await expect(
        store.create({ tenantId: T1, artifact: artifact(), version: version() }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("returns null for another tenant's artifact", async () => {
      // Indistinguishable from absent, so the endpoint cannot be used to probe which ids exist.
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      expect(await store.get({ tenantId: T2, id: asId<ArtifactId>("a1") })).toBeNull();
      expect(await store.getVersion({ tenantId: T2, id: asId<ArtifactId>("a1") })).toBeNull();
    });

    it("makes a new version the default and keeps the earlier one resolvable", async () => {
      // AC-2, both halves. The second half is the one that breaks quietly: an implementation that overwrote
      // would pass every assertion about the *new* version.
      const store = await open();
      await store.create({
        tenantId: T1,
        artifact: artifact(),
        version: version({ id: asId<ArtifactVersionId>("v1"), contentRef: asId<BlobRef>("blob-1") }),
      });
      const added = await store.addVersion({
        tenantId: T1,
        id: asId<ArtifactId>("a1"),
        expectedLatestVersion: 1,
        version: version({
          id: asId<ArtifactVersionId>("v2"),
          contentRef: asId<BlobRef>("blob-2"),
          createdAt: "2026-08-23T13:00:00.000Z",
        }),
      });
      expect(added).toEqual({ added: true, version: 2 });

      expect(await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({ latestVersion: 2 });
      // No version asked for: the current one.
      expect(await store.getVersion({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({
        version: 2,
        contentRef: "blob-2",
      });
      // Asked for by number: still there, still pointing at its own content.
      expect(await store.getVersion({ tenantId: T1, id: asId<ArtifactId>("a1"), version: 1 })).toMatchObject({
        version: 1,
        contentRef: "blob-1",
      });
    });

    it("lets exactly one of two racing regenerations win", async () => {
      // Both hold `expectedLatestVersion: 1`. Without the compare both become version 2 and one silently
      // replaces the other -- which is AC-2 failing in the way nobody notices.
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      const results = await Promise.all([
        store.addVersion({
          tenantId: T1,
          id: asId<ArtifactId>("a1"),
          expectedLatestVersion: 1,
          version: version({ id: asId<ArtifactVersionId>("race-a") }),
        }),
        store.addVersion({
          tenantId: T1,
          id: asId<ArtifactId>("a1"),
          expectedLatestVersion: 1,
          version: version({ id: asId<ArtifactVersionId>("race-b") }),
        }),
      ]);
      expect(results.filter((r) => r.added)).toHaveLength(1);
      expect(await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({ latestVersion: 2 });
    });

    it("refuses a version whose expected latest is stale", async () => {
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      const result = await store.addVersion({
        tenantId: T1,
        id: asId<ArtifactId>("a1"),
        // Wrong on purpose: a caller working from a read that has since moved on.
        expectedLatestVersion: 7,
        version: version({ id: asId<ArtifactVersionId>("stale") }),
      });
      expect(result).toEqual({ added: false });
      expect(await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({ latestVersion: 1 });
    });

    it("does not add a version to another tenant's artifact", async () => {
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      const result = await store.addVersion({
        tenantId: T2,
        id: asId<ArtifactId>("a1"),
        expectedLatestVersion: 1,
        version: version({ id: asId<ArtifactVersionId>("cross") }),
      });
      expect(result).toEqual({ added: false });
      expect(await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({ latestVersion: 1 });
    });

    it("records the conversation, run and inputs that produced a version", async () => {
      // AC-3. Every field, because provenance is stored as one JSON value and a mapper that dropped part of
      // it would still return a plausible record.
      const store = await open();
      await store.create({
        tenantId: T1,
        artifact: artifact(),
        version: version({
          id: asId<ArtifactVersionId>("v1"),
          provenance: {
            runId: asId<RunId>("run-7"),
            producedBy: "summarize_document",
            inputs: { fileId: "file-3", sections: ["revenue"] },
            sourceFileIds: [asId("file-3")],
          },
        }),
      });
      const v1 = await store.getVersion({ tenantId: T1, id: asId<ArtifactId>("a1") });
      // The conversation comes from the artifact -- it owns the artifact, so duplicating it per version would
      // be a second place for it to disagree.
      expect(await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({
        conversationId: C1,
      });
      expect(v1?.provenance).toEqual({
        runId: "run-7",
        producedBy: "summarize_document",
        inputs: { fileId: "file-3", sections: ["revenue"] },
        sourceFileIds: ["file-3"],
      });
    });

    it("lists a conversation's artifacts, newest cursor last", async () => {
      const store = await open([C1, C2]);
      await store.create({
        tenantId: T1,
        artifact: artifact({ id: "a1", name: "first" }),
        version: version({ id: asId<ArtifactVersionId>("v-a1") }),
      });
      await store.create({
        tenantId: T1,
        artifact: artifact({ id: "a2", name: "second" }),
        version: version({ id: asId<ArtifactVersionId>("v-a2"), createdAt: "2026-08-23T13:00:00.000Z" }),
      });
      await store.create({
        tenantId: T1,
        artifact: artifact({ id: "a3", conversationId: C2, name: "elsewhere" }),
        version: version({ id: asId<ArtifactVersionId>("v-a3") }),
      });
      const page = await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 10 });
      expect(page.items.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    });

    it("pages a listing on a keyset cursor rather than an offset", async () => {
      // An offset cursor shifts when a row is inserted, so a caller paging while an artifact is created
      // either sees one twice or misses one.
      const store = await open();
      for (const n of [1, 2, 3, 4, 5]) {
        await store.create({
          tenantId: T1,
          artifact: { ...artifact({ id: `a${n}` }), createdAt: `2026-08-23T1${n}:00:00.000Z` },
          version: version({ id: asId<ArtifactVersionId>(`v-a${n}`), createdAt: `2026-08-23T1${n}:00:00.000Z` }),
        });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listByConversation({
          tenantId: T1,
          conversationId: C1,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((a) => a.id));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    });

    it("lists every version in order, oldest first", async () => {
      // The history a restore reads. Order matters more here than anywhere else in this port.
      const store = await open();
      await store.create({
        tenantId: T1,
        artifact: artifact(),
        version: version({ id: asId<ArtifactVersionId>("v1") }),
      });
      for (const n of [2, 3, 4]) {
        await store.addVersion({
          tenantId: T1,
          id: asId<ArtifactId>("a1"),
          expectedLatestVersion: n - 1,
          // Every version created in the same millisecond: a timestamp keyset would tie, and the version
          // number cannot.
          version: version({ id: asId<ArtifactVersionId>(`v${n}`), createdAt: AT }),
        });
      }
      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listVersions({
          tenantId: T1,
          id: asId<ArtifactId>("a1"),
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((v) => v.version));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toEqual([1, 2, 3, 4]);
    });

    it("returns no versions for another tenant's artifact", async () => {
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      expect(
        (await store.listVersions({ tenantId: T2, id: asId<ArtifactId>("a1"), limit: 10 })).items,
      ).toEqual([]);
    });

    it("hides a soft-deleted artifact from the conversation listing but keeps it resolvable", async () => {
      // Both halves. The row is kept precisely so a shared link resolves to "deleted" rather than to nothing,
      // and a listing that still showed it would be a deleted document coming back.
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      expect(await store.softDelete({ tenantId: T1, id: asId<ArtifactId>("a1"), at: AT })).toEqual({
        deleted: true,
      });
      expect((await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 10 })).items).toEqual(
        [],
      );
      expect(await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({ deletedAt: AT });
    });

    it("keeps the first deletion timestamp when deleted again", async () => {
      // "When was this deleted" must not move every time someone clicks again.
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      await store.softDelete({ tenantId: T1, id: asId<ArtifactId>("a1"), at: AT });
      await store.softDelete({
        tenantId: T1,
        id: asId<ArtifactId>("a1"),
        at: "2026-08-24T12:00:00.000Z",
      });
      expect(await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") })).toMatchObject({ deletedAt: AT });
    });

    it("does not delete another tenant's artifact", async () => {
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      expect(await store.softDelete({ tenantId: T2, id: asId<ArtifactId>("a1"), at: AT })).toEqual({
        deleted: false,
      });
      expect((await store.get({ tenantId: T1, id: asId<ArtifactId>("a1") }))?.deletedAt).toBeUndefined();
    });

    it("adds no version to a deleted artifact", async () => {
      // A new version would resurrect it in every listing that filters through the artifact row.
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      await store.softDelete({ tenantId: T1, id: asId<ArtifactId>("a1"), at: AT });
      expect(
        await store.addVersion({
          tenantId: T1,
          id: asId<ArtifactId>("a1"),
          expectedLatestVersion: 1,
          version: version({ id: asId<ArtifactVersionId>("after-delete") }),
        }),
      ).toEqual({ added: false });
    });

    it("rejects a non-timestamp `at` rather than storing it", async () => {
      // The lesson from #129: a reference adapter laxer than the real one turns a production write failure
      // into a passing test.
      const store = await open();
      await store.create({ tenantId: T1, artifact: artifact(), version: version() });
      await expect(
        store.softDelete({ tenantId: T1, id: asId<ArtifactId>("a1"), at: "t" }),
      ).rejects.toThrow();
    });
  });
}
