/**
 * The three SSRF vectors, each with its own test — REQ-055 (#237), task #238, AC-3 — and #239 AC-3, which is why it lives here.
 *
 * The AC is explicit that one "blocks localhost" test does not satisfy it, and it is right: the three vectors
 * fail differently and a defence against one is no defence against the others. Each block below asserts the
 * same decisive thing — **no request left the process** — because a refusal that happens after the socket is
 * open has already leaked whatever the request would have leaked.
 */
import { describe, expect, it, vi } from "vitest";

import {
  BlockedError,
  isPrivateAddress,
  isPrivateV4,
  isPrivateV6,
  refuseUrl,
  resolvePublicly,
  safeFetch,
  type Resolve,
  type SafeTransport,
} from "../ssrf.js";

/** A transport that records every call and answers 200. If it is called at all, the check failed. */
const spyTransport = () => {
  const calls: { url: string; addresses: readonly string[] }[] = [];
  const transport: SafeTransport = async ({ url, addresses }) => {
    calls.push({ url: url.toString(), addresses });
    return { status: 200, headers: {}, body: "<h1>ok</h1>", truncated: false };
  };
  return { transport, calls };
};

const resolvingTo = (map: Record<string, string[]>): Resolve => async (hostname) => {
  const addresses = map[hostname];
  if (addresses === undefined) throw new Error(`no record for ${hostname}`);
  return addresses;
};

