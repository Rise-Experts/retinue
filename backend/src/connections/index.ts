/**
 * Connections — a tenant's link to a third-party provider. REQ-063 (#259), task #261.
 *
 * `docs/21` assigned this to the platform repository and `docs/21`'s amendment moved the runtime half here,
 * because eight toolkits ship in this package and none of them was usable by a second tenant: every one takes a
 * `credentialRef` and the only resolver that shipped was a static map.
 *
 * ## What a connection is, and is not
 *
 * It is **one tenant's authorisation to reach one provider**. It is not a toolkit's configuration: a base URL
 * or a page size is the same for every tenant and belongs where the toolkit is wired. The dividing line is
 * whether two tenants using the same toolkit would differ, and for a credential they always do.
 *
 * ## Several per tenant, per provider
 *
 * A customer with three GitHub organisations or two Slack workspaces is the normal case, not an edge one. So a
 * connection has its own id, a provider, and an optional label a person chose — and `credentialRef` addresses a
 * **connection**, with a per-tenant default per provider so the common single-connection case stays a one-word
 * ref.
 *
 * ## The secret is opaque here
 *
 * The store holds a `SealedSecret` and cannot read it. That is what lets the same port sit over Postgres,
 * Supabase and memory with the identical guarantee, and it is why `SecretCipher` is a separate seam rather than
 * a detail of one adapter — see `cipher.ts` for why `pgcrypto` and Vault-only were both rejected.
 */

import type { TenantScope } from "../core/context.js";
import type { AuthMode, CredentialScheme } from "../tools/credentials.js";
import type { SealedSecret } from "./cipher.js";

export type ConnectionId = string;

/**
 * A tenant's connection to a provider.
 *
 * Everything here is safe to read and to log, including `sealed` — which is ciphertext, not a secret. The name
 * is the point: a connection list is a screen a person looks at, and rendering it must not need a key.
 */
export type Connection = {
  readonly id: ConnectionId;
  /** `github`, `slack`, `google` — the toolkit's own name, so a ref can be resolved without a second lookup. */
  readonly provider: string;
  /** What a person called it: "Acme org", "#support workspace". Absent for a connection nobody named. */
  readonly label?: string;
  readonly mode: AuthMode;
  readonly scheme: CredentialScheme;
  /**
   * Non-secret vendor identifiers discovered at connection time — Atlassian's cloud id, WhatsApp's phone
   * number id. Stored beside the secret rather than inside it, so listing connections needs no key.
   */
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * Scopes the tenant actually granted.
   *
   * Recorded because a scope check must read what was *granted*, not what the deployment's app requests: a
   * tenant using their own OAuth app (#263) may have granted a different set, and #259's AC-7 — telling someone
   * to *reconnect and grant X* rather than surfacing a 403 — is answerable only from this.
   */
  readonly grantedScopes?: readonly string[];
  readonly sealed: SealedSecret;
  /** Present for a credential that expires; `undefined` for a long-lived token. Refresh is #233's. */
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Set when a connection is revoked but kept for the audit trail.
   *
   * Soft, because "who connected this and when was it removed" is a question a security review asks, and a
   * hard delete makes it unanswerable. A revoked connection never resolves.
   */
  readonly revokedAt?: string;
};

export type ConnectionInput = Omit<Connection, "createdAt" | "updatedAt" | "revokedAt">;

export type ConnectionPatch = {
  readonly label?: string;
  readonly sealed?: SealedSecret;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly grantedScopes?: readonly string[];
  readonly expiresAt?: string;
};

/**
 * Where a tenant's connections live.
 *
 * Tenant-scoped on every method, with no `findById(id)` — governing principle 1. The store never sees a
 * plaintext secret, so an adapter cannot leak one it does not have.
 */
export interface ConnectionStore {
  create(input: TenantScope & { readonly connection: ConnectionInput }): Promise<Connection>;
  get(input: TenantScope & { readonly id: ConnectionId }): Promise<Connection | null>;
  /** Every live connection, optionally narrowed to one provider. Revoked ones are excluded. */
  list(input: TenantScope & { readonly provider?: string }): Promise<readonly Connection[]>;
  update(input: TenantScope & { readonly id: ConnectionId; readonly patch: ConnectionPatch }): Promise<Connection>;
  /** Marks it revoked. The row stays, so the audit trail survives. */
  revoke(input: TenantScope & { readonly id: ConnectionId }): Promise<void>;
  /**
   * Removes a tenant's connections entirely — `docs/18`'s retention, and the one hard delete.
   *
   * Deleting a tenant must remove their secrets: a soft-deleted credential is still a credential, and "we kept
   * it for the audit trail" is not an answer to "delete my data".
   */
  purge(input: TenantScope): Promise<number>;
}

/**
 * Which connection a `credentialRef` names.
 *
 * Two shapes, and both are needed. `provider` alone means "this tenant's default connection for GitHub", which
 * keeps the single-connection case a one-word ref and is what almost every deployment writes. `provider:id`
 * addresses one of several, which is what a customer with three organisations needs.
 *
 * Parsed rather than guessed, so a provider name containing a colon fails loudly instead of resolving to
 * something surprising.
 */
export const parseCredentialRef = (ref: string): { readonly provider: string; readonly id?: ConnectionId } => {
  const parts = ref.split(":");
  if (parts.length === 1) return { provider: parts[0]! };
  if (parts.length === 2 && parts[0] !== "" && parts[1] !== "")
    return { provider: parts[0]!, id: parts[1]! };
  throw new Error(
    `credential reference "${ref}" is not "<provider>" or "<provider>:<connectionId>". A provider name ` +
      "containing a colon would otherwise resolve to a connection nobody meant.",
  );
};

export * from "./cipher.js";
export * from "./resolver.js";
