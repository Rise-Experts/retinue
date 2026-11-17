/**
 * The hop to the web app's internal endpoints.
 *
 * WHY THIS FILE EXISTS: this is the seam where a *credential* and a *tenant boundary* live on the other
 * side. Everything worth asserting is about what is sent, what is refused, and what an unconfigured
 * deployment gets — and none of it is visible from a tool test, which sees a dependency that either
 * exists or does not.
 */
import { describe, expect, it } from "vitest";

import { createInternalWebApp, internalWebAppFrom } from "../internal.js";

const context = { tenantId: "ws-1", principalId: "user-1" } as never;

/**
 * Unwraps a rejection, so a call that *resolved* fails loudly instead of vacuously.
 *
 * `.catch((e) => e)` yields a union of the resolved value and the error, and
 * `expect(error.code).toBe(...)` against a success reads `undefined` while still passing. #276's test
 * typechecking is what refuses the union.
 */
const thrown = (value: unknown): { code: string; message: string } => {
  if (!(value instanceof Error)) throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
  return value as unknown as { code: string; message: string };
};

const responder = (result: { status?: number; body?: unknown }) => {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      async json() {
        return result.body ?? {};
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const app = (result: { status?: number; body?: unknown }) => {
  const { calls, fetchImpl } = responder(result);
  return { calls, client: createInternalWebApp({ baseUrl: "http://web:3000", secret: "s3cret", fetchImpl }) };
};

describe("storeMedia", () => {
  it("posts the bytes as base64 with the workspace and the secret", async () => {
    const { client, calls } = app({ body: { path: "ws-1/a.png", reference: "chorus-media:ws-1/a.png" } });
    const stored = await client.storeMedia({
      context,
      contentType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(stored).toEqual({ path: "ws-1/a.png", reference: "chorus-media:ws-1/a.png" });
    expect(calls[0]?.url).toBe("http://web:3000/api/internal/store-media");
    expect(calls[0]?.headers["x-internal-secret"]).toBe("s3cret");
    expect(calls[0]?.body).toEqual({
      workspaceId: "ws-1",
      userId: "user-1",
      contentType: "image/png",
      dataBase64: "AQID",
    });
  });

  it("refuses a 200 that does not say where the file went", async () => {
    /**
     * A broken contract is not a stored file. An empty reference would put "the diagram is at " in a
     * reply, and the caller could not tell that from a stored image.
     */
    const { client } = app({ body: { path: "ws-1/a.png" } });
    await expect(client.storeMedia({ context, contentType: "image/png", bytes: new Uint8Array([1]) })).rejects.toMatchObject(
      { code: "provider_error" },
    );
  });

  it("names a secret mismatch as configuration rather than as a refused file", async () => {
    /**
     * A 401 here means this deployment's secret does not match the app's. Reported as
     * `provider_unavailable` with that sentence, because "that file could not be opened" would send
     * somebody looking at the file.
     */
    const { client } = app({ status: 401, body: { error: "Unauthorized" } });
    const failure = thrown(
      await client.storeMedia({ context, contentType: "image/png", bytes: new Uint8Array([1]) }).catch((e: unknown) => e),
    );
    expect(failure.code).toBe("provider_unavailable");
    expect(failure.message).toContain("internal secret does not match");
  });
});

describe("signMediaUrl", () => {
  it("sends the path the caller read from the database", async () => {
    /**
     * A **path**, which is what the endpoint authorises on — *"the authorization boundary here is the
     * workspace prefix on `path`"*. It is read from `generated_assets` under the caller's own tenant
     * scope and never arrives from a model.
     */
    const { client, calls } = app({ body: { url: "https://storage.test/signed" } });
    expect(await client.signMediaUrl({ context, path: "ws-1/report.pdf" })).toBe("https://storage.test/signed");
    expect(calls[0]?.url).toBe("http://web:3000/api/internal/media-url");
    expect(calls[0]?.body).toMatchObject({ workspaceId: "ws-1", path: "ws-1/report.pdf" });
  });

  it("passes the endpoint's own refusal through for a path outside the workspace", async () => {
    // The check is the app's, and its message is the useful one.
    const { client } = app({ status: 403, body: { error: "That file could not be opened." } });
    await expect(client.signMediaUrl({ context, path: "other-ws/secret.pdf" })).rejects.toMatchObject({
      code: "invalid_input",
      message: "That file could not be opened.",
    });
  });
});

describe("configuration", () => {
  it("is absent rather than broken when the deployment has no app URL", () => {
    /**
     * The same shape as `MediaDeps.convert`: absent dependency, named refusal in the tool. A client that
     * existed and posted to nowhere would turn a configuration gap into a runtime error on first use.
     */
    expect(internalWebAppFrom({ SHARED_API_SECRET: "s" })).toBeUndefined();
    expect(internalWebAppFrom({ WEB_INTERNAL_URL: "http://web:3000" })).toBeUndefined();
    // Blank is absent, which is what compose sends for an unset optional variable — see env.ts.
    expect(internalWebAppFrom({ WEB_INTERNAL_URL: "http://web:3000", SHARED_API_SECRET: "" })).toBeUndefined();
    expect(internalWebAppFrom({ WEB_INTERNAL_URL: "http://web:3000", SHARED_API_SECRET: "s" })).toBeDefined();
  });

  it("tolerates a trailing slash on the app URL", async () => {
    // `http://web:3000/` and `http://web:3000` must reach the same endpoint; a double slash is a 404.
    const { calls, fetchImpl } = responder({ body: { url: "https://storage.test/signed" } });
    const client = createInternalWebApp({ baseUrl: "http://web:3000/", secret: "s", fetchImpl });
    await client.signMediaUrl({ context, path: "ws-1/a.pdf" });
    expect(calls[0]?.url).toBe("http://web:3000/api/internal/media-url");
  });
});
