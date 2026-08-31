/**
 * A `SecretCipher` over Supabase Vault — REQ-063 (#259), task #268.
 *
 * #261 shipped the seam with an app-side AES-256-GCM implementation and deliberately left this one out: there
 * was no Vault to run it against, and an untested crypto implementation behind a seam that *looks* tested is
 * worse than none. There is one now, and everything below has been run against it.
 *
 * ## The mapping, and the property it changes — AC-3
 *
 * Vault owns the ciphertext and hands back an **id**. The seam expects the caller to hold
 * `{ keyId, algorithm, nonce, ciphertext }`. So:
 *
 * | Field | Holds |
 * |---|---|
 * | `algorithm` | `supabase-vault` — a sentinel, not a cipher name. The algorithm is Vault's business. |
 * | `keyId` | `supabase-vault` — see the rotation note. Vault's own `key_id` column comes back **null**: the root key is held outside the database and Supabase does not expose an identity for it. |
 * | `nonce` | A random **binding token**, not a nonce. See the tamper note. |
 * | `ciphertext` | The Vault secret's **uuid**. Not ciphertext. |
 *
 * **A Vault-sealed row contains no secret material at all.** That is the property worth stating rather than
 * discovering, and it cuts both ways:
 *
 * - A backup of the application's own tables carries no credentials — strictly better than app-side sealing,
 *   where the backup carries ciphertext that a leaked key would open.
 * - The secret lives in `vault.secrets`, so **restoring the application tables without the `vault` schema
 *   leaves every connection pointing at nothing.** With app-side sealing the ciphertext travels with the row;
 *   here it does not, and a backup strategy that covers `public` and not `vault` silently loses every
 *   credential. That is a deployment fact, not a code one, and it belongs in a runbook.
 *
 * ## Deletion — AC-3, and a gap this found
 *
 * Deleting a connection row does **not** delete the Vault secret: the row held a pointer, and dropping a
 * pointer leaves what it pointed at. `docs/18`'s deletion promises are therefore *not* satisfied by deleting
 * the row alone, which is a difference from app-side sealing that nobody would notice until an audit.
 *
 * So `SecretCipher` gained an optional `forget`. App-side sealing has nothing to implement — the ciphertext
 * dies with the row — and this implementation removes the Vault secret. A deployment on Vault that never calls
 * it accumulates orphaned secrets that outlive the connections they belonged to.
 *
 * ## Tampering — AC-2, and where the guarantee genuinely differs
 *
 * AES-GCM authenticates: a flipped byte fails rather than decrypting to something else. A pointer cannot be
 * authenticated by the thing it points at, so an attacker able to *write* the connections table could repoint
 * one connection at another secret in the same Vault and read a credential they were not entitled to. That is
 * a real weakening and it is not hypothetical — it is exactly the shape of a tenant-isolation bypass.
 *
 * Closed here with a **binding token**: `seal` stores a fresh 32-byte random value in the Vault secret's
 * `description` and keeps it in the sealed value's `nonce` field; `open` compares them in constant time and
 * refuses on mismatch. Repointing at another secret now fails, because that secret carries a different token.
 * No application-side key is involved, so the "database cannot decrypt on its own" property is untouched.
 *
 * It is not equivalent to AEAD. An attacker who can write *both* the connections table and `vault.secrets`
 * defeats it, where GCM would still fail. Stated rather than implied.
 */

import { timingSafeEqual } from "node:crypto";
import { randomBytes } from "node:crypto";

import { AgentPlatformError } from "../core/errors.js";
import type { SealedSecret, SecretCipher } from "./cipher.js";
import type { SqlExecutor } from "../adapters/postgres/sql.js";

/**
 * The sentinel in `algorithm`, and the reason it is not a cipher name.
 *
 * A reader of a stored row needs to know *which implementation* sealed it, not which primitive. `aes-256-gcm`
 * tells the app-side cipher how to open the value; `supabase-vault` tells this one that the value is a pointer.
 * Putting libsodium's actual construction here would be a claim about Vault's internals that could stop being
 * true without this package noticing.
 */
export const SUPABASE_VAULT = "supabase-vault" as const;

/** 32 bytes of binding token. Long enough that guessing it is not a strategy. */
const TOKEN_BYTES = 32;

export type VaultCipherOptions = {
  /**
   * Runs the `vault.*` calls. A **service-role** executor: `vault.decrypted_secrets` is not readable by
   * `anon` or `authenticated`, which is most of what makes Vault worth using.
   */
  readonly sql: SqlExecutor;
  /**
   * Prefix for the Vault secret's `name`.
   *
   * Named at all because `vault.secrets.name` is unique and a deployment sharing a database with anything else
   * that writes to Vault would otherwise collide. The name carries no secret and is not used for integrity —
   * that is the token's job.
   */
  readonly namePrefix?: string;
  /** Injectable so a test can assert the token is fresh per seal rather than trusting that it is. */
  readonly randomToken?: () => string;
};

const failed = (message: string, code: "invalid_input" | "internal" = "invalid_input"): never => {
  throw new AgentPlatformError({ code, message, retryable: false });
};

/** Constant-time compare that does not leak *which* byte differed, and tolerates unequal lengths. */
const tokensMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself be a length oracle. Compared against a
  // padded copy so the answer is false rather than an exception.
  if (left.length !== right.length) {
    const padded = Buffer.alloc(Math.max(left.length, right.length));
    const other = Buffer.alloc(padded.length);
    left.copy(padded);
    right.copy(other);
    timingSafeEqual(padded, other);
    return false;
  }
  return timingSafeEqual(left, right);
};

