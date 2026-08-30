/**
 * The attachment lifecycle (#129).
 *
 * The conformance suite already proves each store honours its port on every adapter. What is tested here is
 * the part no single port can hold: the *sequencing*. Every case below is an interleaving — a crash between
 * two writes, a delete racing an upload, a client whose declared size is a lie — and each one has a wrong
 * answer that looks fine until it is the only copy of someone's document.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { ConversationId, FileId, PrincipalId, RequestId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import { createMemoryFileContentStore, createMemoryFileMetadataStore } from "../adapters/memory/index.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import type { FileContentStore, FileMetadataStore } from "../persistence/index.js";
import {

  DEFAULT_UPLOAD_LIMITS,
  MAX_SIGNED_URL_SECONDS,
  createFileService,
  reconcileFiles,
  streamWithCap,
  validateUpload,
} from "../files/index.js";


/**
 * The value a `.catch((e) => e)` produced, asserted to actually be an error.
 *
 * Without this, `expect(a.message).toBe(b.message)` passes **vacuously** when neither call rejected: both
 * `.message` reads are `undefined`, and `undefined === undefined`. The test would then be asserting that two
 * successful calls are indistinguishable, which is the opposite of what it says.
 */
const thrown = (value: unknown): Error => {
  if (!(value instanceof Error)) throw new Error(`expected the call to reject, and it returned ${JSON.stringify(value)}`);
  return value;
};

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

const bytes = (...chunks: readonly string[]): AsyncIterable<Uint8Array> =>
  (async function* () {
    for (const c of chunks) yield new TextEncoder().encode(c);
  })();

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  let out = "";
  for await (const chunk of stream) out += new TextDecoder().decode(chunk);
  return out;
};

/**
 * A policy that allows everything, and one that refuses a named conversation.
 *
 * `filterTools`/`scope` are unreachable from this service and throw rather than returning a plausible empty
 * value: a stub that answers a question nobody asked is a stub that hides the day someone starts asking.
 */
const policy = (deny: readonly string[] = []): AuthorizationPolicy => ({
  async can(_context, _action, resource) {
    return { allow: !(resource.id !== undefined && deny.includes(resource.id)) };
  },
  filterTools() {
    throw new Error("the file service does not filter tools");
  },
  scope() {
    throw new Error("the file service does not scope tools");
  },
});

/** A service over the reference adapters, with the injectable identifiers pinned so they can be asserted. */
const makeService = (
  overrides: {
    readonly metadata?: FileMetadataStore;
    readonly content?: FileContentStore;
    readonly limits?: Parameters<typeof createFileService>[0]["limits"];
    readonly authorization?: AuthorizationPolicy;
  } = {},
) => {
  const metadata = overrides.metadata ?? createMemoryFileMetadataStore();
  const content = overrides.content ?? createMemoryFileContentStore();
  let n = 0;
  const service = createFileService({
    metadata,
    content,
    authorization: overrides.authorization ?? policy(),
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
    clock: () => "2026-08-23T10:00:00.000Z",
    fileId: () => `file-${++n}`,
    contentKey: () => `key-${n}`,
  });
  return { service, metadata, content };
};

const upload = (
  service: ReturnType<typeof makeService>["service"],
  overrides: Partial<Parameters<ReturnType<typeof makeService>["service"]["upload"]>[1]> = {},
  context: ExecutionContext = ctx(),
) =>
  service.upload(context, {
    conversationId: C1,
    filename: "report.pdf",
    mediaType: "application/pdf",
    declaredBytes: 5,
    bytes: bytes("hello"),
    ...overrides,
  });

