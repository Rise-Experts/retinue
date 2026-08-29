/**
 * Credentials, referenced rather than held — REQ-047 (#206), task #214, AC-5; widened by REQ-063 (#259), #260.
 *
 * A toolkit needs a secret. The question is who holds it and when it is read, and getting that wrong is the
 * decision that makes a multi-tenant deployment a rewrite of every package rather than a configuration change.
 *
 * ## Why a tool must not read the environment
 *
 * `process.env.GITHUB_TOKEN` inside a tool works perfectly for exactly one tenant. It is also the shape that
 * twenty more toolkits will copy, because the first one did — and each of them then has to be rewritten when a
 * second customer arrives, with their own token, for the same tool.
 *
 * So a tool takes a **reference** and the host resolves it. What the reference means — a row in a credential
 * table, a secret manager path, an env var name in a single-tenant deployment — is the host's business and
 * changes nothing about the tool.
 *
 * ## Why resolution happens at the point of use
 *
 * Not at construction. A credential read once at startup is a credential that survives its own rotation: the
 * secret changes, every request keeps sending the old one, and the failure looks like the vendor rejecting a
 * token that "has not changed". Resolving per call costs a lookup — cacheable by the host, which knows its own
 * rotation window — and means a rotated secret takes effect without a restart.
 *
 * The corollary: **a resolved secret is never stored on the tool.** It lives in the local scope of one call.
 *
 * ## Why a miss throws
 *
 * Returning an empty string would send an unauthenticated request and surface as a vendor 401 several layers
 * away, where the actual problem — nobody wired the credential — is invisible. A typed failure names the ref.
 *
 * ## Why a string was not enough — #260
 *
 * `resolve()` returned `Promise<string>`, which covers a bearer token and nothing else. Jira and Confluence
 * want an account email *and* an API token as Basic auth; Atlassian's OAuth needs an access token *and* a cloud
 * id discovered after consent; WhatsApp needs a token *and* a phone number id; a vendor using `X-Api-Key` needs
 * a header name. Four of the fourteen integrations specified in `docs/23` cannot be expressed as a string, and
 * every one of them would have grown its own side-channel.
 *
 * Two axes, deliberately kept apart, because they are answered by different people:
 *
 * - **`CredentialScheme`** — how the secret is presented on the wire. The toolkit knows this.
 * - **`AuthMode`** — how the tenant *obtained* it: pasted a token, or completed an OAuth flow. The deployment
 *   knows this, and it is what decides whether an unconnected tool can pause a run for consent (#264) or must
 *   simply fail, since a token has no login URL to redirect to.
 */

import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError, type PlatformError } from "../core/errors.js";

/** An opaque handle. Its meaning belongs to the resolver, and no tool interprets it. */
export type CredentialRef = string;

/** How a secret is presented on the wire. */
export const CREDENTIAL_SCHEMES = ["bearer", "basic", "custom-header"] as const;
export type CredentialScheme = (typeof CREDENTIAL_SCHEMES)[number];

/**
 * How a tenant supplied the credential.
 *
 * Not the same question as the scheme: an OAuth access token is presented as a bearer, so the two would collapse
 * if they shared a type — and the collapse would lose exactly the fact #264 needs, which is whether there is a
 * login URL to send someone to.
 */
