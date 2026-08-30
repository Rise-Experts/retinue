/**
 * The Azure transport, and the 403 that means two different things — REQ-054 (#232), task #236.
 *
 * `createVendorTransport` does the work. Two things are Azure's own, and both are acceptance criteria.
 *
 * ## AC-6: a 403 is either a missing role or a dead credential, and they are opposite remedies
 *
 * Azure answers both with `403`, and the difference is only in the error code inside the body:
 *
 * | Azure code | What it means | What fixes it |
 * |---|---|---|
 * | `AuthorizationFailed` | The identity is fine; it lacks an RBAC role on that scope | An administrator grants a role |
 * | `ExpiredAuthenticationToken` | The identity is not established at all | Refresh the token, or reconnect |
 *
 * Told only "forbidden", an operator re-runs the OAuth consent flow for a role assignment problem — which
 * changes nothing, because consent and RBAC are unrelated systems in Azure — or asks for a role assignment
 * when the token simply expired. Both waste a day, and both are avoidable from information that was in the
 * response all along.
 *
 * So they get **different platform codes**, not different prose: `forbidden` for the missing role and
 * `unauthorized` for the credential. A caller can branch on it without matching on a message, and
 * `withRefreshingCredentials` (#233) is time-driven precisely so that an `unauthorized` here is a real
 * credential fault rather than an expiry nobody pre-empted.
 *
 * ## AC-4: `Retry-After` is Azure's number, not ours
 *
 * ARM throttles per subscription and per operation type, and it *tells you* how long — a `429` carries
 * `Retry-After`, and the read limits carry `x-ms-ratelimit-remaining-subscription-reads` so a client can see
 * the budget draining before it hits zero. The shared transport now propagates `retryAfterMs` into the
 * platform error (it was parsing the header and dropping it), so honouring it here is a matter of classifying
 * the failure and letting the number through rather than substituting a guess.
 */

import {
  createVendorTransport,
  type CredentialRef,
  type CredentialResolver,
  type VendorFailure,
} from "@retinue/agentkit/tools";
import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

export const ARM = "https://management.azure.com";

/** Azure's error codes for "the identity is not established". Distinct from the ones below — see the header. */
export const CREDENTIAL_ERRORS = [
  "ExpiredAuthenticationToken",
  "InvalidAuthenticationToken",
  "InvalidAuthenticationTokenTenant",
  "InvalidAuthenticationTokenAudience",
  "AuthenticationFailed",
] as const;

/** Azure's error codes for "the identity is established and lacks a role". */
export const RBAC_ERRORS = [
  "AuthorizationFailed",
  "LinkedAuthorizationFailed",
  "InsufficientPrivileges",
  "AuthorizationFailure",
] as const;

/** The Azure error code inside a failure body, when there is one. */
export const azureErrorCode = (reason: string): string | undefined => {
  // ARM's envelope is `{"error":{"code":"AuthorizationFailed","message":"…"}}`, sometimes nested in `odata.error`
  // and sometimes at the top level. All three are the same two fields, so the code is matched rather than the
  // shape parsed — the body arrives here already truncated to 500 characters and may not be valid JSON.
  const match = /"code"\s*:\s*"([A-Za-z]+)"/.exec(reason);
  return match?.[1];
};

/**
 * The action an `AuthorizationFailed` message names, which is the single most useful thing in it.
 *
 * `…does not have authorization to perform action 'Microsoft.Compute/virtualMachines/restart/action' over
 * scope '/subscriptions/…'`. Quoting the action back tells an administrator exactly what to grant, and it is
 * the part a person skimming a wall of Azure prose reliably misses.
 */
export const deniedAction = (reason: string): string | undefined =>
  /perform action '([^']+)'/.exec(reason)?.[1];

