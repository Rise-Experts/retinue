/**
 * Refreshable credentials — REQ-054 (#232), task #233.
 *
 * Two of these must not be waved through. **AC-2**: twenty concurrent calls on an expired token must produce
 * exactly one refresh, because several vendors invalidate the previous refresh token when one is used and N
 * concurrent refreshes race to log the deployment out permanently. **AC-4**: two tenants naming the same
 * credential must never see each other's token, which is the failure #91 already found once in another store.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "../../core/ids.js";

import { asId } from "../../core/ids.js";
import type { ExecutionContext } from "../../core/context.js";
import {
  bearer,
  createStaticCredentialResolver,
  DEFAULT_REFRESH_SKEW_MS,
  isExpiring,
  isGrantError,
  isRefreshable,
  refreshable,
  withCredentialAudit,
  withRefreshingCredentials,
  type Credential,
  type CredentialRefresher,
  type CredentialResolver,
  type RefreshableCredential,
} from "../credentials.js";

const contextFor = (tenant: string): ExecutionContext => ({
  tenantId: asId(tenant),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
});

const T1 = contextFor("tenant-1");
const T2 = contextFor("tenant-2");

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

/**
 * A refreshable bearer, built through `refreshable()`.
 *
 * The first version of this helper spread the credential and re-added the token —
 * `{ ...bearer(value), expiresAt, token: value }` — which silently turned the non-enumerable secret into an
 * enumerable one and failed the AC-6 serialisation test. That is exactly the mistake a host writing a
 * `CredentialRefresher` would make, so `refreshable()` exists rather than this helper being quietly fixed.
 */
const token = (value: string, expiresAt: string): RefreshableCredential => refreshable(bearer(value), expiresAt);

/** A resolver that always returns the same stored credential, as a host's would before any refresh. */
const staticResolver = (byTenant: Readonly<Record<string, Credential>>): CredentialResolver => ({
  async resolve({ context }) {
    const credential = byTenant[String(context.tenantId)];
    if (credential === undefined) throw new Error("no credential");
    return credential;
  },
});

describe("the type is additive — AC-1", () => {
  it("passes a plain credential straight through, untouched", async () => {
    /**
     * The whole of AC-1: a resolver returning a credential with no expiry is unchanged, which is why the eight
     * shipped toolkits compile and pass without a line changing.
     */
    const refresher: CredentialRefresher = { refresh: vi.fn() };
    const resolver = withRefreshingCredentials(createStaticCredentialResolver({ github: "ghp_x" }), refresher);
    const credential = await resolver.resolve({ ref: "github", context: T1 });
    expect(credential.scheme).toBe("bearer");
    expect((credential as { token: string }).token).toBe("ghp_x");
    expect(refresher.refresh).not.toHaveBeenCalled();
  });

  it("recognises a refreshable credential by its expiry and nothing else", () => {
    expect(isRefreshable(bearer("x"))).toBe(false);
    expect(isRefreshable(token("x", at(60_000)))).toBe(true);
  });

  it("still composes with the audit wrapper", async () => {
    // The two wrappers are independent and a host will use both; one swallowing the other's behaviour would be
    // found only in production.
    const resolved: string[] = [];
    const resolver = withCredentialAudit(
      withRefreshingCredentials(staticResolver({ "tenant-1": token("live", at(3_600_000)) }), { refresh: vi.fn() }, { now: () => NOW }),
      { onResolved: ({ ref }) => void resolved.push(ref), onRefused: () => {} },
    );
    await resolver.resolve({ ref: "google", context: T1 });
    expect(resolved).toEqual(["google"]);
  });
});

