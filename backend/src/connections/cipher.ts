/**
 * `SecretCipher` — encryption at rest for third-party credentials, REQ-063 (#259), task #261.
 *
 * `docs/21`'s Connections section sets the requirement, and it is precise enough to decide the design:
 *
 * > encryption at rest with **a key the application database cannot decrypt on its own**
 *
 * That sentence rules out the two obvious implementations.
 *
 * ## Why not `pgcrypto`
 *
 * `pgp_sym_encrypt(data, key)` needs the key passed into each query. A key stored in the same database as the
 * ciphertext satisfies nothing — it protects against a stolen backup and nothing else, and the sentence above
 * rules it out by name. A key passed as a SQL literal is worse: it can land in `pg_stat_statements`, in the
 * server log and in a slow-query log, which are three places nobody thinks of as credential stores.
 *
 * `pgsodium` and its transparent column encryption are deprecated; do not build on them.
 *
 * ## Why not Supabase Vault alone
 *
 * Supabase Vault is genuinely good — libsodium, and a root key held outside the database, so it satisfies the
 * requirement. It is also available only on Supabase. Building on it would leave the Postgres and in-memory
 * adapters storing plaintext, so the conformance suite would be asserting *different guarantees per adapter* —
 * which is the one thing a conformance suite must never do.
 *
 * ## So: encrypt in the application, behind a seam
 *
 * The store holds an opaque ciphertext blob and knows nothing about how it was produced. Every adapter family
 * gets the identical property, no key passes through SQL, and Vault becomes one *implementation* of this seam
 * rather than the foundation — a choice a deployment makes, not a dependency it inherits.
 *
 * The honest trade-off, which belongs in the docs rather than in a footnote: app-side encryption means the
 * application process holds the key in memory. Vault means the database performs the decryption and therefore
 * sees plaintext. Neither is strictly better, and a deployment should pick knowing that.
 *
 * **The Vault implementation is not shipped**, and that is deliberate rather than forgotten: there is no
 * Supabase project with Vault available to test it against, and an untested crypto implementation behind a seam
 * that *looks* tested is worse than none — the suite would pass against this implementation, and the first
 * person to select the other would be the first to run it. Tracked by #268; the seam is ready and it is purely
 * additive.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { AgentPlatformError } from "../core/errors.js";

/**
 * A stored secret: ciphertext plus what is needed to read it back.
 *
 * `keyId` is the reason rotation is possible at all — see `createAesGcmCipher`. Everything here is safe to
 * store beside the ciphertext; none of it is secret on its own.
 */
export type SealedSecret = {
  /** Which key sealed this. A design with no key identity has a first key that is permanent. */
  readonly keyId: string;
  /** Algorithm, so a future one can be added without guessing what old rows used. */
  readonly algorithm: string;
  /** Base64. */
  readonly nonce: string;
  /** Base64, including the authentication tag. */
  readonly ciphertext: string;
};

export interface SecretCipher {
  seal(plaintext: string): Promise<SealedSecret>;
  open(sealed: SealedSecret): Promise<string>;
  /** The key new secrets are sealed with. Exposed so a rotation job can tell what still needs re-sealing. */
  currentKeyId(): string;
}

export const AES_GCM = "aes-256-gcm" as const;

/** 96 bits, which is what GCM is specified for; a different length changes the security argument. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type AesKey = {
  readonly id: string;
  /** 32 bytes. A shorter key is a configuration error, not a weaker mode. */
  readonly key: Buffer;
};

/**
 * AES-256-GCM, with a key set rather than a key.
 *
 * **Rotation is why this takes a list.** A design with one key has a first key that is permanent: re-encrypting
 * every stored secret requires reading them, which requires the old key, which the process no longer has. So
 * every sealed secret records its `keyId`, `open` looks the key up, and rotation is: add a new key, make it
 * current, re-seal in the background, retire the old one. A deployment that never rotates passes one key and
 * notices nothing.
 *
 * **Authenticated encryption, and the authentication is the point.** GCM's tag means a tampered ciphertext
 * *fails* rather than decrypting to something else. Without it, a byte flipped in a database row would produce
 * garbage that gets sent to a vendor as a token — a failure that looks like an expired credential and is not.
 */
