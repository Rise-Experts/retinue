/**
 * `FileContentStore` over Supabase Storage (#129).
 *
 * The cases only an HTTP store has. The conformance harness itself runs in `supabase-conformance.test.ts`,
 * because that is the one file per adapter the matrix generator reads — a harness run anywhere else would
 * pass while the matrix reported the port as uncovered.
 *
 * The `fetch` is the shared in-process double in `testing/supabase-storage-double.ts`, so the real URL
 * construction, status handling and tenant prefixing are exercised without a live bucket.
 */

import { describe, expect, it } from "vitest";
import { createSupabaseStorageFileContentStore } from "../adapters/supabase/storage.js";
import {
  STORAGE_BUCKET,
  STORAGE_KEY,
  STORAGE_URL,
  supabaseStorageDouble,
} from "../testing/supabase-storage-double.js";


/**
 * The value a `.catch((e) => e)` produced, asserted to actually be an error.
 *
 * Without it, `expect(error.message).toContain(...)` reads `undefined` when the call *succeeded* — and
 * `expect(undefined).toContain(...)` fails, so this particular shape is not vacuous. It is still worth
 * narrowing: the failure then names what came back instead of reporting a missing property.
 */
const thrown = (value: unknown): Error => {
  if (!(value instanceof Error)) throw new Error(`expected the call to reject, and it returned ${JSON.stringify(value)}`);
  return value;
};

const make = supabaseStorageDouble;

const bytes = (text: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield new TextEncoder().encode(text);
  })();

const put = (store: ReturnType<typeof make>["store"], tenantId: string, contentKey: string, text = "hi") =>
  store.putFile({
    tenantId: tenantId as never,
    contentKey,
    mediaType: "text/plain",
    bytes: bytes(text),
    maxBytes: 1000,
  });

