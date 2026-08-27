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
  /**
   * True when this run must perform **no external write** — docs/07 and docs/08's shadow mode: *"old and
   * new systems may run in shadow mode, but shadow execution performs no external writes."*
   *
   * On the context deliberately, and the paragraph above is the reason it is safe: shadow-ness is
   * constructed by the host, exactly like `tenantId`, and **a model must never be able to clear it** —
   * clearing it would turn a shadow run into a real one. A hint a model could set would not belong here;
   * this is the opposite kind of field.
   *
   * Absent means a real run. That is the uncomfortable direction — a forgotten flag publishes rather than
   * suppresses — and it is unavoidable, because defaulting to shadow would make every existing context a
   * shadow context. The dangerous direction is closed in `defineDelegatingTool` instead: a run that *says*
   * it is shadow and has nowhere to record the suppression is refused, not performed.
   */
  readonly shadow?: boolean;
  /**
   * The running agent's tool policy — task #244.
   *
   * On the context for the same reason `shadow` is, and the argument is the one at the top of this file: context
   * identity is constructed by the host, and **nothing originating in a tool argument, a skill body or an MCP
   * tool description may reach these fields.** A model must never be able to widen `excluded`, and the only way
   * to guarantee that is for the policy to travel on the one object a model cannot write to.
   *
   * The engine sets it from `AgentManifest.toolPolicy` before it builds tools, so every path that reaches the
   * registry — a direct call, `execute_tool`, a delegating tool — sees the same policy. That breadth is the
   * point: `toolPolicy.excluded` reads as a security control, and a control enforced only where the catalogue is
   * built is bypassed by the first caller who already knows the tool's name.
   *
   * Structural (three name lists) rather than importing `ToolPolicyView`, because `core` must not depend on
   * `tools`. The same choice `ApprovalCheck` makes to avoid a tools→hitl dependency.
   *
   * Absent means no agent-level policy — every authorized tool is available. That is the right default here, and
   * it is the *safe* direction unlike `shadow`: a missing policy grants nothing that authorization has not
   * already granted, whereas a missing `shadow` flag publishes.
   */
  readonly agentToolPolicy?: {
    readonly preloaded: readonly string[];
    readonly categories: readonly string[];
    readonly excluded: readonly string[];
  };
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
