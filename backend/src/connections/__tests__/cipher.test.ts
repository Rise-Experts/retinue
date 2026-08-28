/**
 * `SecretCipher` — REQ-063 (#259), task #261, AC-2 and AC-4.
 *
 * `docs/21` requires "encryption at rest with a key the application database cannot decrypt on its own", which
 * is what rules out `pgcrypto` keyed from a column and what makes Vault one implementation rather than the
 * foundation. See `cipher.ts` for the full argument.
 *
 * The clause that earns the most here is authentication. Without it a flipped byte in a database row decrypts
 * to garbage, and garbage gets sent to a vendor as a token — a failure that looks like an expired credential
 * and sends an operator to rotate something that was never wrong.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { AES_GCM, createAesGcmCipher, sealedEquals } from "../cipher.js";

const key = (id: string, byte: number) => ({ id, key: Buffer.alloc(32, byte) });

describe("sealing and opening", () => {
  it("round-trips", async () => {
    const cipher = createAesGcmCipher({ keys: [key("k1", 1)] });
    const sealed = await cipher.seal("sk-live-SECRET");
    expect(await cipher.open(sealed)).toBe("sk-live-SECRET");
  });

  it("produces ciphertext that does not contain the plaintext", async () => {
    // The whole point, and worth asserting rather than assuming: a "cipher" that base64'd the input would pass
    // a round-trip test perfectly.
    const cipher = createAesGcmCipher({ keys: [key("k1", 1)] });
    const sealed = await cipher.seal("sk-live-SECRET");
    expect(JSON.stringify(sealed)).not.toContain("sk-live-SECRET");
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain("sk-live");
  });

  it("uses a fresh nonce per seal, so the same plaintext seals differently", async () => {
    // Reusing a nonce under one key breaks GCM outright, and identical ciphertexts would also tell an observer
    // with database access which tenants share a credential.
    const cipher = createAesGcmCipher({ keys: [key("k1", 1)] });
    const a = await cipher.seal("same");
    const b = await cipher.seal("same");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await cipher.open(b)).toBe("same");
  });

  it("handles an empty string and unicode", async () => {
    const cipher = createAesGcmCipher({ keys: [key("k1", 1)] });
    for (const value of ["", "🔐 clé — ключ", "a".repeat(10_000)]) {
      expect(await cipher.open(await cipher.seal(value))).toBe(value);
    }
  });
});

describe("a tampered secret fails rather than decrypting to something else — AC-4", () => {
  const cipher = createAesGcmCipher({ keys: [key("k1", 1)] });

  it("rejects a flipped ciphertext byte", async () => {
    const sealed = await cipher.seal("sk-live-SECRET");
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[0] ^= 0xff;
    await expect(cipher.open({ ...sealed, ciphertext: raw.toString("base64") })).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects a flipped authentication tag", async () => {
    const sealed = await cipher.seal("sk-live-SECRET");
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff;
    await expect(cipher.open({ ...sealed, ciphertext: raw.toString("base64") })).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects a swapped nonce", async () => {
    // The realistic corruption: two rows' columns crossed by a bad migration or a botched restore.
    const a = await cipher.seal("first");
    const b = await cipher.seal("second");
    await expect(cipher.open({ ...a, nonce: b.nonce })).rejects.toThrow(/failed authentication/);
  });

  it("rejects a ciphertext too short to carry a tag", async () => {
    const sealed = await cipher.seal("x");
    await expect(cipher.open({ ...sealed, ciphertext: "AAAA" })).rejects.toThrow(/too short/);
  });

  it("rejects an algorithm it does not implement, rather than guessing", async () => {
    const sealed = await cipher.seal("x");
    await expect(cipher.open({ ...sealed, algorithm: "rot13" })).rejects.toThrow(/cannot open/);
  });
});

describe("rotation — AC-7", () => {
  it("seals with the current key and opens with whichever key sealed it", async () => {
    // The property that makes rotation possible at all: a design with one key has a first key that is
    // permanent, because re-sealing every row needs the old key.
    const old = key("k1", 1);
    const next = key("k2", 2);
    const before = createAesGcmCipher({ keys: [old] });
    const sealed = await before.seal("sk-live-SECRET");
    expect(sealed.keyId).toBe("k1");

    const after = createAesGcmCipher({ keys: [old, next], currentKeyId: "k2" });
    expect(after.currentKeyId()).toBe("k2");
    // Old rows still open...
    expect(await after.open(sealed)).toBe("sk-live-SECRET");
    // ...and new ones are sealed with the new key, which is what a re-sealing job produces.
    expect((await after.seal("x")).keyId).toBe("k2");
  });

  it("names the missing key when one was retired too early", async () => {
    // The specific operational mistake: retiring a key before re-sealing everything that used it. The message
    // has to say which key, because the remedy is to put that one back.
    const sealed = await createAesGcmCipher({ keys: [key("k1", 1)] }).seal("x");
    const without = createAesGcmCipher({ keys: [key("k2", 2)] });
    await expect(without.open(sealed)).rejects.toThrow(/no key "k1" is configured/);
  });

  it("refuses a configuration that could never work", async () => {
    expect(() => createAesGcmCipher({ keys: [] })).toThrow(/at least one key/);
    expect(() => createAesGcmCipher({ keys: [{ id: "short", key: randomBytes(16) }] })).toThrow(/32/);
    expect(() => createAesGcmCipher({ keys: [key("k1", 1)], currentKeyId: "k9" })).toThrow(/not among the keys/);
  });

  it("refuses a nonce of the wrong length", async () => {
    // 96 bits is what GCM is specified for; a different length changes the security argument rather than
    // merely the encoding.
    const cipher = createAesGcmCipher({ keys: [key("k1", 1)], randomNonce: () => Buffer.alloc(8) });
    await expect(cipher.seal("x")).rejects.toThrow(/12 bytes/);
  });
});

describe("sealedEquals", () => {
  it("compares without leaking timing, and distinguishes every field", async () => {
    const cipher = createAesGcmCipher({ keys: [key("k1", 1)] });
    const a = await cipher.seal("x");
    expect(sealedEquals(a, a)).toBe(true);
    expect(sealedEquals(a, { ...a, keyId: "k2" })).toBe(false);
    expect(sealedEquals(a, { ...a, nonce: Buffer.alloc(12, 9).toString("base64") })).toBe(false);
    expect(sealedEquals(a, { ...a, algorithm: "other" })).toBe(false);
    expect(sealedEquals(a, await cipher.seal("x"))).toBe(false);
  });
});

describe("the algorithm is named in the sealed value", () => {
  it("records it, so a future one can be added without guessing what old rows used", async () => {
    expect((await createAesGcmCipher({ keys: [key("k1", 1)] }).seal("x")).algorithm).toBe(AES_GCM);
  });
});
