/**
 * Azure resource ids, parsed before use — REQ-054 (#232), task #236, AC-5.
 *
 * A resource id is a path:
 *
 * ```
 * /subscriptions/{guid}/resourceGroups/{name}/providers/{namespace}/{type}/{name}[/{childType}/{childName}]…
 * ```
 *
 * ## Why this is validated locally rather than sent and hoped for
 *
 * Two reasons, and only the first is the obvious one.
 *
 * **A malformed id gets a confusing answer, not a clear one.** ARM replies to a wrong-shaped path with `404`,
 * which is indistinguishable from a resource that exists in a subscription this credential cannot see — and a
 * model told "not found" starts guessing names. Told "that is not a resource id, it is missing the
 * `/providers/` segment", it stops.
 *
 * **A resource id is interpolated into a URL, and every call appends `?api-version=…`.** A "name" containing a
 * `?` therefore ends the path and starts the query string, so a caller — or a model repeating a string it read
 * out of a document — could append or override query parameters on an authenticated request to
 * `management.azure.com`. The same goes for `#`, for a bare `%` beginning an escape, and for a `/` smuggled in
 * as `%2f`, which ARM's router decodes. That is not a typo class, it is a request-forgery class, and it is why
 * the segment charset here is an allowlist rather than a handful of banned characters.
 *
 * Nothing here talks to Azure, so all of it is testable without a network and none of it can pass by accident.
 */

/** A parsed id. `type` is the full `Namespace/type[/childType…]`, which is what a caller actually matches on. */
export type ResourceId = {
  readonly subscriptionId: string;
  /** Absent for a subscription-scoped resource — a policy assignment, say — which has no group. */
  readonly resourceGroup?: string;
  readonly namespace: string;
  /** `Microsoft.Compute/virtualMachines`, lowercased for comparison by `typeOf`. */
  readonly type: string;
  /** The last name in the path: the resource itself, or the child when the id addresses one. */
  readonly name: string;
  /** Normalised: exactly as Azure would write it, with the canonical segment spellings. */
  readonly id: string;
};