export const createSupabaseVaultCipher = (options: VaultCipherOptions): SecretCipher => {
  const prefix = options.namePrefix ?? "retinue";
  const newToken = options.randomToken ?? (() => randomBytes(TOKEN_BYTES).toString("base64"));

  return {
    /**
     * `keyId` is a constant, and that is Vault's answer to rotation — AC-4.
     *
     * `resealConnections` walks `sealed.keyId` looking for rows sealed under a retired key. Under Vault that
     * loop finds **nothing, forever**, because there is one key identity and it never changes.
     *
     * That is correct rather than broken, and the distinction matters: Supabase rotates the Vault root key
     * outside the database, and re-sealing through this cipher would mean decrypting and re-encrypting with
     * the *same* key — work that changes nothing. But a rotation job that silently does nothing looks
     * identical to a rotation job that is wired wrong, so a deployment on Vault should not run one and expect
     * output. `vaultRotationIsExternal` exists to be asserted in a test rather than remembered.
     */
    currentKeyId() {
      return SUPABASE_VAULT;
    },

    async seal(plaintext: string): Promise<SealedSecret> {
      const token = newToken();
      /**
       * The name is unique per secret, so two seals of the same plaintext are two Vault rows.
       *
       * Vault's `create_secret` raises on a duplicate name, and a cipher that reused one would make the
       * second seal of a value fail — which would look like an intermittent credential bug.
       */
      const name = `${prefix}:${randomBytes(16).toString("hex")}`;
      const rows = await options.sql.query<{ id: string }>(
        "select vault.create_secret($1, $2, $3) as id",
        [plaintext, name, token],
      );
      const id = rows[0]?.id;
      if (typeof id !== "string" || id === "") {
        return failed("Supabase Vault did not return an id for the secret it was asked to store.", "internal");
      }
      return {
        keyId: SUPABASE_VAULT,
        algorithm: SUPABASE_VAULT,
        // The binding token, not a nonce — see the header. Kept in this field so the shape of a stored row is
        // unchanged and no migration is needed to select this implementation.
        nonce: token,
        // The pointer. **Not ciphertext**; see the backup note in the header.
        ciphertext: id,
      };
    },

    async open(sealed: SealedSecret): Promise<string> {
      if (sealed.algorithm !== SUPABASE_VAULT) {
        // Refused rather than guessed: a row sealed by the app-side cipher must not be handed to this one, and
        // the mistake is a misconfiguration worth naming rather than a decryption failure to debug.
        return failed(
          `This secret was sealed with "${sealed.algorithm}", not ${SUPABASE_VAULT}. A deployment that has ` +
            "switched ciphers must re-seal its existing rows; opening one with the wrong implementation " +
            "cannot work and is not attempted.",
        );
      }
      if (sealed.ciphertext === "") return failed("This Vault-sealed secret carries no id.");

      const rows = await options.sql.query<{ decrypted_secret: string | null; description: string | null }>(
        "select decrypted_secret, description from vault.decrypted_secrets where id = $1::uuid",
        [sealed.ciphertext],
      );
      const row = rows[0];
      if (row === undefined) {
        /**
         * A pointer with nothing behind it.
         *
         * The likeliest cause is the one named in the header: application tables restored without the `vault`
         * schema. Said explicitly, because "secret not found" against a row that plainly has an id sends an
         * operator looking for a code bug.
         */
        return failed(
          `Supabase Vault has no secret ${sealed.ciphertext}. Either it was deleted, or these rows were ` +
            "restored from a backup that did not include the vault schema — a Vault-sealed row holds a " +
            "pointer, not the ciphertext.",
        );
      }

      /**
       * The binding check — AC-2.
       *
       * Without it, an attacker who can write the connections table repoints a row at another secret in the
       * same Vault and reads a credential they were not entitled to. A pointer cannot be authenticated by
       * what it points at, so the token is what makes the pair inseparable.
       */
      if (!tokensMatch(sealed.nonce, row.description ?? "")) {
        return failed(
          "This Vault secret does not belong to this row. The binding token does not match, which means the " +
            "stored id was changed — refused rather than returning a credential from somewhere else.",
        );
      }

      const plaintext = row.decrypted_secret;
      if (plaintext === null) {
        return failed("Supabase Vault returned no plaintext for this secret.", "internal");
      }
      return plaintext;
    },

    /**
     * Removes the Vault secret — the deletion half of AC-3.
     *
     * Deleting a connection row drops a pointer and leaves the secret. A deployment on Vault that never calls
     * this accumulates credentials that outlive the connections they belonged to, which is the opposite of
     * what `docs/18` promises.
     */
    async forget(sealed: SealedSecret): Promise<void> {
      if (sealed.algorithm !== SUPABASE_VAULT || sealed.ciphertext === "") return;
      /**
       * Guarded by the binding token, like `open`.
       *
       * A `forget` that deleted whatever the id pointed at would be a way to destroy *another* connection's
       * credential by writing an id into a row — a smaller blast radius than reading it, and the same class of
       * bug. The delete is scoped to a row whose description matches.
       */
      await options.sql.query(
        "delete from vault.secrets where id = $1::uuid and description = $2",
        [sealed.ciphertext, sealed.nonce],
      );
    },
  };
};

/**
 * Rotation is Vault's, not ours — AC-4, stated as a value so a test can assert it.
 *
 * `resealConnections` walks `sealed.keyId`; this cipher's is constant, so that walk finds nothing forever.
 * Correct, and indistinguishable from a misconfigured rotation job unless somebody wrote it down.
 */
export const vaultRotationIsExternal = {
  cipher: SUPABASE_VAULT,
  resealFinds: "nothing, by design",
  why:
    "Supabase rotates the Vault root key outside the database. Re-sealing through this cipher would decrypt " +
    "and re-encrypt under the same key identity, which changes nothing. A deployment on Vault should not run " +
    "a re-seal job and expect it to report work.",
} as const;
