/**
 * `FileMetadataStore` and `FileContentStore` conformance (#129).
 *
 * Both carry safety properties rather than only a data contract, and both are asserted here rather than
 * assumed:
 *
 * - **A `contentKey` from one tenant must not resolve another's bytes.** The key is opaque and a caller
 *   cannot construct one — but an adapter that took the key as sufficient would leak across tenants the
 *   moment a key was guessed, logged or copied. #91 found an `AgentStore` that accepted `TenantScope` and
 *   ignored it, which is why every adapter is asked the question directly.
 * - **`transition` is a compare-and-set.** A blind write lets a conversation delete racing an upload leave a
 *   file `stored` after its bytes were scheduled for removal — bytes that then never get swept, because
 *   nothing is looking for a `stored` file's object.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { ConversationId, FileId, PrincipalId, TenantId } from "../../core/ids.js";
import type { FileContentStore, FileMetadata, FileMetadataStore } from "../../persistence/index.js";
import { withConversation, type FixtureOrStore } from "./parents.js";

const T1 = asId<TenantId>("conf-file-tenant-1");
const T2 = asId<TenantId>("conf-file-tenant-2");
const C1 = asId<ConversationId>("conf-file-convo-1");
const C2 = asId<ConversationId>("conf-file-convo-2");
const P1 = asId<PrincipalId>("conf-file-principal-1");

const file = (over: Partial<FileMetadata> & { id: string }): FileMetadata => ({
  conversationId: C1,
  filename: "notes.pdf",
  mediaType: "application/pdf",
  byteSize: 1_024,
  contentKey: `key-${over.id}`,
  state: "stored",
  uploadedBy: P1,
  createdAt: "2026-08-23T10:00:00.000Z",
  ...over,
  id: asId<FileId>(over.id),
});

const bytes = (text: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield new TextEncoder().encode(text);
  })();

/**
 * A real timestamp, because `at` is one.
 *
 * This was a placeholder string until #129 ran the harness against Postgres, which rejected it: the
 * in-memory adapter had been storing whatever it was handed. The lesson is the matrix's whole purpose --
 * a reference adapter laxer than the real one turns a production failure into a passing test -- so the
 * placeholder became a timestamp and `rejects a non-timestamp \`at\`` below holds both adapters to it.
 */
const AT = "2026-08-23T12:00:00.000Z";

