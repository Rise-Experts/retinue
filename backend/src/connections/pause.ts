/**
 * A run that needs a connection pauses and asks — REQ-063 (#259), task #264.
 *
 * A tool call fails because the tenant has no connection, or the one they have expired or lacks a scope. Before
 * this, that was `capability_unavailable`: the run died and a person read an error. Now it **pauses**, hands
 * back a login URL, and resumes when consent completes.
 *
 * ## The third pause, not a new mechanism
 *
 * The runtime already does exactly this shape twice — `waiting-for-question` and `waiting-for-approval`, each
 * with an event the engine emits, a status the worker parks in, and a resume to `queued`. Building a bespoke
 * polling loop, or leaving a failed run for somebody to restart by hand, would be a second mechanism for the
 * thing the durable runtime exists to do.
 *
 * ## Where it does **not** apply
 *
 * Only where a login URL exists. A token-based integration has nothing to redirect to, so a missing token must
 * still fail with the message naming the ref. Getting this backwards produces the worst outcome available: a run
 * that hangs for ever waiting for a consent screen nobody can reach.
 *
 * That decision comes from `ToolkitAuth.modes` (#260) — the reason `AuthMode` and `CredentialScheme` are
 * separate axes. An OAuth access token is presented as a bearer, so a design that only knew the wire format
 * could not answer this question at all.
 */

import { AgentPlatformError, isAgentPlatformError } from "../core/errors.js";
import type { AuthMode } from "../tools/credentials.js";

/**
 * Why a connection is not usable. Three triggers, all of which should pause.
 *
 * Separate values because a UI says different things: "connect your GitHub" is not "your GitHub connection
 * expired" is not "grant one more permission", and a person who is told the wrong one goes looking in the wrong
 * place.
 */
export const CONNECTION_GAPS = ["absent", "expired", "insufficient-scope"] as const;
export type ConnectionGap = (typeof CONNECTION_GAPS)[number];

export type ConnectionNeed = {
  readonly provider: string;
  readonly gap: ConnectionGap;
  /** Scopes the consent must ask for. For `insufficient-scope`, the missing ones plus what was already granted. */
  readonly scopes: readonly string[];
  readonly toolName?: string;
};

/**
 * Recognises a failure as *a missing connection* rather than a broken tool.
 *
 * Structural rather than a string match on the message: a `details.connectionGap` set by the resolver, so
 * rewording an error cannot silently turn a pausable failure into a fatal one. The marker is added by the
 * connection resolver, which is the only code that knows the difference.
 */
export const connectionNeedOf = (thrown: unknown): ConnectionNeed | null => {
  if (!isAgentPlatformError(thrown)) return null;
  const details = (thrown as { details?: Record<string, unknown> }).details;
  const gap = details?.["connectionGap"];
  const provider = details?.["connectionProvider"];
  if (typeof gap !== "string" || !(CONNECTION_GAPS as readonly string[]).includes(gap)) return null;
  if (typeof provider !== "string" || provider === "") return null;
  const scopes = details?.["connectionScopes"];
  return {
    provider,
    gap: gap as ConnectionGap,
    scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [],
    ...(typeof details?.["toolName"] === "string" ? { toolName: details["toolName"] } : {}),
  };
};

/** Attaches the marker above to an error, so the engine can recognise it without parsing prose. */
export const withConnectionGap = (
  error: AgentPlatformError,
  need: ConnectionNeed,
): AgentPlatformError =>
  new AgentPlatformError({
    code: error.code,
    message: error.message,
    retryable: false,
    details: {
      ...((error as { details?: Record<string, unknown> }).details ?? {}),
      connectionGap: need.gap,
      connectionProvider: need.provider,
      connectionScopes: [...need.scopes],
      ...(need.toolName === undefined ? {} : { toolName: need.toolName }),
    },
  });

/**
 * Whether this provider can be connected by sending somebody somewhere — the branch that decides pause or fail.
 *
 * `undefined` modes means the host has not declared any, and the honest answer there is **no**: pausing a run
 * for a provider that turns out to have no flow would hang it for ever, and failing is recoverable.
 */
export const canPauseForConsent = (modes: readonly AuthMode[] | undefined): boolean =>
  modes !== undefined && modes.includes("oauth2");

/**
 * The message a person sees, per gap.
 *
 * Written here rather than in a UI so every client says the same thing, and so the distinction between the
 * three gaps survives — a person told "connect your GitHub" when the real problem is a missing scope will
 * disconnect and reconnect and land in exactly the same place.
 */
export const consentPrompt = (need: ConnectionNeed): string => {
  switch (need.gap) {
    case "absent":
      return `Connect ${need.provider} to continue.`;
    case "expired":
      return `Your ${need.provider} connection expired. Reconnect to continue.`;
    case "insufficient-scope":
      return (
        `Your ${need.provider} connection needs ${need.scopes.join(", ") || "additional permissions"}. ` +
        "Reconnect and grant them to continue."
      );
  }
};
