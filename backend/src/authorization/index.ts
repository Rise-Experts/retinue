/**
 * Authorization port — `docs/11-authorization.md`. **Frozen v1.**
 *
 * A first-class port, not scattered `if` checks. The engine lands in REQ-004; this is the shape
 * every store, tool and retrieval path takes decisions from. Imports only core + tool contracts —
 * never an adapter.
 */

import { AgentPlatformError } from "../core/errors.js";
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

// ---------------------------------------------------------------------------
// Reference engine (REQ-004). A role→permission model; tenant policy may restrict but never
// widen it. The engine is deterministic and cache-safe for the life of a request.
// ---------------------------------------------------------------------------

export type Permission = {
  /** e.g. "read" | "execute" | "publish" | "*" */
  readonly action: string;
  /** e.g. "conversation" | "tool" | "*" */
  readonly resourceType: string;
  /** When true, a granted decision carries a requires-approval obligation. */
  readonly requiresApproval?: boolean;
};

export type RoleDefinition = {
  readonly roleId: string;
  readonly permissions: readonly Permission[];
  /** Tool names or categories this role may discover and execute. */
  readonly tools?: readonly string[];
};

export type AuditEvent = {
  readonly kind: "denied" | "allowed-write";
  readonly tenantId: string;
  readonly principalId: string;
  readonly action: string;
  readonly resource: ResourceRef;
  readonly reason?: string;
};

export type AuthorizationConfig = {
  readonly roles: readonly RoleDefinition[];
  /** Sink for denials and allowed external writes (docs/11 auditing). */
  readonly audit?: (event: AuditEvent) => void;
};

const WRITE_ACTIONS = new Set(["create", "update", "delete", "publish", "send", "execute"]);

/** The tenant predicate `scope()` produces — the same rule a Supabase RLS policy enforces. */
export const tenantRlsFilter = (tenantId: string): Readonly<Record<string, unknown>> => ({
  tenant_id: tenantId,
});

export const createAuthorizationPolicy = (config: AuthorizationConfig): AuthorizationPolicy => {
  const roleMap = new Map(config.roles.map((r) => [r.roleId, r] as const));
  const rolesOf = (ctx: ExecutionContext): RoleDefinition[] =>
    ctx.roleIds.map((id) => roleMap.get(id)).filter((r): r is RoleDefinition => r !== undefined);
  const matches = (p: Permission, action: string, type: string): boolean =>
    (p.action === "*" || p.action === action) && (p.resourceType === "*" || p.resourceType === type);

  return {
    async can(context, action, resource) {
      const audit = (kind: AuditEvent["kind"], reason?: string) =>
        config.audit?.({ kind, tenantId: context.tenantId, principalId: context.principalId, action, resource, ...(reason ? { reason } : {}) });

      // Cross-tenant guard: a resource carrying another tenant's id is never visible.
      const rt = resource.attributes?.["tenantId"];
      if (typeof rt === "string" && rt !== context.tenantId) {
        audit("denied", "cross-tenant");
        return { allow: false, reason: "cross-tenant" };
      }
      // Tools are governed by the role's allow-list (name or category), so discovery and
      // execution use the exact same rule.
      if (resource.type === "tool") {
        const allowed = new Set(rolesOf(context).flatMap((r) => r.tools ?? []));
        const category = resource.attributes?.["category"];
        const ok =
          (resource.id !== undefined && allowed.has(resource.id)) ||
          (typeof category === "string" && allowed.has(category));
        if (!ok) {
          audit("denied", "tool not permitted");
          return { allow: false, reason: `tool ${resource.id ?? "?"} not permitted` };
        }
        audit("allowed-write");
        return { allow: true };
      }
      const perm = rolesOf(context).flatMap((r) => r.permissions).find((p) => matches(p, action, resource.type));
      if (!perm) {
        audit("denied", "no permission");
        return { allow: false, reason: `no permission for ${action} on ${resource.type}` };
      }
      if (WRITE_ACTIONS.has(action)) audit("allowed-write");
      return perm.requiresApproval
        ? { allow: true, obligations: [{ kind: "requires-approval" }] }
        : { allow: true };
    },

    async filterTools(context, tools) {
      const allowed = new Set(rolesOf(context).flatMap((r) => r.tools ?? []));
      return tools.filter((t) => allowed.has(t.name) || allowed.has(t.category));
    },

    async scope(context) {
      return { tenantId: context.tenantId, roleIds: context.roleIds, filter: tenantRlsFilter(context.tenantId) };
    },
  };
};

/** Guard for the execution path: throws `forbidden` when the tool may not run. */
export const assertToolAuthorized = async (
  policy: AuthorizationPolicy,
  context: ExecutionContext,
  tool: { readonly name: string; readonly category: string },
): Promise<void> => {
  const decision = await policy.can(context, "execute", {
    type: "tool",
    id: tool.name,
    attributes: { category: tool.category },
  });
  if (!decision.allow) {
    throw new AgentPlatformError({
      code: "forbidden",
      message: decision.reason ?? `Tool ${tool.name} is not authorized`,
      retryable: false,
    });
  }
};
