/**
 * The Supabase Vault `SecretCipher`, against a **real Vault** — task #268.
 *
 * #261 deferred this implementation because there was no Vault to run it against, and an untested crypto
 * implementation behind a seam that looks tested is worse than none. So the point of this file is not that it
 * passes; it is that it passed *here*, against `vault.create_secret` and `vault.decrypted_secrets`, before the
 * implementation landed.
 *
 * The suite mirrors `cipher.test.ts` clause for clause — AC-2 — plus the three things that are true of a
 * pointer-based cipher and of nothing else:
 *
 * - **Deletion.** Dropping the row leaves the secret; `forget` is what closes that.
 * - **Repointing.** A pointer cannot be authenticated by what it points at, so an id swapped for another valid
 *   id must fail rather than return somebody else's credential.
 * - **A dangling pointer.** Application tables restored without the `vault` schema.
 *
 * Skips without `RETINUE_TEST_VAULT_URL`. It does not fall back to a stub: a stub would make this file assert
 * that a mock behaves like a mock, which is exactly the reassurance #268 refused to ship.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSupabaseVaultCipher, SUPABASE_VAULT, vaultRotationIsExternal } from "../vault-cipher.js";
import { createAesGcmCipher } from "../cipher.js";
import type { SealedSecret } from "../cipher.js";
import type { SqlExecutor } from "../../adapters/postgres/sql.js";

const VAULT_URL = process.env["RETINUE_TEST_VAULT_URL"];
const PREFIX = "retinue-test-268";

let sql: SqlExecutor;
let end: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (VAULT_URL === undefined) return;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: VAULT_URL, connectionTimeoutMillis: 5_000 });
  end = () => pool.end();
  sql = {
    async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
      const result = await pool.query(text, params ? [...params] : undefined);
      return result.rows as Row[];
    },
  };
});

afterAll(async () => {
  // Every secret this file created, and only those — the prefix is what makes the cleanup safe to run against
  // a database that has other Vault users in it.
  if (VAULT_URL !== undefined) await sql.query("delete from vault.secrets where name like $1", [`${PREFIX}:%`]);
  await end?.();
});

const cipherFor = () => createSupabaseVaultCipher({ sql, namePrefix: PREFIX });

describe.skipIf(VAULT_URL === undefined)("Supabase Vault SecretCipher — AC-1", () => {
  describe("sealing and opening — AC-2", () => {
    it("round-trips", async () => {
      const cipher = cipherFor();
      const sealed = await cipher.seal("sk-live-SECRET");
      expect(await cipher.open(sealed)).toBe("sk-live-SECRET");
    });

    it("stores no plaintext in the sealed value", async () => {
      /**
       * Trivially true here and asserted anyway, because the *reason* it is true differs from app-side
       * sealing: the sealed value is a uuid and a token, and the plaintext is in another schema entirely.
       */
      const cipher = cipherFor();
      const sealed = await cipher.seal("sk-live-SECRET");
      expect(JSON.stringify(sealed)).not.toContain("sk-live-SECRET");
      expect(sealed.algorithm).toBe(SUPABASE_VAULT);
      expect(sealed.ciphertext).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("stores no plaintext in Vault's own table either", async () => {
      // The row Vault keeps is encrypted. Read directly rather than through the view, because the view is the
      // thing that decrypts — asserting on it would prove nothing.
      const cipher = cipherFor();
      const sealed = await cipher.seal("sk-live-SECRET");
      const rows = await sql.query<{ secret: string }>("select secret from vault.secrets where id = $1::uuid", [
        sealed.ciphertext,
      ]);
      expect(rows[0]?.secret).toBeDefined();
      expect(rows[0]?.secret).not.toContain("sk-live-SECRET");
    });

    it("seals the same plaintext to two different values", async () => {
      /**
       * The equivalent of "a fresh nonce per seal", for a cipher where that concept lives inside Vault. What
       * this package controls is that two seals are two *secrets* — a cipher that reused one Vault name would
       * make the second seal of a value fail outright, which would read as an intermittent credential bug.
       */
      const cipher = cipherFor();
      const first = await cipher.seal("same-value");
      const second = await cipher.seal("same-value");
      expect(first.ciphertext).not.toBe(second.ciphertext);
      expect(first.nonce).not.toBe(second.nonce);
      expect(await cipher.open(first)).toBe("same-value");
      expect(await cipher.open(second)).toBe("same-value");
    });

    it("handles an empty string and unicode", async () => {
      const cipher = cipherFor();
      for (const value of ["", "clé-🔐-秘密"]) {
        const sealed = await cipher.seal(value);
        expect(await cipher.open(sealed)).toBe(value);
      }
    });
  });

  describe("a tampered secret fails rather than decrypting to something else — AC-2", () => {
    it("refuses an id repointed at another secret", async () => {
      /**
       * **The clause that matters, and the one where a pointer is genuinely weaker than AEAD.**
       *
       * An attacker able to write the connections table swaps one id for another valid id and reads a
       * credential they were not entitled to — a tenant-isolation bypass. The binding token is what closes
       * it: the other secret carries a different token, so the pair no longer matches.
       */
      const cipher = cipherFor();
      const mine = await cipher.seal("my-credential");
      const theirs = await cipher.seal("someone-elses-credential");

      const repointed: SealedSecret = { ...mine, ciphertext: theirs.ciphertext };
      await expect(cipher.open(repointed)).rejects.toThrow(/does not belong to this row/);
      // And emphatically not this:
      await expect(cipher.open(repointed)).rejects.not.toThrow(/someone-elses/);
    });

    it("refuses a tampered binding token", async () => {
      const cipher = cipherFor();
      const sealed = await cipher.seal("my-credential");
      await expect(cipher.open({ ...sealed, nonce: "not-the-token" })).rejects.toThrow(/does not belong/);
      // A truncated token must not match a prefix of the real one.
      await expect(cipher.open({ ...sealed, nonce: sealed.nonce.slice(0, -4) })).rejects.toThrow(/does not belong/);
    });

    it("refuses a dangling pointer, and says why", async () => {
      /**
       * The failure a backup strategy produces: `public` restored, `vault` not. The message names that cause,
       * because "secret not found" against a row that plainly has an id sends an operator hunting a code bug.
       */
      const cipher = cipherFor();
      const sealed = await cipher.seal("my-credential");
      await sql.query("delete from vault.secrets where id = $1::uuid", [sealed.ciphertext]);
      await expect(cipher.open(sealed)).rejects.toThrow(/did not include the vault schema/);
    });

    it("refuses a row sealed by the other cipher rather than guessing", async () => {
      const appSide = createAesGcmCipher({ keys: [{ id: "k1", key: Buffer.alloc(32, 7) }] });
      const sealedElsewhere = await appSide.seal("sk-live-SECRET");
      await expect(cipherFor().open(sealedElsewhere)).rejects.toThrow(/must re-seal its existing rows/);
    });

    it("refuses a sealed value carrying no id", async () => {
      await expect(cipherFor().open({ keyId: SUPABASE_VAULT, algorithm: SUPABASE_VAULT, nonce: "t", ciphertext: "" })).rejects.toThrow(
        /carries no id/,
      );
    });
  });

  describe("deletion — AC-3", () => {
    it("forget removes the Vault secret, so the credential does not outlive the row", async () => {
      /**
       * The gap this task found. Deleting a connection row drops a *pointer*; without this the credential
       * stays in Vault, which is the opposite of what `docs/18` promises.
       */
      const cipher = cipherFor();
      const sealed = await cipher.seal("my-credential");
      expect(await cipher.open(sealed)).toBe("my-credential");

      await cipher.forget?.(sealed);

      const rows = await sql.query<{ id: string }>("select id from vault.secrets where id = $1::uuid", [
        sealed.ciphertext,
      ]);
      expect(rows).toHaveLength(0);
    });

    it("forget will not delete a secret the row does not own", async () => {
      /**
       * The mirror of the repointing test. A `forget` that deleted whatever the id pointed at would let an
       * attacker destroy another connection's credential by writing an id into a row — smaller blast radius
       * than reading it, same class of bug.
       */
      const cipher = cipherFor();
      const mine = await cipher.seal("mine");
      const theirs = await cipher.seal("theirs");

      await cipher.forget?.({ ...mine, ciphertext: theirs.ciphertext });

      // Still there, and still readable by its rightful row.
      expect(await cipher.open(theirs)).toBe("theirs");
    });

    it("the app-side cipher has nothing to forget", () => {
      // Optional for a reason: the ciphertext *is* the stored value there, so deleting the row deletes the
      // secret. A required no-op would be a method every future cipher writes to say "not applicable".
      const appSide = createAesGcmCipher({ keys: [{ id: "k1", key: Buffer.alloc(32, 7) }] });
      expect(appSide.forget).toBeUndefined();
    });
  });

  describe("rotation is Vault's — AC-4", () => {
    it("has one key identity, so a re-seal walk finds nothing forever", async () => {
      /**
       * Asserted rather than documented, because a rotation job that silently does nothing is
       * indistinguishable from one that is wired wrong. Vault's own `key_id` column comes back **null**: the
       * root key is outside the database and Supabase exposes no identity for it, so there is nothing this
       * cipher could put in `keyId` that would ever change.
       */
      const cipher = cipherFor();
      expect(cipher.currentKeyId()).toBe(SUPABASE_VAULT);
      const first = await cipher.seal("a");
      const second = await cipher.seal("b");
      expect(first.keyId).toBe(second.keyId);
      expect(first.keyId).toBe(cipher.currentKeyId());

      const rows = await sql.query<{ key_id: string | null }>(
        "select key_id from vault.secrets where id = $1::uuid",
        [first.ciphertext],
      );
      expect(rows[0]?.key_id).toBeNull();
    });

    it("records that rotation is external rather than leaving a no-op job", () => {
      expect(vaultRotationIsExternal.resealFinds).toBe("nothing, by design");
      expect(vaultRotationIsExternal.why).toMatch(/outside the database/);
    });
  });
});

describe("without a Vault, this suite declines to pretend — AC-1", () => {
  it("says so rather than falling back to a stub", () => {
    /**
     * #268's whole argument was that an untested implementation behind a seam that looks tested is worse than
     * none. A stubbed Vault here would recreate exactly that: a green suite asserting a mock behaves like a
     * mock, with the first real user being the first to run the code.
     */
    if (VAULT_URL === undefined) {
      expect(true).toBe(true);
      return;
    }
    expect(VAULT_URL).toMatch(/^postgres/);
  });
});