export const AUTH_MODES = ["token", "oauth2"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Non-secret vendor identifiers that travel with the credential.
 *
 * Atlassian's cloud id, WhatsApp's phone number id, Slack's team id — discovered at connection time, needed on
 * every request, and **not secrets**. They live here rather than in a toolkit's configuration because they are
 * per *connection*: two tenants using the same toolkit have different ones, which is the same reason the token
 * is not configuration either.
 */
export type CredentialMetadata = Readonly<Record<string, string>>;

type WithMetadata = { readonly metadata?: CredentialMetadata; readonly mode?: AuthMode };

export type Credential =
  | (WithMetadata & { readonly scheme: "bearer"; readonly token: string })
  | (WithMetadata & { readonly scheme: "basic"; readonly username: string; readonly password: string })
  | (WithMetadata & { readonly scheme: "custom-header"; readonly header: string; readonly value: string });

/** The secret-bearing property of each scheme — the ones that must never be enumerable. */
const SECRET_KEYS: Readonly<Record<CredentialScheme, readonly string[]>> = {
  bearer: ["token"],
  basic: ["password"],
  "custom-header": ["value"],
};

const REDACTED = "[credential redacted]";

/**
 * Builds a credential whose secret is **not enumerable** — AC-7.
 *
 * A typed object is far more likely to reach a log line than a bare string was: it gets spread into an error's
 * `details`, passed to a structured logger, or serialised into an audit row, and every one of those uses
 * `JSON.stringify` or an object spread. So the secret is defined non-enumerably and `toJSON`/`toString`/
 * `util.inspect` are overridden. `credential.token` still reads normally; `{ ...credential }`,
 * `JSON.stringify(credential)` and `console.log(credential)` do not.
 *
 * This is defence in depth, not a licence: a caller that reads `.token` and logs *that* is still logging a
 * secret, and no type can stop it.
 */
export const createCredential = (input: Credential): Credential => {
  const secrets = SECRET_KEYS[input.scheme];
  const credential = { ...input } as Record<string, unknown>;
  for (const key of secrets) {
    const value = credential[key];
    delete credential[key];
    Object.defineProperty(credential, key, { value, enumerable: false, writable: false, configurable: false });
  }
  Object.defineProperty(credential, "toJSON", {
    value: () => ({ scheme: input.scheme, ...(input.mode === undefined ? {} : { mode: input.mode }), secret: REDACTED }),
    enumerable: false,
  });
  Object.defineProperty(credential, "toString", { value: () => REDACTED, enumerable: false });
  // Node's `console.log` and `util.inspect` ignore `toString`; this is the hook they do read.
  Object.defineProperty(credential, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => `Credential(${input.scheme}) ${REDACTED}`,
    enumerable: false,
  });
  return Object.freeze(credential) as Credential;
};

/** A bearer credential, which is what most vendors want and what a plain string used to mean. */
export const bearer = (token: string, metadata?: CredentialMetadata, mode?: AuthMode): Credential =>
  createCredential({ scheme: "bearer", token, ...(metadata === undefined ? {} : { metadata }), ...(mode === undefined ? {} : { mode }) });

export interface CredentialResolver {
  /**
   * The credential behind a reference, for this caller.
   *
   * Takes the context because a reference is resolved *per tenant*: two tenants using the same toolkit name the
   * same credential and mean different secrets, and a resolver that ignored the caller would hand one tenant
   * another's token.
   */
  resolve(input: { readonly ref: CredentialRef; readonly context: ExecutionContext }): Promise<Credential>;
}

/**
 * Told about every resolution — `docs/21`'s Connections section, "an audit record of every resolution".
 *
 * A sink rather than a return value, so a toolkit cannot forget to report and a host cannot be surprised by
 * one. **Both outcomes are reported**: a refused resolution is the more interesting audit event, because a
 * successful one is the normal case and a refused one is somebody asking for something they do not have.
 *
 * It never receives the credential. An audit trail that carries the secret is a second copy of the secret in a
 * place designed to be kept for a long time.
 */
export interface CredentialAudit {
  onResolved(input: {
    readonly ref: CredentialRef;
    readonly context: ExecutionContext;
    readonly scheme: CredentialScheme;
  }): Promise<void> | void;
  onRefused(input: {
    readonly ref: CredentialRef;
    readonly context: ExecutionContext;
    readonly reason: string;
  }): Promise<void> | void;
}