describe("validateUpload", () => {
  it("names the limit in the refusal, so the user does not have to guess it", async () => {
    // AC-2. "Too large" sends someone to bisect their file; a number does not.
    expect(() =>
      validateUpload({ mediaType: "application/pdf", declaredBytes: 99_000_000 }, DEFAULT_UPLOAD_LIMITS),
    ).toThrow(/26214400/);
  });

  it("accepts a media type carrying the charset a browser actually sends", () => {
    // `text/plain; charset=utf-8` is what a real upload looks like. A bare-string comparison refuses it,
    // and the user cannot act on that refusal because the file is fine.
    expect(() =>
      validateUpload({ mediaType: "text/plain; charset=utf-8", declaredBytes: 10 }, DEFAULT_UPLOAD_LIMITS),
    ).not.toThrow();
  });

  it("refuses a type that is merely a prefix of an accepted one", () => {
    // The wildcard question, settled: `image/svg+xml` is the type that makes `image/*` a script-execution
    // vector, so the list is exact.
    expect(() =>
      validateUpload({ mediaType: "image/svg+xml", declaredBytes: 10 }, DEFAULT_UPLOAD_LIMITS),
    ).toThrow(/not accepted/);
  });

  it("refuses a size that was not stated", () => {
    for (const declaredBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validateUpload({ mediaType: "application/pdf", declaredBytes }, DEFAULT_UPLOAD_LIMITS),
      ).toThrow(/greater than zero/);
    }
  });
});

describe("streamWithCap", () => {
  it("stops the producer instead of reading a hostile body to the end", async () => {
    // The property that makes this AC-2's real half. A cap checked after the read is a denial of service
    // that reports itself politely: the memory is already gone by the time the error is returned.
    let produced = 0;
    const hostile = (async function* () {
      for (let i = 0; i < 1000; i += 1) {
        produced += 1;
        yield new Uint8Array(10);
      }
    })();

    await expect(collect(streamWithCap(hostile, 25))).rejects.toThrow(/exceeds the 25 byte limit/);
    // Three chunks read, not a thousand: the throw propagates into the generator and cancels it.
    expect(produced).toBeLessThan(10);
  });

  it("passes a stream inside the cap through byte for byte", async () => {
    expect(await collect(streamWithCap(bytes("ab", "cd"), 10))).toBe("abcd");
  });
});

describe("createFileService.upload", () => {
  it("records the size as written, not as declared", async () => {
    // A declared size is a claim. The row should say what is actually stored, or every later reconciliation
    // compares against a number the client chose.
    const { service } = makeService();
    const file = await upload(service, { declaredBytes: 5, bytes: bytes("hello") });
    expect(file).toMatchObject({ state: "stored", byteSize: 5 });
    expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves the row in `pending` when the bytes fail, rather than tidying it away", async () => {
    // The orphan-you-can-find property. Deleting the row here would hide the partial object, which is the
    // one thing reconciliation has to be able to see.
    const { service, metadata } = makeService({ limits: { ...DEFAULT_UPLOAD_LIMITS, maxBytes: 3 } });
    await expect(
      // Declares 3 and sends 8: past the early check, caught by the cap.
      upload(service, { declaredBytes: 3, bytes: bytes("12345678") }),
    ).rejects.toThrow(/exceeds/);

    const row = await metadata.get({ tenantId: T1, id: asId<FileId>("file-1") });
    expect(row).toMatchObject({ state: "pending" });
  });

  it("writes nothing to storage when the cap is hit mid-stream", async () => {
    // The other half of the same failure: a partial object left behind is billed for and referenced by
    // nothing. `putFile`'s contract says discard, and this is the assertion that it does.
    const { service, content } = makeService({ limits: { ...DEFAULT_UPLOAD_LIMITS, maxBytes: 3 } });
    await expect(upload(service, { declaredBytes: 3, bytes: bytes("12345678") })).rejects.toThrow();
    expect((await content.listObjects({ tenantId: T1, limit: 10 })).items).toEqual([]);
  });

  it("deletes the bytes when the conversation was deleted mid-upload", async () => {
    // The realistic race. The `pending` row is moved to `deleting` by the conversation delete, so the
    // upload's own transition finds the wrong state and loses — and the bytes it just wrote are now
    // referenced by nothing, so it removes them itself rather than waiting for a sweep.
    const metadata = createMemoryFileMetadataStore();
    const racing = createMemoryFileContentStore();
    const service = createFileService({
      metadata,
      content: racing,
      authorization: policy(),
      clock: () => "2026-08-23T10:00:00.000Z",
      fileId: () => "file-9",
      contentKey: () => "key-9",
    });

    const uploading = service.upload(ctx(), {
      conversationId: C1,
      filename: "a.pdf",
      mediaType: "application/pdf",
      declaredBytes: 5,
      // Yields once, then awaits a promise the test resolves after scheduling the deletion, so the delete
      // lands strictly between the metadata write and the transition.
      bytes: (async function* () {
        yield new TextEncoder().encode("he");
        await metadata.scheduleConversationDeletion({
          tenantId: T1,
          conversationId: C1,
          at: "2026-08-23T10:00:01.000Z",
        });
        yield new TextEncoder().encode("llo");
      })(),
    });

    await expect(uploading).rejects.toThrow(/deleted while the file was uploading/);
    expect((await racing.listObjects({ tenantId: T1, limit: 10 })).items).toEqual([]);
  });
});

