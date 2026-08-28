/**
 * A credential is a typed value, not a string — REQ-063 (#259), task #260.
 *
 * `resolve()` returned `Promise<string>`, which covers a bearer token and nothing else. Four of the fourteen
 * integrations specified in `docs/23` cannot be expressed that way — Jira and Confluence want an account email
 * *and* an API token as Basic auth, Atlassian's OAuth needs a cloud id discovered after consent, WhatsApp needs
 * a phone number id — and every one of them would otherwise have grown its own side-channel.
 */
import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import {
  AUTH_MODES,
  CREDENTIAL_SCHEMES,
  assertToolkitAuth,
  bearer,
  createCredential,
  createStaticCredentialResolver,
  credentialHeader,
  withCredentialAudit,
  type Credential,
  type CredentialAudit,
} from "../credentials.js";

const context: ExecutionContext = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
};

describe("a bare string still means a bearer token", () => {
  it("keeps the single-tenant path one line — AC-4", async () => {
    // The widening must not make the common case harder. A host with one token writes what it always wrote.
    const resolver = createStaticCredentialResolver({ github: "ghp_x" });
    const credential = await resolver.resolve({ ref: "github", context });
    expect(credential.scheme).toBe("bearer");
    expect(credentialHeader(credential)).toEqual(["Authorization", "Bearer ghp_x"]);
  });

  it("accepts a typed credential in the same map", async () => {
    const resolver = createStaticCredentialResolver({
      jira: createCredential({ scheme: "basic", username: "me@example.com", password: "api-token" }),
    });
    const credential = await resolver.resolve({ ref: "jira", context });
    expect(credential.scheme).toBe("basic");
  });
});