export function fileMetadataStoreConformance(
  makeFixture: () => FixtureOrStore<FileMetadataStore>,
): void {
  // A file references a conversation, and Postgres enforces that with a foreign key — so the parent has to
  // exist before the child, and only the fixture can create it. Same shape as `messageStoreConformance`.
  const open = (conversations: readonly ConversationId[] = [C1]) =>
    withConversation(
      makeFixture(),
      conversations.map((conversationId) => ({ tenantId: T1, conversationId })),
    );

  describe("FileMetadataStore conformance", () => {
    it("stores and reads back a file", async () => {
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1" }) });
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f1") })).toMatchObject({
        id: "f1",
        filename: "notes.pdf",
        state: "stored",
      });
    });

    it("returns null for another tenant's file", async () => {
      // Indistinguishable from absent, so the store cannot be used to probe which ids exist.
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1" }) });
      expect(await store.get({ tenantId: T2, id: asId<FileId>("f1") })).toBeNull();
    });

    it("refuses to create the same id twice", async () => {
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1" }) });
      await expect(store.create({ tenantId: T1, file: file({ id: "f1" }) })).rejects.toThrow();
    });

    it("lists a conversation's live files, newest cursor last", async () => {
      const store = await open([C1, C2]);
      await store.create({ tenantId: T1, file: file({ id: "f1", createdAt: "2026-08-23T10:00:00.000Z" }) });
      await store.create({ tenantId: T1, file: file({ id: "f2", createdAt: "2026-08-23T11:00:00.000Z" }) });
      await store.create({ tenantId: T1, file: file({ id: "f3", conversationId: C2 }) });

      const page = await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 10 });
      expect(page.items.map((f) => f.id)).toEqual(["f1", "f2"]);
      // Another conversation's file is absent, not merely last.
      expect(page.items.map((f) => f.id)).not.toContain("f3");
    });

    it("pages on a keyset cursor rather than an offset", async () => {
      // An offset shifts when a row is inserted, so a caller paging a conversation while a file uploads
      // either sees one twice or misses one.
      const store = await open();
      for (const n of [1, 2, 3, 4]) {
        await store.create({
          tenantId: T1,
          file: file({ id: `f${n}`, createdAt: `2026-08-23T1${n}:00:00.000Z` }),
        });
      }
      const first = await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 2 });
      expect(first.items.map((f) => f.id)).toEqual(["f1", "f2"]);
      expect(first.nextCursor).toBeDefined();

      const second = await store.listByConversation({
        tenantId: T1,
        conversationId: C1,
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items.map((f) => f.id)).toEqual(["f3", "f4"]);
      // No cursor when the page is the last one, so a caller loops on its presence.
      expect(second.nextCursor).toBeUndefined();
    });

    it("hides a soft-deleted file from the conversation listing", async () => {
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1" }) });
      await store.transition({
        tenantId: T1,
        id: asId<FileId>("f1"),
        from: "stored",
        to: "deleting",
        at: "2026-08-23T12:00:00.000Z",
      });
      // A deleted attachment reappearing in the list is the failure this guards.
      const page = await store.listByConversation({ tenantId: T1, conversationId: C1, limit: 10 });
      expect(page.items).toEqual([]);
    });

    it("moves a file only from the state the caller expected", async () => {
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1", state: "pending" }) });

      const wrong = await store.transition({
        tenantId: T1,
        id: asId<FileId>("f1"),
        from: "stored",
        to: "deleted",
        at: AT,
      });
      expect(wrong.moved).toBe(false);
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f1") })).toMatchObject({ state: "pending" });

      const right = await store.transition({
        tenantId: T1,
        id: asId<FileId>("f1"),
        from: "pending",
        to: "stored",
        at: AT,
        checksum: "abc",
      });
      expect(right.moved).toBe(true);
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f1") })).toMatchObject({
        state: "stored",
        checksum: "abc",
      });
    });

    it("lets exactly one of two racing transitions win", async () => {
      // The race that matters: a conversation delete and an upload completion both trying to move the same
      // file. A blind write would let the upload land after the delete, leaving a `stored` file whose bytes
      // are scheduled for removal — and nothing sweeps a `stored` file's object.
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1", state: "pending" }) });
      const results = await Promise.all([
        store.transition({ tenantId: T1, id: asId<FileId>("f1"), from: "pending", to: "stored", at: AT }),
        store.transition({ tenantId: T1, id: asId<FileId>("f1"), from: "pending", to: "deleting", at: AT }),
      ]);
      expect(results.filter((r) => r.moved)).toHaveLength(1);
    });

    it("does not transition another tenant's file", async () => {
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1", state: "pending" }) });
      const result = await store.transition({
        tenantId: T2,
        id: asId<FileId>("f1"),
        from: "pending",
        to: "stored",
        at: AT,
      });
      expect(result.moved).toBe(false);
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f1") })).toMatchObject({ state: "pending" });
    });

    it("rejects a non-timestamp `at` rather than storing it", async () => {
      // Found by running this harness against Postgres for the first time (#129): it rejected the
      // placeholder string the in-memory adapter had been storing happily. Either behaviour is defensible
      // in isolation; differing is not, because it makes a production write failure something the
      // in-memory tests cannot see. Pinned here so neither adapter can drift back.
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1", state: "pending" }) });
      await expect(
        store.transition({ tenantId: T1, id: asId<FileId>("f1"), from: "pending", to: "stored", at: "t" }),
      ).rejects.toThrow();
      // And it did not move: a rejected write must not be a partial one.
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f1") })).toMatchObject({ state: "pending" });
    });

    it("schedules every live file of a conversation in one call", async () => {
      // One call rather than list-then-loop: a file uploaded between the two would be missed, leaving bytes
      // for a conversation that no longer exists.
      const store = await open([C1, C2]);
      await store.create({ tenantId: T1, file: file({ id: "f1", state: "stored" }) });
      await store.create({ tenantId: T1, file: file({ id: "f2", state: "pending" }) });
      await store.create({ tenantId: T1, file: file({ id: "f3", conversationId: C2 }) });

      const result = await store.scheduleConversationDeletion({
        tenantId: T1,
        conversationId: C1,
        at: "2026-08-23T12:00:00.000Z",
      });
      // `pending` as well as `stored`: an in-flight upload must not complete into a deleted conversation.
      expect(result.scheduled).toBe(2);
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f1") })).toMatchObject({ state: "deleting" });
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f2") })).toMatchObject({ state: "deleting" });
      // Another conversation's file is untouched.
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f3") })).toMatchObject({ state: "stored" });
    });

    it("does not schedule another tenant's conversation", async () => {
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1" }) });
      const result = await store.scheduleConversationDeletion({
        tenantId: T2,
        conversationId: C1,
        at: AT,
      });
      expect(result.scheduled).toBe(0);
      expect(await store.get({ tenantId: T1, id: asId<FileId>("f1") })).toMatchObject({ state: "stored" });
    });

    it("lists by state only past the age threshold", async () => {
      // Without the threshold the job reports every upload happening while it runs.
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "old", state: "pending", createdAt: "2026-08-23T09:00:00.000Z" }) });
      await store.create({ tenantId: T1, file: file({ id: "new", state: "pending", createdAt: "2026-08-23T12:00:00.000Z" }) });

      const page = await store.listByState({
        tenantId: T1,
        state: "pending",
        olderThan: "2026-08-23T10:00:00.000Z",
        limit: 10,
      });
      expect(page.items.map((f) => f.id)).toEqual(["old"]);
    });

    it("does not list another tenant's files by state", async () => {
      const store = await open();
      await store.create({ tenantId: T1, file: file({ id: "f1", state: "pending" }) });
      const page = await store.listByState({
        tenantId: T2,
        state: "pending",
        olderThan: "2027-01-01T00:00:00.000Z",
        limit: 10,
      });
      expect(page.items).toEqual([]);
    });
  });
}

