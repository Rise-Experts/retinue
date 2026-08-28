/**
 * Connect, disconnect, list — the operations a host mounts — task #262, AC-1, AC-7, AC-8 and AC-9.
 *
 * The flow in `./index.ts` produces a URL and consumes a callback. This is what turns that into a stored
 * connection, and what takes one away.
 *
 * Deliberately not a router. A host mounts these on its own paths with its own authentication, exactly as
 * `./mcp-server` leaves the transport alone: every method here takes an already-authenticated
 * `ExecutionContext`, so a host that has not authenticated has nothing to pass.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { ExecutionContext } from "../../core/context.js";
import type { AuthMode, CredentialScheme } from "../../tools/credentials.js";
import type { SecretCipher } from "../cipher.js";
import type { Connection, ConnectionId, ConnectionStore } from "../index.js";
import { assertSecureEndpoint } from "./index.js";
import type { OAuthProviderConfig, TokenResponse } from "./index.js";

/**
 * Where a provider's token may be revoked, when it has such an endpoint.
 *
 * Optional because many providers do not offer one, and #262's AC-7 asks that the absence be *documented*
 * rather than silently skipped — which is what `revocationUrl: undefined` plus this comment is.
 */
export type RevocationConfig = {
  readonly revocationUrl?: string;
  /** RFC 7009 calls it `token`; some providers differ. */
  readonly tokenParam?: string;
};

export type OAuthConnectionServiceDeps = {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  readonly config: OAuthProviderConfig & RevocationConfig;
  readonly fetchImpl?: typeof fetch;
  readonly newId?: () => string;
  readonly now?: () => string;
};

/**
 * What a connection is missing, for a caller deciding whether to send somebody back through consent — AC-9.
 *
 * Reads what was **granted**, never what the deployment's app requests: a tenant using their own OAuth app
 * (#263) may have granted a different set, and the whole point is to say *reconnect and grant X* rather than
 * surfacing a vendor 403 that names nothing actionable.
 *
 * A connection with no recorded grant returns `[]` rather than "everything is missing" — the provider did not
 * tell us, and inventing a refusal from an absence would block working connections.
 */
export const missingScopes = (
  connection: Pick<Connection, "grantedScopes">,
  required: readonly string[],
): readonly string[] => {
  if (connection.grantedScopes === undefined) return [];
  const granted = new Set(connection.grantedScopes);
  return required.filter((scope) => !granted.has(scope));
};

export const createOAuthConnectionService = (deps: OAuthConnectionServiceDeps) => {
  // Same reasoning as the flow's: a revocation request carries the token and the client secret.
  if (deps.config.revocationUrl !== undefined) assertSecureEndpoint("revocationUrl", deps.config.revocationUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newId = deps.newId ?? (() => `${deps.config.provider}-${Math.random().toString(36).slice(2, 10)}`);

  return {
    /**
     * Stores the result of a completed exchange — AC-8.
     *
     * The token is sealed on the way in and the non-secret parts are not, which is what lets a connection list
     * render without a key. `metadata` carries whatever the provider disclosed at consent time — Atlassian's
     * cloud id, Slack's team id — because those are needed on every subsequent request and are per connection.
     */
    async complete(input: {
      readonly context: ExecutionContext;
      readonly tokens: TokenResponse;
      readonly label?: string;
      readonly scheme?: CredentialScheme;
      readonly mode?: AuthMode;
      readonly metadata?: Readonly<Record<string, string>>;
    }): Promise<Connection> {
      return deps.store.create({
        tenantId: input.context.tenantId,
        connection: {
          id: newId(),
          provider: deps.config.provider,
          ...(input.label === undefined ? {} : { label: input.label }),
          mode: input.mode ?? "oauth2",
          scheme: input.scheme ?? "bearer",
          ...(input.tokens.metadata === undefined && input.metadata === undefined
            ? {}
            : { metadata: { ...input.tokens.metadata, ...input.metadata } }),
          ...(input.tokens.grantedScopes === undefined ? {} : { grantedScopes: input.tokens.grantedScopes }),
          sealed: await deps.cipher.seal(input.tokens.accessToken),
          ...(input.tokens.expiresAt === undefined ? {} : { expiresAt: input.tokens.expiresAt }),
        },
      });
    },

    /** A tenant's live connections for this provider. Never decrypts anything. */
    async list(context: ExecutionContext): Promise<readonly Connection[]> {
      return deps.store.list({ tenantId: context.tenantId, provider: deps.config.provider });
    },

    /**
     * Revokes at the provider, then locally — AC-7.
     *
     * **In that order.** Deleting first and then failing to revoke leaves a live token nobody can see and
     * nobody can stop, which is strictly the worst outcome: the credential still works and the record of it is
     * gone. Revoking first means a provider failure leaves a connection that is still listed and still
     * revocable, which a person can retry.
     *
     * A provider with no revocation endpoint is **reported**, not silently skipped: a caller that believes a
     * token was revoked when it was not will not go and remove it by hand.
     */
    async disconnect(input: {
      readonly context: ExecutionContext;
      readonly id: ConnectionId;
    }): Promise<{ readonly revokedAtProvider: boolean; readonly reason?: string }> {
      const connection = await deps.store.get({ tenantId: input.context.tenantId, id: input.id });
      if (connection === null)
        throw new AgentPlatformError({
          code: "not_found",
          message: `no connection "${input.id}" for this workspace`,
          retryable: false,
        });

      let revokedAtProvider = false;
      let reason: string | undefined;
      if (deps.config.revocationUrl === undefined) {
        reason = `${deps.config.provider} publishes no token revocation endpoint, so the token remains valid at the provider until it expires or is removed there by hand`;
      } else {
        try {
          const token = await deps.cipher.open(connection.sealed);
          const body = new URLSearchParams({
            [deps.config.tokenParam ?? "token"]: token,
            client_id: deps.config.clientId,
          });
          if (deps.config.clientSecret !== undefined) body.set("client_secret", deps.config.clientSecret);
          const response = await fetchImpl(deps.config.revocationUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          });
          revokedAtProvider = response.ok;
          if (!response.ok) reason = `the provider answered ${response.status} to the revocation request`;
        } catch (thrown) {
          // Reported, not thrown: the local revocation below must still happen, or a provider outage leaves a
          // connection nobody can remove.
          reason = thrown instanceof Error ? thrown.message : String(thrown);
        }
      }

      await deps.store.revoke({ tenantId: input.context.tenantId, id: input.id });
      return { revokedAtProvider, ...(reason === undefined ? {} : { reason }) };
    },

    /**
     * What a caller should tell somebody when a tool needs a scope this connection lacks — AC-9.
     *
     * Returns the message rather than throwing, because the caller decides what to do with it: #264 turns it
     * into a login URL and pauses the run, and a simpler host may just show it.
     */
    scopeGap(connection: Connection, required: readonly string[]): string | null {
      const missing = missingScopes(connection, required);
      if (missing.length === 0) return null;
      return (
        `this ${deps.config.provider} connection was granted ${(connection.grantedScopes ?? []).join(", ") || "no scopes"} ` +
        `and this needs ${missing.join(", ")}. Reconnect and grant ${missing.join(", ")} — the provider will ` +
        "otherwise answer 403, which names nothing you can act on."
      );
    },
  };
};