describe("extraction is requested, never awaited (#131)", () => {
  it("asks for extraction after the file is stored, not before", async () => {
    // A worker picking the job up immediately must find a file it can read. Requesting before the transition
    // would hand it a `pending` file, which the pipeline correctly skips — losing the extraction to a race.
    const seen: { fileId: string; state: string | undefined }[] = [];
    const metadata = createMemoryFileMetadataStore();
    const content = createMemoryFileContentStore();
    const service = createFileService({
      metadata,
      content,
      authorization: policy(),
      clock: () => "2026-08-23T10:00:00.000Z",
      fileId: () => "file-1",
      contentKey: () => "key-1",
      async requestExtraction({ tenantId, fileId }) {
        const row = await metadata.get({ tenantId, id: fileId });
        seen.push({ fileId, state: row?.state });
      },
    });
    await service.upload(ctx(), {
      conversationId: C1,
      filename: "report.csv",
      mediaType: "application/pdf",
      declaredBytes: 5,
      bytes: bytes("hello"),
    });
    expect(seen).toEqual([{ fileId: "file-1", state: "stored" }]);
  });

  it("still returns the uploaded file when the extraction queue is unreachable", async () => {
    // AC-2. The bytes and the row are both durable by this point; an unreachable queue must not turn a
    // successful upload into a failed one. The sweep is what picks up the dropped request.
    const logged: string[] = [];
    const { metadata, content } = makeService();
    const service = createFileService({
      metadata,
      content,
      authorization: policy(),
      clock: () => "2026-08-23T10:00:00.000Z",
      fileId: () => "file-1",
      contentKey: () => "key-1",
      async requestExtraction() {
        throw new Error("redis unreachable");
      },
      log: (message) => logged.push(message),
    });
    const file = await service.upload(ctx(), {
      conversationId: C1,
      filename: "report.pdf",
      mediaType: "application/pdf",
      declaredBytes: 5,
      bytes: bytes("hello"),
    });
    expect(file).toMatchObject({ state: "stored" });
    // Dropped loudly rather than silently: the log line is the only trace, so it has to exist.
    expect(logged).toContain("extraction request failed after upload");
  });

  it("uploads fine with no extraction configured at all", async () => {
    // A deployment with no extraction is a valid one, and attaching a text file must not require Redis.
    const { service } = makeService();
    await expect(upload(service)).resolves.toMatchObject({ state: "stored" });
  });
});

