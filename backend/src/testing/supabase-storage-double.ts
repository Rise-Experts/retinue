/**
 * An in-process Supabase Storage, for the `FileContentStore` adapter (#129).
 *
 * Lives here rather than beside one test because two suites need it: `supabase-conformance.test.ts` is the
 * single conformance entrypoint the matrix generator reads, and `supabase-storage.test.ts` holds the cases
 * only an HTTP store has. A double copied into both would drift, and a drifting double is a suite that
 * proves two different things while appearing to prove one.
 *
 * Deliberately strict about what the adapter must get right: it requires the bearer token, it refuses an
 * upload to an existing path unless `x-upsert` says otherwise, and it 404s an unknown object rather than
 * returning an empty body. A lenient double would let every one of those bugs through to production.
 *
 * It can only prove the adapter is self-consistent about the API it *believes* Supabase has. What it proves
 * well is everything on this side of the wire — URL construction, status handling, tenant prefixing — which
 * is where the tenant boundary lives.
 */

import type { FetchLike } from "../adapters/supabase/storage.js";
import { createSupabaseStorageFileContentStore } from "../adapters/supabase/storage.js";
import type { FileContentStore } from "../persistence/index.js";

export type RecordedCall = {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
};

export const STORAGE_BUCKET = "attachments";
export const STORAGE_URL = "https://project.supabase.test";
export const STORAGE_KEY = "service-role-key";

const fakeStorage = () => {
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const calls: RecordedCall[] = [];

  const reply = (status: number, body: string | Uint8Array) => ({
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return typeof body === "string" ? body : new TextDecoder().decode(body);
    },
    async arrayBuffer() {
      return (typeof body === "string" ? new TextEncoder().encode(body) : body)
        .slice()
        .buffer as ArrayBuffer;
    },
  });

  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = init?.headers ?? {};
    calls.push({ method, url, headers });
    if (headers["Authorization"] !== `Bearer ${STORAGE_KEY}`) return reply(401, "missing bearer token");

    const rest = url.slice(`${STORAGE_URL}/storage/v1/`.length);

    if (rest.startsWith(`object/list/${STORAGE_BUCKET}`) && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        prefix: string;
        limit: number;
        offset: number;
      };
      const matched = [...objects.entries()]
        .filter(([path]) => path.startsWith(body.prefix))
        .map(([path, value]) => ({
          // The API returns names relative to the searched prefix, which is what the adapter relies on.
          name: path.slice(body.prefix.length),
          metadata: { size: value.bytes.byteLength },
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(body.offset, body.offset + body.limit);
      return reply(200, JSON.stringify(matched));
    }

    if (rest.startsWith(`object/sign/${STORAGE_BUCKET}/`) && method === "POST") {
      const path = rest.slice(`object/sign/${STORAGE_BUCKET}/`.length);
      if (!objects.has(path)) return reply(404, "Object not found");
      const { expiresIn } = JSON.parse(String(init?.body ?? "{}")) as { expiresIn: number };
      return reply(200, JSON.stringify({ signedURL: `/object/sign/${STORAGE_BUCKET}/${path}?token=t&exp=${expiresIn}` }));
    }

    if (rest.startsWith(`object/${STORAGE_BUCKET}/`)) {
      const path = rest.slice(`object/${STORAGE_BUCKET}/`.length);
      if (method === "POST") {
        if (objects.has(path) && headers["x-upsert"] !== "true") return reply(409, "The resource already exists");
        const body = init?.body;
        if (!(body instanceof Uint8Array)) return reply(400, "expected a byte body");
        objects.set(path, { bytes: body, mediaType: headers["Content-Type"] ?? "application/octet-stream" });
        return reply(200, JSON.stringify({ Key: `${STORAGE_BUCKET}/${path}` }));
      }
      if (method === "DELETE") {
        if (!objects.has(path)) return reply(404, "Object not found");
        objects.delete(path);
        return reply(200, JSON.stringify({ message: "Successfully deleted" }));
      }
      const stored = objects.get(path);
      return stored === undefined ? reply(404, "Object not found") : reply(200, stored.bytes);
    }

    return reply(404, `unrouted ${method} ${rest}`);
  };

  return { fetchImpl, objects, calls };
};

/** The adapter over the double, plus the double's innards for the assertions that need them. */
export const supabaseStorageDouble = (): {
  readonly store: FileContentStore;
  readonly objects: Map<string, { bytes: Uint8Array; mediaType: string }>;
  readonly calls: RecordedCall[];
} => {
  const storage = fakeStorage();
  return {
    store: createSupabaseStorageFileContentStore({
      url: STORAGE_URL,
      serviceKey: STORAGE_KEY,
      bucket: STORAGE_BUCKET,
      fetch: storage.fetchImpl,
    }),
    objects: storage.objects,
    calls: storage.calls,
  };
};
