/**
 * The Google transport, and the scope gate — REQ-054 (#232), task #234.
 *
 * Mostly `createVendorTransport`, plus the one thing Google needs that no previous vendor did: **a scope check
 * before the call.**
 *
 * ## Why the scope is checked here and not left to Google — AC-3
 *
 * Google answers a missing scope with `403 PERMISSION_DENIED` and a message that names the API, not the scope.
 * A model reading it retries with different arguments, because "permission denied" reads like a wrong id. The
 * operator reading the log sees a 403 against `gmail.send` and has to work out that the consent screen asked
 * for `gmail.readonly` three weeks ago.
 *
 * The information to prevent that is already present: the tool declares `requiredScopes`, and the OAuth token
 * response says what was granted. Comparing them costs nothing and produces an error naming the scope, the
 * tool, and what to do — before the call.
 *
 * **It only refuses when it knows.** A deployment using a static token has no granted-scope metadata, and
 * refusing there would break a working configuration to enforce a check that cannot be performed. Unknown
 * means proceed, and Google's 403 is then mapped to something readable as a fallback.
 */

import {
  createVendorTransport,
  type Credential,
  type CredentialRef,
  type CredentialResolver,
  type VendorFailure,
  type VendorTransport,
} from "@retinue/agentkit/tools";
import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

export const GOOGLE_API = "https://www.googleapis.com";

/**
 * The scopes a credential was granted, if it says.
 *
 * Google's token response carries `scope` as a space-separated string, and a host storing a connection keeps
 * it — `Connection.grantedScopes` in #261. Either shape is read here, because a host may pass it through as
 * metadata rather than reshaping it.
 *
 * `null` means *not stated*, which is different from *none*: an empty grant would refuse everything, and a
 * static token that simply has no metadata must keep working.
 */
export const grantedScopes = (credential: Credential): readonly string[] | null => {
  const metadata = (credential as { metadata?: Record<string, string> }).metadata;
  const raw = metadata?.scope ?? metadata?.scopes;
  if (raw === undefined || raw.trim() === "") return null;
  return raw.split(/[\s,]+/).filter((scope) => scope !== "");
};

/** Which of `required` the grant is missing. Empty when it has them all, or when the grant is unstated. */
export const missingScopes = (credential: Credential, required: readonly string[]): readonly string[] => {
  const granted = grantedScopes(credential);
  if (granted === null) return [];
  const held = new Set(granted);
  return required.filter((scope) => !held.has(scope));
};

/**
 * Google's failures, in words a model can act on.
 *
 * The 403 arm is the fallback for the check above: when the grant was unstated, a scope problem still arrives
 * as a 403, and the message says so rather than leaving "forbidden" to be interpreted.
 */
const classify = (failure: VendorFailure) => {
  if (failure.status === 403) {
    return {
      code: "unauthorized" as const,
      message:
        `Google refused this (403): ${failure.reason}. This is usually a scope the connection was never ` +
        "granted rather than a wrong identifier — reconnect the account and grant the scope this tool needs. " +
        "Retrying with different arguments will not help.",
      retryable: false,
    };
  }
  if (failure.status === 404) {
    return {
      code: "not_found" as const,
      message: `Google returned 404: ${failure.reason}. Either it does not exist or this account cannot see it.`,
      retryable: false,
    };
  }
  return undefined;
};

export type GoogleTransport = VendorTransport & {
  /**
   * Refuses before the call when the connection demonstrably lacks a scope.
   *
   * Separate from `json` rather than folded into it because the transport does not know which tool is calling
   * — the scopes belong to the descriptor, and the assembly in `index.ts` is what has both.
   */
  readonly assertScopes: (context: ExecutionContext, tool: string, required: readonly string[]) => Promise<void>;
};

export type GoogleTransportConfig = {
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
};

export const createGoogleTransport = (config: GoogleTransportConfig): GoogleTransport => {
  const transport = createVendorTransport({
    vendor: "Google",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.baseUrl ?? GOOGLE_API,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  return {
    ...transport,
    async assertScopes(context, tool, required) {
      if (required.length === 0) return;
      // Resolved through the same resolver as a call, so a refreshable credential is refreshed here too and a
      // check never runs against a token the call would not have used.
      const credential = await config.resolver.resolve({ ref: config.credentialRef, context });
      const missing = missingScopes(credential, required);
      if (missing.length === 0) return;
      throw new AgentPlatformError({
        code: "unauthorized",
        message:
          `${tool} needs ${missing.join(", ")}, which this Google connection was not granted ` +
          `(it has ${(grantedScopes(credential) ?? []).join(", ") || "no scopes"}). Reconnect the account and ` +
          "grant the missing scope. Nothing was sent to Google.",
        retryable: false,
      });
    },
  };
};
