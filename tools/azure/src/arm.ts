/**
 * Azure Resource Manager — REQ-054 (#232), task #236.
 *
 * Seven reads and the two writes. The shape of this file is the decision the issue opened with: **everywhere
 * else in this sprint a gated write costs a person an approval click, and here it can cost a production
 * environment.** So there is no create, no delete, no scale, no deployment and no role assignment — see the
 * Limits section of the integration page, which states that as a decision rather than apologising for a gap.
 */

import { confirms, defineTool, destroys, type Tool } from "@retinue/agentkit/tools";

import { checkedApiVersion, checkedGroup, checkedId, checkedSubscription, refuse } from "./guards.js";
import { CONTAINER_CONTRIBUTOR, READER, TAG_CONTRIBUTOR, VM_CONTRIBUTOR, WEBSITE_CONTRIBUTOR } from "./roles.js";
import type { AzureTransport } from "./transport.js";

const CATEGORY = "cloud";

/** ARM api-versions, pinned. An unpinned version is a toolkit that changes behaviour on Azure's schedule. */
export const RESOURCES_API = "2021-04-01";
export const SUBSCRIPTIONS_API = "2022-12-01";

type Json = Record<string, unknown>;

const MAX_RESULTS = 200;
const DEFAULT_RESULTS = 50;

/** A range check that says what it wanted, used by every list here. */
const bounded = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), max);

/**
 * A resource type, validated before it goes into an OData `$filter`.
 *
 * `$filter=resourceType eq '<caller's string>'` with no check is a string built out of untrusted input and
 * sent to an authenticated endpoint — an apostrophe closes the literal and everything after it is filter
 * syntax. ARM's filter language cannot write, so the worst case is reading a wider set than intended rather
 * than a change; that is still the wrong answer returned confidently, which is the failure mode this whole
 * package is arranged against.
 */
const checkedResourceType = (type: string): string => {
  const trimmed = String(type ?? "").trim();
  if (!/^[A-Za-z0-9.]+\/[A-Za-z0-9]+(\/[A-Za-z0-9]+)*$/.test(trimmed)) {
    refuse(`"${type}" is not a resource type. One looks like Microsoft.Compute/virtualMachines.`);
  }
  return trimmed;
};

const summariseResource = (resource: Json): Json => ({
  id: resource.id,
  name: resource.name,
  type: resource.type,
  location: resource.location,
  kind: resource.kind,
  sku: resource.sku,
  tags: resource.tags,
  provisioningState: ((resource.properties ?? {}) as Json).provisioningState,
});

/**
 * Which resource types this package will restart, the endpoint for each, and the role each needs.
 *
 * An allowlist, and the narrowness is the safety property. `POST {id}/restart` is a convention rather than a
 * rule: the path, the api-version and the *meaning* differ by provider, and several types have an operation
 * spelled `restart` that does something materially worse than a restart — a `Microsoft.HDInsight` cluster node
 * reimage, for one. A generic "append /restart and hope" would be a destructive tool whose blast radius is
 * whatever a caller can name, which is not a thing to ship on the strength of a naming convention.
 *
 * Adding a type here is a deliberate act with a documented api-version and a role, which is the correct amount
 * of friction for extending the one tool in this package that causes an outage.
 */
export const RESTART_ROLES: Readonly<Record<string, { readonly apiVersion: string; readonly role: string; readonly what: string }>> = {
  "microsoft.compute/virtualmachines": {
    apiVersion: "2024-07-01",
    role: VM_CONTRIBUTOR,
    what: "reboots the virtual machine — everything running on it stops",
  },
  "microsoft.web/sites": {
    apiVersion: "2023-12-01",
    role: WEBSITE_CONTRIBUTOR,
    what: "restarts the app service — in-flight requests are dropped",
  },
  "microsoft.containerinstance/containergroups": {
    apiVersion: "2023-05-01",
    role: CONTAINER_CONTRIBUTOR,
    what: "restarts every container in the group",
  },
};

