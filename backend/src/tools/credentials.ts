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
import type { PlatformError } from "../core/errors.js";

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