export const createAesGcmCipher = (input: {
  readonly keys: readonly AesKey[];
  readonly currentKeyId?: string;
  readonly randomNonce?: () => Buffer;
}): SecretCipher => {
  if (input.keys.length === 0) throw new Error("SecretCipher needs at least one key");
  for (const { id, key } of input.keys) {
    if (key.length !== 32)
      throw new Error(`SecretCipher key "${id}" is ${key.length} bytes; AES-256 needs 32`);
  }
  const byId = new Map(input.keys.map((k) => [k.id, k.key]));
  const currentId = input.currentKeyId ?? input.keys[0]!.id;
  if (!byId.has(currentId)) throw new Error(`SecretCipher currentKeyId "${currentId}" is not among the keys`);
  const nonceOf = input.randomNonce ?? (() => randomBytes(NONCE_BYTES));

  return {
    currentKeyId: () => currentId,
    async seal(plaintext) {
      const nonce = nonceOf();
      if (nonce.length !== NONCE_BYTES) throw new Error(`GCM nonce must be ${NONCE_BYTES} bytes`);
      const cipher = createCipheriv(AES_GCM, byId.get(currentId)!, nonce);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      // Tag appended rather than stored separately: one field cannot be reunited with the wrong other field.
      return {
        keyId: currentId,
        algorithm: AES_GCM,
        nonce: nonce.toString("base64"),
        ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
      };
    },
    async open(sealed) {
      if (sealed.algorithm !== AES_GCM)
        throw new AgentPlatformError({
          code: "capability_unavailable",
          message: `sealed with ${sealed.algorithm}, which this cipher cannot open`,
          retryable: false,
        });
      const key = byId.get(sealed.keyId);
      if (key === undefined)
        throw new AgentPlatformError({
          code: "capability_unavailable",
          // Named, because the remedy is specific: the key was retired before everything sealed with it was
          // re-sealed, and a rotation job needs to know which one to put back.
          message:
            `no key "${sealed.keyId}" is configured, so this secret cannot be opened. It was sealed with a key ` +
            "this process does not have — retire a key only after re-sealing everything that used it.",
          retryable: false,
        });
      const raw = Buffer.from(sealed.ciphertext, "base64");
      if (raw.length < TAG_BYTES)
        throw new AgentPlatformError({ code: "invalid_input", message: "ciphertext is too short to carry a tag", retryable: false });
      const decipher = createDecipheriv(AES_GCM, key, Buffer.from(sealed.nonce, "base64"));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      try {
        return Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        /**
         * A tampered or corrupt secret **fails**, and this is the branch that matters.
         *
         * Without authentication a flipped byte decrypts to garbage, and garbage gets sent to a vendor as a
         * token — which looks like an expired credential and sends an operator to rotate something that was
         * never wrong. The message says what happened rather than what it looks like.
         */
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            "this secret failed authentication: it was modified after being sealed, or was sealed with a " +
            "different key. It is deliberately not returned — an unauthenticated decryption yields bytes that " +
            "would be sent to a vendor as a credential.",
          retryable: false,
        });
      }
    },
  };
};

/** Constant-time comparison, for callers checking a sealed secret against another without leaking timing. */
export const sealedEquals = (a: SealedSecret, b: SealedSecret): boolean => {
  if (a.keyId !== b.keyId || a.algorithm !== b.algorithm || a.nonce !== b.nonce) return false;
  const left = Buffer.from(a.ciphertext, "base64");
  const right = Buffer.from(b.ciphertext, "base64");
  return left.length === right.length && timingSafeEqual(left, right);
};
