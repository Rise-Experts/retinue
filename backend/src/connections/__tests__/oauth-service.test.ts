/**
 * Connect, disconnect, and the scope gap — task #262, AC-7, AC-8, AC-9 and AC-12.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import { createMemoryConnectionStore } from "../../adapters/memory/connections.js";
import { createAesGcmCipher } from "../cipher.js";
import { createConnectionCredentialResolver } from "../resolver.js";
import { createOAuthConnectionService, missingScopes } from "../oauth/service.js";
import type { OAuthProviderConfig } from "../oauth/index.js";

const context = (tenant = "t1"): ExecutionContext => ({
  tenantId: asId<TenantId>(tenant),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

const cipher = createAesGcmCipher({ keys: [{ id: "k1", key: Buffer.alloc(32, 3) }] });

const config = (over: Partial<OAuthProviderConfig & { revocationUrl?: string }> = {}) =>
  ({
    provider: "github",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: "client-123",
    clientSecret: "secret-456",
    scopes: ["repo"],
    redirectUris: ["https://app.example.com/cb"],
    ...over,
  }) as OAuthProviderConfig & { revocationUrl?: string };

const service = (over: Record<string, unknown> = {}) => {
  const store = createMemoryConnectionStore();
  return {
    store,
    svc: createOAuthConnectionService({
      store,
      cipher,
      config: config(),
      newId: () => "conn-1",
      ...over,
    } as never),
  };
};

describe("the exchange lands in the store — AC-8", () => {
  it("seals the token and keeps the non-secret parts readable", async () => {
    const { store, svc } = service();
    const connection = await svc.complete({
      context: context(),
      label: "Acme",
      tokens: {
        accessToken: "gho_SECRET",
        grantedScopes: ["repo"],
        metadata: { cloudId: "abc-123" },
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(connection.mode).toBe("oauth2");
    expect(connection.metadata?.cloudId).toBe("abc-123");
    expect(connection.grantedScopes).toEqual(["repo"]);
    expect(JSON.stringify(connection)).not.toContain("gho_SECRET");

    // And it resolves back to the real token.
    const credential = await createConnectionCredentialResolver({ store, cipher }).resolve({
      ref: "github",
      context: context(),
    });
    expect(credential.scheme === "bearer" && credential.token).toBe("gho_SECRET");
  });
});

describe("disconnect revokes at the provider first — AC-7", () => {
  it("calls the revocation endpoint, then removes it locally", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    const { store, svc } = service({ config: config({ revocationUrl: "https://github.com/revoke" }), fetchImpl });
    await svc.complete({ context: context(), tokens: { accessToken: "gho_SECRET" } });
    const result = await svc.disconnect({ context: context(), id: "conn-1" });
    expect(result.revokedAtProvider).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(await store.get({ tenantId: context().tenantId, id: "conn-1" })).toBeNull();
  });

  it("still removes it locally when the provider refuses, and says why", async () => {
    // A provider outage must not leave a connection nobody can remove.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);
    const { store, svc } = service({ config: config({ revocationUrl: "https://github.com/revoke" }), fetchImpl });
    await svc.complete({ context: context(), tokens: { accessToken: "gho_SECRET" } });
    const result = await svc.disconnect({ context: context(), id: "conn-1" });
    expect(result.revokedAtProvider).toBe(false);
    expect(result.reason).toMatch(/503/);
    expect(await store.get({ tenantId: context().tenantId, id: "conn-1" })).toBeNull();
  });

  it("reports a provider with no revocation endpoint rather than skipping silently", async () => {
    // A caller that believes a token was revoked when it was not will not go and remove it by hand.
    const { svc } = service();
    await svc.complete({ context: context(), tokens: { accessToken: "gho_SECRET" } });
    const result = await svc.disconnect({ context: context(), id: "conn-1" });
    expect(result.revokedAtProvider).toBe(false);
    expect(result.reason).toMatch(/no token revocation endpoint/);
  });

  it("refuses to disconnect another tenant's connection", async () => {
    const { svc } = service();
    await svc.complete({ context: context("t1"), tokens: { accessToken: "gho_SECRET" } });
    await expect(svc.disconnect({ context: context("t2"), id: "conn-1" })).rejects.toThrow(/no connection/);
  });
});

describe("the scope gap — AC-9", () => {
  it("reads what was granted, not what was requested", async () => {
    const { svc } = service();
    const connection = await svc.complete({
      context: context(),
      tokens: { accessToken: "gho", grantedScopes: ["repo"] },
    });
    expect(missingScopes(connection, ["repo"])).toEqual([]);
    expect(missingScopes(connection, ["repo", "admin:org"])).toEqual(["admin:org"]);
    expect(svc.scopeGap(connection, ["repo", "admin:org"])).toMatch(/Reconnect and grant admin:org/);
    expect(svc.scopeGap(connection, ["repo"])).toBeNull();
  });

  it("does not invent a refusal when the provider disclosed no scopes", async () => {
    // A connection with no recorded grant means the provider did not tell us — not that everything is missing.
    // Treating an absence as a refusal would block working connections.
    const { svc } = service();
    const connection = await svc.complete({ context: context(), tokens: { accessToken: "gho" } });
    expect(missingScopes(connection, ["anything"])).toEqual([]);
    expect(svc.scopeGap(connection, ["anything"])).toBeNull();
  });
});

describe("revocation takes effect on an in-flight run — AC-12", () => {
  it("the next tool call in the same run fails after a disconnect", async () => {
    /**
     * The property `docs/21` asks for, and it holds by construction rather than by a new mechanism: a
     * credential is resolved **per call**, so a run that already resolved one holds it only for that call and
     * the next one goes back to the store.
     *
     * `credentials.ts` chose per-call resolution to survive rotation. This is the second thing it buys, and it
     * is worth a test of its own because a future "optimisation" that cached a resolved credential for a run
     * would silently remove it.
     */
    const { store, svc } = service();
    await svc.complete({ context: context(), tokens: { accessToken: "gho_SECRET" } });
    const resolver = createConnectionCredentialResolver({ store, cipher });

    // First call in the run: resolves.
    const before = await resolver.resolve({ ref: "github", context: context() });
    expect(before.scheme === "bearer" && before.token).toBe("gho_SECRET");

    // Somebody disconnects while the run is in flight.
    await svc.disconnect({ context: context(), id: "conn-1" });

    // The next call in the *same* run fails, rather than reusing what it already had.
    await expect(resolver.resolve({ ref: "github", context: context() })).rejects.toThrow(
      /no github connection for this workspace/,
    );
  });
});