describe("createFileService reads", () => {
  it("reports another tenant's file as absent, not as forbidden", async () => {
    // `forbidden` confirms the id exists. Two callers, one answer.
    const { service } = makeService();
    const file = await upload(service);
    await expect(service.get(ctx(T2), file.id)).rejects.toThrow(/no such file/);
  });

  it("refuses to read a file that is still pending", async () => {
    const { service, metadata } = makeService();
    await metadata.create({
      tenantId: T1,
      file: {
        id: asId<FileId>("half"),
        conversationId: C1,
        filename: "a.pdf",
        mediaType: "application/pdf",
        byteSize: 1,
        contentKey: "key-half",
        state: "pending",
        uploadedBy: asId<PrincipalId>("user-1"),
        createdAt: "2026-08-23T10:00:00.000Z",
      },
    });
    await expect(service.get(ctx(), asId<FileId>("half"))).rejects.toThrow(/not available/);
  });

  it("refuses a row marked deleted even if its state still says stored", async () => {
    // Defence in depth on a state the ports do not currently produce -- `deletedAt` is only set alongside a
    // state change. The row is constructible through the port, though, so a future writer or a hand-edited
    // row could make it; a deleted file coming back is the failure that must not depend on one field.
    const { service, metadata } = makeService();
    await metadata.create({
      tenantId: T1,
      file: {
        id: asId<FileId>("ghost"),
        conversationId: C1,
        filename: "a.pdf",
        mediaType: "application/pdf",
        byteSize: 1,
        contentKey: "key-ghost",
        state: "stored",
        uploadedBy: asId<PrincipalId>("user-1"),
        createdAt: "2026-08-23T10:00:00.000Z",
        deletedAt: "2026-08-23T11:00:00.000Z",
      },
    });
    await expect(service.get(ctx(), asId<FileId>("ghost"))).rejects.toThrow(/no such file/);
  });

  it("refuses a file in a conversation the caller may not read", async () => {
    // AC-3, and the reason the policy is a required dependency: tenant scoping alone lets any member of a
    // tenant read every attachment in it.
    //
    // The restricted service is built over the **same stores**, which is the whole test. An earlier version
    // gave it fresh ones, so the refusal came from the file not being there — and the assertion passed with
    // the authorization check deleted.
    const { service, metadata, content } = makeService();
    const file = await upload(service);
    const restricted = createFileService({
      metadata,
      content,
      authorization: policy([C1]),
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await expect(restricted.get(ctx(), file.id)).rejects.toThrow(/no such file/);
    // The entitled caller still gets it, so the refusal is about entitlement rather than about the fixture.
    await expect(service.get(ctx(), file.id)).resolves.toMatchObject({ id: file.id });
  });

  it("gives the unentitled caller the same answer as the nonexistent id", async () => {
    // A distinct message or code here would confirm the file exists to precisely the caller who must not
    // learn that. Compared rather than asserted separately, so the two cannot drift apart.
    const { service, metadata, content } = makeService();
    const file = await upload(service);
    const restricted = createFileService({
      metadata,
      content,
      authorization: policy([C1]),
      clock: () => "2026-08-23T10:00:00.000Z",
    });

    const forbidden = await restricted.get(ctx(), file.id).catch((e: Error) => e);
    const absent = await restricted.get(ctx(), asId<FileId>("no-such-id")).catch((e: Error) => e);
    expect(thrown(forbidden).message).toBe(thrown(absent).message);
    expect(forbidden).toMatchObject({ code: "not_found" });
    expect(absent).toMatchObject({ code: "not_found" });
  });

  it("refuses to list files in a conversation the caller may not read", async () => {
    const { service } = makeService({ authorization: policy([C1]) });
    await expect(service.listForConversation(ctx(), { conversationId: C1, limit: 10 })).rejects.toThrow(
      /no such conversation/,
    );
  });

  it("refuses an upload into a conversation the caller may not write, before any row exists", async () => {
    // Not merely refused: refused before the metadata write, so an unentitled caller cannot put a filename
    // of their choosing into a conversation they cannot read.
    const { service, metadata, content } = makeService({ authorization: policy([C1]) });
    await expect(upload(service)).rejects.toThrow(/no such conversation/);
    expect((await content.listObjects({ tenantId: T1, limit: 10 })).items).toEqual([]);
    expect(await metadata.get({ tenantId: T1, id: asId<FileId>("file-1") })).toBeNull();
  });

  it("clamps a signed URL's life rather than trusting the caller's optimism", async () => {
    // AC-6. A signed URL is a bearer token in a query string; a caller asking for a day gets fifteen
    // minutes. Asserted on the argument, because the reference content store returns null by design.
    const seen: number[] = [];
    const content = createMemoryFileContentStore();
    const spying: FileContentStore = {
      ...content,
      async signedUrl(input) {
        seen.push(input.expiresInSeconds);
        return `https://example.test/${input.contentKey}`;
      },
    };
    const { service } = makeService({
      content: spying,
      limits: { ...DEFAULT_UPLOAD_LIMITS, signedUrlSeconds: 86_400 },
    });
    const file = await upload(service);
    await service.signedReadUrl(ctx(), file.id);
    expect(seen).toEqual([MAX_SIGNED_URL_SECONDS]);
  });

  it("reports missing bytes as missing rather than as an empty file", async () => {
    // An empty stream is something a caller might reasonably use. This is the read path's view of the
    // orphan, and it has to be loud.
    const { service, content } = makeService();
    const file = await upload(service);
    await content.deleteFile({ tenantId: T1, contentKey: file.contentKey });
    await expect(service.read(ctx(), file.id)).rejects.toThrow(/contents are missing/);
  });

  it("streams the stored bytes back", async () => {
    const { service } = makeService();
    const file = await upload(service, { bytes: bytes("hel", "lo") });
    expect(await collect(await service.read(ctx(), file.id))).toBe("hello");
  });
});

describe("createFileService deletion", () => {
  it("hides a scheduled file from the conversation before its bytes are gone", async () => {
    // AC-4's user-visible half. The bytes outlive the metadata by design, and the window must not be a
    // window in which the file is still listed.
    const { service, content } = makeService();
    await upload(service);
    const { scheduled } = await service.deleteConversationFiles(ctx(), C1);
    expect(scheduled).toBe(1);
    expect((await service.listForConversation(ctx(), { conversationId: C1, limit: 10 })).items).toEqual([]);
    // Still there — which is why the sweep exists.
    expect((await content.listObjects({ tenantId: T1, limit: 10 })).items).toHaveLength(1);
  });

  it("removes the bytes before the state, so a crash retries instead of orphaning", async () => {
    const { service, content, metadata } = makeService();
    const file = await upload(service);
    await service.deleteConversationFiles(ctx(), C1);
    const result = await service.sweepDeletions(ctx(), { olderThan: "2026-08-24T00:00:00.000Z", limit: 10 });
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect((await content.listObjects({ tenantId: T1, limit: 10 })).items).toEqual([]);
    expect(await metadata.get({ tenantId: T1, id: file.id })).toMatchObject({ state: "deleted" });
  });

  it("counts an unreachable object and carries on with the rest of the sweep", async () => {
    // One bad object must not stop the batch: the row stays `deleting` and the next run retries it, which
    // is exactly what deleting bytes before the state buys.
    const content = createMemoryFileContentStore();
    const failing: FileContentStore = {
      ...content,
      async deleteFile(input) {
        if (input.contentKey === "key-1") throw new Error("storage unreachable");
        return content.deleteFile(input);
      },
    };
    const metadata = createMemoryFileMetadataStore();
    let n = 0;
    const service = createFileService({
      metadata,
      content: failing,
      authorization: policy(),
      clock: () => "2026-08-23T10:00:00.000Z",
      fileId: () => `file-${++n}`,
      contentKey: () => `key-${n}`,
    });
    await upload(service);
    await upload(service, { filename: "b.pdf" });
    await service.deleteConversationFiles(ctx(), C1);

    const result = await service.sweepDeletions(ctx(), { olderThan: "2026-08-24T00:00:00.000Z", limit: 10 });
    expect(result).toEqual({ deleted: 1, failed: 1 });
    // The failed one is still `deleting`, so the next sweep picks it up again.
    expect(await metadata.get({ tenantId: T1, id: asId<FileId>("file-1") })).toMatchObject({
      state: "deleting",
    });
  });

  it("does not sweep a file that entered `deleting` after the threshold", async () => {
    // Without the threshold the job races itself: it would delete the bytes of a deletion scheduled a
    // millisecond ago, in the same instant something else might still be reading them.
    const { service, content } = makeService();
    await upload(service);
    await service.deleteConversationFiles(ctx(), C1);
    const result = await service.sweepDeletions(ctx(), { olderThan: "2026-08-23T09:00:00.000Z", limit: 10 });
    expect(result).toEqual({ deleted: 0, failed: 0 });
    expect((await content.listObjects({ tenantId: T1, limit: 10 })).items).toHaveLength(1);
  });
});

describe("reconcileFiles", () => {
  it("reports an object nothing references, and does not delete it", async () => {
    // AC-5, in the AC's own words. A job that deletes is a job that can delete a file whose metadata write
    // was merely slow.
    const { service, metadata, content } = makeService();
    await upload(service);
    await content.putFile({
      tenantId: T1,
      contentKey: "stray",
      mediaType: "application/pdf",
      bytes: bytes("orphan"),
      maxBytes: 100,
    });

    const report = await reconcileFiles(
      ctx(),
      { metadata, content },
      { olderThan: "2026-08-24T00:00:00.000Z", limit: 50 },
    );
    expect(report.orphanedObjects).toEqual(["stray"]);
    // Still there afterwards. This is the assertion that makes "reports, never deletes" a property rather
    // than a comment.
    expect((await content.listObjects({ tenantId: T1, limit: 10 })).items).toHaveLength(2);
  });

  it("does not call an object orphaned just because its deletion is already scheduled", async () => {
    // The false positive that would make the report never come clean: someone told to delete a key that a
    // sweep is about to delete anyway.
    const { service, metadata, content } = makeService();
    await upload(service);
    await service.deleteConversationFiles(ctx(), C1);
    const report = await reconcileFiles(
      ctx(),
      { metadata, content },
      { olderThan: "2026-08-24T00:00:00.000Z", limit: 50 },
    );
    expect(report.orphanedObjects).toEqual([]);
    expect(report.stuckDeleting).toEqual([asId<FileId>("file-1")]);
  });

  it("reports metadata that says stored while the bytes are gone", async () => {
    const { service, metadata, content } = makeService();
    const file = await upload(service);
    await content.deleteFile({ tenantId: T1, contentKey: file.contentKey });
    const report = await reconcileFiles(
      ctx(),
      { metadata, content },
      { olderThan: "2026-08-24T00:00:00.000Z", limit: 50 },
    );
    expect(report.missingContent).toEqual([file.id]);
  });

  it("reports an upload that never finished", async () => {
    const { service, metadata, content } = makeService({ limits: { ...DEFAULT_UPLOAD_LIMITS, maxBytes: 3 } });
    await expect(upload(service, { declaredBytes: 3, bytes: bytes("12345678") })).rejects.toThrow();
    const report = await reconcileFiles(
      ctx(),
      { metadata, content },
      { olderThan: "2026-08-24T00:00:00.000Z", limit: 50 },
    );
    expect(report.stuckPending).toEqual([asId<FileId>("file-1")]);
    // The `pending` row's key is a reference, so the partial object is not also reported as an orphan —
    // one fault, one line in the report.
    expect(report.orphanedObjects).toEqual([]);
  });

  it("does not report a file uploaded after the threshold as an orphan", async () => {
    // Found by sabotage: reusing the caller's `olderThan` for the reference scan looks harmless and is the
    // worst false positive the report can produce. A file uploaded a minute ago is younger than the
    // threshold, so its row is skipped, so its key is missing from the referenced set — and a live file's
    // bytes are handed to someone as safe to delete. The reference pass deliberately scans every age.
    const metadata = createMemoryFileMetadataStore();
    const content = createMemoryFileContentStore();
    const service = createFileService({
      metadata,
      content,
      authorization: policy(),
      // Uploaded *after* the threshold the report is asked about.
      clock: () => "2026-08-23T23:00:00.000Z",
      fileId: () => "fresh",
      contentKey: () => "key-fresh",
    });
    await upload(service);

    const report = await reconcileFiles(
      ctx(),
      { metadata, content },
      { olderThan: "2026-08-23T12:00:00.000Z", limit: 50 },
    );
    expect(report.orphanedObjects).toEqual([]);
    expect(report.stuckPending).toEqual([]);
  });

  it("finds another tenant's orphan only in that tenant's report", async () => {
    const { service, metadata, content } = makeService();
    await upload(service);
    await content.putFile({
      tenantId: T2,
      contentKey: "other-tenant-stray",
      mediaType: "application/pdf",
      bytes: bytes("x"),
      maxBytes: 100,
    });
    const mine = await reconcileFiles(
      ctx(),
      { metadata, content },
      { olderThan: "2026-08-24T00:00:00.000Z", limit: 50 },
    );
    expect(mine.orphanedObjects).toEqual([]);
    const theirs = await reconcileFiles(
      ctx(T2),
      { metadata, content },
      { olderThan: "2026-08-24T00:00:00.000Z", limit: 50 },
    );
    expect(theirs.orphanedObjects).toEqual(["other-tenant-stray"]);
  });
});
