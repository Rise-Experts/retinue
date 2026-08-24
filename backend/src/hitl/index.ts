/**
 * Durable questions and approvals — `docs/04-durable-runtime-and-hitl.md`.
 */

import type { ApprovalGrantId, InteractionId, RunId, TenantId } from "../core/ids.js";
import type { QuestionAnswer } from "../core/content-parts.js";
import type { QuestionSpec } from "./service.js";

export type PendingQuestion = {
  readonly id: InteractionId;
  readonly tenantId: TenantId;
  readonly runId: RunId;
  /**
   * The specs as asked — `QuestionSpec`, not a narrower copy of it (#163).
   *
   * This was an inline duplicate carrying only `key`, `prompt` and `options`, so when `multiple` and
   * `allowOther` were added to `QuestionSpec` they were stored and read back by the adapters and then dropped
   * on the floor here. Anything reading a pending question — the GraphQL query, a host's own UI — saw a
   * multi-select as a single choice, with nothing in the types to say so.
   */
  readonly questions: readonly QuestionSpec[];
  readonly createdAt: string;
  readonly answeredAt?: string;
  /** A value may be a string or an array — see `QuestionSpec.multiple` (#155). */
  readonly answers?: Readonly<Record<string, QuestionAnswer>>;
};

export const APPROVAL_DECISIONS = [
  "allow-once",
  "allow-conversation",
  "allow-always",
  "deny",
] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export type ApprovalScope = "principal" | "tenant" | "category" | "conversation";

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
  /**
   * When the single execution this approval authorizes was claimed.
   *
   * This is where `allow-once` gets its "once". A grant would have been the easy mechanism and the
   * wrong one — a grant is standing by definition, so issuing one for a one-time decision would
   * silently broaden the authority the human actually gave. The interaction carries its own
   * at-most-once counter instead, claimed atomically by the store, so a resumed run executes the
   * approved call exactly once and a second attempt finds nothing left to claim.
   */
  readonly consumedAt?: string;
};


/** A standing grant from `allow-conversation` or `allow-always`. */
export type ApprovalGrant = {
  readonly id: ApprovalGrantId;
  readonly tenantId: TenantId;
  readonly scope: ApprovalScope;
  readonly toolNameOrCategory: string;
  /** Required when `scope` is `conversation`: the grant only applies within this conversation. */
  readonly conversationId?: string;
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

export * from "./service.js";
export * from "./approved-execution.js";
