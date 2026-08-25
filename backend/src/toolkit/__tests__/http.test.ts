/**
 * The outbound client's refusals — REQ-039 (#188).
 *
 * The assertion that matters in most of these is not the returned value but `calls.length === 0`: **a refusal
 * that still sends the packet is not a refusal.** A test that only checks the message passes against an
 * implementation that fetches first and judges afterwards, which is the bug worth catching.
 */

import { describe, expect, it } from "vitest";
import { createHttpClient } from "../http.js";

/** Records every URL it is asked for, so "did not send" is provable rather than assumed. */
const spyFetch = (response?: Partial<Response> & { headers?: Record<string, string> }) => {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    const headers = new Headers(response?.headers ?? { "content-type": "text/plain" });
    return {
      status: response?.status ?? 200,
      headers,
      body: null,
      text: async () => (response as { textBody?: string })?.textBody ?? "hello",
      init,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const client = (over: Parameters<typeof createHttpClient>[0] = {}) =>
  createHttpClient({ nonce: () => "testnonce", ...over });

describe("egress refusals happen before the request", () => {
  const forbidden = [
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["loopback", "https://127.0.0.1/admin"],
    ["localhost by name", "https://localhost:8080/"],
    ["a private range", "https://10.0.0.5/"],
    ["another private range", "https://192.168.1.1/"],
    ["an IPv6 literal hiding the metadata address", "https://[::ffff:169.254.169.254]/"],
    ["a .internal name", "https://vault.internal/secret"],
    ["plain http", "http://example.com/"],
    ["a file URL", "file:///etc/passwd"],
    ["credentials in the URL", "https://user:pass@example.com/"],
  ] as const;

  for (const [what, url] of forbidden) {
    it(`refuses ${what} without sending anything`, async () => {
      const spy = spyFetch();
      const outcome = await client({ fetchImpl: spy.impl }).request({ url });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.kind).toBe("forbidden");
      expect(spy.calls).toEqual([]);
    });
  }

  it("allows a permitted host", async () => {
    const spy = spyFetch();
    const outcome = await client({ fetchImpl: spy.impl }).request({ url: "https://example.com/page" });
    expect(outcome.ok).toBe(true);
    expect(spy.calls).toEqual(["https://example.com/page"]);
  });
});

describe("redirects", () => {
  it("are reported, not followed", async () => {
    // The classic SSRF bypass: a permitted host answering with a location inside the network.
    const spy = spyFetch({ status: 302, headers: { location: "https://169.254.169.254/" } });
    const outcome = await client({ fetchImpl: spy.impl }).request({ url: "https://example.com/go" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("redirected");
    expect(outcome.ok === false && outcome.reason).toContain("169.254.169.254");
    // One call — to the URL that was checked. Following it would be two.
    expect(spy.calls).toEqual(["https://example.com/go"]);
  });

  it("asks for manual redirect handling rather than relying on the default", async () => {
    let seen: RequestInit | undefined;
    const impl = (async (_url: string, init: RequestInit) => {
      seen = init;
      return { status: 200, headers: new Headers(), body: null, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    await client({ fetchImpl: impl }).request({ url: "https://example.com/" });
    expect(seen?.redirect).toBe("manual");
  });
});

describe("credentials", () => {
  it("come from configuration, keyed by the validated host", async () => {
    let seen: Record<string, string> = {};
    const impl = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { status: 200, headers: new Headers(), body: null, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await client({
      fetchImpl: impl,
      headersFor: (host) => (host === "api.example.com" ? { authorization: "Bearer configured" } : undefined),
    }).request({ url: "https://api.example.com/v1" });

    expect(seen.authorization).toBe("Bearer configured");
  });

  it("is not sent to a host it was not configured for", async () => {
    let seen: Record<string, string> = {};
    const impl = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { status: 200, headers: new Headers(), body: null, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await client({
      fetchImpl: impl,
      headersFor: (host) => (host === "api.example.com" ? { authorization: "Bearer configured" } : undefined),
    }).request({ url: "https://elsewhere.example.org/collect" });

    expect(seen.authorization).toBeUndefined();
  });

  it("refuses an Authorization the caller supplied, rather than forwarding it", async () => {
    let seen: Record<string, string> = {};
    const impl = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { status: 200, headers: new Headers(), body: null, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await client({ fetchImpl: impl }).request({
      url: "https://example.com/",
      // A model choosing which credential to spend. There is no schema field for this, and even reached
      // directly it does not survive.
      headers: { Authorization: "Bearer stolen", Cookie: "session=abc", "X-Fine": "yes" },
    });

    expect(seen.authorization).toBeUndefined();
    expect(seen.Authorization).toBeUndefined();
    expect(seen.Cookie).toBeUndefined();
    expect(seen["X-Fine"]).toBe("yes");
  });

  it("does not let a caller header shadow a configured one", async () => {
    let seen: Record<string, string> = {};
    const impl = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { status: 200, headers: new Headers(), body: null, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await client({ fetchImpl: impl, headersFor: () => ({ "x-api-key": "configured" }) }).request({
      url: "https://example.com/",
      headers: { "x-api-key": "chosen-by-the-model" },
    });

    expect(seen["x-api-key"]).toBe("configured");
  });
});

describe("bounds and failures", () => {
  it("stops reading at the byte ceiling and says so", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1_000));
    let cancelled = false;
    const body = {
      getReader: () => {
        let sent = 0;
        return {
          read: async () => (sent++ < 100 ? { value: chunk, done: false } : { value: undefined, done: true }),
          cancel: async () => {
            cancelled = true;
          },
        };
      },
    };
    const impl = (async () =>
      ({ status: 200, headers: new Headers(), body, text: async () => "" }) as unknown as Response) as unknown as typeof fetch;

    const outcome = await client({ fetchImpl: impl, maxBytes: 5_000 }).request({ url: "https://example.com/big", fence: false });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.truncated).toBe(true);
    expect(outcome.ok === true && outcome.body.length).toBeLessThanOrEqual(5_000);
    // Without the cancel the connection stays open pulling a body nobody wants.
    expect(cancelled).toBe(true);
  });

  it("reports a 404 as a failure a model can read, with the status", async () => {
    const spy = spyFetch({ status: 404 });
    const outcome = await client({ fetchImpl: spy.impl }).request({ url: "https://example.com/gone" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("http-error");
    expect(outcome.ok === false && outcome.status).toBe(404);
    expect(outcome.ok === false && outcome.reason).toContain("404");
  });

  it("reports a timeout as a timeout", async () => {
    const impl = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    const outcome = await client({ fetchImpl: impl, timeoutMs: 1_000 }).request({ url: "https://example.com/slow" });
    expect(outcome.ok === false && outcome.kind).toBe("timeout");
    expect(outcome.ok === false && outcome.reason).toContain("1 second");
  });

  it("fences the body as untrusted content by default", async () => {
    const spy = spyFetch({ headers: { "content-type": "text/plain" } });
    const outcome = await client({ fetchImpl: spy.impl }).request({ url: "https://example.com/" });
    expect(outcome.ok === true && outcome.body).toContain("untrusted-content");
    expect(outcome.ok === true && outcome.body).toContain("testnonce");
  });

  it("returns the body raw when the caller parses it itself", async () => {
    const spy = spyFetch();
    const outcome = await client({ fetchImpl: spy.impl }).request({ url: "https://example.com/", fence: false });
    expect(outcome.ok === true && outcome.body).toBe("hello");
  });
});