export const credentialMissing = (ref: CredentialRef, detail?: string): PlatformError => ({
  code: "capability_unavailable",
  message:
    `No credential is wired for reference "${ref}"` +
    (detail === undefined ? "" : `: ${detail}`) +
    ". A tool cannot read one from the environment — supply a CredentialResolver to the host.",
  // Retrying an unwired credential cannot help; something has to be configured.
  retryable: false,
});

/**
 * The credential resolved is not the shape this toolkit can present — #260 AC-2.
 *
 * Raised at **construction** where possible, and at resolution otherwise. A misconfiguration discovered as a
 * vendor 401 an hour later is the failure this exists to prevent: the vendor's message says the token is
 * invalid, which sends an operator to rotate a token that was never the problem.
 */
export const credentialSchemeMismatch = (
  ref: CredentialRef,
  expected: readonly CredentialScheme[],
  got: CredentialScheme,
): PlatformError => ({
  code: "capability_unavailable",
  message:
    `Credential "${ref}" is a ${got} credential and this toolkit presents ${expected.join(" or ")}. ` +
    "The vendor would answer 401 and the message would say the token is invalid, which is not the problem.",
  retryable: false,
});

/**
 * A resolver over a plain map, for a single-tenant deployment and for tests.
 *
 * Shipped because the alternative is every host writing the same six lines, and the sixth one writing it with a
 * fallback to `process.env` — which is the thing this module exists to prevent. Explicitly *not* environment
 * backed: a host that wants that passes `{ github: process.env.GITHUB_TOKEN ?? "" }` and can see it doing so.
 *
 * **A bare string still works**, and stays the common case: it means a bearer token, which is what it meant
 * before #260. The single-tenant path must not get harder because multi-tenant got possible.
 */
export const createStaticCredentialResolver = (
  secrets: Readonly<Record<string, string | Credential>>,
): CredentialResolver => ({
  async resolve({ ref }) {
    const secret = secrets[ref];
    if (secret === undefined || secret === "") throw credentialMissing(ref, "not present in the static map");
    return typeof secret === "string" ? bearer(secret) : secret;
  },
});

/**
 * Wraps a resolver so every resolution is audited, and so a scheme mismatch is caught here rather than by the
 * vendor — #260 AC-2 and AC-8.
 *
 * A wrapper rather than a change to every resolver: a host's own resolver stays a four-line object, and the
 * cross-cutting obligations are added once, where they cannot be forgotten per toolkit.
 */
export const withCredentialAudit = (
  resolver: CredentialResolver,
  audit: CredentialAudit,
  expected?: readonly CredentialScheme[],
): CredentialResolver => ({
  async resolve(input) {
    let credential: Credential;
    try {
      credential = await resolver.resolve(input);
    } catch (thrown) {
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      await audit.onRefused({ ref: input.ref, context: input.context, reason });
      throw thrown;
    }
    if (expected !== undefined && !expected.includes(credential.scheme)) {
      const error = credentialSchemeMismatch(input.ref, expected, credential.scheme);
      await audit.onRefused({ ref: input.ref, context: input.context, reason: error.message });
      throw error;
    }
    await audit.onResolved({ ref: input.ref, context: input.context, scheme: credential.scheme });
    return credential;
  },
});

/**
 * The `Authorization`-style header a credential presents as.
 *
 * One function, so twenty toolkits do not each write their own base64 and get the padding wrong. Returns the
 * header **name and value**, because `custom-header` does not use `Authorization`.
 */
export const credentialHeader = (credential: Credential): readonly [string, string] => {
  switch (credential.scheme) {
    case "bearer":
      return ["Authorization", `Bearer ${credential.token}`];
    case "basic":
      return ["Authorization", `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`];
    case "custom-header":
      return [credential.header, credential.value];
  }
};