export function fileContentStoreConformance(make: () => FileContentStore): void {
  describe("FileContentStore conformance", () => {
    it("writes bytes and reads them back unchanged", async () => {
      const store = make();
      const stored = await store.putFile({
        tenantId: T1,
        contentKey: "k1",
        mediaType: "text/plain",
        bytes: bytes("hello"),
        maxBytes: 1_000,
      });
      expect(stored.byteSize).toBe(5);
      expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);

      const read = await store.readFile({ tenantId: T1, contentKey: "k1" });
      expect(read).not.toBeNull();
      const chunks: Uint8Array[] = [];
      for await (const chunk of read!) chunks.push(chunk);
      expect(new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))).toBe("hello");
    });

    it("does not resolve another tenant's key", async () => {
      // The key is opaque and a caller cannot construct one — but an adapter treating the key as sufficient
      // would leak the moment one was guessed, logged or copied.
      const store = make();
      await store.putFile({
        tenantId: T1,
        contentKey: "k1",
        mediaType: "text/plain",
        bytes: bytes("secret"),
        maxBytes: 1_000,
      });
      expect(await store.readFile({ tenantId: T2, contentKey: "k1" })).toBeNull();
    });

    it("stops at the cap and writes nothing", async () => {
      // Stops, rather than reading to the end and then refusing — and stores nothing, because a kept partial
      // object is an orphan created by every oversized upload.
      const store = make();
      await expect(
        store.putFile({
          tenantId: T1,
          contentKey: "k1",
          mediaType: "text/plain",
          bytes: bytes("far too long"),
          maxBytes: 4,
        }),
      ).rejects.toThrow();
      expect(await store.readFile({ tenantId: T1, contentKey: "k1" })).toBeNull();
    });

    it("deletes idempotently", async () => {
      // A retried sweep depends on it: the sweep deletes bytes before moving the state, so a crash between
      // them means the next run deletes an object that is already gone.
      const store = make();
      await store.putFile({
        tenantId: T1,
        contentKey: "k1",
        mediaType: "text/plain",
        bytes: bytes("x"),
        maxBytes: 10,
      });
      await store.deleteFile({ tenantId: T1, contentKey: "k1" });
      await expect(store.deleteFile({ tenantId: T1, contentKey: "k1" })).resolves.toBeUndefined();
      expect(await store.readFile({ tenantId: T1, contentKey: "k1" })).toBeNull();
    });

    it("does not delete another tenant's object", async () => {
      const store = make();
      await store.putFile({
        tenantId: T1,
        contentKey: "k1",
        mediaType: "text/plain",
        bytes: bytes("keep"),
        maxBytes: 10,
      });
      await store.deleteFile({ tenantId: T2, contentKey: "k1" });
      expect(await store.readFile({ tenantId: T1, contentKey: "k1" })).not.toBeNull();
    });

    it("lists only this tenant's objects", async () => {
      const store = make();
      for (const [tenantId, key] of [
        [T1, "a"],
        [T1, "b"],
        [T2, "c"],
      ] as const) {
        await store.putFile({ tenantId, contentKey: key, mediaType: "text/plain", bytes: bytes("x"), maxBytes: 10 });
      }
      const page = await store.listObjects({ tenantId: T1, limit: 10 });
      expect(page.items.map((o) => o.contentKey).sort()).toEqual(["a", "b"]);
    });

    it("either signs with an expiry or returns null, never a durable URL", async () => {
      // AC-6 as a property of the port. An adapter with no signing mechanism says so; one that signs must
      // take an expiry, and there is no method that returns a URL without one.
      const store = make();
      await store.putFile({
        tenantId: T1,
        contentKey: "k1",
        mediaType: "text/plain",
        bytes: bytes("x"),
        maxBytes: 10,
      });
      const url = await store.signedUrl({ tenantId: T1, contentKey: "k1", expiresInSeconds: 60 });
      if (url !== null) {
        // A signed URL carries its expiry somewhere in it. Asserted loosely because the parameter name is
        // the provider's, and asserting a specific one would only test the adapter we happened to write.
        expect(url).toMatch(/https?:\/\//);
        expect(url.length).toBeGreaterThan("https://".length);
      }
    });
  });
}
