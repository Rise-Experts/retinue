/**
 * OAuth 2.0, authorization-code with PKCE — REQ-063 (#259), task #262.
 *
 * Shipped so a deployment mounts a flow rather than implementing one. That matters beyond convenience: this is
 * the piece where a mistake is *exploitable* rather than merely broken, and twenty deployments writing it
 * themselves is twenty chances at the same three mistakes.
 *
 * ## The three ways an OAuth callback is attacked
 *
 * Each has its own defence here and its own sabotage test. None is theoretical; all three are routine findings.
 *
 * **1. No `state`, or a `state` not bound to the session.** An attacker completes their own consent and gets
 * their code delivered into the victim's session — the victim's tenant ends up holding an attacker-controlled
 * connection, which is a *login CSRF* and is worse than it sounds: every subsequent action the agent takes
 * against that provider is the attacker's account. So `state` is single-use, TTL-bounded, and bound to the
 * tenant *and* the principal who started it, verified before the code is touched.
 *
 * **2. An unallowlisted `redirect_uri`.** Any reflection of a caller-supplied redirect turns the callback into
 * an open redirect and the code into a token somebody else holds. Redirect URIs come from configuration and are
 * matched **exactly** — no prefix matching, which `https://app.example.com.evil.tld` defeats, and no wildcard
 * subdomains.
 *
 * **3. No PKCE.** With a public client, or an intercepted code, the verifier is what stops the exchange. Used
 * everywhere the provider supports it rather than only where a client secret is absent, because "we have a
 * secret so we do not need PKCE" is an argument about one threat and PKCE defends another.
 *
 * ## What is deliberately not here
 *
 * No transport. This produces a URL, consumes a callback, and returns a `Connection` — a host mounts it on its
 * own router with its own authentication, exactly as `./mcp-server` leaves the transport to the host. A
 * convenience wrapper would have to guess at the authentication, and guessing about authentication is how a
 * surface ends up open.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AgentPlatformError } from "../../core/errors.js";
import type { ExecutionContext } from "../../core/context.js";

/** How long an authorization attempt may stay open. Long enough to read a consent screen, not to leave open. */
export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthProviderConfig = {
  readonly provider: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Absent for a public client. PKCE is used either way. */
  readonly clientSecret?: string;
  readonly scopes: readonly string[];
  /**
   * Every redirect URI this provider may return to. **Matched exactly.**
   *
   * A list rather than one value, because a deployment legitimately has several environments — and a list is
   * still an allowlist. What it must never become is a prefix or a pattern.
   */
  readonly redirectUris: readonly string[];
  /** Some providers need extra authorization parameters (`access_type=offline`, `prompt=consent`). */
  readonly extraAuthorizationParams?: Readonly<Record<string, string>>;
  /** Providers that reject PKCE outright. Absent means use it — the safe default. */
  readonly usePkce?: boolean;
};

/**
 * One in-flight authorization attempt.
 *
 * The verifier is here and **never leaves the server**: sending it to the browser would defeat PKCE entirely,
 * since the whole point is that only the party that began the flow can finish it.
 */
export type OAuthAttempt = {
  readonly state: string;
  readonly provider: string;
  readonly tenantId: string;
  /** Who began it. A code must not be redeemable by a different person in the same tenant. */
  readonly principalId: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
  readonly expiresAt: number;
  /** Where to send the person afterwards. Validated by the host, not reflected from the request. */
  readonly returnTo?: string;
};

/**
 * Where in-flight attempts live.
 *
 * A port, because the answer differs by deployment shape: one process can hold a `Map`, and several behind a
 * load balancer cannot — the callback may land on a different instance from the one that started the flow.
 *
 * `consume` is **take-once**: it returns the attempt and removes it in the same step. A `get` followed by a
 * `delete` is a replay window, and a replay window is the first attack in the list above.
 *
 * **The store does not judge expiry.** The flow writes `expiresAt` from its own clock and checks it with the
 * same one; a store that also checked would be a *second* clock deciding one fact, and injecting a clock into
 * one and not the other yields attempts that are expired the instant they are written. Found by a test doing
 * exactly that. The store still drops stale entries as housekeeping — that is a memory concern, not a security
 * decision.
 */
export interface OAuthAttemptStore {
  put(attempt: OAuthAttempt): Promise<void>;
  /** Returns and removes. `null` only for a state this store does not have. */
  consume(state: string): Promise<OAuthAttempt | null>;
}