export const armTools = (transport: AzureTransport): readonly Tool[] => [
  defineTool({
    name: "azure_list_subscriptions",
    label: "List subscriptions",
    description:
      "List the Azure subscriptions this credential can see. **Start here** — every other tool is scoped by a subscription id, and guessing one produces a 404 that looks like a missing resource.",
    category: CATEGORY,
    execute: async (_input: Record<string, never>, context) => {
      const result = (await transport.json(context, `/subscriptions?api-version=${SUBSCRIPTIONS_API}`, {
        role: READER,
      })) as Json;
      return {
        subscriptions: ((result.value as Json[] | undefined) ?? []).map((subscription) => ({
          subscriptionId: subscription.subscriptionId,
          displayName: subscription.displayName,
          state: subscription.state,
          tenantId: subscription.tenantId,
        })),
      };
    },
  }),
  defineTool({
    name: "azure_list_resource_groups",
    label: "List resource groups",
    description: "List the resource groups in a subscription, with their locations and tags.",
    category: CATEGORY,
    execute: async (input: { subscriptionId: string; limit?: number }, context) => {
      const subscriptionId = checkedSubscription(input.subscriptionId);
      const limit = bounded(input.limit, DEFAULT_RESULTS, MAX_RESULTS);
      const result = (await transport.json(
        context,
        `/subscriptions/${subscriptionId}/resourcegroups?api-version=${RESOURCES_API}&$top=${limit}`,
        { role: READER },
      )) as Json;
      const groups = (result.value as Json[] | undefined) ?? [];
      return {
        groups: groups.map((group) => ({
          name: group.name,
          location: group.location,
          tags: group.tags,
          provisioningState: ((group.properties ?? {}) as Json).provisioningState,
        })),
        truncated: result.nextLink !== undefined,
      };
    },
  }),
  defineTool({
    name: "azure_list_resources",
    label: "List resources",
    description:
      "List resources in a subscription, optionally narrowed to one resource group or one resource type (for example `Microsoft.Compute/virtualMachines`). Returns ids — pass one to azure_get_resource for detail.",
    category: CATEGORY,
    execute: async (
      input: { subscriptionId: string; resourceGroup?: string; resourceType?: string; limit?: number },
      context,
    ) => {
      const subscriptionId = checkedSubscription(input.subscriptionId);
      const limit = bounded(input.limit, DEFAULT_RESULTS, MAX_RESULTS);
      const scope =
        input.resourceGroup === undefined
          ? `/subscriptions/${subscriptionId}/resources`
          : `/subscriptions/${subscriptionId}/resourceGroups/${checkedGroup(input.resourceGroup)}/resources`;
      const params = new URLSearchParams({ "api-version": RESOURCES_API, $top: String(limit) });
      if (input.resourceType !== undefined) {
        params.set("$filter", `resourceType eq '${checkedResourceType(input.resourceType)}'`);
      }
      const result = (await transport.json(context, `${scope}?${params.toString()}`, { role: READER })) as Json;
      const resources = (result.value as Json[] | undefined) ?? [];
      return {
        resources: resources.map(summariseResource),
        count: resources.length,
        // `nextLink` is Azure saying there is another page. Reported rather than followed: a list tool that
        // silently pages can return a subscription's entire inventory into a model's context.
        truncated: result.nextLink !== undefined,
      };
    },
  }),
  defineTool({
    name: "azure_get_resource",
    label: "Read a resource",
    description:
      "Read one resource by its full id: location, SKU, tags and provisioning state. Supply `apiVersion` to get the provider's own detailed properties — without it, Azure returns the generic view, which has the SKU but not every provider-specific field.",
    category: CATEGORY,
    execute: async (input: { resourceId: string; apiVersion?: string }, context) => {
      const parsed = checkedId(input.resourceId);
      /**
       * The generic `Resources - Get By Id` version by default, the provider's own when asked.
       *
       * There is no api-version that returns full properties for every type, and picking the provider's
       * requires knowing the provider. Defaulting to the generic one means this tool always works and
       * sometimes returns less; defaulting to a guessed provider version means it sometimes returns `400
       * InvalidApiVersionParameter`, which reads like a broken tool.
       */
      const apiVersion = input.apiVersion === undefined ? RESOURCES_API : checkedApiVersion(input.apiVersion);
      const resource = (await transport.json(context, `${parsed.id}?api-version=${apiVersion}`, {
        role: READER,
      })) as Json;
      return {
        ...summariseResource(resource),
        resourceGroup: parsed.resourceGroup,
        subscriptionId: parsed.subscriptionId,
        properties: resource.properties,
        detailed: input.apiVersion !== undefined,
      };
    },
  }),
  confirms({
    name: "azure_tag_resource",
    label: "Tag a resource",
    description:
      "Add or update tags on a resource. Metadata only — nothing about the running resource changes. Existing tags not named here are **kept**. Requires approval.",
    category: CATEGORY,
    execute: async (input: { resourceId: string; tags: Record<string, string> }, context) => {
      const parsed = checkedId(input.resourceId);
      const entries = Object.entries(input.tags ?? {});
      if (entries.length === 0) refuse("azure_tag_resource was called with no tags to set.");
      for (const [name, value] of entries) {
        // Azure's own rules. Refused here so the failure names the tag rather than arriving as a 400 about the
        // whole request.
        if (name.length === 0 || name.length > 512 || /[<>%&\\?/]/.test(name)) {
          refuse(`"${name}" is not a valid tag name: up to 512 characters, and none of < > % & \\ ? /.`);
        }
        if (typeof value !== "string" || value.length > 256) {
          refuse(`The value for tag "${name}" must be a string of at most 256 characters.`);
        }
      }
      /**
       * `Merge`, never `Replace` — and this is the difference between a metadata write and a destructive one.
       *
       * `Replace` sets the tag set to exactly what is sent, silently deleting every tag not named. Tags carry
       * cost-centre attribution, ownership and, in many organisations, the input to policy that governs
       * whether a resource may exist at all. A tool that quietly dropped them would be `destroys()`, not
       * `confirms()` — so it does not do that, and the classification stays honest.
       */
      const result = (await transport.json(
        context,
        `${parsed.id}/providers/Microsoft.Resources/tags/default?api-version=${RESOURCES_API}`,
        { role: TAG_CONTRIBUTOR, method: "PATCH", body: { operation: "Merge", properties: { tags: input.tags } } },
      )) as Json;
      return {
        resourceId: parsed.id,
        tagsSet: entries.map(([name]) => name),
        tags: ((result.properties ?? {}) as Json).tags,
        // Said in the result, not only the description: a tag write leaves the others alone, and a summary of
        // what happened should be able to state that without inferring it.
        existingTagsKept: true,
      };
    },
  }),
  destroys({
    name: "azure_restart_resource",
    label: "Restart a resource",
    description:
      "Restart a running Azure resource. **This causes an outage**: the resource stops serving, in-flight work is lost, and how long it takes to come back is Azure's decision, not this tool's. It is not idempotent from a user's point of view — calling it twice means two outages. Only virtual machines, app services and container groups can be restarted; anything else is refused. Requires approval.",
    category: CATEGORY,
    execute: async (input: { resourceId: string }, context) => {
      const parsed = checkedId(input.resourceId);
      const kind = RESTART_ROLES[parsed.type.toLowerCase()];
      if (kind === undefined) {
        refuse(
          `This toolkit will not restart a ${parsed.type}. It restarts virtual machines, app services and ` +
            `container groups — ${Object.keys(RESTART_ROLES).join(", ")} — because those are the types whose ` +
            "restart endpoint and semantics are known. Nothing was sent to Azure.",
        );
      }
      const { apiVersion, role, what } = kind;
      await transport.json(context, `${parsed.id}/restart?api-version=${apiVersion}`, { role, method: "POST" });
      return {
        resourceId: parsed.id,
        type: parsed.type,
        restarted: true,
        effect: what,
        /**
         * ARM answers `202 Accepted` and does the work afterwards.
         *
         * Reported rather than smoothed over, because "restarted: true" on its own would be a claim this tool
         * cannot support: the request was accepted, and whether the resource comes back healthy is visible
         * only through `azure_get_resource` a minute later.
         */
        note: "Azure accepted the restart. It happens asynchronously — read the resource again to see its state.",
      };
    },
  }),
];
