/**
 * Durable questions and approvals — `docs/04-durable-runtime-and-hitl.md`.
 */

import type { ApprovalGrantId, InteractionId, RunId, TenantId } from "../core/ids.js";

export type PendingQuestion = {
  readonly id: InteractionId;
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly questions: readonly {
    readonly key: string;
    readonly prompt: string;
    readonly options?: readonly string[];
  }[];
  readonly createdAt: string;
  readonly answeredAt?: string;
  readonly answers?: Readonly<Record<string, string>>;
};

export const APPROVAL_DECISIONS = [
  "allow-once",
  "allow-conversation",
  "allow-always",
  "deny",
] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export type ApprovalScope = "principal" | "tenant" | "category";

/**
 * The pending approval stores the exact normalized tool name and input. Resumption
 * executes the stored input — never a model-regenerated version.
 */
export type PendingApproval = {
  readonly id: InteractionId;
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly toolName: string;
  readonly normalizedInput: unknown;
  readonly riskCategory: string;
  readonly summary: string;
  readonly estimatedCostMinorUnits?: number;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly decidedAt?: string;
  readonly decision?: ApprovalDecision;
};

/** A standing grant from `allow-conversation` or `allow-always`. */
export type ApprovalGrant = {
  readonly id: ApprovalGrantId;
  readonly tenantId: TenantId;
  readonly scope: ApprovalScope;
  readonly toolNameOrCategory: string;
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
};

/**
 * Derived from tenant, run and tool-call identity, so a resumed or retried call returns
 * the original result instead of repeating the side effect.
 */
export type IdempotencyKeyInput = {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly toolCallId: string;
};