/** Single-process store. Adequate for one instance; see the port's note for why that is a real limit. */
export const createMemoryOAuthAttemptStore = (now: () => number = Date.now): OAuthAttemptStore => {
  const attempts = new Map<string, OAuthAttempt>();
  return {
    async put(attempt) {
      // Expired entries are dropped on write rather than by a timer: a timer keeps the process alive and needs
      // clearing, and the set is small by construction.
      for (const [key, value] of attempts) if (value.expiresAt <= now()) attempts.delete(key);
      attempts.set(attempt.state, attempt);
    },
    async consume(state) {
      const attempt = attempts.get(state);
      // Deleted whether or not it is expired: a state presented once is spent, and leaving an expired one
      // behind is a row that can be presented again after a clock correction. Expiry itself is the *flow's*
      // judgement — see the port's note.
      attempts.delete(state);
      return attempt ?? null;
    },
  };
};

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

/** RFC 7636 S256. Plain is not offered: it is PKCE in name only. */
export const codeChallengeOf = (verifier: string): string =>
  base64url(createHash("sha256").update(verifier).digest());

function refuse(message: string, code: AgentPlatformError["code"] = "invalid_input"): never {
  // A function declaration, not an arrow: TypeScript narrows on a `never`-returning *declaration* used as a
  // statement, and an arrow assigned to a const does not narrow the code after the call. Without this the
  // callback below reads as "attempt is possibly null" everywhere after the guard.
  throw new AgentPlatformError({ code, message, retryable: false });
}

/**
 * Exact match, and the reason it is a function rather than an `includes` is that it must stay one.
 *
 * `https://app.example.com.evil.tld/callback` starts with `https://app.example.com`, so a prefix check accepts
 * an attacker's host. A `URL`-based comparison would also be wrong in a subtler way: it normalises, so a
 * trailing slash or a default port could make two different strings compare equal and widen the allowlist by
 * accident.
 */
export const isAllowedRedirect = (allowlist: readonly string[], candidate: string): boolean =>
  allowlist.some((allowed) => allowed === candidate);

export type StartInput = {
  readonly context: ExecutionContext;
  readonly redirectUri: string;
  /** Extra scopes beyond the provider's defaults — a tenant's own app may need different ones (#263). */
  readonly scopes?: readonly string[];
  readonly returnTo?: string;
};

export type OAuthFlowDeps = {
  readonly config: OAuthProviderConfig;
  readonly attempts: OAuthAttemptStore;
  readonly now?: () => number;
  readonly randomBytesOf?: (size: number) => Buffer;
  readonly stateTtlMs?: number;
  /** Injected so the exchange is testable without a provider. */
  readonly fetchImpl?: typeof fetch;
};

export type TokenResponse = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly grantedScopes?: readonly string[];
  /** Everything else the provider returned that is not a secret — Atlassian's cloud id, Slack's team id. */
  readonly metadata?: Readonly<Record<string, string>>;
};

/**
 * Refuses a provider endpoint that is not HTTPS — checked at construction.
 *
 * The token request carries the **client secret and the authorization code** in its body. Over cleartext, both
 * are readable by anything on the path, and the failure is completely silent: the flow works.
 *
 * `localhost` is allowed over HTTP, because a provider emulator on a developer's machine is a real and harmless
 * case, and refusing it would push people to disable the check entirely — which is how a check stops applying
 * in production too.
 */
