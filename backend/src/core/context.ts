/**
 * Execution context — `docs/02-core-and-persistence.md`.
 *
 * Context identity is constructed by the host application. Model-generated input can
 * never override it: nothing that originates in a tool argument, a skill body or an
 * MCP tool description may reach these fields.
 */

import type {
  ConversationId,
  MembershipId,
  PrincipalId,
  RequestId,
  RoleId,
  RunId,
  TenantId,
} from "./ids.js";

export type ExecutionContext = {
  readonly tenantId: TenantId;
  readonly principalId: PrincipalId;
  readonly membershipId?: MembershipId;
  readonly roleIds: readonly RoleId[];
  readonly locale: string;
  readonly timezone: string;
  readonly conversationId?: ConversationId;
  readonly runId?: RunId;
  readonly requestId: RequestId;
};

/**
 * The tenant scope every store method receives explicitly. Governing principle 1:
 * unsafe APIs such as `findById(id)` are forbidden.
 */
export type TenantScope = {
  readonly tenantId: TenantId;
};

/** Stable cursor pagination, required of every list method. */
export type Page<T> = {
  readonly items: readonly T[];
  readonly nextCursor?: string;
};

export type PageRequest = {
  readonly limit: number;
  readonly cursor?: string;
};
