/**
 * Which OAuth app a tenant connects through — REQ-063 (#259), task #263.
 *
 * Two ways to reach a provider, and both must work.
 *
 * **The deployment's shared app.** One registration per provider; every tenant consents to it. Simplest for the
 * customer — nothing to register — and the path most will take.
 *
 * **The tenant's own app.** A customer who already has a registered Slack app, GitHub App or Google Cloud
 * project uses their own client id and secret. This is not a nicety. Meta's app review is per app, so a shared
 * app's approved use case may not cover a customer's; X's access tier is per app, so a customer paying for a
 * higher tier gains nothing from a shared one on a lower; and an enterprise whose security team will not
 * approve a third-party app in their Google tenant has no other route.
 *
 * ## The fallback is explicit, never silent
 *
 * `resolveOAuthClient` reports **which** app it chose. A caller that logs or displays it can see the difference;
 * one that ignores it behaves as before. The reason is AC-7: removing a tenant's app configuration must not
 * quietly migrate their live connections to the shared app, because that is a credential swap nobody
 * authorised — the tokens were issued by a client that no longer participates, and the shared app cannot
 * refresh or revoke them.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { ExecutionContext } from "../../core/context.js";
import type { SecretCipher } from "../cipher.js";
import type { Connection, ConnectionStore } from "../index.js";
import { assertSecureEndpoint, isAllowedRedirect, type OAuthProviderConfig } from "./index.js";

/** Which registration a flow is running under, and where it came from. */
export type ResolvedOAuthClient = {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUris: readonly string[];
  readonly scopes: readonly string[];
  readonly source: "tenant" | "deployment";
  /** The connection id of the tenant's registration, when `source` is `"tenant"`. */
  readonly registrationId?: string;
};

/**
 * A tenant's registration, stored as an `oauth-app` row.
 *
 * The client secret is sealed by the same `SecretCipher` as every token — AC-2 — because it is exactly as much
 * a secret and exactly as much the tenant's. The client id, redirect URI and scopes are metadata, readable,
 * because a settings screen should render without a key.
 */
export const registerTenantOAuthApp = async (input: {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  readonly context: ExecutionContext;
  readonly provider: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUris: readonly string[];
  readonly scopes?: readonly string[];
  readonly id?: string;
  readonly label?: string;
}): Promise<Connection> => {
  if (input.redirectUris.length === 0)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "a tenant's OAuth app must declare at least one redirect URI, or no flow could ever complete",
      retryable: false,
    });
  return input.store.create({
    tenantId: input.context.tenantId,
    connection: {
      id: input.id ?? `${input.provider}-app`,
      kind: "oauth-app",
      provider: input.provider,
      ...(input.label === undefined ? {} : { label: input.label }),
      mode: "oauth2",
      scheme: "bearer",
      metadata: {
        clientId: input.clientId,
        redirectUris: input.redirectUris.join(" "),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes.join(" ") }),
      },
      sealed: await input.cipher.seal(input.clientSecret),
    },
  });
};

/**
 * The client this tenant connects through — theirs if registered, otherwise the deployment's.
 *
 * A tenant's own app brings its **own** redirect URIs, and they are still allowlisted: this is the obvious place
 * that check gets loosened into a wildcard to make BYO work, and the whole of #262's second defence would go
 * with it. The registration's URIs simply *become* the allowlist for that tenant's flow — an allowlist chosen by
 * the customer, not a pattern.
 */
export const resolveOAuthClient = async (input: {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  readonly context: ExecutionContext;
  readonly config: OAuthProviderConfig;
}): Promise<ResolvedOAuthClient> => {
  const registrations = await input.store.list({
    tenantId: input.context.tenantId,
    provider: input.config.provider,
    kind: "oauth-app",
  });
  const registration = registrations[0];
  if (registration === undefined) {
    return {
      clientId: input.config.clientId,
      ...(input.config.clientSecret === undefined ? {} : { clientSecret: input.config.clientSecret }),
      redirectUris: input.config.redirectUris,
      scopes: input.config.scopes,
      source: "deployment",
    };
  }

  const clientId = registration.metadata?.clientId;
  const redirectUris = (registration.metadata?.redirectUris ?? "").split(" ").filter(Boolean);
  if (clientId === undefined || redirectUris.length === 0) {
    // A half-written registration is refused rather than silently falling back: falling back here is exactly
    // the credential swap AC-7 forbids, and it would happen at the worst moment — mid-migration.
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        `this workspace's ${input.config.provider} app registration is incomplete (needs metadata.clientId and ` +
        "metadata.redirectUris). Refusing rather than falling back to the shared app: that would issue tokens " +
        "from a different client than the one your existing connections were created with.",
      retryable: false,
    });
  }
  for (const uri of redirectUris) assertSecureEndpoint("a tenant redirect URI", uri);

  const scopes = (registration.metadata?.scopes ?? "").split(" ").filter(Boolean);
  return {
    clientId,
    clientSecret: await input.cipher.open(registration.sealed),
    redirectUris,
    // A tenant's app may be approved for a different scope set — Meta's review is per app.
    scopes: scopes.length > 0 ? scopes : input.config.scopes,
    source: "tenant",
    registrationId: registration.id,
  };
};

/** The provider config a flow should run with, for this tenant. */
export const configForTenant = (
  base: OAuthProviderConfig,
  client: ResolvedOAuthClient,
): OAuthProviderConfig => ({
  ...base,
  clientId: client.clientId,
  ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
  // Still an allowlist, and still matched exactly — see the note on `resolveOAuthClient`.
  redirectUris: client.redirectUris,
  scopes: client.scopes,
});

/**
 * Refuses to use a connection with a client that did not issue it — AC-4.
 *
 * A token obtained through one app is not usable through another: refresh and revocation both authenticate as
 * the client, so a connection whose client changed underneath it fails at the provider with a message about an
 * invalid client — which reads as "your integration is broken" and sends nobody to the actual cause.
 *
 * Failing loudly here, naming both clients, is the difference between a five-minute fix and an afternoon.
 */
export const assertClientMatches = (connection: Connection, client: ResolvedOAuthClient): void => {
  const issuedBy = connection.metadata?.clientId;
  // A connection created before client ids were recorded cannot be checked. Refusing those would break every
  // existing connection to enforce a property they predate.
  if (issuedBy === undefined || issuedBy === client.clientId) return;
  throw new AgentPlatformError({
    code: "capability_unavailable",
    message:
      `this ${connection.provider} connection was created with OAuth client "${issuedBy}" and this workspace ` +
      `now resolves to "${client.clientId}". Refresh and revocation both authenticate as the client, so it ` +
      "cannot be used — reconnect, or restore the previous app registration.",
    retryable: false,
  });
};

/** Whether a redirect is allowed for this tenant's resolved client. Exactly matched, as always. */
export const isAllowedRedirectForClient = (client: ResolvedOAuthClient, candidate: string): boolean =>
  isAllowedRedirect(client.redirectUris, candidate);