describe("refresh is time-driven — AC-5", () => {
  it("leaves a credential alone while it is comfortably valid", async () => {
    const refresher: CredentialRefresher = { refresh: vi.fn() };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("live", at(3_600_000)) }),
      refresher,
      { now: () => NOW },
    );
    expect((await resolver.resolve({ ref: "google", context: T1 })) as unknown as { token: string }).toMatchObject({
      token: "live",
    });
    expect(refresher.refresh).not.toHaveBeenCalled();
  });

  it("replaces one that expires inside the skew window, before it is used", async () => {
    /**
     * The point of a skew at all. A tool call can take tens of seconds, so a token valid at the start must be
     * valid on arrival — refreshing exactly at expiry makes "expired mid-flight" the common case, and that
     * failure looks like an intermittent authentication bug.
     */
    const refresher: CredentialRefresher = { refresh: vi.fn(async () => token("fresh", at(3_600_000))) };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("nearly-dead", at(10_000)) }),
      refresher,
      { now: () => NOW },
    );
    const credential = (await resolver.resolve({ ref: "google", context: T1 })) as unknown as { token: string };
    expect(credential.token).toBe("fresh");
    expect(refresher.refresh).toHaveBeenCalledTimes(1);
  });

  it("honours a configured skew, in both directions", async () => {
    const stored = token("t", at(120_000));
    const wide: CredentialRefresher = { refresh: vi.fn(async () => token("fresh", at(3_600_000))) };
    const narrow: CredentialRefresher = { refresh: vi.fn(async () => token("fresh", at(3_600_000))) };
    await withRefreshingCredentials(staticResolver({ "tenant-1": stored }), wide, { skewMs: 300_000, now: () => NOW })
      .resolve({ ref: "g", context: T1 });
    await withRefreshingCredentials(staticResolver({ "tenant-1": stored }), narrow, { skewMs: 30_000, now: () => NOW })
      .resolve({ ref: "g", context: T1 });
    expect(wide.refresh).toHaveBeenCalledTimes(1);
    expect(narrow.refresh).not.toHaveBeenCalled();
  });

  it("defaults to a minute, which is a commitment rather than a guess", () => {
    expect(DEFAULT_REFRESH_SKEW_MS).toBe(60_000);
    expect(isExpiring(token("t", at(30_000)), DEFAULT_REFRESH_SKEW_MS, NOW)).toBe(true);
    expect(isExpiring(token("t", at(90_000)), DEFAULT_REFRESH_SKEW_MS, NOW)).toBe(false);
  });

  it("treats an unparseable expiry as expiring rather than trusting it", () => {
    // The alternative is using a credential whose lifetime is unknown; an unnecessary refresh costs one call.
    expect(isExpiring(token("t", "not a date"), 0, NOW)).toBe(true);
  });

  it("never refreshes on a 401, because a 401 is four different things — AC-7", async () => {
    /**
     * There is deliberately no 401 hook to test, so this asserts the absence: the wrapper's only input is
     * time. Refreshing on 401 turns a *revoked* grant into an infinite loop against the token endpoint, and a
     * missing scope into a refresh that succeeds and a call that fails again identically.
     */
    const refresher: CredentialRefresher = { refresh: vi.fn() };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("live", at(3_600_000)) }),
      refresher,
      { now: () => NOW },
    );
    // A caller that saw a 401 has nothing to call: resolving again returns the same valid token.
    for (let i = 0; i < 5; i += 1) await resolver.resolve({ ref: "google", context: T1 });
    expect(refresher.refresh).not.toHaveBeenCalled();
  });
});

describe("twenty concurrent calls produce one refresh — AC-2", () => {
  it("collapses a stampede into a single refresh", async () => {
    /**
     * The failure this prevents is not a slow test, it is a **permanent logout**: several vendors invalidate
     * the previous refresh token when one is used, so twenty concurrent refreshes race to invalidate each
     * other's result and the grant is unrecoverable.
     */
    let refreshes = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresher: CredentialRefresher = {
      async refresh() {
        refreshes += 1;
        // Held open so all twenty callers are genuinely in flight together, rather than serialised by luck.
        await gate;
        return token("fresh", at(3_600_000));
      },
    };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("dead", at(-1_000)) }),
      refresher,
      { now: () => NOW },
    );

    const calls = Array.from({ length: 20 }, () => resolver.resolve({ ref: "google", context: T1 }));
    release?.();
    const results = (await Promise.all(calls)) as unknown as { token: string }[];

    expect(refreshes).toBe(1);
    // And every one of them got the *new* token, not a mix.
    for (const credential of results) expect(credential.token).toBe("fresh");
  });

  it("does not hold the in-flight promise after it settles", async () => {
    // A stale in-flight entry would pin the first refreshed token forever, and the next expiry would never be
    // acted on.
    let refreshes = 0;
    let clock = NOW;
    const refresher: CredentialRefresher = {
      async refresh() {
        refreshes += 1;
        return token(`fresh-${refreshes}`, new Date(clock + 120_000).toISOString());
      },
    };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("dead", at(-1_000)) }),
      refresher,
      { now: () => clock, skewMs: 1_000 },
    );
    await resolver.resolve({ ref: "g", context: T1 });
    clock += 200_000; // the refreshed token has now expired too
    const second = (await resolver.resolve({ ref: "g", context: T1 })) as unknown as { token: string };
    expect(refreshes).toBe(2);
    expect(second.token).toBe("fresh-2");
  });

  it("lets a later caller retry after a failed refresh, rather than caching the failure", async () => {
    let attempts = 0;
    const refresher: CredentialRefresher = {
      async refresh() {
        attempts += 1;
        if (attempts === 1) throw new Error("network down");
        return token("fresh", at(3_600_000));
      },
    };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("dead", at(-1_000)) }),
      refresher,
      { now: () => NOW },
    );
    await expect(resolver.resolve({ ref: "g", context: T1 })).rejects.toThrow();
    const recovered = (await resolver.resolve({ ref: "g", context: T1 })) as unknown as { token: string };
    expect(recovered.token).toBe("fresh");
  });
});

