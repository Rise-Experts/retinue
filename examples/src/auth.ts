/**
 * The example's `authenticate` — #155, AC-6.
 *
 * `AgentkitApp.authenticate` has no default on purpose: the server refuses to start without one, because a
 * permissive fallback would serve an open API to anyone who forgot to set it. An *example* is the most dangerous
 * place to undermine that, since example code is what people copy.
 *
 * So this reads tenant and principal from request headers — which is exactly what you must not do in production
 * — and **refuses to run unless `AGENTKIT_EXAMPLE_DEV_AUTH=1` is set explicitly**. The opt-in is the whole
 * point: nobody reaches this code path by accident, and the failure is a startup error naming the variable
 * rather than an open API nobody notices.
 */

import { asId, parseExecutionContext } from "@agentkit/backend";
import type { ExecutionContext } from "@agentkit/backend";
import type { Authenticate } from "@agentkit/server";

export const DEV_AUTH_VARIABLE = "AGENTKIT_EXAMPLE_DEV_AUTH";

/** Headers the dev authenticator reads. Named so the README and the code cannot drift. */
export const TENANT_HEADER = "x-agentkit-tenant";
export const PRINCIPAL_HEADER = "x-agentkit-principal";
export const ROLES_HEADER = "x-agentkit-roles";

export class DevAuthNotEnabled extends Error {
  constructor() {
    super(
      `${DEV_AUTH_VARIABLE} is not set. The example authenticates from request headers, which is not ` +
        `authentication — any caller can claim any tenant. Set ${DEV_AUTH_VARIABLE}=1 to acknowledge that ` +
        `before starting. There is deliberately no way to enable it implicitly.`,
    );
    this.name = "DevAuthNotEnabled";
  }
}

/**
 * Build the dev authenticator, or throw.
 *
 * Throwing at *construction* rather than per request, so a misconfigured example fails at boot with one clear
 * message instead of returning 401 to every caller and leaving someone to guess why.
 */
export const createDevAuthenticate = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Authenticate => {
  if (env[DEV_AUTH_VARIABLE] !== "1") throw new DevAuthNotEnabled();

  return (request: Request): ExecutionContext | null => {
    const tenantId = request.headers.get(TENANT_HEADER)?.trim();
    const principalId = request.headers.get(PRINCIPAL_HEADER)?.trim();
    // No fallback tenant. A default here would mean an unauthenticated request silently landing in *somebody's*
    // data, which is the one failure tenant isolation exists to prevent — so a missing header is a rejection.
    if (tenantId === undefined || tenantId === "" || principalId === undefined || principalId === "") return null;

    const roleIds = (request.headers.get(ROLES_HEADER) ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r !== "");

    // Through the platform's own validator rather than cast. The context reaches authorization decisions, and a
    // shape this file believed was valid but was not would fail somewhere far less obvious.
    return parseExecutionContext({
      tenantId,
      principalId,
      roleIds,
      locale: request.headers.get("accept-language")?.split(",")[0]?.trim() || "en",
      timezone: "UTC",
      requestId: request.headers.get("x-request-id") ?? `ex-${asId(String(Date.now()))}`,
    });
  };
};

/**
 * The startup check, separated from the authenticator — #155 AC-7.
 *
 * `createDevAuthenticate()` throws when the flag is unset, and the app module called it at module scope: which
 * gave the guarantee AC-6 asks for — *refuses to start* — and also made the module unimportable, so anything
 * reaching it (a test, the single-process composition) needed the flag too.
 *
 * Splitting it keeps both. Every runner calls this first, so the process still refuses to start with a message
 * that says what is missing; and the authenticator is built when a request arrives, so importing the module is
 * just importing a module.
 *
 * The refusal stays a **throw**, not a warning. A permissive default is how header auth reaches a deployment, and
 * "it is only the example" is a sentence nobody re-reads before copying the file.
 */
export const assertDevAuthEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  if (env[DEV_AUTH_VARIABLE] !== "1") throw new DevAuthNotEnabled();
};
