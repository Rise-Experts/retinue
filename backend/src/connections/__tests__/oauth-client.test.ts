/**
 * Bring-your-own OAuth app — REQ-063 (#259), task #263.
 *
 * Not a nicety. Meta's app review is per app, so a shared app's approved use case may not cover a customer's;
 * X's access tier is per app, so a customer paying for a higher tier gains nothing from a shared one; and an
 * enterprise whose security team will not approve a third-party app in their Google tenant has no other route.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import { createMemoryConnectionStore } from "../../adapters/memory/connections.js";
import { createAesGcmCipher } from "../cipher.js";
import { createConnectionCredentialResolver } from "../resolver.js";
import {
  assertClientMatches,
  configForTenant,
  isAllowedRedirectForClient,
  registerTenantOAuthApp,
  resolveOAuthClient,
} from "../oauth/client.js";
import { createOAuthFlow, createMemoryOAuthAttemptStore, type OAuthProviderConfig } from "../oauth/index.js";

const context = (tenant = "t1"): ExecutionContext => ({
  tenantId: asId<TenantId>(tenant),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

const cipher = createAesGcmCipher({ keys: [{ id: "k1", key: Buffer.alloc(32, 5) }] });

const config: OAuthProviderConfig = {
  provider: "github",
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  clientId: "deployment-client",
  clientSecret: "deployment-secret",
  scopes: ["repo"],
  redirectUris: ["https://app.example.com/cb"],
};

const setup = () => ({ store: createMemoryConnectionStore(), cipher, config });

describe("which app a tenant connects through — AC-1", () => {
  it("uses the deployment's app when the tenant has registered none", async () => {
    const deps = { ...setup(), context: context() };
    const client = await resolveOAuthClient(deps);
    expect(client).toMatchObject({ clientId: "deployment-client", source: "deployment" });
  });

  it("uses the tenant's app when they have registered one", async () => {
    const deps = { ...setup(), context: context() };
    await registerTenantOAuthApp({
      ...deps,
      provider: "github",
      clientId: "acme-client",
      clientSecret: "acme-secret",
      redirectUris: ["https://acme.example.com/cb"],
    });
    const client = await resolveOAuthClient(deps);
    expect(client).toMatchObject({ clientId: "acme-client", source: "tenant", registrationId: "github-app" });
    expect(client.clientSecret).toBe("acme-secret");
  });

  it("reports which app it chose, so a fallback is never silent", async () => {
    // The whole reason `source` exists: a caller that logs or displays it can see the difference.
    const deps = { ...setup(), context: context() };
    expect((await resolveOAuthClient(deps)).source).toBe("deployment");
  });

  it("keeps one tenant's registration out of another's resolution", async () => {
    const shared = setup();
    await registerTenantOAuthApp({
      ...shared,
      context: context("t1"),
      provider: "github",
      clientId: "acme-client",
      clientSecret: "acme-secret",
      redirectUris: ["https://acme.example.com/cb"],
    });
    expect((await resolveOAuthClient({ ...shared, context: context("t2") })).source).toBe("deployment");
  });
});

describe("the client secret is stored like every other secret — AC-2", () => {
  it("is sealed, and does not appear in the stored row", async () => {
    const deps = { ...setup(), context: context() };
    const registration = await registerTenantOAuthApp({
      ...deps,
      provider: "github",
      clientId: "acme-client",
      clientSecret: "acme-SECRET",
      redirectUris: ["https://acme.example.com/cb"],
    });
    expect(JSON.stringify(registration)).not.toContain("acme-SECRET");
    // The client id stays readable: a settings screen should render without a key.
    expect(registration.metadata?.clientId).toBe("acme-client");
  });

  it("is not returned by a plain connection listing, so a resolver cannot hand it to a toolkit", async () => {
    // The discriminator is load-bearing. A credential resolver that received an app registration would present
    // a client secret to a vendor as a bearer token.
    const deps = { ...setup(), context: context() };
    await registerTenantOAuthApp({
      ...deps,
      provider: "github",
      clientId: "acme-client",
      clientSecret: "acme-SECRET",
      redirectUris: ["https://acme.example.com/cb"],
    });
    expect(await deps.store.list({ tenantId: context().tenantId })).toEqual([]);
    await expect(
      createConnectionCredentialResolver({ store: deps.store, cipher }).resolve({ ref: "github", context: context() }),
    ).rejects.toThrow(/no github connection/);
  });
});

describe("a tenant's redirect URI is still allowlisted — AC-3", () => {
  it("becomes the allowlist rather than widening it", async () => {
    // This is the obvious place the exact-match check gets loosened into a wildcard to make BYO work, and the
    // whole of #262's second defence would go with it.
    const deps = { ...setup(), context: context() };
    await registerTenantOAuthApp({
      ...deps,
      provider: "github",
      clientId: "acme-client",
      clientSecret: "acme-secret",
      redirectUris: ["https://acme.example.com/cb"],
    });
    const client = await resolveOAuthClient(deps);
    expect(isAllowedRedirectForClient(client, "https://acme.example.com/cb")).toBe(true);
    // Still exact: the attacker shapes from #262 are refused here too.
    for (const attacker of [
      "https://acme.example.com.evil.tld/cb",
      "https://acme.example.com/cb/",
      "http://acme.example.com/cb",
      // And the *deployment's* URI is not automatically allowed for a tenant running their own app.
      "https://app.example.com/cb",
    ]) {
      expect(isAllowedRedirectForClient(client, attacker), attacker).toBe(false);
    }
  });

  it("refuses a cleartext redirect URI at registration", async () => {
    const deps = { ...setup(), context: context() };
    await expect(
      registerTenantOAuthApp({
        ...deps,
        provider: "github",
        clientId: "acme",
        clientSecret: "s",
        redirectUris: ["http://acme.example.com/cb"],
      }).then(() => resolveOAuthClient(deps)),
    ).rejects.toThrow(/must be https/);
  });

  it("refuses a registration with no redirect URI, which could never complete a flow", async () => {
    const deps = { ...setup(), context: context() };
    await expect(
      registerTenantOAuthApp({ ...deps, provider: "github", clientId: "a", clientSecret: "s", redirectUris: [] }),
    ).rejects.toThrow(/at least one redirect URI/);
  });

  it("drives a flow with the tenant's config, refusing the deployment's redirect", async () => {
    const deps = { ...setup(), context: context() };
    await registerTenantOAuthApp({
      ...deps,
      provider: "github",
      clientId: "acme-client",
      clientSecret: "acme-secret",
      redirectUris: ["https://acme.example.com/cb"],
      scopes: ["repo", "admin:org"],
    });
    const client = await resolveOAuthClient(deps);
    const flow = createOAuthFlow({
      config: configForTenant(config, client),
      attempts: createMemoryOAuthAttemptStore(),
    });
    const { url } = await flow.start({ context: context(), redirectUri: "https://acme.example.com/cb" });
    expect(new URL(url).searchParams.get("client_id")).toBe("acme-client");
    // Scopes are per app — Meta's review is per app, so a tenant's may differ — AC-6.
    expect(new URL(url).searchParams.get("scope")).toBe("repo admin:org");
    await expect(flow.start({ context: context(), redirectUri: "https://app.example.com/cb" })).rejects.toThrow(
      /allowlist/,
    );
  });
});

describe("a token is not usable through a different client — AC-4", () => {
  const connection = (clientId?: string) =>
    ({
      id: "c1",
      provider: "github",
      mode: "oauth2" as const,
      scheme: "bearer" as const,
      ...(clientId === undefined ? {} : { metadata: { clientId } }),
      sealed: { keyId: "k1", algorithm: "aes-256-gcm", nonce: "AAAA", ciphertext: "AAAA" },
      createdAt: "t",
      updatedAt: "t",
    });

  it("fails loudly, naming both clients", async () => {
    // Refresh and revocation both authenticate as the client, so the provider's own answer is "invalid client"
    // — which reads as "your integration is broken" and sends nobody to the actual cause.
    expect(() =>
      assertClientMatches(connection("old-client"), {
        clientId: "new-client",
        redirectUris: [],
        scopes: [],
        source: "tenant",
      }),
    ).toThrow(/"old-client".*"new-client"/s);
  });

  it("passes when the client is the same", () => {
    expect(() =>
      assertClientMatches(connection("same"), { clientId: "same", redirectUris: [], scopes: [], source: "tenant" }),
    ).not.toThrow();
  });

  it("does not break connections created before client ids were recorded", () => {
    // Refusing those would break every existing connection to enforce a property they predate.
    expect(() =>
      assertClientMatches(connection(), { clientId: "anything", redirectUris: [], scopes: [], source: "deployment" }),
    ).not.toThrow();
  });
});

describe("removing a registration does not silently migrate connections — AC-7", () => {
  it("refuses an incomplete registration rather than falling back", async () => {
    // Falling back here is exactly the credential swap this AC forbids, and it would happen at the worst
    // moment — mid-migration.
    const deps = { ...setup(), context: context() };
    await deps.store.create({
      tenantId: context().tenantId,
      connection: {
        id: "github-app",
        kind: "oauth-app",
        provider: "github",
        mode: "oauth2",
        scheme: "bearer",
        // Registered without redirect URIs — a half-written row.
        metadata: { clientId: "acme-client" },
        sealed: await cipher.seal("s"),
      },
    });
    await expect(resolveOAuthClient(deps)).rejects.toThrow(/Refusing rather than falling back/);
  });

  it("leaves existing connections failing loudly once the registration is gone", async () => {
    // Not silently re-pointed at the shared app: the tokens were issued by a client that no longer
    // participates, and the shared app can neither refresh nor revoke them.
    const deps = { ...setup(), context: context() };
    await registerTenantOAuthApp({
      ...deps,
      provider: "github",
      clientId: "acme-client",
      clientSecret: "acme-secret",
      redirectUris: ["https://acme.example.com/cb"],
    });
    const existing = {
      id: "c1",
      provider: "github",
      mode: "oauth2" as const,
      scheme: "bearer" as const,
      metadata: { clientId: "acme-client" },
      sealed: await cipher.seal("gho"),
      createdAt: "t",
      updatedAt: "t",
    };
    // The registration is removed.
    await deps.store.revoke({ tenantId: context().tenantId, id: "github-app" });
    const now = await resolveOAuthClient(deps);
    expect(now.source).toBe("deployment");
    expect(() => assertClientMatches(existing, now)).toThrow(/cannot be used/);
  });
});
