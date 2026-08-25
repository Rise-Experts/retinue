/**
 * Header authentication, for local use only — REQ-044 (#201).
 *
 * This is **not authentication**. It reads a tenant and a principal out of request headers, so any caller can
 * claim to be anyone. It exists because a service you cannot start is a service nobody evaluates, and the honest
 * way to ship that is a thing that says what it is and refuses to run unless someone acknowledges it.
 *
 * `RETINUE_DEV_AUTH=1` is the acknowledgement, and it is checked at **construction** rather than per request: a
 * misconfigured service then fails at boot with one clear message, instead of returning 401 to every caller and
 * leaving somebody to guess why.
 */

import { randomUUID } from "node:crypto";
import { asId } from "@retinue/agentkit";
import type { Authenticate } from "@retinue/agentkit/server";
import type { ExecutionContext } from "@retinue/agentkit";

export const DEV_AUTH_VARIABLE = "RETINUE_DEV_AUTH";
export const TENANT_HEADER = "x-retinue-tenant";
export const PRINCIPAL_HEADER = "x-retinue-principal";
export const ROLES_HEADER = "x-retinue-roles";

export class DevAuthNotEnabled extends Error {
  constructor() {
    super(
      `${DEV_AUTH_VARIABLE} is not set. This service would authenticate from request headers, which is not ` +
        `authentication — any caller could claim any tenant. Set ${DEV_AUTH_VARIABLE}=1 to acknowledge that ` +
        `before starting, or provide your own authenticate. There is deliberately no implicit default.`,
    );
    this.name = "DevAuthNotEnabled";
  }
}

export const createDevAuthenticate = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Authenticate => {
  if (env[DEV_AUTH_VARIABLE] !== "1") throw new DevAuthNotEnabled();

  return (request: Request): ExecutionContext | null => {
    const tenantId = request.headers.get(TENANT_HEADER)?.trim();
    const principalId = request.headers.get(PRINCIPAL_HEADER)?.trim();
    // Both, or nothing. A request with a tenant and no principal is not partially authenticated; it is
    // unauthenticated, and treating it as the former is how a principal-scoped store ends up keyed on undefined.
    if (!tenantId || !principalId) return null;

    const roleIds = (request.headers.get(ROLES_HEADER) ?? "")
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);

    return {
      // `asId` rather than a cast: the branded types exist so an id cannot be built by accident, and a service
      // that casts its way past them is a service that has opted out of the guarantee for everyone downstream.
      tenantId: asId(tenantId),
      principalId: asId(principalId),
      roleIds: roleIds.map((role) => asId(role)),
      locale: "en",
      timezone: "UTC",
      // `randomUUID`, not a counter: a module-level counter is how #166's `usage_records_pkey` duplicate key
      // happened, and a request id that repeats makes two requests indistinguishable in a trace.
      requestId: asId(`req-${randomUUID()}`),
    };
  };
};
