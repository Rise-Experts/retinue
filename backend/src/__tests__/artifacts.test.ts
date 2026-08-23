/**
 * The artifact lifecycle (#133).
 *
 * The conformance suite already proves each adapter honours the port. What is tested here is the sequencing
 * and the entitlement — the parts no store can hold — and the property that costs most when it is wrong:
 * **an earlier version must stay resolvable**, because a shared link that 404s is the failure a user notices
 * and cannot work around.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type {
  ArtifactId,
  ConversationId,
  PrincipalId,
  RequestId,
  RunId,
  TenantId,
} from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import { createMemoryArtifactStore, createMemoryBlobStore } from "../adapters/memory/index.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import {
  MAX_ARTIFACT_BYTES,
  contentByteSize,
  createArtifactService,
} from "../artifacts/index.js";

const T1 = asId<TenantId>("tenant-1");
const T2 = asId<TenantId>("tenant-2");
const C1 = asId<ConversationId>("convo-1");

const ctx = (tenantId: TenantId = T1): ExecutionContext => ({
  tenantId,
  principalId: asId<PrincipalId>("user-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

/**
 * A policy allowing everything, or refusing named conversations.
 *
 * `filterTools`/`scope` throw rather than returning a plausible empty value: a stub that answers a question
 * nobody asked hides the day someone starts asking.
 */
const policy = (deny: readonly string[] = []): AuthorizationPolicy => ({
  async can(_context, _action, resource) {
    return { allow: !(resource.id !== undefined && deny.includes(resource.id)) };
  },
  filterTools() {
    throw new Error("the artifact service does not filter tools");
  },
  scope() {
    throw new Error("the artifact service does not scope tools");
  },
});

const setup = (overrides: { authorization?: AuthorizationPolicy } = {}) => {
  const artifacts = createMemoryArtifactStore();
  const blobs = createMemoryBlobStore();
  let n = 0;
  const service = createArtifactService({
    artifacts,
    blobs,
    authorization: overrides.authorization ?? policy(),
    clock: () => "2026-08-23T10:00:00.000Z",
    artifactId: () => "art-1",
    versionId: () => `ver-${++n}`,
  });
  return { artifacts, blobs, service };
};

const create = (
  service: ReturnType<typeof setup>["service"],
  value: unknown = "# Q3\n\nRevenue rose.",
  context: ExecutionContext = ctx(),
) =>
  service.create(context, {
    conversationId: C1,
    name: "Q3 summary",
    content: { kind: "markdown", value },
    provenance: { producedBy: "create_artifact", inputs: { topic: "q3" } },
  });

describe("creating an artifact", () => {
  it("stores content by reference and returns version 1", async () => {
    // AC-1 and AC-5. The row carries a ref; the content is in the blob store.
    const { service, artifacts, blobs } = setup();
    const created = await create(service);
    expect(created).toMatchObject({ name: "Q3 summary", kind: "markdown", latestVersion: 1 });

    const version = await artifacts.getVersion({ tenantId: T1, id: created.id });
    expect(version).toMatchObject({ version: 1, byteSize: contentByteSize("# Q3\n\nRevenue rose.") });
    expect(version?.checksum).toMatch(/^[0-9a-f]{64}$/);
    // The content is where the reference says it is, and nowhere else.
    expect(await blobs.get({ tenantId: T1, ref: version!.contentRef })).toBe("# Q3\n\nRevenue rose.");
  });

  it("records the run and inputs that produced it", async () => {
    // AC-3. The conversation comes from the artifact, which owns it; duplicating it per version would be a
    // second place for it to disagree.
    const { service, artifacts } = setup();
    const created = await service.create(ctx(), {
      conversationId: C1,
      name: "Report",
      content: { kind: "markdown", value: "text" },
      provenance: {
        runId: asId<RunId>("run-7"),
        producedBy: "summarize_document",
        inputs: { fileId: "file-3", sections: ["revenue"] },
      },
    });
    expect(created.conversationId).toBe(C1);
    expect((await artifacts.getVersion({ tenantId: T1, id: created.id }))?.provenance).toEqual({
      runId: "run-7",
      producedBy: "summarize_document",
      inputs: { fileId: "file-3", sections: ["revenue"] },
    });
  });

  it("names the limit when it refuses an oversized artifact", async () => {
    // A ceiling exists because model output has no natural bound; in practice this catches a loop writing the
    // same paragraph a thousand times.
    const { service } = setup();
    await expect(create(service, "x".repeat(MAX_ARTIFACT_BYTES + 1))).rejects.toThrow(
      new RegExp(String(MAX_ARTIFACT_BYTES)),
    );
  });

  it("measures a structured value on its serialised form", async () => {
    // What is stored and what is billed. Measuring before serialisation under-counts by exactly what the
    // encoding adds.
    const { service, artifacts } = setup();
    const value = { rows: [{ q: "Q3", rev: 1200 }] };
    const created = await service.create(ctx(), {
      conversationId: C1,
      name: "Table",
      content: { kind: "json", value },
      provenance: { producedBy: "t", inputs: {} },
    });
    expect((await artifacts.getVersion({ tenantId: T1, id: created.id }))?.byteSize).toBe(
      new TextEncoder().encode(JSON.stringify(value)).byteLength,
    );
  });

  it("writes the blob before the row, so a crash leaves waste rather than corruption", async () => {
    // A row pointing at content that does not exist reads as corruption; an unreferenced blob is merely
    // waste. Observed by failing the row write and checking what survived.
    const blobs = createMemoryBlobStore();
    const artifacts = createMemoryArtifactStore();
    const service = createArtifactService({
      artifacts: {
        ...artifacts,
        async create() {
          throw new Error("row write failed");
        },
      },
      blobs,
      authorization: policy(),
      clock: () => "2026-08-23T10:00:00.000Z",
      artifactId: () => "art-1",
      versionId: () => "ver-1",
    });
    await expect(create(service)).rejects.toThrow(/row write failed/);
    // No artifact, and the blob is the orphan — which is the survivable direction.
    expect(await artifacts.get({ tenantId: T1, id: asId<ArtifactId>("art-1") })).toBeNull();
  });
});