describe("vector 1: a private or link-local literal", () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    "http://[2002:a9fe:a9fe::]/",
    "http://127.0.0.1:8080/admin",
    "http://[::1]:8080/admin",
    "http://0.0.0.0/",
    "http://10.0.0.5/internal",
    "http://172.16.4.4/internal",
    "http://192.168.1.1/router",
    "http://192.0.0.192/",
    "http://100.64.3.1/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://localhost/admin",
    "http://vault.internal/secret",
    "http://metadata.google.internal/computeMetadata/v1/",
    // Obfuscated forms of loopback that some stacks resolve. Not valid dotted quads, so refused as malformed.
    "http://0177.0.0.1/",
    "http://127.1/",
  ];

  it.each(blocked)("refuses %s without connecting", async (url) => {
    const { transport, calls } = spyTransport();
    await expect(safeFetch(url, { transport, resolve: resolvingTo({}) })).rejects.toBeInstanceOf(BlockedError);
    // The whole point. A refusal after the connection is not a refusal.
    expect(calls).toHaveLength(0);
  });

  it("classifies the ranges that matter, and leaves public addresses alone", () => {
    expect(isPrivateV4("169.254.169.254")).toBe(true);
    expect(isPrivateV4("100.64.0.1")).toBe(true);
    expect(isPrivateV4("198.18.0.1")).toBe(true);
    expect(isPrivateV4("224.0.0.1")).toBe(true);
    expect(isPrivateV4("8.8.8.8")).toBe(false);
    expect(isPrivateV4("93.184.216.34")).toBe(false);

    expect(isPrivateV6("::1")).toBe(true);
    expect(isPrivateV6("fc00::1")).toBe(true);
    expect(isPrivateV6("fe80::1")).toBe(true);
    // The mapped and embedded forms are the ones a v4-only check misses.
    expect(isPrivateV6("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateV6("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateV6("2002:a9fe:a9fe::")).toBe(true);
    expect(isPrivateV6("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses a scheme that is not http or https", () => {
    expect(refuseUrl(new URL("file:///etc/passwd"))).toMatch(/not a scheme/);
    expect(refuseUrl(new URL("data:text/html,<h1>x</h1>"))).toMatch(/not a scheme/);
    expect(refuseUrl(new URL("https://example.com/ok"))).toBeNull();
  });
});

describe("vector 2: a public hostname that resolves to a private address", () => {
  it("refuses the name, and never connects", async () => {
    const { transport, calls } = spyTransport();
    /**
     * The hostname is genuinely public and passes every string check that could be written about it. Only the
     * resolution says otherwise, which is why the resolution has to happen before the connection rather than
     * inside it.
     */
    const resolve = resolvingTo({ "metadata.attacker.example": ["169.254.169.254"] });
    await expect(
      safeFetch("https://metadata.attacker.example/latest/meta-data/", { transport, resolve }),
    ).rejects.toThrow(/resolves to 169\.254\.169\.254/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when only one of several records is private", async () => {
    // A public and a private record together is rebinding with the work done up front: connecting to whichever
    // came back first is a coin flip, and a check that passes on a coin flip has checked nothing.
    const { transport, calls } = spyTransport();
    const resolve = resolvingTo({ "split.example": ["93.184.216.34", "10.0.0.7"] });
    await expect(safeFetch("https://split.example/", { transport, resolve })).rejects.toThrow(/10\.0\.0\.7/);
    expect(calls).toHaveLength(0);
  });

  it("connects to the address it validated, not to the name", async () => {
    const { transport, calls } = spyTransport();
    const resolve = resolvingTo({ "example.com": ["93.184.216.34"] });
    await safeFetch("https://example.com/page", { transport, resolve });
    expect(calls).toHaveLength(1);
    /**
     * The address is handed to the transport, which pins it as the connection's `lookup`. That is what closes
     * the rebinding window: there is no second resolution between the check and the socket.
     */
    expect(calls[0]!.addresses).toEqual(["93.184.216.34"]);
  });

  it("refuses a host that resolves to nothing", async () => {
    const { transport, calls } = spyTransport();
    await expect(
      safeFetch("https://nowhere.example/", { transport, resolve: async () => [] }),
    ).rejects.toThrow(/no addresses/);
    expect(calls).toHaveLength(0);
    await expect(resolvePublicly("x.example", async () => { throw new Error("SERVFAIL"); })).rejects.toBeInstanceOf(
      BlockedError,
    );
  });
});

describe("vector 3: a redirect to somewhere private", () => {
  /** A transport that redirects the first URL to `to`, then answers 200 for anything else. */
  const redirectingTo = (to: string) => {
    const calls: string[] = [];
    const transport: SafeTransport = async ({ url }) => {
      calls.push(url.toString());
      return calls.length === 1
        ? { status: 302, headers: { location: to }, body: "", truncated: false }
        : { status: 200, headers: {}, body: "<h1>ok</h1>", truncated: false };
    };
    return { transport, calls };
  };

  it("refuses a hop to a private literal, having connected only to the public first hop", async () => {
    const { transport, calls } = redirectingTo("http://169.254.169.254/latest/meta-data/");
    const resolve = resolvingTo({ "harmless.example": ["93.184.216.34"] });
    await expect(safeFetch("https://harmless.example/start", { transport, resolve })).rejects.toThrow(
      /private, loopback or link-local/,
    );
    // One call: the public page that issued the redirect. The private target was never requested.
    expect(calls).toEqual(["https://harmless.example/start"]);
  });

  it("refuses a hop to a name that resolves privately", async () => {
    const { transport, calls } = redirectingTo("https://metadata.attacker.example/");
    const resolve = resolvingTo({
      "harmless.example": ["93.184.216.34"],
      "metadata.attacker.example": ["169.254.169.254"],
    });
    await expect(safeFetch("https://harmless.example/start", { transport, resolve })).rejects.toThrow(/resolves to/);
    expect(calls).toEqual(["https://harmless.example/start"]);
  });

  it("follows an ordinary redirect and reports the whole chain", async () => {
    // Following redirects is the reason this cannot simply reuse the shared client, which refuses them — a
    // great many real pages are one hop from their canonical URL.
    const { transport } = redirectingTo("https://www.example.com/page");
    const resolve = resolvingTo({ "example.com": ["93.184.216.34"], "www.example.com": ["93.184.216.34"] });
    const response = await safeFetch("https://example.com/page", { transport, resolve });
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://www.example.com/page");
    expect(response.chain).toEqual(["https://example.com/page", "https://www.example.com/page"]);
  });

  it("abandons a redirect loop rather than following it forever", async () => {
    const transport: SafeTransport = async () => ({
      status: 302,
      headers: { location: "https://loop.example/next" },
      body: "",
      truncated: false,
    });
    const resolve = resolvingTo({ "loop.example": ["93.184.216.34"] });
    await expect(
      safeFetch("https://loop.example/start", { transport, resolve, maxRedirects: 3 }),
    ).rejects.toThrow(/redirected more than 3 times/);
  });

  it("re-checks a relative redirect, which resolves against the current URL", async () => {
    const { transport } = redirectingTo("/moved");
    const resolve = resolvingTo({ "example.com": ["93.184.216.34"] });
    const response = await safeFetch("https://example.com/start", { transport, resolve });
    expect(response.url).toBe("https://example.com/moved");
  });
});
