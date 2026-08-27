/**
 * Credentials, referenced rather than held — REQ-047 (#206), task #214, AC-5.
 *
 * A toolkit needs a token. The question is who holds it and when it is read, and getting that wrong is the
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
 */

import type { ExecutionContext } from "../core/context.js";
import type { PlatformError } from "../core/errors.js";

/** An opaque handle. Its meaning belongs to the resolver, and no tool interprets it. */
export type CredentialRef = string;

export interface CredentialResolver {
  /**
   * The secret behind a reference, for this caller.
   *
   * Takes the context because a reference is resolved *per tenant*: two tenants using the same toolkit name the
   * same credential and mean different secrets, and a resolver that ignored the caller would hand one tenant
   * another's token.
   */
  resolve(input: { readonly ref: CredentialRef; readonly context: ExecutionContext }): Promise<string>;
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
 * A resolver over a plain map, for a single-tenant deployment and for tests.
 *
 * Shipped because the alternative is every host writing the same six lines, and the sixth one writing it with a
 * fallback to `process.env` — which is the thing this module exists to prevent. Explicitly *not* environment
 * backed: a host that wants that passes `{ github: process.env.GITHUB_TOKEN ?? "" }` and can see it doing so.
 */
export const createStaticCredentialResolver = (secrets: Readonly<Record<string, string>>): CredentialResolver => ({
  async resolve({ ref }) {
    const secret = secrets[ref];
    if (secret === undefined || secret === "") throw credentialMissing(ref, "not present in the static map");
    return secret;
  },
});
