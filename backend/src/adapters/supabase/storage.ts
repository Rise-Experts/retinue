/**
 * `FileContentStore` over Supabase Storage — the production object-storage adapter (#129).
 *
 * This is the first store where Supabase is not simply Postgres. Every other port aliases straight to the
 * Postgres implementation, and `supabase-conformance.test.ts` asserts that by identity. File bytes are the
 * exception, and not incidentally: #102 declined to make `blobs` a pointer table, and `0013_files` keeps
 * only metadata, precisely so that bytes live somewhere built for them.
 *
 * **Over `fetch`, not an SDK.** Supabase Storage is a plain REST API with a bearer token, so an SDK would
 * add a dependency, a client lifecycle and an auth model for four HTTP calls. `fetch` is injected rather
 * than reached for, so the conformance harness runs the real URL construction and status handling against
 * an in-process double instead of a live bucket.
 *
 * **Two properties that are not obvious from the port:**
 *
 * - **The tenant is the path prefix, and a content key may not contain a separator.** `sanitizeMediaRefs` in
 *   ShareFlow is the cautionary tale this is written against — its workspace-prefix check was *"the ONLY
 *   thing standing between a forged path and a signed URL to another tenant's private object."* Here the
 *   key is validated to a character class, so `../` cannot be spelled at all.
 * - **Listing is offset-paged, because the API is.** Unlike the metadata stores, which use keyset cursors
 *   deliberately, this one cannot: a concurrent upload can shift a page. That is tolerable only because the
 *   sole caller is reconciliation, which reports rather than deletes and runs again.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type { FileContentStore, StoredContent, StoredObject } from "../../persistence/index.js";

/** The slice of `fetch` this adapter uses. Injected so the harness can run the real request building. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  },
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type SupabaseStorageConfig = {
  /** Project URL, e.g. `https://abc.supabase.co`. No trailing slash required. */
  readonly url: string;
  /**
   * The service-role key.
   *
   * A `secret://` reference in a manifest, resolved by the host before it reaches here — the same rule
   * #96 set for MCP credentials. Never logged: every error below reports status and path, never headers.
   */
  readonly serviceKey: string;
  readonly bucket: string;
  readonly fetch: FetchLike;
};

/**
 * What a content key may contain.
 *
 * No `/`, so a key cannot leave its tenant's prefix; no `.` runs, so `..` cannot be spelled. The service
 * mints keys as `f_<uuid>`, which satisfies this — the check is here for the caller that does not.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;

const assertSafeKey = (contentKey: string): void => {
  if (!SAFE_KEY.test(contentKey) || contentKey.includes(".."))
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `content key ${JSON.stringify(contentKey)} is not a valid object name`,
      retryable: false,
    });
};

/** Tenant ids come from the host, but a traversal here would cross a tenant boundary, so they are checked too. */
const assertSafeTenant = (tenantId: string): void => {
  if (!SAFE_KEY.test(tenantId) || tenantId.includes(".."))
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "tenant id is not a valid object path segment",
      retryable: false,
    });
};

const objectPath = (tenantId: string, contentKey: string): string => {
  assertSafeTenant(tenantId);
  assertSafeKey(contentKey);
  return `${tenantId}/${contentKey}`;
};

/**
 * A storage failure: the status, the path, and a truncated body.
 *
 * `retryable` follows the status rather than a guess: 5xx and 429 are worth another attempt, a 4xx is the
 * request being wrong and retrying it just repeats the mistake.
 *
 * **The service key is redacted from the body.** Found while testing this file: the body is quoted for
 * diagnostics, and a service — or a proxy's error page in front of it — that echoes the request would put
 * the service-role key into an error message, which is to say into logs. Redacting at the one place error
 * messages are built is the only version of this that stays true as callers are added.
 */
