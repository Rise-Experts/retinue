/**
 * A `CredentialResolver` over stored connections — the half that makes #260 useful, task #261.
 *
 * #260 made a credential a typed value and shipped one resolver: a static map, which serves exactly one tenant.
 * This is the multi-tenant one, and it is the piece the whole integrations milestone was waiting for.
 *
 * ## Resolution is per call, and that is not an implementation detail
 *
 * `credentials.ts` explains why: a credential read once at startup survives its own rotation, and the failure
 * looks like the vendor rejecting a token that "has not changed". This resolver therefore reads the store on
 * every call and caches nothing. A deployment that wants caching adds it knowing its own rotation window —
 * which is a decision only the deployment can make.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import {
  createCredential,
  type Credential,
  type CredentialResolver,
  type CredentialScheme,
} from "../tools/credentials.js";
import type { SecretCipher } from "./cipher.js";
import { parseCredentialRef, type Connection, type ConnectionStore } from "./index.js";
import { withConnectionGap } from "./pause.js";

/**
 * How the plaintext behind a connection maps back to a `Credential`.
 *
 * The sealed blob holds **only** the secret parts — the token, or the password of a basic pair. Everything
 * non-secret (the username, the header name, the metadata) is stored in readable columns, so listing
 * connections needs no key and a person can see *which account* a connection is for without decrypting
 * anything.
 */
const toCredential = (connection: Connection, plaintext: string): Credential => {
  const shared = {
    mode: connection.mode,
    ...(connection.metadata === undefined ? {} : { metadata: connection.metadata }),
  };
  switch (connection.scheme) {
    case "bearer":
      return createCredential({ scheme: "bearer", token: plaintext, ...shared });
    case "basic": {
      // The username lives in metadata because it is not a secret and a person needs to see it.
      const username = connection.metadata?.username;
      if (username === undefined)
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            `connection "${connection.id}" is a basic credential with no \`metadata.username\`. The username is ` +
            "stored readable on purpose — a connection list should show which account it is for without a key.",
          retryable: false,
        });
      return createCredential({ scheme: "basic", username, password: plaintext, ...shared });
    }
    case "custom-header": {
      const header = connection.metadata?.header;
      if (header === undefined)
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `connection "${connection.id}" is a custom-header credential with no \`metadata.header\``,
          retryable: false,
        });
      return createCredential({ scheme: "custom-header", header, value: plaintext, ...shared });
    }
  }
};

export type ConnectionResolverDeps = {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  /**
   * Which connection a bare `<provider>` ref means when a tenant has several.
   *
   * Defaults to the oldest, which is stable and explainable — "the first one you connected" — rather than
   * newest, which would silently re-point every agent the moment somebody adds a second account.
   */
  readonly chooseDefault?: (candidates: readonly Connection[]) => Connection | undefined;
};

export const createConnectionCredentialResolver = (deps: ConnectionResolverDeps): CredentialResolver => {
  const chooseDefault = deps.chooseDefault ?? ((candidates) => candidates[0]);

  return {
    async resolve({ ref, context }: { ref: string; context: ExecutionContext }) {
      const { provider, id } = parseCredentialRef(ref);
      const connection =
        id === undefined
          ? chooseDefault(await deps.store.list({ tenantId: context.tenantId, provider }))
          : ((await deps.store.get({ tenantId: context.tenantId, id })) ?? undefined);

      if (connection === undefined || connection === null)
        // Marked, so the engine can recognise it as *a missing connection* rather than a broken tool and pause
        // the run instead of failing it — #264. Structural, not a string match: rewording this message must not
        // silently turn a pausable failure into a fatal one.
        throw withConnectionGap(
          new AgentPlatformError({
            code: "capability_unavailable",
            message:
              `no ${provider} connection for this workspace` +
              (id === undefined ? "" : ` with id "${id}"`) +
              ". Connect one, or check the credential reference.",
            retryable: false,
          }),
          { provider, gap: "absent", scopes: [] },
        );

      // A ref naming one provider must not resolve to another's credential, which is what a wrong id would do.
      if (id !== undefined && connection.provider !== provider)
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `connection "${id}" is a ${connection.provider} connection, not ${provider}`,
          retryable: false,
        });

      /**
       * Expiry is reported, not refreshed — refresh is #233's, deliberately.
       *
       * Saying "expired" rather than sending it is the difference between a message an operator can act on and
       * a vendor 401 that says the token is invalid.
       */
      if (connection.expiresAt !== undefined && Date.parse(connection.expiresAt) <= Date.now())
        throw withConnectionGap(
          new AgentPlatformError({
            code: "capability_unavailable",
            message: `the ${provider} connection expired at ${connection.expiresAt}. Reconnect, or wire a refresh.`,
            retryable: false,
          }),
          { provider, gap: "expired", scopes: connection.grantedScopes ?? [] },
        );

      const plaintext = await deps.cipher.open(connection.sealed);
      return toCredential(connection, plaintext);
    },
  };
};

/** Which scheme a connection presents, for `assertToolkitAuth` at wiring time. */
export const schemeOf = (connection: Connection): CredentialScheme => connection.scheme;

/**
 * Re-seals every connection that is not already under the current key — task #261 AC-7.
 *
 * Rotation without this is theory: `SecretCipher` can *open* an old key's secrets, but nothing moves them
 * forward, so the old key can never be retired and the first key is permanent in practice.
 *
 * The order is what makes it safe to interrupt. Each connection is opened, re-sealed and written **one at a
 * time**, and a failure leaves everything before it done and everything after it untouched — both readable,
 * because the old key is still configured. Running it twice is a no-op: a connection already on the current key
 * is skipped.
 *
 * Deliberately not a transaction over the whole tenant. A rotation across thousands of connections held in one
 * transaction is a long-running write that blocks and, if it fails at the end, achieves nothing.
 */
export const resealConnections = async (input: {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  readonly tenantId: string;
  /** Reported per connection, so a long rotation is observable rather than silent. */
  readonly onProgress?: (progress: { readonly id: string; readonly from: string; readonly to: string }) => void;
}): Promise<{ readonly resealed: number; readonly skipped: number }> => {
  const current = input.cipher.currentKeyId();
  const connections = await input.store.list({ tenantId: input.tenantId as never });
  let resealed = 0;
  let skipped = 0;
  for (const connection of connections) {
    if (connection.sealed.keyId === current) {
      skipped += 1;
      continue;
    }
    const plaintext = await input.cipher.open(connection.sealed);
    await input.store.update({
      tenantId: input.tenantId as never,
      id: connection.id,
      patch: { sealed: await input.cipher.seal(plaintext) },
    });
    input.onProgress?.({ id: connection.id, from: connection.sealed.keyId, to: current });
    resealed += 1;
  }
  return { resealed, skipped };
};