/**
 * What a toolkit accepts — #260 AC-2.
 *
 * Declared by the toolkit and checked at **construction**, so wiring a Basic-auth vendor with a bearer token is
 * a startup error naming both, rather than a vendor 401 an hour later whose message says the token is invalid.
 *
 * `modes` is the other axis and is not the platform's business to validate — it is a fact about the vendor that
 * a deployment reads: "GitHub takes a PAT or OAuth", "Google is OAuth only". #262 uses it to decide which
 * connection flows to offer, and #264 uses it to decide whether an unconnected tool can pause a run for consent
 * or must simply fail, since a token has no login URL.
 */
export type ToolkitAuth = {
  /** How a tenant may obtain the credential. */
  readonly modes: readonly AuthMode[];
  /** The scheme(s) this toolkit can present. A credential of any other scheme is refused. */
  readonly schemes: readonly CredentialScheme[];
};

/**
 * Refuses a toolkit configuration whose credential cannot be presented — at construction.
 *
 * Takes the *declared* scheme rather than resolving, because resolution needs a context and construction has
 * none. A host that wires a static map can therefore be told immediately; a host whose resolver is dynamic is
 * caught by `withCredentialAudit` at the first call instead. Both are before the vendor sees anything.
 */
export const assertToolkitAuth = (
  ref: CredentialRef,
  auth: ToolkitAuth,
  declared: CredentialScheme | undefined,
): void => {
  if (auth.schemes.length === 0)
    throw new Error(`toolkit auth for "${ref}" declares no schemes, so no credential could ever satisfy it`);
  if (declared !== undefined && !auth.schemes.includes(declared)) {
    const error = credentialSchemeMismatch(ref, auth.schemes, declared);
    throw Object.assign(new Error(error.message), error);
  }
};

// ---------------------------------------------------------------------------------------------------
// Refreshable credentials — REQ-054 (#232), task #233
// ---------------------------------------------------------------------------------------------------

/**
 * A credential that stops working at a known time.
 *
 * Additive by construction: `RefreshableCredential` is a `Credential` with one more field, so a resolver that
 * returns a plain one is unchanged and the eight shipped toolkits compile untouched. That is AC-1, and it is a
 * property of the *type* rather than a claim about the code.
 *
 * The refresh token is deliberately **not here.** It lives wherever the host keeps it — `ConnectionStore` seals
 * it (#261) — and only the refresher ever sees it. Putting it on the credential would mean the longest-lived
 * secret in an OAuth grant travelling through every toolkit that only needed the short-lived one.
 */
export type RefreshableCredential = Credential & {
  /** ISO 8601. When the vendor stops accepting this. */
  readonly expiresAt: string;
};

/**
 * Adds an expiry to a credential **without losing its secret protection** — AC-6.
 *
 * This exists because the obvious way to build one is wrong, and wrong invisibly. A host writing a
 * `CredentialRefresher` reaches for:
 *
 * ```ts
 * return { ...bearer(accessToken), expiresAt };   // ← the secret is now enumerable
 * ```
 *
 * `createCredential` defines the secret **non-enumerably**, which is precisely what makes it survive a
 * `JSON.stringify` into a log line — and precisely what a spread drops. The result looks identical, works
 * identically, and serialises the token into the first structured log that touches it.
 *
 * Found by the AC-6 test failing against this repository's own test helper, which had made exactly that
 * mistake. If the helper made it, a host will.
 */
export const refreshable = (credential: Credential, expiresAt: string): RefreshableCredential => {
  const secrets = SECRET_KEYS[credential.scheme];
  /**
   * Rebuilt **through** `createCredential`, with the expiry passed in rather than added after.
   *
   * Two reasons it has to be this way round. The protection must be *applied* rather than copied — a copy of a
   * non-enumerable property is an enumerable one — and `createCredential` freezes what it returns, so there is
   * no "after" to add a field in. The secrets are read back explicitly because the spread above cannot see
   * them, which is the whole point of them.
   */
  return createCredential({
    ...(credential as unknown as Record<string, unknown>),
    ...Object.fromEntries(secrets.map((key) => [key, (credential as unknown as Record<string, unknown>)[key]])),
    expiresAt,
  } as unknown as Credential) as RefreshableCredential;
};