export class InvalidResourceIdError extends Error {}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * What may appear in a single path segment.
 *
 * Letters, digits and the punctuation Azure actually permits in resource names — `.`, `_`, `-`, `(`, `)` — plus
 * nothing else. In particular **not** `/`, `?`, `#`, `%`, `\`, a space, or any control character. Azure's own
 * naming rules are per-provider and looser in places (a storage account is stricter, a resource group allows
 * unicode), and being marginally stricter than the loosest provider costs a caller nothing they can act on,
 * while being looser than this costs the guarantee in the header.
 */
const SEGMENT = /^[A-Za-z0-9._()-]{1,260}$/;

/**
 * Declared as a `function` with an `asserts` signature, not an arrow.
 *
 * TypeScript only narrows through an assertion when it can see one syntactically, and an arrow assigned to a
 * `const` does not qualify. Written the other way, every check below still throws at runtime while the compiler
 * goes on believing the values might be `undefined` — so the file would need a cast per field, and a cast is
 * exactly the thing that stops a real mistake being caught here later.
 */
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvalidResourceIdError(message);
}

/**
 * Parses an id, throwing an explanation rather than sending a malformed path.
 *
 * Case-insensitive on the fixed segments — ARM writes `resourceGroups` in the ids it returns and accepts
 * `resourcegroups` in the ones it is given, and a caller pasting an id out of the portal has whichever the
 * portal used that day.
 */
export const parseResourceId = (raw: string): ResourceId => {
  assert(
    typeof raw === "string" && raw.trim() !== "",
    "A resource id is required, like /subscriptions/<guid>/resourceGroups/<group>/providers/Microsoft.Compute/virtualMachines/<name>.",
  );
  const trimmed = raw.trim();
  assert(trimmed.startsWith("/"), `"${trimmed}" is not a resource id — an id starts with /subscriptions/.`);

  const parts = trimmed.slice(1).split("/");
  // Checked before anything else: an empty segment means a `//`, which some routers collapse and some do not.
  assert(
    parts.every((part) => part !== ""),
    `"${trimmed}" has an empty path segment. A resource id has no repeated or trailing slashes.`,
  );
  for (const part of parts) {
    assert(
      SEGMENT.test(part),
      `"${part}" is not a valid path segment in a resource id. Letters, digits and . _ - ( ) only — a name ` +
        "containing a slash, a question mark, a percent sign or a space is not a resource name, and this " +
        "request was not sent.",
    );
  }

  assert(
    parts[0]?.toLowerCase() === "subscriptions",
    `"${trimmed}" does not start with /subscriptions/. Management-group and tenant-scoped ids are not supported by this toolkit.`,
  );
  const subscriptionId = parts[1];
  assert(
    subscriptionId !== undefined && GUID.test(subscriptionId),
    `"${parts[1] ?? ""}" is not a subscription id — it should be a GUID.`,
  );

  let index = 2;
  let resourceGroup: string | undefined;
  if (parts[index]?.toLowerCase() === "resourcegroups") {
    resourceGroup = parts[index + 1];
    assert(resourceGroup !== undefined, `"${trimmed}" ends after /resourceGroups/ without naming one.`);
    const group: string = resourceGroup;
    // Azure's own limit, and worth enforcing because a group name is the segment most often pasted wrong.
    assert(group.length <= 90, `The resource group name in "${trimmed}" is longer than Azure's 90-character limit.`);
    index += 2;
  }

  assert(
    parts[index]?.toLowerCase() === "providers",
    `"${trimmed}" has no /providers/ segment, so it names a subscription or a resource group rather than a resource.`,
  );
  index += 1;

  const namespace = parts[index];
  assert(namespace !== undefined, `"${trimmed}" ends after /providers/ without a resource provider.`);
  assert(
    namespace.includes("."),
    `"${namespace}" is not a resource provider namespace — one looks like Microsoft.Compute.`,
  );
  index += 1;

  /**
   * The remainder must be `type/name` pairs.
   *
   * An odd count means a *type* with no name — `…/virtualMachines` — which is a collection, not a resource.
   * ARM answers a GET on one with a list, so accepting it here would turn "get this VM" into "get every VM in
   * the group" and the caller would never know the difference from the shape of the reply.
   */
  const rest = parts.slice(index);
  assert(rest.length >= 2, `"${trimmed}" names the provider ${namespace} but no resource type and name.`);
  assert(
    rest.length % 2 === 0,
    `"${trimmed}" ends with a resource type and no name, which addresses a collection rather than one resource.`,
  );

  const typeSegments = rest.filter((_, position) => position % 2 === 0);
  const nameSegments = rest.filter((_, position) => position % 2 === 1);
  const name = nameSegments[nameSegments.length - 1];
  assert(name !== undefined, `"${trimmed}" has no resource name.`);

  return {
    subscriptionId,
    ...(resourceGroup === undefined ? {} : { resourceGroup }),
    namespace,
    type: [namespace, ...typeSegments].join("/"),
    name,
    id: trimmed,
  };
};

/** The full type, lowercased — the form to compare against, since ARM's casing varies by endpoint. */
export const typeOf = (id: string | ResourceId): string =>
  (typeof id === "string" ? parseResourceId(id) : id).type.toLowerCase();

export const isValidResourceId = (raw: string): boolean => {
  try {
    parseResourceId(raw);
    return true;
  } catch {
    return false;
  }
};

/**
 * A subscription id on its own, for the tools scoped to one rather than to a resource.
 *
 * Same reasoning as the segment check: it goes straight into a URL path, so it is a GUID or it is refused.
 */
export const assertSubscriptionId = (subscriptionId: string): string => {
  assert(
    typeof subscriptionId === "string" && GUID.test(subscriptionId.trim()),
    `"${subscriptionId}" is not a subscription id. Call azure_list_subscriptions to see the ones this credential can reach.`,
  );
  return subscriptionId.trim();
};

/** A resource group name, for the same reason. Azure allows a trailing period nowhere. */
export const assertResourceGroup = (group: string): string => {
  const trimmed = String(group ?? "").trim();
  assert(SEGMENT.test(trimmed) && trimmed.length <= 90, `"${group}" is not a resource group name.`);
  assert(!trimmed.endsWith("."), `"${group}" ends with a period, which Azure does not allow in a resource group name.`);
  return trimmed;
};

/**
 * An `api-version`, validated because it is a query parameter a caller may supply.
 *
 * `2021-04-01`, optionally `-preview`. Anything else — and specifically anything containing an `&` — would let
 * a caller add parameters to an authenticated ARM request, which is the same hole the segment charset closes.
 */
export const assertApiVersion = (version: string): string => {
  const trimmed = String(version ?? "").trim();
  assert(
    /^\d{4}-\d{2}-\d{2}(-preview|-beta|-privatepreview)?$/.test(trimmed),
    `"${version}" is not an api-version. One looks like 2021-04-01, or 2021-04-01-preview.`,
  );
  return trimmed;
};
