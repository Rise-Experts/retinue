/**
 * Azure tools — REQ-054 (#232), task #236.
 *
 * The one integration in this sprint where the honest default is **read-only**. Everywhere else a gated write
 * costs a person an approval click; here it can cost a production environment. So the surface is deliberately
 * narrow: seven reads, one metadata write, one restart, and no way at all to create, delete, scale, deploy or
 * assign a role.
 *
 * That is a decision, not an unfinished list — see the Limits section of the integration page. Standing up and
 * tearing down infrastructure is not a capability this sprint grants, and the reason it is written down is that
 * a missing tool and a declined tool look identical from outside.
 *
 * ## Credentials
 *
 * `credentialRef` only. Specifically **not** the ambient `az` CLI login, and **not** managed identity: both
 * would make this toolkit work on the developer's machine because the developer happened to be logged in, and
 * fail everywhere else — the "passes having checked nothing" shape this repository keeps finding. An Azure
 * access token also lives about an hour, so anything beyond a single session wants the resolver wrapped in
 * `withRefreshingCredentials` (#233); that is why this task was blocked on it rather than merely sequenced
 * after it.
 */

import type { CredentialRef, CredentialResolver, Tool, ToolProvider, ToolkitAuth } from "@retinue/agentkit/tools";

import { armTools } from "./arm.js";
import { monitorTools } from "./monitor.js";
import { createAzureTransport, ARM } from "./transport.js";

export { parseResourceId, isValidResourceId, typeOf, assertApiVersion, assertResourceGroup, assertSubscriptionId, InvalidResourceIdError } from "./resource-id.js";
export type { ResourceId } from "./resource-id.js";
export { createAzureTransport, azureErrorCode, deniedAction, CREDENTIAL_ERRORS, RBAC_ERRORS, ARM } from "./transport.js";
export type { AzureTransport, AzureCall } from "./transport.js";
export { RESTART_ROLES, RESOURCES_API, SUBSCRIPTIONS_API } from "./arm.js";
export {
  boundQuery,
  checkedHours,
  rowsToObjects,
  MAX_TIMESPAN_HOURS,
  MAX_ACTIVITY_LOG_HOURS,
  MAX_ROWS,
  DEFAULT_ROWS,
} from "./monitor.js";
export { TOOL_ROLES, READER, MONITORING_READER, LOG_ANALYTICS_READER, TAG_CONTRIBUTOR, VM_CONTRIBUTOR, WEBSITE_CONTRIBUTOR } from "./roles.js";

export type AzureToolkitConfig = {
  /**
   * Resolved per call, by the host. Never read from the environment here — AC-7.
   *
   * For anything longer than a session this must be wrapped in `withRefreshingCredentials` (#233): an Azure
   * access token expires in roughly an hour, and a static one produces a toolkit that stops working mid-task.
   */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Ship only these. Mutually exclusive with `exclude`; an unknown name is refused. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};

/**
 * Narrow the surface, refusing a name that is not in it.
 *
 * The same rule as every sibling toolkit's, and it earns its keep here more than most: the name an operator is
 * most likely to exclude is `azure_restart_resource`, and a typo silently ignored ships an agent that can
 * restart production.
 */
export const select = (
  all: readonly Tool[],
  config: Pick<AzureToolkitConfig, "include" | "exclude">,
): readonly Tool[] => {
  if (config.include !== undefined && config.exclude !== undefined) {
    throw new Error(
      "createAzureToolkit was given both include and exclude. Pick one: include names what ships, exclude names what does not.",
    );
  }
  const known = new Set(all.map((tool) => tool.descriptor.name));
  const requested = config.include ?? config.exclude ?? [];
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `createAzureToolkit was given ${config.include === undefined ? "exclude" : "include"} names this toolkit ` +
        `does not have: ${unknown.join(", ")}. It has: ${[...known].join(", ")}.`,
    );
  }
  if (config.include !== undefined) {
    const wanted = new Set(config.include);
    return all.filter((tool) => wanted.has(tool.descriptor.name));
  }
  if (config.exclude !== undefined) {
    const unwanted = new Set(config.exclude);
    return all.filter((tool) => !unwanted.has(tool.descriptor.name));
  }
  return all;
};

export const createAzureToolkit = (config: AzureToolkitConfig): ToolProvider => {
  const transport = createAzureTransport(config);
  const tools = select([...armTools(transport), ...monitorTools(transport)], config);
  return {
    id: "azure",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Azure accepts — #260 AC-2.
 *
 * **OAuth only.** Azure AD has no personal-access-token equivalent for ARM; every path is a token from the
 * identity platform, whether obtained by a user consenting or by a service principal's client-credentials
 * grant. Both are `oauth2` and both arrive as a bearer, which is why `modes` has one entry and `schemes` one.
 */
export const AZURE_AUTH: ToolkitAuth = { modes: ["oauth2"], schemes: ["bearer"] };

/**
 * The two tools that are not reads — AC-2.
 *
 * Exported so the assertion in the test suite is *exact* rather than a scan for anything suspicious: every
 * tool not named here must be `read`. A create or delete tool added later without touching this constant fails
 * the test, which is the only way a package stays read-first once the person who decided it has moved on.
 */
export const AZURE_GATED: Readonly<Record<string, "external-write" | "destructive">> = {
  azure_tag_resource: "external-write",
  azure_restart_resource: "destructive",
};

export const AZURE_TOOL_NAMES = [
  // ARM.
  "azure_list_subscriptions",
  "azure_list_resource_groups",
  "azure_list_resources",
  "azure_get_resource",
  "azure_tag_resource",
  "azure_restart_resource",
  // Monitor.
  "azure_query_logs",
  "azure_get_metrics",
  "azure_list_activity_log",
] as const;