export const assertSecureEndpoint = (label: string, value: string): void => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse(`${label} is not a URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !local) {
    refuse(
      `${label} must be https — the token request carries the client secret and the authorization code in its ` +
        "body, and over cleartext both are readable by anything on the path while the flow still works.",
    );
  }
};

export const createOAuthFlow = (deps: OAuthFlowDeps) => {
  assertSecureEndpoint("authorizationUrl", deps.config.authorizationUrl);
  assertSecureEndpoint("tokenUrl", deps.config.tokenUrl);
  const now = deps.now ?? Date.now;
  const random = deps.randomBytesOf ?? randomBytes;
  const ttl = deps.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  const usePkce = deps.config.usePkce ?? true;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    /** The URL to send a person to, and the attempt recorded server-side. */
    async start(input: StartInput): Promise<{ readonly url: string; readonly state: string }> {
      if (!isAllowedRedirect(deps.config.redirectUris, input.redirectUri)) {
        // Refused before anything is stored, so an attacker probing redirects leaves no attempts behind.
        refuse(
          `redirect_uri "${input.redirectUri}" is not in this provider's allowlist. It is matched exactly — a ` +
            "prefix match would accept https://app.example.com.evil.tld.",
        );
      }
      const state = base64url(random(32));
      const codeVerifier = usePkce ? base64url(random(32)) : undefined;
      await deps.attempts.put({
        state,
        provider: deps.config.provider,
        tenantId: String(input.context.tenantId),
        principalId: String(input.context.principalId),
        redirectUri: input.redirectUri,
        ...(codeVerifier === undefined ? {} : { codeVerifier }),
        expiresAt: now() + ttl,
        ...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
      });

      const url = new URL(deps.config.authorizationUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", deps.config.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", (input.scopes ?? deps.config.scopes).join(" "));
      url.searchParams.set("state", state);
      if (codeVerifier !== undefined) {
        url.searchParams.set("code_challenge", codeChallengeOf(codeVerifier));
        url.searchParams.set("code_challenge_method", "S256");
      }
      for (const [key, value] of Object.entries(deps.config.extraAuthorizationParams ?? {})) {
        url.searchParams.set(key, value);
      }
      return { url: url.toString(), state };
    },

    /**
     * Verifies the callback and exchanges the code.
     *
     * **The state is verified before the code is touched.** Every check that can be made without contacting the
     * provider is made first, so an attacker probing the callback never causes an outbound request.
     */
    async callback(input: {
      readonly state: string;
      readonly code: string;
      readonly context: ExecutionContext;
    }): Promise<{ readonly tokens: TokenResponse; readonly attempt: OAuthAttempt }> {
      const attempt = await deps.attempts.consume(input.state);
      /**
       * One message for every state failure — unknown, replayed, expired, wrong tenant.
       *
       * A callback that distinguishes them is an oracle: it tells an attacker whether a state existed, which is
       * enough to confirm a guess. The server-side log can say which; the response cannot.
       */
      if (attempt === null) refuse("this authorization attempt is not valid", "forbidden");

      // Expiry judged here, with the clock that wrote it. Same message as every other state failure, so the
      // callback stays free of an oracle.
      if (attempt.expiresAt <= now()) refuse("this authorization attempt is not valid", "forbidden");

      if (
        attempt.tenantId !== String(input.context.tenantId) ||
        attempt.principalId !== String(input.context.principalId)
      ) {
        refuse("this authorization attempt is not valid", "forbidden");
      }

      if (input.code === "") refuse("the callback carried no authorization code");

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        // The *recorded* redirect URI, never one from the request. A provider checks it matches what the
        // authorization used, and taking it from the request would let an attacker choose both halves.
        redirect_uri: attempt.redirectUri,
        client_id: deps.config.clientId,
      });
      if (deps.config.clientSecret !== undefined) body.set("client_secret", deps.config.clientSecret);
      if (attempt.codeVerifier !== undefined) body.set("code_verifier", attempt.codeVerifier);

      const response = await fetchImpl(deps.config.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
      });
      if (!response.ok) {
        // The provider's body is not echoed: it routinely quotes the request, which carries the client secret
        // and the code.
        refuse(`the provider refused the token exchange with status ${response.status}`, "provider_error");
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const accessToken = payload["access_token"];
      if (typeof accessToken !== "string" || accessToken === "") {
        refuse("the provider's token response carried no access_token", "provider_error");
      }

      const expiresIn = payload["expires_in"];
      const scope = payload["scope"];
      return {
        attempt,
        tokens: {
          accessToken: accessToken as string,
          ...(typeof payload["refresh_token"] === "string" ? { refreshToken: payload["refresh_token"] } : {}),
          ...(typeof expiresIn === "number"
            ? { expiresAt: new Date(now() + expiresIn * 1000).toISOString() }
            : {}),
          /**
           * The scopes the provider **granted**, which is not what we asked for.
           *
           * A provider may grant fewer, and #259's AC-7 — telling somebody to *reconnect and grant X* rather
           * than surfacing a 403 — is answerable only from what was actually granted.
           */
          ...(typeof scope === "string" ? { grantedScopes: scope.split(" ").filter(Boolean) } : {}),
        },
      };
    },
  };
};

/** Constant-time state comparison, for a caller checking one against another outside the store. */
export const stateEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