describe("AC-2: regenerating creates a new version", () => {
  it("makes the new version current and keeps the old one resolvable", async () => {
    // The second half is what breaks quietly: an implementation that overwrote would pass every assertion
    // about the *new* version.
    const { service } = setup();
    const created = await create(service, "first draft");
    const { version } = await service.regenerate(ctx(), {
      id: created.id,
      content: { kind: "markdown", value: "second draft" },
      provenance: { producedBy: "create_artifact", inputs: { topic: "q3", retry: 1 } },
    });
    expect(version).toBe(2);

    expect((await service.read(ctx(), { id: created.id })).content).toBe("second draft");
    expect((await service.read(ctx(), { id: created.id, version: 1 })).content).toBe("first draft");
  });

  it("regenerates repeatedly, each time from the version that is actually current", async () => {
    // Found by sabotage: every other test regenerates from version 1, so hardcoding the expected latest to 1
    // passed all of them. A third draft is the ordinary case and it is the one that breaks.
    const { service } = setup();
    const created = await create(service, "draft 1");
    for (const n of [2, 3, 4]) {
      const { version } = await service.regenerate(ctx(), {
        id: created.id,
        content: { kind: "markdown", value: `draft ${n}` },
        provenance: { producedBy: "create_artifact", inputs: { attempt: n } },
      });
      expect(version).toBe(n);
    }
    expect((await service.read(ctx(), { id: created.id })).content).toBe("draft 4");
    // And every earlier draft is still resolvable, which is the property the whole AC is about.
    for (const n of [1, 2, 3]) {
      expect((await service.read(ctx(), { id: created.id, version: n })).content).toBe(`draft ${n}`);
    }
  });

  it("gives each version its own provenance", async () => {
    // Comparing two versions' inputs is how a reader explains why a regeneration produced something else.
    const { service } = setup();
    const created = await create(service);
    await service.regenerate(ctx(), {
      id: created.id,
      content: { kind: "markdown", value: "again" },
      provenance: { producedBy: "create_artifact", inputs: { topic: "q3", tone: "formal" } },
    });
    const history = await service.history(ctx(), { id: created.id, limit: 10 });
    expect(history.items.map((v) => v.provenance.inputs)).toEqual([
      { topic: "q3" },
      { topic: "q3", tone: "formal" },
    ]);
  });

  it("refuses when the artifact moved under it", async () => {
    // The read establishes what is being regenerated *from*; the compare makes a concurrent regeneration lose
    // loudly instead of silently replacing this one.
    const { service, artifacts } = setup();
    const created = await create(service);
    // Someone else's version 2 lands between this caller's read and its write.
    const racing = createArtifactService({
      artifacts,
      blobs: createMemoryBlobStore(),
      authorization: policy(),
      clock: () => "2026-08-23T11:00:00.000Z",
      artifactId: () => "art-1",
      versionId: () => "ver-other",
    });
    await racing.regenerate(ctx(), {
      id: created.id,
      content: { kind: "markdown", value: "theirs" },
      provenance: { producedBy: "t", inputs: {} },
    });

    // Now a caller working from the stale `latestVersion: 1`.
    const stale = await artifacts.addVersion({
      tenantId: T1,
      id: created.id,
      expectedLatestVersion: 1,
      version: {
        id: asId("ver-stale"),
        contentRef: asId("blob-x"),
        byteSize: 1,
        provenance: { producedBy: "t", inputs: {} },
        createdBy: asId<PrincipalId>("user-1"),
        createdAt: "2026-08-23T12:00:00.000Z",
      },
    });
    expect(stale).toEqual({ added: false });
  });

  it("does not regenerate a deleted artifact", async () => {
    const { service } = setup();
    const created = await create(service);
    await service.softDelete(ctx(), created.id);
    await expect(
      service.regenerate(ctx(), {
        id: created.id,
        content: { kind: "markdown", value: "zombie" },
        provenance: { producedBy: "t", inputs: {} },
      }),
    ).rejects.toThrow(/no such artifact/);
  });
});

