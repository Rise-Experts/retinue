/**
 * Authorization port — `docs/11-authorization.md`. **Frozen v1.**
 *
 * A first-class port, not scattered `if` checks. The engine lands in REQ-004; this is the shape
 * every store, tool and retrieval path takes decisions from. Imports only core + tool contracts —
 * never an adapter.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ToolDescriptor } from "../tools/index.js";

export type ResourceRef = {
  readonly type: string;
  readonly id?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
};

export type Obligation =
  | { readonly kind: "requires-approval"; readonly riskCategory?: string }
  | { readonly kind: "redact"; readonly fields: readonly string[] };

export type Decision = {
  readonly allow: boolean;
  readonly reason?: string;
  readonly obligations?: readonly Obligation[];
};

/** The query-time filter applied *before* search, so retrieval never returns unauthorized rows. */
export type PermissionScope = {
  readonly tenantId: string;
  readonly roleIds: readonly string[];
  readonly filter?: Readonly<Record<string, unknown>>;
};

export interface AuthorizationPolicy {
  /** A single point decision; may carry obligations (e.g. requires-approval, redact). */
  can(context: ExecutionContext, action: string, resource: ResourceRef): Promise<Decision>;
  /** The permission-filtered catalog, computed before discovery. */
  filterTools(
    context: ExecutionContext,
    tools: readonly ToolDescriptor[],
  ): Promise<readonly ToolDescriptor[]>;
  /** The scope filter for a resource type, applied before any list/search. */
  scope(context: ExecutionContext, resourceType: string): Promise<PermissionScope>;
}
