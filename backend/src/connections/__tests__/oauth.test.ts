/**
 * The OAuth flow — REQ-063 (#259), task #262.
 *
 * This is the piece where a mistake is *exploitable* rather than merely broken, so almost every test here is a
 * sabotage. The three attacks the flow defends against are not theoretical; all three are routine findings.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { PrincipalId, TenantId } from "../../core/ids.js";
import {
  codeChallengeOf,
  createMemoryOAuthAttemptStore,
  createOAuthFlow,
  isAllowedRedirect,
  type OAuthProviderConfig,
} from "../oauth/index.js";

const REDIRECT = "https://app.example.com/oauth/callback";

const context = (tenant = "t1", principal = "p1"): ExecutionContext => ({
  tenantId: asId<TenantId>(tenant),
  principalId: asId<PrincipalId>(principal),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

const config = (over: Partial<OAuthProviderConfig> = {}): OAuthProviderConfig => ({
  provider: "github",
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  clientId: "client-123",
  clientSecret: "secret-456",
  scopes: ["repo", "read:org"],
  redirectUris: [REDIRECT],
  ...over,
});

const tokenResponse = (payload: Record<string, unknown> = {}) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "gho_ACCESS", token_type: "bearer", ...payload }),
  }) as unknown as Response;

const flow = (over: Parameters<typeof createOAuthFlow>[0] extends infer T ? Partial<T> : never = {}) =>
  createOAuthFlow({
    config: config(),
    attempts: createMemoryOAuthAttemptStore(),
    fetchImpl: vi.fn(async () => tokenResponse()) as unknown as typeof fetch,
    ...over,
  } as Parameters<typeof createOAuthFlow>[0]);

describe("attack 1: a state not bound to the session", () => {
  it("refuses a replayed state — take-once, not get-then-delete", async () => {
    // A replay window is the whole attack: an attacker who observes one callback can drive it again.
    const oauth = flow();
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    await expect(oauth.callback({ state, code: "c", context: context() })).resolves.toBeDefined();
    await expect(oauth.callback({ state, code: "c", context: context() })).rejects.toThrow(/not valid/);
  });

  it("refuses a state issued for another tenant", async () => {
    // The login-CSRF: an attacker completes their own consent and gets the code delivered into the victim's
    // session, so the victim's tenant ends up holding an attacker-controlled connection — and every action the
    // agent then takes against that provider is the attacker's account.
    const oauth = flow();
    const { state } = await oauth.start({ context: context("attacker"), redirectUri: REDIRECT });
    await expect(oauth.callback({ state, code: "c", context: context("victim") })).rejects.toThrow(/not valid/);
  });

  it("refuses a state issued for another principal in the same tenant", async () => {
    // Same tenant is not the same person: a code must not be redeemable by a colleague.
    const oauth = flow();
    const { state } = await oauth.start({ context: context("t1", "alice"), redirectUri: REDIRECT });
    await expect(oauth.callback({ state, code: "c", context: context("t1", "bob") })).rejects.toThrow(/not valid/);
  });

  it("refuses an expired state", async () => {
    let clock = 1_000_000;
    // One clock, injected into the flow. The store deliberately does not judge expiry — see the port's note.
    const oauth = flow({ now: () => clock, stateTtlMs: 1_000 });
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    clock += 1_001;
    await expect(oauth.callback({ state, code: "c", context: context() })).rejects.toThrow(/not valid/);
  });

  it("refuses a state nobody issued", async () => {
    await expect(flow().callback({ state: "made-up", code: "c", context: context() })).rejects.toThrow(/not valid/);
  });

  it("gives the same message for every state failure, so the callback is not an oracle", async () => {
    // Distinguishing "unknown" from "expired" from "wrong tenant" tells an attacker whether a state existed,
    // which is enough to confirm a guess.
    const oauth = flow();
    const { state } = await oauth.start({ context: context("a"), redirectUri: REDIRECT });
    const messages: string[] = [];
    for (const attempt of [
      () => oauth.callback({ state: "unknown", code: "c", context: context("a") }),
      () => oauth.callback({ state, code: "c", context: context("b") }),
    ]) {
      await attempt().catch((e: Error) => messages.push(e.message));
    }
    expect(new Set(messages).size).toBe(1);
  });

  it("does not contact the provider when the state is bad", async () => {
    // Every check that can be made without the provider is made first, so probing the callback never causes an
    // outbound request — and never spends a real code.
    const fetchImpl = vi.fn(async () => tokenResponse());
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await oauth.callback({ state: "nope", code: "c", context: context() }).catch(() => undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("attack 2: an unallowlisted redirect_uri", () => {
  it("matches exactly, so a prefix cannot be extended into another host", () => {
    // `https://app.example.com.evil.tld` starts with `https://app.example.com`. A prefix check accepts it.
    expect(isAllowedRedirect([REDIRECT], REDIRECT)).toBe(true);
    for (const attacker of [
      "https://app.example.com.evil.tld/oauth/callback",
      "https://app.example.com/oauth/callback/../../evil",
      "https://app.example.com:8443/oauth/callback",
      "https://app.example.com/oauth/callback?next=https://evil.tld",
      "http://app.example.com/oauth/callback",
      "https://app.example.com/oauth/callback/",
    ]) {
      expect(isAllowedRedirect([REDIRECT], attacker), attacker).toBe(false);
    }
  });

  it("refuses at start, before an attempt is stored", async () => {
    // So an attacker probing redirects leaves nothing behind to replay.
    const attempts = createMemoryOAuthAttemptStore();
    const put = vi.spyOn(attempts, "put");
    const oauth = flow({ attempts });
    await expect(
      oauth.start({ context: context(), redirectUri: "https://evil.tld/callback" }),
    ).rejects.toThrow(/allowlist/);
    expect(put).not.toHaveBeenCalled();
  });

  it("exchanges with the recorded redirect, never one from the request", async () => {
    // Taking it from the request would let an attacker choose both halves of the pair the provider checks.
    const fetchImpl = vi.fn(async () => tokenResponse());
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    await oauth.callback({ state, code: "c", context: context() });
    const body = String((fetchImpl.mock.calls[0]?.[1] as { body: string }).body);
    expect(new URLSearchParams(body).get("redirect_uri")).toBe(REDIRECT);
  });
});

describe("attack 3: no PKCE", () => {
  it("sends an S256 challenge and keeps the verifier server-side", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse());
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { url } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    const params = new URL(url).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    const challenge = params.get("code_challenge") ?? "";
    expect(challenge.length).toBeGreaterThan(0);
    // The verifier must not be in the URL: sending it to the browser defeats PKCE entirely, since the point is
    // that only the party that began the flow can finish it.
    expect(url).not.toContain("code_verifier");
  });

  it("sends the verifier on the exchange, and it matches the challenge", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse());
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { url, state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    const challenge = new URL(url).searchParams.get("code_challenge");
    await oauth.callback({ state, code: "c", context: context() });
    const verifier = new URLSearchParams(String((fetchImpl.mock.calls[0]?.[1] as { body: string }).body)).get(
      "code_verifier",
    );
    expect(verifier).toBeTruthy();
    expect(codeChallengeOf(verifier!)).toBe(challenge);
    // And the challenge really is S256 of the verifier, not the verifier itself — "plain" is PKCE in name only.
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(challenge);
  });

  it("is on by default, including when a client secret is configured", async () => {
    // "We have a secret so we do not need PKCE" is an argument about one threat, and PKCE defends another.
    const { url } = await flow().start({ context: context(), redirectUri: REDIRECT });
    expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("can be turned off for a provider that rejects it, and then sends nothing", async () => {
    const oauth = flow({ config: config({ usePkce: false }) });
    const { url } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    expect(new URL(url).searchParams.get("code_challenge")).toBeNull();
  });
});

describe("the authorization URL", () => {
  it("carries the parameters a provider needs, and the requested scopes", async () => {
    const { url, state } = await flow().start({ context: context(), redirectUri: REDIRECT });
    const params = new URL(url).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("client-123");
    expect(params.get("redirect_uri")).toBe(REDIRECT);
    expect(params.get("scope")).toBe("repo read:org");
    expect(params.get("state")).toBe(state);
  });

  it("never carries the client secret", async () => {
    // It goes in the token request body, over the back channel. A secret in a URL is in the browser's history,
    // the referrer header and every proxy log on the way.
    const { url } = await flow().start({ context: context(), redirectUri: REDIRECT });
    expect(url).not.toContain("secret-456");
  });

  it("honours per-request scopes, which a tenant's own app may differ on", async () => {
    const { url } = await flow().start({ context: context(), redirectUri: REDIRECT, scopes: ["read:user"] });
    expect(new URL(url).searchParams.get("scope")).toBe("read:user");
  });

  it("issues a distinct state per attempt", async () => {
    const oauth = flow();
    const a = await oauth.start({ context: context(), redirectUri: REDIRECT });
    const b = await oauth.start({ context: context(), redirectUri: REDIRECT });
    expect(a.state).not.toBe(b.state);
  });
});

describe("the token exchange", () => {
  it("records the scopes the provider GRANTED, not the ones requested", async () => {
    // A provider may grant fewer. #259's AC-7 — telling somebody to reconnect and grant X rather than
    // surfacing a 403 — is answerable only from what was actually granted.
    const fetchImpl = vi.fn(async () => tokenResponse({ scope: "repo" }));
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT, scopes: ["repo", "read:org"] });
    const { tokens } = await oauth.callback({ state, code: "c", context: context() });
    expect(tokens.grantedScopes).toEqual(["repo"]);
  });

  it("turns expires_in into an absolute instant", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({ expires_in: 3600 }));
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_700_000_000_000 });
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    const { tokens } = await oauth.callback({ state, code: "c", context: context() });
    expect(tokens.expiresAt).toBe(new Date(1_700_000_000_000 + 3_600_000).toISOString());
  });

  it("keeps a refresh token when one is returned", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({ refresh_token: "ghr_REFRESH" }));
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    const { tokens } = await oauth.callback({ state, code: "c", context: context() });
    expect(tokens.refreshToken).toBe("ghr_REFRESH");
  });

  it("does not echo the provider's error body", async () => {
    // A provider's error routinely quotes the request, which carries the client secret and the code.
    const fetchImpl = vi.fn(
      async () =>
        ({ ok: false, status: 401, json: async () => ({ error: "bad", request: "client_secret=secret-456" }) }) as unknown as Response,
    );
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    // A fresh attempt per assertion: a state is take-once, so reusing one here would fail for the *other*
    // reason and the assertion would prove nothing.
    const first = await oauth.start({ context: context(), redirectUri: REDIRECT });
    await expect(oauth.callback({ state: first.state, code: "c", context: context() })).rejects.toThrow(/status 401/);
    const second = await oauth.start({ context: context(), redirectUri: REDIRECT });
    const thrown = await oauth
      .callback({ state: second.state, code: "c", context: context() })
      .then(() => null, (e: Error) => e);
    expect(thrown?.message).not.toContain("secret-456");
  });

  it("refuses a response with no access token rather than storing an empty credential", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    await expect(oauth.callback({ state, code: "c", context: context() })).rejects.toThrow(/no access_token/);
  });

  it("refuses an empty code without contacting the provider", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse());
    const oauth = flow({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { state } = await oauth.start({ context: context(), redirectUri: REDIRECT });
    await expect(oauth.callback({ state, code: "", context: context() })).rejects.toThrow(/no authorization code/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("provider endpoints must be https", () => {
  it("refuses a cleartext token endpoint at construction", () => {
    // The token request body carries the client secret and the authorization code. Over cleartext both are
    // readable by anything on the path, and the failure is completely silent — the flow works.
    expect(() =>
      createOAuthFlow({
        config: config({ tokenUrl: "http://github.com/login/oauth/access_token" }),
        attempts: createMemoryOAuthAttemptStore(),
      }),
    ).toThrow(/must be https/);
  });

  it("refuses a cleartext authorization endpoint too", () => {
    expect(() =>
      createOAuthFlow({
        config: config({ authorizationUrl: "http://github.com/login/oauth/authorize" }),
        attempts: createMemoryOAuthAttemptStore(),
      }),
    ).toThrow(/must be https/);
  });

  it("allows http on localhost, so a provider emulator does not push anybody to disable the check", () => {
    // A check people turn off is a check that stops applying in production too.
    expect(() =>
      createOAuthFlow({
        config: config({ tokenUrl: "http://localhost:8080/token", authorizationUrl: "http://127.0.0.1:8080/auth" }),
        attempts: createMemoryOAuthAttemptStore(),
      }),
    ).not.toThrow();
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() =>
      createOAuthFlow({ config: config({ tokenUrl: "not-a-url" }), attempts: createMemoryOAuthAttemptStore() }),
    ).toThrow(/is not a URL/);
  });
});
