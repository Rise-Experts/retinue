/**
 * The secret is ciphertext in the database, and two tenants cannot see each other's — task #261, AC-3 and AC-5.
 *
 * AC-3 is the one that must not be waved through: it is the assertion a reviewer can check in ten seconds and
 * the one that silently regresses, because every other test in this area passes just as happily against a store
 * that wrote plaintext. So it reads the **raw rows** and asserts the plaintext appears in no column — not that
 * `secret_ciphertext` looks encrypted, which a base64 of the input would satisfy.
 *
 * Runs against PGlite by default, which is real Postgres and needs no server, so this is not a test somebody
 * has to opt into.
 */
import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { TenantId } from "../core/ids.js";
import { freshPgliteSchema } from "../testing/pglite.js";
import { createPostgresConnectionStore } from "../adapters/postgres/connections.js";
import { createAesGcmCipher, createConnectionCredentialResolver, resealConnections } from "../connections/index.js";
import type { SqlExecutor } from "../adapters/postgres/sql.js";

const SECRET = "sk-live-DO-NOT-STORE-ME";
const T1 = asId<TenantId>("at-rest-t1");
const T2 = asId<TenantId>("at-rest-t2");

const context = (tenantId: TenantId) => ({
  tenantId,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

const cipher = createAesGcmCipher({ keys: [{ id: "k1", key: Buffer.alloc(32, 7) }] });

/** A fresh, migrated schema per test, so one test's rows cannot make another's assertion pass. */
const open = async (): Promise<SqlExecutor> => (await freshPgliteSchema()).sql;

describe("at rest — AC-3", () => {
  it("stores ciphertext, and the plaintext appears in no column of the raw row", async () => {
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    await store.create({
      tenantId: T1,
      connection: {
        id: "c1",
        provider: "github",
        label: "Acme",
        mode: "token",
        scheme: "bearer",
        metadata: { org: "acme" },
        sealed: await cipher.seal(SECRET),
      },
    });

    // Every column, as text, concatenated — so a plaintext hiding in `label`, `metadata` or a column added
    // later is caught, not only one in the column we expect.
    const raw = await sql.query<Record<string, unknown>>(`SELECT * FROM connections WHERE tenant_id = $1`, [T1]);
    expect(raw).toHaveLength(1);
    const dumped = JSON.stringify(raw[0]);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain("sk-live");
    // The control: the row genuinely holds the sealed value, so the assertion above is about encryption rather
    // than about an empty table.
    expect(dumped).toContain("aes-256-gcm");
    expect(String(raw[0]?.["secret_ciphertext"]).length).toBeGreaterThan(0);
  });

  it("round-trips through the resolver, so the ciphertext is the real credential", async () => {
    // The other half of the control: unreadable-in-the-database is only interesting if it is still usable.
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    await store.create({
      tenantId: T1,
      connection: { id: "c1", provider: "github", mode: "token", scheme: "bearer", sealed: await cipher.seal(SECRET) },
    });
    const resolver = createConnectionCredentialResolver({ store, cipher });
    const credential = await resolver.resolve({ ref: "github", context: context(T1) });
    expect(credential.scheme === "bearer" && credential.token).toBe(SECRET);
  });

  it("keeps a basic credential's username readable and its password not", async () => {
    // The split is deliberate: a connection list should show *which account* a connection is for without
    // needing a key.
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    await store.create({
      tenantId: T1,
      connection: {
        id: "jira",
        provider: "jira",
        mode: "token",
        scheme: "basic",
        metadata: { username: "me@example.com" },
        sealed: await cipher.seal(SECRET),
      },
    });
    const raw = await sql.query<Record<string, unknown>>(`SELECT * FROM connections WHERE tenant_id = $1`, [T1]);
    const dumped = JSON.stringify(raw[0]);
    expect(dumped).toContain("me@example.com");
    expect(dumped).not.toContain(SECRET);

    const credential = await createConnectionCredentialResolver({ store, cipher }).resolve({
      ref: "jira",
      context: context(T1),
    });
    expect(credential.scheme === "basic" && credential.username).toBe("me@example.com");
    expect(credential.scheme === "basic" && credential.password).toBe(SECRET);
  });
});

describe("tenant isolation — AC-5", () => {
  it("does not resolve another tenant's connection, in the same process", async () => {
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    await store.create({
      tenantId: T1,
      connection: { id: "c1", provider: "github", mode: "token", scheme: "bearer", sealed: await cipher.seal(SECRET) },
    });
    const resolver = createConnectionCredentialResolver({ store, cipher });
    // T1 resolves...
    await expect(resolver.resolve({ ref: "github", context: context(T1) })).resolves.toBeDefined();
    // ...and T2, using the *same ref name*, gets nothing rather than T1's credential.
    await expect(resolver.resolve({ ref: "github", context: context(T2) })).rejects.toThrow(
      /no github connection for this workspace/,
    );
  });

  it("refuses a crafted reference to another tenant's connection id", async () => {
    // The sabotage: a caller who knows the id. Tenant scoping that only applies to listing is not scoping.
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    await store.create({
      tenantId: T1,
      connection: { id: "secret-conn", provider: "github", mode: "token", scheme: "bearer", sealed: await cipher.seal(SECRET) },
    });
    const resolver = createConnectionCredentialResolver({ store, cipher });
    await expect(
      resolver.resolve({ ref: "github:secret-conn", context: context(T2) }),
    ).rejects.toThrow(/no github connection/);
  });
});

describe("the resolver's own refusals", () => {
  it("reports an expired connection rather than sending it", async () => {
    // "Expired" is a message an operator can act on; the vendor's own answer is a 401 saying the token is
    // invalid, which sends them to rotate something that was never wrong.
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    await store.create({
      tenantId: T1,
      connection: {
        id: "c1",
        provider: "github",
        mode: "oauth2",
        scheme: "bearer",
        sealed: await cipher.seal(SECRET),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    await expect(
      createConnectionCredentialResolver({ store, cipher }).resolve({ ref: "github", context: context(T1) }),
    ).rejects.toThrow(/expired/);
  });

  it("does not resolve a revoked connection", async () => {
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    await store.create({
      tenantId: T1,
      connection: { id: "c1", provider: "github", mode: "token", scheme: "bearer", sealed: await cipher.seal(SECRET) },
    });
    await store.revoke({ tenantId: T1, id: "c1" });
    await expect(
      createConnectionCredentialResolver({ store, cipher }).resolve({ ref: "github", context: context(T1) }),
    ).rejects.toThrow(/no github connection/);
  });

  it("picks the oldest as the default, stably", async () => {
    // Newest-first would silently re-point every agent the moment somebody connects a second account.
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    for (const [id, secret] of [["first", "SECRET-FIRST"], ["second", "SECRET-SECOND"]] as const) {
      await store.create({
        tenantId: T1,
        connection: { id, provider: "github", mode: "token", scheme: "bearer", sealed: await cipher.seal(secret) },
      });
    }
    const credential = await createConnectionCredentialResolver({ store, cipher }).resolve({
      ref: "github",
      context: context(T1),
    });
    expect(credential.scheme === "bearer" && credential.token).toBe("SECRET-FIRST");
  });

  it("refuses a malformed reference rather than resolving something surprising", async () => {
    const sql = await open();
    const resolver = createConnectionCredentialResolver({ store: createPostgresConnectionStore(sql), cipher });
    await expect(resolver.resolve({ ref: "a:b:c", context: context(T1) })).rejects.toThrow(/not "<provider>"/);
  });
});

describe("key rotation is an operation, not a theory — AC-7", () => {
  const oldKey = { id: "k1", key: Buffer.alloc(32, 7) };
  const newKey = { id: "k2", key: Buffer.alloc(32, 8) };

  it("re-seals under the new key and leaves the plaintext unchanged", async () => {
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    const before = createAesGcmCipher({ keys: [oldKey] });
    for (const id of ["a", "b"]) {
      await store.create({
        tenantId: T1,
        connection: { id, provider: "github", mode: "token", scheme: "bearer", sealed: await before.seal(`${SECRET}-${id}`) },
      });
    }

    // Both keys configured, the new one current — which is exactly the deployment state during a rotation.
    const during = createAesGcmCipher({ keys: [oldKey, newKey], currentKeyId: "k2" });
    const result = await resealConnections({ store, cipher: during, tenantId: T1 });
    expect(result).toEqual({ resealed: 2, skipped: 0 });

    const after = createAesGcmCipher({ keys: [newKey], currentKeyId: "k2" });
    const resolver = createConnectionCredentialResolver({ store, cipher: after });
    const credential = await resolver.resolve({ ref: "github:a", context: context(T1) });
    // The old key is gone from this process, and the credential still resolves — which is the whole point.
    expect(credential.scheme === "bearer" && credential.token).toBe(`${SECRET}-a`);
  });

  it("is a no-op the second time, so an interrupted rotation can simply be re-run", async () => {
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    const before = createAesGcmCipher({ keys: [oldKey] });
    await store.create({
      tenantId: T1,
      connection: { id: "a", provider: "github", mode: "token", scheme: "bearer", sealed: await before.seal(SECRET) },
    });
    const during = createAesGcmCipher({ keys: [oldKey, newKey], currentKeyId: "k2" });
    expect(await resealConnections({ store, cipher: during, tenantId: T1 })).toEqual({ resealed: 1, skipped: 0 });
    expect(await resealConnections({ store, cipher: during, tenantId: T1 })).toEqual({ resealed: 0, skipped: 1 });
  });

  it("stops at the tenant boundary", async () => {
    // A rotation job run per tenant must not touch another's rows, or a partial rotation becomes a partial
    // outage for a customer nobody was working on.
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    const before = createAesGcmCipher({ keys: [oldKey] });
    for (const [tenantId, id] of [[T1, "mine"], [T2, "theirs"]] as const) {
      await store.create({
        tenantId,
        connection: { id, provider: "github", mode: "token", scheme: "bearer", sealed: await before.seal(SECRET) },
      });
    }
    const during = createAesGcmCipher({ keys: [oldKey, newKey], currentKeyId: "k2" });
    await resealConnections({ store, cipher: during, tenantId: T1 });
    expect((await store.get({ tenantId: T1, id: "mine" }))?.sealed.keyId).toBe("k2");
    expect((await store.get({ tenantId: T2, id: "theirs" }))?.sealed.keyId).toBe("k1");
  });
});

describe("errors do not carry the secret — AC-9", () => {
  it("keeps plaintext and ciphertext out of a failed resolution's message", async () => {
    const sql = await open();
    const store = createPostgresConnectionStore(sql);
    const sealed = await cipher.seal(SECRET);
    await store.create({
      tenantId: T1,
      connection: { id: "c1", provider: "github", mode: "token", scheme: "bearer", sealed },
    });
    // A cipher without the key that sealed it: the realistic failure after a key was retired too early.
    const wrong = createAesGcmCipher({ keys: [{ id: "k9", key: Buffer.alloc(32, 9) }] });
    try {
      await createConnectionCredentialResolver({ store, cipher: wrong }).resolve({ ref: "github", context: context(T1) });
      throw new Error("expected a refusal");
    } catch (thrown) {
      const serialised = JSON.stringify({ message: (thrown as Error).message, error: thrown });
      expect(serialised).not.toContain(SECRET);
      expect(serialised).not.toContain(sealed.ciphertext);
      // It still says which key is missing, because the remedy is to put that one back.
      expect((thrown as Error).message).toContain("k1");
    }
  });
});