describe("a dead grant and a dead network are different — AC-3", () => {
  const failing = (reason: string): CredentialRefresher => ({
    async refresh() {
      throw new Error(reason);
    },
  });
  const resolverFor = (refresher: CredentialRefresher) =>
    withRefreshingCredentials(staticResolver({ "tenant-1": token("dead", at(-1_000)) }), refresher, { now: () => NOW });

  it("surfaces invalid_grant as non-retryable and names re-consent", async () => {
    const error = (await resolverFor(failing("invalid_grant: token revoked"))
      .resolve({ ref: "google", context: T1 })
      .catch((thrown: unknown) => thrown)) as { code: string; retryable: boolean; message: string };
    expect(error.code).toBe("unauthorized");
    expect(error.retryable).toBe(false);
    // A person has to act; the message says so rather than leaving a model to retry forever.
    expect(error.message).toContain("connect the account again");
    expect(error.message).toContain("retrying will not help");
  });

  it("treats every grant-death code the same way", async () => {
    for (const reason of ["invalid_client", "unauthorized_client", "access_denied"]) {
      const error = (await resolverFor(failing(reason))
        .resolve({ ref: "g", context: T1 })
        .catch((thrown: unknown) => thrown)) as { retryable: boolean };
      expect(error.retryable, reason).toBe(false);
    }
  });

  it("surfaces a network failure as retryable", async () => {
    const error = (await resolverFor(failing("fetch failed: ETIMEDOUT"))
      .resolve({ ref: "google", context: T1 })
      .catch((thrown: unknown) => thrown)) as { code: string; retryable: boolean };
    expect(error.code).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
  });

  it("classifies by the code, not by whether the word 'invalid' appears", () => {
    expect(isGrantError(new Error("invalid_grant"))).toBe(true);
    expect(isGrantError(new Error("HTTP 400: invalid_request"))).toBe(false);
    expect(isGrantError(new Error("socket hang up"))).toBe(false);
  });
});