export const isRefreshable = (credential: Credential): credential is RefreshableCredential =>
  typeof (credential as { expiresAt?: unknown }).expiresAt === "string";

/**
 * How early a token is replaced.
 *
 * Sixty seconds, and the number is a *commitment* rather than a guess: a tool call can take tens of seconds —
 * a slow vendor, a large upload, a retry — and a token that was valid when the call started must still be
 * valid when it arrives. Refreshing exactly at expiry makes "expired mid-flight" the common case rather than
 * the rare one, and that failure looks like an intermittent authentication bug.
 *
 * AC-5. Configurable because a deployment whose calls are slower than this needs more.
 */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

/** Whether a credential is expired, or close enough that it should be replaced before use. */
export const isExpiring = (credential: Credential, skewMs: number, now: number): boolean => {
  if (!isRefreshable(credential)) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  // An unparseable expiry is treated as expiring. The alternative is using a credential whose lifetime is
  // unknown, and the cost of an unnecessary refresh is one call.
  return Number.isNaN(expiresAt) || expiresAt - now <= skewMs;
};

/**
 * Obtains a fresh credential for a reference.
 *
 * A port, because how a token is renewed differs entirely by vendor and by where the grant is stored. The
 * host's implementation reads its own `ConnectionStore`, calls the vendor's token endpoint, re-seals the new
 * refresh token and returns the new access credential — none of which the runtime should know about.
 *
 * It is given the ref and the context, and **not** the expired credential: it has to look the grant up anyway,
 * and handing it a dead secret would be one more copy of one for no purpose.
 */
export interface CredentialRefresher {
  refresh(input: {
    readonly ref: CredentialRef;
    readonly context: ExecutionContext;
  }): Promise<RefreshableCredential>;
}

/**
 * A refresh that failed because the grant is gone, rather than because the network was.
 *
 * The distinction is the whole of AC-3, and it is not cosmetic: `invalid_grant` means a person must consent
 * again and no amount of retrying will help, while a timeout means try again in a second. A runtime that
 * conflates them either retries a dead grant forever or asks a user to re-authorise because of a blip.
 */
export const REFRESH_GRANT_ERRORS = ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"] as const;

export const isGrantError = (error: unknown): boolean => {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return REFRESH_GRANT_ERRORS.some((code) => text.includes(code));
};

export type RefreshingResolverOptions = {
  readonly skewMs?: number;
  /** Injectable so a test can move time without waiting for it. */
  readonly now?: () => number;
  /**
   * Told that a refresh happened. Never told the token — see `CredentialAudit`, same reasoning.
   *
   * `expiresAt` is included because it is not a secret and it is the one thing an operator debugging a
   * refresh loop actually needs.
   */
  readonly onRefreshed?: (input: {
    readonly ref: CredentialRef;
    readonly tenantId: string;
    readonly expiresAt: string;
  }) => void;
};

/**
 * Wraps a resolver so an expiring credential is renewed before it is handed out.
 *
 * A wrapper, like `withCredentialAudit`, and for the same reason: the eight shipped toolkits already resolve
 * **per call**, so they pick this up without a line changing. A toolkit that cached a credential at
 * construction would defeat it, which is why `createGitHubToolkit` and every sibling resolve inside `call()`.
 *
 * ## Time-driven, never 401-driven — AC-7
 *
 * The obvious design is to refresh when the vendor returns 401. It is wrong, and worth stating plainly because
 * it is what most integrations do:
 *
 * A 401 is what a vendor returns for an expired token, a **revoked** grant, a token for the wrong tenant, and a
 * scope the grant never had. Refreshing on 401 therefore turns a revoked grant into an infinite refresh loop
 * against the vendor's token endpoint, and turns a missing scope into a refresh that succeeds and a call that
 * fails again identically. Neither is diagnosable from the outside.
 *
 * Time is the only signal that means what it says: a token with an expiry in the past is expired, and nothing
 * else is inferred from it. A 401 on a freshly-refreshed token is a real error and is surfaced as one.
 *
 * ## One refresh, not N — AC-2
 *
 * Twenty concurrent tool calls hitting an expired token must produce **one** refresh. Refresh endpoints rate
 * limit, and — worse — several vendors invalidate the previous refresh token when one is used, so N concurrent
 * refreshes race to invalidate each other and log the deployment out permanently.
 *
 * The in-flight promise is stored *before* the first await, so a second caller entering the function
 * synchronously after the first still finds it.
 */