const makeStorageError =
  (serviceKey: string) =>
  (status: number, what: string, detail: string): AgentPlatformError =>
    new AgentPlatformError({
      code: status === 404 ? "not_found" : status === 403 || status === 401 ? "forbidden" : "internal",
      message: `storage ${what} failed with ${status}: ${detail
        .replaceAll(serviceKey, "[redacted]")
        .slice(0, 200)}`,
      retryable: status >= 500 || status === 429,
    });

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Offset cursors, because the list API takes an offset. Opaque so the shape stays this file's business. */
const encodeOffset = (offset: number): string => Buffer.from(String(offset), "utf8").toString("base64url");
const decodeOffset = (cursor: string): number => {
  const parsed = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export const createSupabaseStorageFileContentStore = (config: SupabaseStorageConfig): FileContentStore => {
  const base = `${config.url.replace(/\/+$/, "")}/storage/v1`;
  const headers = { Authorization: `Bearer ${config.serviceKey}` };
  const storageError = makeStorageError(config.serviceKey);

  return {
    async putFile({ tenantId, contentKey, mediaType, bytes, maxBytes }) {
      const path = objectPath(tenantId, contentKey);

      // Buffered, not streamed, and the bound is the reason it is acceptable: the checksum is over the whole
      // object, so the bytes have to be seen anyway, and `maxBytes` caps what can be held. The cap is
      // re-enforced here rather than trusted from `streamWithCap`, because a second caller can skip a check
      // that lives above the adapter.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of bytes) {
        size += chunk.byteLength;
        if (size > maxBytes)
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `the file exceeds the ${maxBytes} byte limit`,
            retryable: false,
          });
        chunks.push(chunk);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const response = await config.fetch(`${base}/object/${config.bucket}/${path}`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": mediaType,
          // No upsert. A content key is minted per upload, so a collision is not a retry — it is two files
          // pointed at one object, and overwriting would replace the first one's bytes.
          "x-upsert": "false",
        },
        body,
      });
      if (!response.ok) throw storageError(response.status, `upload of ${path}`, await response.text());

      return { contentKey, byteSize: size, checksum: await sha256Hex(body) } satisfies StoredContent;
    },

    async readFile({ tenantId, contentKey }) {
      const path = objectPath(tenantId, contentKey);
      const response = await config.fetch(`${base}/object/${config.bucket}/${path}`, { headers });
      // Absent is `null`, per the port: the read path turns that into "contents are missing", which is the
      // orphan seen from the other direction. Any other failure throws, because an unreachable bucket must
      // not be reported as a missing file — that would send someone hunting a data-loss bug during an outage.
      if (response.status === 404 || response.status === 400) return null;
      if (!response.ok) throw storageError(response.status, `read of ${path}`, await response.text());
      const buffer = new Uint8Array(await response.arrayBuffer());
      return (async function* () {
        yield buffer;
      })();
    },

    async signedUrl({ tenantId, contentKey, expiresInSeconds }) {
      const path = objectPath(tenantId, contentKey);
      const response = await config.fetch(`${base}/object/sign/${config.bucket}/${path}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        // The expiry as given. Clamping lives in `signedReadUrl`, once, so there is one answer to "how long
        // does a URL live" rather than a floor here and a ceiling there.
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw storageError(response.status, `signing of ${path}`, await response.text());
      const parsed = JSON.parse(await response.text()) as { signedURL?: string; signedUrl?: string };
      const signed = parsed.signedURL ?? parsed.signedUrl;
      if (signed === undefined)
        throw storageError(502, `signing of ${path}`, "the response carried no signed URL");
      // Relative in the API's response. Returned absolute, because a caller cannot use half a URL and would
      // have to reconstruct the base — which is how the wrong project's URL gets built.
      return signed.startsWith("http") ? signed : `${base}${signed.startsWith("/") ? "" : "/"}${signed}`;
    },

    async deleteFile({ tenantId, contentKey }) {
      const path = objectPath(tenantId, contentKey);
      const response = await config.fetch(`${base}/object/${config.bucket}/${path}`, {
        method: "DELETE",
        headers,
      });
      // Idempotent: a retried sweep must not fail on the object it already removed. The state moves only
      // after this call returns, so a 404 here is the previous attempt having succeeded.
      if (response.status === 404 || response.ok) return;
      throw storageError(response.status, `delete of ${path}`, await response.text());
    },

    async listObjects({ tenantId, prefix, limit, cursor }) {
      assertSafeTenant(tenantId);
      const offset = cursor === undefined ? 0 : decodeOffset(cursor);
      const response = await config.fetch(`${base}/object/list/${config.bucket}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          // The tenant prefix is not optional and not appended to the caller's — it is the caller's prefix
          // scoped *inside* the tenant's. A caller passing `../other-tenant/` gets a literal prefix that
          // matches nothing, because the key check above means no object is named that.
          prefix: `${tenantId}/${prefix ?? ""}`,
          limit: limit + 1,
          offset,
          sortBy: { column: "name", order: "asc" },
        }),
      });
      if (!response.ok) throw storageError(response.status, "list", await response.text());

      const rows = JSON.parse(await response.text()) as readonly {
        name?: string;
        metadata?: { size?: number } | null;
      }[];
      const items: StoredObject[] = rows
        .slice(0, limit)
        .flatMap((row) =>
          // A row with no name is a folder placeholder in this API. Skipped rather than surfaced as an
          // object with an empty key, which reconciliation would then report as an orphan nobody can find.
          row.name === undefined || row.name === ""
            ? []
            : [{ contentKey: row.name, byteSize: row.metadata?.size ?? 0 }],
        );
      // Keys come back relative to the prefix the API was given, which is already tenant-scoped, so what
      // the port returns is the bare content key — the same string `putFile` was handed.
      return rows.length > limit ? { items, nextCursor: encodeOffset(offset + limit) } : ({ items } satisfies Page<StoredObject>);
    },
  };
};