describe("two tenants never see each other's token — AC-4", () => {
  it("keeps them apart when both name the same credential and one refreshes", async () => {
    /**
     * The sabotage this AC asks for, and the reason the cache is keyed by tenant *and* ref rather than ref
     * alone. Both tenants call their credential "google"; a cache keyed by name would hand tenant B whatever
     * tenant A last refreshed, and the symptom would be one customer reading another's mailbox.
     */
    const refreshed: string[] = [];
    const refresher: CredentialRefresher = {
      async refresh({ context }) {
        const value = `fresh-${String(context.tenantId)}`;
        refreshed.push(value);
        return token(value, at(3_600_000));
      },
    };
    const resolver = withRefreshingCredentials(
      staticResolver({
        "tenant-1": token("dead-1", at(-1_000)),
        "tenant-2": token("dead-2", at(-1_000)),
      }),
      refresher,
      { now: () => NOW },
    );

    // Tenant A refreshes first; tenant B must not inherit the result.
    const a = (await resolver.resolve({ ref: "google", context: T1 })) as unknown as { token: string };
    const b = (await resolver.resolve({ ref: "google", context: T2 })) as unknown as { token: string };

    expect(a.token).toBe("fresh-tenant-1");
    expect(b.token).toBe("fresh-tenant-2");
    expect(refreshed).toEqual(["fresh-tenant-1", "fresh-tenant-2"]);

    // And the cached path stays separated on a second pass, which is where a shared cache would show.
    expect(((await resolver.resolve({ ref: "google", context: T2 })) as unknown as { token: string }).token).toBe(
      "fresh-tenant-2",
    );
    expect(((await resolver.resolve({ ref: "google", context: T1 })) as unknown as { token: string }).token).toBe(
      "fresh-tenant-1",
    );
  });

  it("does not collapse two tenants' concurrent refreshes into one", async () => {
    // Single-flight is per key, not global. Sharing it across tenants would be the same leak arriving by a
    // different route — and would look like a *feature* to somebody reading only AC-2.
    let refreshes = 0;
    const refresher: CredentialRefresher = {
      async refresh({ context }) {
        refreshes += 1;
        return token(`fresh-${String(context.tenantId)}`, at(3_600_000));
      },
    };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("d1", at(-1_000)), "tenant-2": token("d2", at(-1_000)) }),
      refresher,
      { now: () => NOW },
    );
    const [a, b] = (await Promise.all([
      resolver.resolve({ ref: "google", context: T1 }),
      resolver.resolve({ ref: "google", context: T2 }),
    ])) as unknown as { token: string }[];
    expect(refreshes).toBe(2);
    expect(a?.token).toBe("fresh-tenant-1");
    expect(b?.token).toBe("fresh-tenant-2");
  });

  it("keeps two refs apart within one tenant", async () => {
    const refresher: CredentialRefresher = {
      async refresh({ ref }) {
        return token(`fresh-${ref}`, at(3_600_000));
      },
    };
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("dead", at(-1_000)) }),
      refresher,
      { now: () => NOW },
    );
    const google = (await resolver.resolve({ ref: "google", context: T1 })) as unknown as { token: string };
    const azure = (await resolver.resolve({ ref: "azure", context: T1 })) as unknown as { token: string };
    expect(google.token).toBe("fresh-google");
    expect(azure.token).toBe("fresh-azure");
  });
});

describe("no token reaches a log, an audit record or an error — AC-6", () => {
  it("keeps the secret out of the refreshed credential's serialisation", async () => {
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("dead", at(-1_000)) }),
      { async refresh() { return token("super-secret-value", at(3_600_000)); } },
      { now: () => NOW },
    );
    const credential = await resolver.resolve({ ref: "google", context: T1 });
    expect(JSON.stringify(credential)).not.toContain("super-secret-value");
    expect(String(credential)).not.toContain("super-secret-value");
    // It still reads normally, which is the whole point of non-enumerability rather than removal.
    expect((credential as unknown as { token: string }).token).toBe("super-secret-value");
  });

  it("keeps it out of the error when a refresh fails", async () => {
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("super-secret-value", at(-1_000)) }),
      { async refresh() { throw new Error("invalid_grant"); } },
      { now: () => NOW },
    );
    const error = (await resolver
      .resolve({ ref: "google", context: T1 })
      .catch((thrown: unknown) => thrown)) as Error & { details?: unknown };
    // The serialisation, not just the message — an error reaches a log through `JSON.stringify` more often
    // than through `.message`.
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain("super-secret-value");
    expect(error.message).not.toContain("super-secret-value");
  });

  it("tells the refresh hook the expiry and never the token", async () => {
    const seen: unknown[] = [];
    const resolver = withRefreshingCredentials(
      staticResolver({ "tenant-1": token("dead", at(-1_000)) }),
      { async refresh() { return token("super-secret-value", at(3_600_000)); } },
      { now: () => NOW, onRefreshed: (input) => void seen.push(input) },
    );
    await resolver.resolve({ ref: "google", context: T1 });
    expect(JSON.stringify(seen)).not.toContain("super-secret-value");
    expect(seen[0]).toMatchObject({ ref: "google", tenantId: "tenant-1" });
    // The expiry is not a secret and is the one thing an operator debugging a refresh loop needs.
    expect((seen[0] as { expiresAt: string }).expiresAt).toBe(at(3_600_000));
  });

  it("keeps it out of the audit record when the two wrappers are composed", async () => {
    const records: unknown[] = [];
    const resolver = withCredentialAudit(
      withRefreshingCredentials(
        staticResolver({ "tenant-1": token("dead", at(-1_000)) }),
        { async refresh() { return token("super-secret-value", at(3_600_000)); } },
        { now: () => NOW },
      ),
      {
        onResolved: (input) => void records.push(input),
        onRefused: (input) => void records.push(input),
      },
    );
    await resolver.resolve({ ref: "google", context: T1 });
    expect(JSON.stringify(records)).not.toContain("super-secret-value");
  });
});