export const withRefreshingCredentials = (
  resolver: CredentialResolver,
  refresher: CredentialRefresher,
  options: RefreshingResolverOptions = {},
): CredentialResolver => {
  const skewMs = Math.max(0, options.skewMs ?? DEFAULT_REFRESH_SKEW_MS);
  const now = options.now ?? (() => Date.now());

  /**
   * Keyed by tenant **and** ref — AC-4.
   *
   * Two tenants naming the same credential `"google"` mean different grants, and a cache keyed by ref alone
   * would hand one tenant the other's token after a refresh. A space separates them: a tenant id cannot
   * contain one, so `a` + `b c` and `a b` + `c` cannot collide.
   */
  const cached = new Map<string, RefreshableCredential>();
  const inFlight = new Map<string, Promise<RefreshableCredential>>();
  const keyOf = (tenantId: string, ref: CredentialRef): string => `${tenantId} ${ref}`;

  const refreshOnce = (
    key: string,
    input: { ref: CredentialRef; context: ExecutionContext },
  ): Promise<RefreshableCredential> => {
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    // Built and stored before the first await, so a synchronous second caller joins this one rather than
    // starting a second refresh.
    const attempt = (async () => {
      try {
        const fresh = await refresher.refresh({ ref: input.ref, context: input.context });
        cached.set(key, fresh);
        options.onRefreshed?.({
          ref: input.ref,
          tenantId: String(input.context.tenantId),
          expiresAt: fresh.expiresAt,
        });
        return fresh;
      } catch (thrown) {
        /**
         * Belt-and-braces, and **not** load-bearing — worth saying rather than implying otherwise.
         *
         * A cached credential that is expiring already fails the freshness guard in `resolve`, so the next
         * caller would attempt a refresh whether or not this line ran. Removing it breaks no test, which is
         * exactly what one should expect. It stays because the invariant it states — a credential known to be
         * dead is never held — is one a future edit could otherwise quietly rely on being false.
         */
        cached.delete(key);
        throw new AgentPlatformError(
          isGrantError(thrown)
            ? {
                code: "unauthorized",
                message:
                  `The stored authorisation for "${input.ref}" is no longer valid and could not be renewed. ` +
                  "Someone needs to connect the account again — retrying will not help.",
                retryable: false,
              }
            : {
                code: "provider_unavailable",
                message: `Could not renew the authorisation for "${input.ref}" right now.`,
                retryable: true,
              },
          { cause: thrown },
        );
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, attempt);
    return attempt;
  };

  return {
    async resolve(input) {
      const key = keyOf(String(input.context.tenantId), input.ref);

      const held = cached.get(key);
      if (held !== undefined && !isExpiring(held, skewMs, now())) return held;

      // Ask the underlying resolver first: it is the source of truth, and on the common path the credential it
      // returns is a plain one with no expiry, which is passed straight through.
      const resolved = await resolver.resolve(input);
      if (!isRefreshable(resolved)) return resolved;
      if (!isExpiring(resolved, skewMs, now())) {
        cached.set(key, resolved);
        return resolved;
      }
      return refreshOnce(key, input);
    },
  };
};