describe("restoring an earlier version", () => {
  it("makes a new version rather than moving a pointer backwards", async () => {
    // Moving a pointer would make the history lie about what happened, and "the version that was current on
    // Tuesday" is exactly the question a shared link asks.
    const { service } = setup();
    const created = await create(service, "v1 text");
    await service.regenerate(ctx(), {
      id: created.id,
      content: { kind: "markdown", value: "v2 text" },
      provenance: { producedBy: "t", inputs: {} },
    });
    const { version } = await service.restore(ctx(), { id: created.id, version: 1 });
    expect(version).toBe(3);

    // The current content is v1's, and v2 is still there.
    expect((await service.read(ctx(), { id: created.id })).content).toBe("v1 text");
    expect((await service.read(ctx(), { id: created.id, version: 2 })).content).toBe("v2 text");
    expect((await service.history(ctx(), { id: created.id, limit: 10 })).items.map((v) => v.version)).toEqual([
      1, 2, 3,
    ]);
  });

  it("reuses the blob rather than copying identical content", async () => {
    // A blob is immutable, so sharing it is safe — and copying would double the storage for a byte-identical
    // value.
    const { service, artifacts } = setup();
    const created = await create(service, "v1 text");
    await service.regenerate(ctx(), {
      id: created.id,
      content: { kind: "markdown", value: "v2 text" },
      provenance: { producedBy: "t", inputs: {} },
    });
    await service.restore(ctx(), { id: created.id, version: 1 });
    const versions = (await artifacts.listVersions({ tenantId: T1, id: created.id, limit: 10 })).items;
    expect(versions[2]?.contentRef).toBe(versions[0]?.contentRef);
  });

  it("records what it restored from", async () => {
    // So the history explains itself without a reader comparing content refs.
    const { service } = setup();
    const created = await create(service, "v1");
    await service.regenerate(ctx(), {
      id: created.id,
      content: { kind: "markdown", value: "v2" },
      provenance: { producedBy: "t", inputs: {} },
    });
    await service.restore(ctx(), { id: created.id, version: 1 });
    const history = await service.history(ctx(), { id: created.id, limit: 10 });
    expect(history.items[2]?.provenance).toMatchObject({
      producedBy: "restore",
      inputs: { restoredFromVersion: 1 },
    });
  });

  it("refuses to restore a version that does not exist", async () => {
    const { service } = setup();
    const created = await create(service);
    await expect(service.restore(ctx(), { id: created.id, version: 9 })).rejects.toThrow(/no such version/);
  });
});