describe("Supabase Storage FileContentStore", () => {
  it("puts every object under its tenant's prefix", async () => {
    const { store, objects } = make();
    await put(store, "tenant-a", "k1");
    await put(store, "tenant-b", "k1");
    // The same content key in two tenants is two objects. If the tenant were a filter rather than the path,
    // these would be one, and the second upload would overwrite the first tenant's bytes.
    expect([...objects.keys()].sort()).toEqual(["tenant-a/k1", "tenant-b/k1"]);
  });

  it("refuses a content key that could climb out of the tenant prefix", async () => {
    // The `sanitizeMediaRefs` failure, prevented by construction rather than by a check someone maintains.
    const { store, calls } = make();
    for (const contentKey of ["../tenant-b/k1", "a/b", "..", "", "k1/../../x"]) {
      await expect(put(store, "tenant-a", contentKey)).rejects.toThrow(/not a valid object name/);
    }
    // And no request was made: the refusal is before the wire, so a forged key never reaches storage at all.
    expect(calls).toEqual([]);
  });

  it("refuses to overwrite an existing object rather than replacing its bytes", async () => {
    // A content key is minted per upload, so a collision is never a retry — it is two files pointed at one
    // object. `x-upsert: false` is what makes that a loud failure instead of silent data loss.
    const { store } = make();
    await put(store, "t", "k1", "first");
    await expect(put(store, "t", "k1", "second")).rejects.toThrow(/upload of t\/k1 failed with 409/);
  });

  it("reads an absent object as null and an unreachable bucket as a failure", async () => {
    // The distinction matters: reporting an outage as a missing file sends someone hunting data loss.
    const { store } = make();
    expect(await store.readFile({ tenantId: "t" as never, contentKey: "nope" })).toBeNull();

    const broken = createSupabaseStorageFileContentStore({
      url: STORAGE_URL,
      serviceKey: STORAGE_KEY,
      bucket: STORAGE_BUCKET,
      fetch: async () => ({
        status: 503,
        ok: false,
        async text() {
          return "upstream unavailable";
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      }),
    });
    await expect(broken.readFile({ tenantId: "t" as never, contentKey: "k1" })).rejects.toThrow(/503/);
  });

  it("marks a server failure retryable and a client failure not", async () => {
    // Retrying a 4xx repeats the mistake; retrying a 5xx is the whole point of having the flag.
    const status = { code: 500 };
    const store = createSupabaseStorageFileContentStore({
      url: STORAGE_URL,
      serviceKey: STORAGE_KEY,
      bucket: STORAGE_BUCKET,
      fetch: async () => ({
        status: status.code,
        ok: false,
        async text() {
          return "boom";
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      }),
    });
    await expect(put(store, "t", "k1")).rejects.toMatchObject({ retryable: true });
    status.code = 409;
    await expect(put(store, "t", "k1")).rejects.toMatchObject({ retryable: false });
  });

  it("returns an absolute signed URL, not the relative one the API sends", async () => {
    // A caller handed half a URL has to rebuild the base, which is how another project's URL gets built.
    const { store } = make();
    await put(store, "t", "k1");
    const url = await store.signedUrl({ tenantId: "t" as never, contentKey: "k1", expiresInSeconds: 300 });
    expect(url).toBe(`${STORAGE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/t/k1?token=t&exp=300`);
  });

  it("passes the expiry through rather than substituting its own", async () => {
    // Clamping lives in `signedReadUrl`, once. A second ceiling here would mean two answers to "how long
    // does a URL live", and the shorter one would win invisibly.
    const { store } = make();
    await put(store, "t", "k1");
    const url = await store.signedUrl({ tenantId: "t" as never, contentKey: "k1", expiresInSeconds: 60 });
    expect(url).toContain("exp=60");
  });

  it("signs nothing for an object that is not there", async () => {
    const { store } = make();
    expect(
      await store.signedUrl({ tenantId: "t" as never, contentKey: "gone", expiresInSeconds: 60 }),
    ).toBeNull();
  });

  it("treats deleting an absent object as done", async () => {
    // The sweep deletes bytes before moving the state, so a retry always re-deletes an object that is
    // already gone. If that threw, every interrupted sweep would be stuck forever.
    const { store } = make();
    await expect(store.deleteFile({ tenantId: "t" as never, contentKey: "never-existed" })).resolves.toBeUndefined();
  });

  it("lists only the asking tenant's objects, by bare content key", async () => {
    const { store } = make();
    await put(store, "tenant-a", "a1");
    await put(store, "tenant-a", "a2");
    await put(store, "tenant-b", "b1");
    const page = await store.listObjects({ tenantId: "tenant-a" as never, limit: 10 });
    expect(page.items.map((o) => o.contentKey)).toEqual(["a1", "a2"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("pages through a listing without repeating or skipping an object", async () => {
    const { store } = make();
    for (const n of [1, 2, 3, 4, 5]) await put(store, "t", `k${n}`);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listObjects({
        tenantId: "t" as never,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((o) => o.contentKey));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(["k1", "k2", "k3", "k4", "k5"]);
  });

  it("sends the service key on every request and never in a message", async () => {
    // An error carrying the token would put it in logs, which is the one place a service-role key must
    // never be. Asserted on a failing call, because that is the path that builds a message.
    const { store, calls } = make();
    await put(store, "t", "k1");
    expect(calls.every((c) => c.headers["Authorization"] === `Bearer ${STORAGE_KEY}`)).toBe(true);

    // The failure is provoked by a broken transport rather than by another rule of this adapter, so this
    // test keeps failing for its own reason if that rule changes.
    const failing = createSupabaseStorageFileContentStore({
      url: STORAGE_URL,
      serviceKey: STORAGE_KEY,
      bucket: STORAGE_BUCKET,
      fetch: async () => ({
        status: 500,
        ok: false,
        // Even if the service echoed the request back, the message must not carry it.
        async text() {
          return `upstream said: Bearer ${STORAGE_KEY}`;
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      }),
    });
    const error = await put(failing, "t", "k1").catch((e: Error) => e);
    expect(thrown(error).message).toContain("500");
    expect(thrown(error).message).not.toContain(STORAGE_KEY);
  });
});