const classify = (failure: VendorFailure) => {
  if (failure.status === 401 || failure.status === 403) {
    const code = azureErrorCode(failure.reason);
    const credentialProblem =
      code !== undefined && (CREDENTIAL_ERRORS as readonly string[]).includes(code);
    /**
     * An unrecognised 401 is a credential problem and an unrecognised 403 is a role problem.
     *
     * The default matters because Azure's code list is longer than the two above and grows. Splitting on the
     * status is right for the codes nobody has enumerated: a 401 is the status for "who are you", a 403 the
     * status for "not you". The enumeration above only exists because Azure violates that split for expired
     * tokens on some endpoints, which is the whole reason this AC is here.
     */
    if (credentialProblem || (failure.status === 401 && code === undefined)) {
      return {
        code: "unauthorized" as const,
        message:
          `Azure rejected the credential${code === undefined ? "" : ` (${code})`}: ${failure.reason}. This is ` +
          "the token, not a permission — the connection needs refreshing or reconnecting. Granting an RBAC " +
          "role will not fix it.",
        retryable: false,
      };
    }
    const action = deniedAction(failure.reason);
    return {
      code: "forbidden" as const,
      message:
        `Azure refused this for lack of a role${code === undefined ? "" : ` (${code})`}` +
        `${action === undefined ? "" : `: the credential cannot perform ${action}`}. The credential is valid — ` +
        "an administrator must assign an RBAC role on this scope. Reconnecting the account will not fix it, " +
        "and neither will retrying.",
      retryable: false,
    };
  }
  if (failure.status === 429 || failure.status === 503) {
    /**
     * `retryAfterMs` is *not* set here on purpose.
     *
     * The shared transport propagates `failure.retryAfterMs` when a classifier does not override it, so leaving
     * it alone is what makes Azure's own number win. Setting a value here would be substituting a guess for the
     * server's answer — which is the defect AC-4 is about, written the other way round.
     */
    const remaining = failure.headers?.["x-ms-ratelimit-remaining-subscription-reads"];
    return {
      code: "rate_limited" as const,
      message:
        `Azure Resource Manager throttled this request (${failure.status}): ${failure.reason}.` +
        (failure.retryAfterMs === undefined
          ? " ARM did not say how long to wait."
          : ` ARM asked for ${Math.ceil(failure.retryAfterMs / 1000)}s.`) +
        (remaining === undefined ? "" : ` Reads left on this subscription: ${remaining}.`),
      retryable: true,
    };
  }
  if (failure.status === 404) {
    return {
      code: "not_found" as const,
      message:
        `Azure returned 404: ${failure.reason}. Either it does not exist, or it is in a subscription this ` +
        "credential cannot see — azure_list_subscriptions shows which ones those are.",
      retryable: false,
    };
  }
  return undefined;
};

/**
 * One ARM call.
 *
 * `role` is **required**, and that is the point of this type existing rather than the tools calling the shared
 * transport directly. AC-6 asks for an error naming the role needed; a role that a tool may forget to declare
 * is one that half the tools eventually do not declare. Making it part of the call signature turns that from a
 * thing a test hopes to catch into a thing that does not compile.
 */
export type AzureCall = {
  /** The least-privileged built-in role that permits this call. See `roles.ts`. */
  readonly role: string;
  readonly method?: string;
  readonly body?: unknown;
};

export type AzureTransport = {
  readonly json: (context: ExecutionContext, path: string, call: AzureCall) => Promise<unknown>;
};

export type AzureTransportConfig = {
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
};

export const createAzureTransport = (config: AzureTransportConfig): AzureTransport => {
  const transport = createVendorTransport({
    vendor: "Azure",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.baseUrl ?? ARM,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  return {
    async json(context, path, call) {
      try {
        return await transport.json(context, path, {
          ...(call.method === undefined ? {} : { method: call.method }),
          ...(call.body === undefined ? {} : { body: call.body }),
        });
      } catch (error) {
        /**
         * The role is named here rather than in `classify`, because only the caller knows which one it needed.
         *
         * `classify` has the failure and not the tool; the tool has the role and not the failure. Joining them
         * anywhere else would mean either a transport that knows the catalogue or a per-tool copy of Azure's
         * error vocabulary.
         */
        if (error instanceof AgentPlatformError && error.code === "forbidden") {
          throw new AgentPlatformError({
            code: "forbidden",
            message: `${error.message} This call needs the "${call.role}" role, or another role including its actions.`,
            retryable: false,
          });
        }
        throw error;
      }
    },
  };
};