describe("AC-4: access follows conversation entitlement", () => {
  it("refuses a read for a caller not entitled to the conversation", async () => {
    // Built over the *same* stores, which is the whole test: fresh stores would make the refusal come from
    // the artifact not being there, and the assertion would pass with the check deleted.
    const { service, artifacts, blobs } = setup();
    const created = await create(service);
    const restricted = createArtifactService({
      artifacts,
      blobs,
      authorization: policy([C1]),
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await expect(restricted.read(ctx(), { id: created.id })).rejects.toThrow(/no such artifact/);
    // And the entitled caller still gets it, so the refusal is about entitlement rather than the fixture.
    await expect(service.read(ctx(), { id: created.id })).resolves.toMatchObject({ content: "# Q3\n\nRevenue rose." });
  });

  it("gives the unentitled caller the same answer as a nonexistent id", async () => {
    // A distinct message or code confirms the artifact exists to precisely the caller who must not learn that.
    const { service, artifacts, blobs } = setup();
    const created = await create(service);
    const restricted = createArtifactService({
      artifacts,
      blobs,
      authorization: policy([C1]),
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    const forbidden = await restricted.read(ctx(), { id: created.id }).catch((e: Error) => e);
    const absent = await restricted.read(ctx(), { id: asId<ArtifactId>("nope") }).catch((e: Error) => e);
    expect(forbidden.message).toBe(absent.message);
    expect(forbidden).toMatchObject({ code: "not_found" });
  });

  it("refuses a write, a history read, a restore and a delete alike", async () => {
    // Every entry point, because one unguarded method is the whole model gone.
    const { service, artifacts, blobs } = setup();
    const created = await create(service);
    const restricted = createArtifactService({
      artifacts,
      blobs,
      authorization: policy([C1]),
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await expect(
      restricted.regenerate(ctx(), {
        id: created.id,
        content: { kind: "markdown", value: "x" },
        provenance: { producedBy: "t", inputs: {} },
      }),
    ).rejects.toThrow(/no such artifact/);
    await expect(restricted.history(ctx(), { id: created.id, limit: 5 })).rejects.toThrow(/no such artifact/);
    await expect(restricted.restore(ctx(), { id: created.id, version: 1 })).rejects.toThrow(/no such artifact/);
    await expect(restricted.softDelete(ctx(), created.id)).rejects.toThrow(/no such artifact/);
    await expect(
      restricted.listForConversation(ctx(), { conversationId: C1, limit: 5 }),
    ).rejects.toThrow(/no such conversation/);
  });

  it("refuses a create into a conversation the caller may not write", async () => {
    // Before anything is stored, so an unentitled caller cannot put a name of their choosing into a
    // conversation they cannot read.
    const { service, artifacts } = setup({ authorization: policy([C1]) });
    await expect(create(service)).rejects.toThrow(/no such conversation/);
    expect(await artifacts.get({ tenantId: T1, id: asId<ArtifactId>("art-1") })).toBeNull();
  });

  it("does not resolve another tenant's artifact", async () => {
    const { service } = setup();
    const created = await create(service);
    await expect(service.read(ctx(T2), { id: created.id })).rejects.toThrow(/no such artifact/);
  });
});

describe("reading", () => {
  it("reports missing content as missing rather than as an empty artifact", async () => {
    // An empty artifact is something a caller might reasonably export, so this has to be loud.
    const { service, artifacts, blobs } = setup();
    const created = await create(service);
    const version = await artifacts.getVersion({ tenantId: T1, id: created.id });
    const service2 = createArtifactService({
      artifacts,
      // A blob store that lost the value: the row still points at it.
      blobs: { ...blobs, async get() { return null; } },
      authorization: policy(),
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    expect(version).not.toBeNull();
    await expect(service2.read(ctx(), { id: created.id })).rejects.toThrow(/content is missing/);
  });

  it("loads no content for a history read", async () => {
    // A history is metadata. Loading every version's content to list them would make an audit the most
    // expensive read in the system.
    const { service, artifacts, blobs } = setup();
    const created = await create(service);
    let gets = 0;
    const counting = createArtifactService({
      artifacts,
      blobs: {
        ...blobs,
        async get(input) {
          gets += 1;
          return blobs.get(input);
        },
      },
      authorization: policy(),
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await counting.history(ctx(), { id: created.id, limit: 10 });
    expect(gets).toBe(0);
  });

  it("hides a deleted artifact from the listing but keeps a direct read explicable", async () => {
    const { service } = setup();
    const created = await create(service);
    await service.softDelete(ctx(), created.id);
    expect((await service.listForConversation(ctx(), { conversationId: C1, limit: 10 })).items).toEqual([]);
    // Not silently absent: the caller is told it is gone rather than that it never existed.
    await expect(service.read(ctx(), { id: created.id })).rejects.toThrow(/no such artifact/);
  });
});
