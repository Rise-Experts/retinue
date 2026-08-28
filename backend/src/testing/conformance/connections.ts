/**
 * `ConnectionStore` conformance — REQ-063 (#259), task #261.
 *
 * Every clause here is a defect somebody would otherwise ship, and two of them are the reason the port exists
 * at all: a store that leaked across tenants would hand one customer another's credential, and a store that
 * kept a revoked connection readable would let a withdrawn credential be used once more.
 *
 * The store never sees plaintext, so this suite never supplies any: it seals nothing and asserts nothing about
 * encryption. That belongs to `SecretCipher`'s own tests and to the raw-row assertion, which needs a real
 * database and lives with the adapter.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import type { ConnectionInput, ConnectionStore, SealedSecret } from "../../connections/index.js";

const sealed = (marker: string): SealedSecret => ({
  keyId: "k1",
  algorithm: "aes-256-gcm",
  nonce: Buffer.alloc(12, 1).toString("base64"),
  ciphertext: Buffer.from(`sealed-${marker}`).toString("base64"),
});

const connection = (over: Partial<ConnectionInput> & { id: string }): ConnectionInput => ({
  provider: "github",
  mode: "token",
  scheme: "bearer",
  sealed: sealed(over.id),
  ...over,
});

export function connectionStoreConformance(makeStore: () => ConnectionStore | Promise<ConnectionStore>): void {
  describe("ConnectionStore conformance", () => {
    const T1 = asId<TenantId>("conn-t1");
    const T2 = asId<TenantId>("conn-t2");

    it("creates and reads back, scoped to its tenant", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1", label: "Acme org" }) });
      const read = await store.get({ tenantId: T1, id: "c1" });
      expect(read).toMatchObject({ id: "c1", provider: "github", label: "Acme org", scheme: "bearer" });
      expect(read?.sealed.ciphertext).toBe(sealed("c1").ciphertext);
      expect(read?.createdAt).toBeTruthy();
    });

    it("returns null for another tenant's connection", async () => {
      // Indistinguishable from absent, so the store cannot be used to probe which ids exist — and, far worse,
      // cannot hand T2 a credential belonging to T1.
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      expect(await store.get({ tenantId: T2, id: "c1" })).toBeNull();
    });

    it("lists only this tenant's live connections", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "a" }) });
      await store.create({ tenantId: T2, connection: connection({ id: "b" }) });
      expect((await store.list({ tenantId: T1 })).map((c) => c.id)).toEqual(["a"]);
    });

    it("allows several connections to one provider for one tenant", async () => {
      // A customer with three GitHub organisations is the normal case, not an edge one.
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "org-a", label: "A" }) });
      await store.create({ tenantId: T1, connection: connection({ id: "org-b", label: "B" }) });
      expect((await store.list({ tenantId: T1, provider: "github" })).map((c) => c.id)).toEqual(["org-a", "org-b"]);
    });

    it("narrows a listing by provider", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "gh" }) });
      await store.create({ tenantId: T1, connection: connection({ id: "sl", provider: "slack" }) });
      expect((await store.list({ tenantId: T1, provider: "slack" })).map((c) => c.id)).toEqual(["sl"]);
    });

    it("orders a listing stably, so a default connection does not move", async () => {
      // The resolver's default is "the oldest", which is only stable if the order is. Newest-first would
      // silently re-point every agent the moment somebody connects a second account.
      const store = await makeStore();
      for (const id of ["first", "second", "third"]) {
        await store.create({ tenantId: T1, connection: connection({ id }) });
      }
      const once = (await store.list({ tenantId: T1 })).map((c) => c.id);
      const twice = (await store.list({ tenantId: T1 })).map((c) => c.id);
      expect(once).toEqual(twice);
      expect(once[0]).toBe("first");
    });

    it("refuses to create the same id twice rather than overwriting", async () => {
      // Silently overwriting is the worst resolution of a duplicate: it replaces a working credential with
      // whatever the second caller had.
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      await expect(store.create({ tenantId: T1, connection: connection({ id: "c1" }) })).rejects.toThrow();
    });

    it("updates the secret, which is what a refresh does", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      const updated = await store.update({ tenantId: T1, id: "c1", patch: { sealed: sealed("rotated") } });
      expect(updated.sealed.ciphertext).toBe(sealed("rotated").ciphertext);
      expect((await store.get({ tenantId: T1, id: "c1" }))?.sealed.ciphertext).toBe(sealed("rotated").ciphertext);
    });

    it("leaves unpatched fields alone", async () => {
      // An absent field means "leave it", not "set it to null" — otherwise a label-only rename would wipe the
      // credential.
      const store = await makeStore();
      await store.create({
        tenantId: T1,
        connection: connection({ id: "c1", label: "before", metadata: { cloudId: "x" } }),
      });
      const updated = await store.update({ tenantId: T1, id: "c1", patch: { label: "after" } });
      expect(updated.label).toBe("after");
      expect(updated.metadata?.cloudId).toBe("x");
      expect(updated.sealed.ciphertext).toBe(sealed("c1").ciphertext);
    });

    it("refuses to update another tenant's connection", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      await expect(store.update({ tenantId: T2, id: "c1", patch: { label: "mine now" } })).rejects.toThrow();
    });

    it("makes a revoked connection unreadable, while keeping the row", async () => {
      // The audit trail survives — "who connected this and when was it removed" is a question a security review
      // asks — and the credential does not resolve.
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      await store.revoke({ tenantId: T1, id: "c1" });
      expect(await store.get({ tenantId: T1, id: "c1" })).toBeNull();
      expect(await store.list({ tenantId: T1 })).toEqual([]);
    });

    it("treats revoking twice as success", async () => {
      // A retried disconnect should not have to distinguish "already gone" from "failed".
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      await store.revoke({ tenantId: T1, id: "c1" });
      await expect(store.revoke({ tenantId: T1, id: "c1" })).resolves.toBeUndefined();
    });

    it("refuses to revoke another tenant's connection", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      await expect(store.revoke({ tenantId: T2, id: "c1" })).rejects.toThrow();
    });

    it("refuses to update a revoked connection", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "c1" }) });
      await store.revoke({ tenantId: T1, id: "c1" });
      await expect(store.update({ tenantId: T1, id: "c1", patch: { label: "back" } })).rejects.toThrow();
    });

    it("purges one tenant's connections and only that tenant's", async () => {
      // `docs/18`. A soft-deleted credential is still a credential, so deletion has to be real — and it has to
      // stop at the tenant boundary, or a retention job for one customer removes another's access.
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "a" }) });
      await store.create({ tenantId: T1, connection: connection({ id: "b" }) });
      await store.create({ tenantId: T2, connection: connection({ id: "c" }) });
      expect(await store.purge({ tenantId: T1 })).toBe(2);
      expect(await store.list({ tenantId: T1 })).toEqual([]);
      expect((await store.list({ tenantId: T2 })).map((x) => x.id)).toEqual(["c"]);
    });

    it("purges revoked connections too, since a retention promise covers them", async () => {
      const store = await makeStore();
      await store.create({ tenantId: T1, connection: connection({ id: "a" }) });
      await store.revoke({ tenantId: T1, id: "a" });
      expect(await store.purge({ tenantId: T1 })).toBe(1);
    });

    it("round-trips metadata and granted scopes without reshaping them", async () => {
      // Both are read on the request path — the cloud id goes into the URL, the scopes decide whether to tell
      // somebody to reconnect — so a store that dropped or reordered them would break the call, not the listing.
      const store = await makeStore();
      await store.create({
        tenantId: T1,
        connection: connection({
          id: "c1",
          metadata: { cloudId: "abc", username: "me@example.com" },
          grantedScopes: ["read:issues", "write:issues"],
        }),
      });
      const read = await store.get({ tenantId: T1, id: "c1" });
      expect(read?.metadata).toEqual({ cloudId: "abc", username: "me@example.com" });
      expect(read?.grantedScopes).toEqual(["read:issues", "write:issues"]);
    });
  });
}