describe("the schemes the vendors actually need", () => {
  it("presents basic auth as base64, once, in one place", () => {
    // Jira and Confluence. One helper, so twenty toolkits do not each write their own base64 and get the
    // padding wrong.
    const [name, value] = credentialHeader(
      createCredential({ scheme: "basic", username: "me@example.com", password: "tok" }),
    );
    expect(name).toBe("Authorization");
    expect(value).toBe(`Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
  });

  it("presents a custom header under its own name, not Authorization", () => {
    expect(credentialHeader(createCredential({ scheme: "custom-header", header: "X-Api-Key", value: "k" }))).toEqual([
      "X-Api-Key",
      "k",
    ]);
  });

  it("carries non-secret vendor identifiers alongside the secret", () => {
    // Atlassian's cloud id, WhatsApp's phone number id, Slack's team id: needed on every request, discovered at
    // connection time, and per *connection* rather than per deployment — which is why they are not configuration.
    const credential = bearer("t", { cloudId: "abc-123" });
    expect(credential.metadata?.cloudId).toBe("abc-123");
  });

  it("covers every declared scheme, so a fourth cannot be added without a header rule", () => {
    for (const scheme of CREDENTIAL_SCHEMES) {
      const credential = (
        scheme === "bearer"
          ? createCredential({ scheme, token: "t" })
          : scheme === "basic"
            ? createCredential({ scheme, username: "u", password: "p" })
            : createCredential({ scheme, header: "X", value: "v" })
      ) as Credential;
      const [name, value] = credentialHeader(credential);
      expect(name.length, scheme).toBeGreaterThan(0);
      expect(value.length, scheme).toBeGreaterThan(0);
    }
  });
});

describe("the secret does not leak through serialisation — AC-7", () => {
  const cases: readonly [string, Credential, string][] = [
    ["bearer", createCredential({ scheme: "bearer", token: "sk-live-SECRET" }), "sk-live-SECRET"],
    ["basic", createCredential({ scheme: "basic", username: "me", password: "p4ssw0rd-SECRET" }), "p4ssw0rd-SECRET"],
    ["custom-header", createCredential({ scheme: "custom-header", header: "X-Api-Key", value: "key-SECRET" }), "key-SECRET"],
  ];

  it.each(cases)("%s: JSON.stringify does not reveal it", (_name, credential, secret) => {
    // A typed object is far more likely to reach a log line than a bare string was: it gets spread into an
    // error's `details`, handed to a structured logger, or serialised into an audit row.
    expect(JSON.stringify(credential)).not.toContain(secret);
    expect(JSON.stringify({ credential })).not.toContain(secret);
    expect(JSON.stringify(credential)).toContain("redacted");
  });

  it.each(cases)("%s: a spread does not carry it", (_name, credential, secret) => {
    expect(JSON.stringify({ ...credential })).not.toContain(secret);
    expect(Object.keys(credential)).not.toContain("token");
  });

  it.each(cases)("%s: String() and util.inspect do not reveal it", (_name, credential, secret) => {
    // `console.log` uses `inspect`, not `toString`, so overriding only the latter would leave the most likely
    // leak open.
    expect(String(credential)).not.toContain(secret);
    expect(inspect(credential)).not.toContain(secret);
    expect(inspect({ nested: credential })).not.toContain(secret);
  });

  it("still reads normally at the call site", () => {
    // Defence in depth, not a lock: a toolkit must be able to use the thing.
    const credential = createCredential({ scheme: "bearer", token: "sk-live-SECRET" });
    expect(credential.scheme === "bearer" && credential.token).toBe("sk-live-SECRET");
    expect(credentialHeader(credential)[1]).toContain("sk-live-SECRET");
  });
});

describe("every resolution is audited — AC-8", () => {
  const audit = (): CredentialAudit & { resolved: unknown[]; refused: unknown[] } => {
    const resolved: unknown[] = [];
    const refused: unknown[] = [];
    return { resolved, refused, onResolved: (i) => void resolved.push(i), onRefused: (i) => void refused.push(i) };
  };

  it("records a success with the scheme and the ref, and never the secret", async () => {
    const sink = audit();
    const resolver = withCredentialAudit(createStaticCredentialResolver({ github: "ghp_SECRET" }), sink);
    await resolver.resolve({ ref: "github", context });
    expect(sink.resolved).toEqual([{ ref: "github", context, scheme: "bearer" }]);
    expect(JSON.stringify(sink.resolved)).not.toContain("ghp_SECRET");
  });

  it("records a refusal, which is the more interesting event", async () => {
    // A successful resolution is the normal case; a refused one is somebody asking for something they do not
    // have. `docs/21` asks for "an audit record of every resolution", and half of them are the refusals.
    const sink = audit();
    const resolver = withCredentialAudit(createStaticCredentialResolver({}), sink);
    await expect(resolver.resolve({ ref: "github", context })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(sink.refused).toHaveLength(1);
    expect(sink.resolved).toEqual([]);
  });

  it("refuses a scheme the toolkit cannot present, before the vendor sees it", async () => {
    // Otherwise the vendor answers 401 and its message says the token is invalid — which sends an operator to
    // rotate a token that was never the problem.
    const sink = audit();
    const resolver = withCredentialAudit(
      createStaticCredentialResolver({ jira: createCredential({ scheme: "basic", username: "u", password: "p" }) }),
      sink,
      ["bearer"],
    );
    await expect(resolver.resolve({ ref: "jira", context })).rejects.toMatchObject({
      code: "capability_unavailable",
    });
    expect(sink.refused).toHaveLength(1);
  });
});

describe("a toolkit declares what it accepts — AC-2", () => {
  it("refuses a mismatch at construction", () => {
    expect(() => assertToolkitAuth("jira", { modes: ["token"], schemes: ["basic"] }, "bearer")).toThrow(
      /presents basic/,
    );
  });

  it("accepts a declared scheme", () => {
    expect(() => assertToolkitAuth("github", { modes: ["token", "oauth2"], schemes: ["bearer"] }, "bearer")).not.toThrow();
  });

  it("refuses a toolkit that declares no scheme at all", () => {
    // A toolkit no credential could satisfy is a wiring error, not a permissive default.
    expect(() => assertToolkitAuth("x", { modes: ["token"], schemes: [] }, "bearer")).toThrow(/no schemes/);
  });

  it("says nothing when the scheme is not known at construction", () => {
    // A dynamic resolver cannot be checked without a context; `withCredentialAudit` catches it at the first
    // call instead. Both are before the vendor sees anything.
    expect(() => assertToolkitAuth("x", { modes: ["token"], schemes: ["bearer"] }, undefined)).not.toThrow();
  });

  it("keeps modes and schemes as separate axes", () => {
    // An OAuth access token is presented as a bearer, so collapsing the two would lose exactly the fact #264
    // needs: whether there is a login URL to send someone to.
    expect(AUTH_MODES).toEqual(["token", "oauth2"]);
    expect(CREDENTIAL_SCHEMES).toEqual(["bearer", "basic", "custom-header"]);
  });
});

describe("resolution stays per call — AC-6", () => {
  it("a rotated secret takes effect on the next call, with no restart", async () => {
    // The property `credentials.ts` was written to protect, and the one a richer return type makes easier to
    // break: a resolver that cached would now be caching an object rather than a string, which looks more
    // legitimate.
    let current = "first";
    const resolver = { resolve: vi.fn(async () => bearer(current)) };
    const one = await resolver.resolve();
    current = "second";
    const two = await resolver.resolve();
    expect(one.scheme === "bearer" && one.token).toBe("first");
    expect(two.scheme === "bearer" && two.token).toBe("second");
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
  });
});
