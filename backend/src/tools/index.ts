/**
 * Tool registry — `docs/03-intelligence-runtime.md`.
 *
 * The runtime builds a permission-filtered compact catalog. Only commonly required
 * tools are preloaded; other schemas load lazily. Execution rechecks authorization and
 * validates input even when the tool was discoverable earlier.
 */

import type { ExecutionContext } from "../core/context.js";
import type { PlatformError } from "../core/errors.js";
import type { BlobRef } from "../core/ids.js";
import type { IdempotencyKey } from "../idempotency/index.js";

/**
 * Effect classification. This drives the approval policy, so an unknown effect is
 * never treated as `read` — see `../mcp` for how imported tools are classified.
 */
export const TOOL_EFFECTS = [
  "read",
  "internal-write",
  "external-write",
  "destructive",
] as const;

export type ToolEffect = (typeof TOOL_EFFECTS)[number];

export type ApprovalPolicy = "never" | "policy" | "always";

export type ToolDescriptor = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  /** JSON Schema. Validated on execution, not merely advertised. */
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly effect: ToolEffect;
  readonly approvalPolicy: ApprovalPolicy;
  /** External and destructive tools must supply an idempotency key. */
  readonly requiresIdempotencyKey: boolean;
  /**
   * For a delegating tool (#113): the deterministic function this capability wraps.
   *
   * On the descriptor rather than only at the definition site, so "which existing function does this
   * delegate to" is answerable wherever a tool is visible — a catalog dump, a log line, a review.
   * Optional because a tool need not delegate; required by `defineDelegatingTool` for those that do.
   */
  readonly delegatesTo?: string;
};

/** What enters the model's context during discovery: no schemas, just enough to choose. */
export type ToolCatalogEntry = Pick<
  ToolDescriptor,
  "name" | "label" | "description" | "category" | "effect"
>;

/**
 * Shared success/error envelope — every tool, including imported ones.
 *
 * `ranToolName` is set only when the call the model made is not the call that ran: `execute_tool` names its
 * target, and without this the run event log records the indirection and loses the action. A `destructive` tool
 * invoked that way would otherwise appear in the audit trail as "execute_tool", which is not an answer to the
 * question an audit trail exists to answer.
 */
export type ToolResult<T = unknown> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly ranToolName?: string;
      /** Set when the payload was compacted or spilled rather than returned inline. */
      readonly spilledOutputRef?: BlobRef;
      readonly truncated?: boolean;
    }
  | {
      readonly ok: false;
      readonly error: PlatformError;
      readonly ranToolName?: string;
    };

/**
 * A single approved execution, presented at the moment of the call.
 *
 * Structural on purpose — the tools layer must not depend on `hitl` (the approval *check* is a
 * structural port here for the same reason). The id is opaque to everything in this layer: whoever
 * implements the check verifies it against the stored interaction, so passing one along is never the
 * same as granting anything.
 */
export type OneTimeApprovalRef = { readonly interactionId: string };

export type ToolExecutionInput = {
  readonly context: ExecutionContext;
  readonly input: unknown;
  /** Derived from tenant, run and tool-call identity. Replays return the first result. */
  readonly idempotencyKey?: string;
  /**
   * Set when this call is the execution a human already approved.
   *
   * Threaded down to the tool rather than consumed by the registry alone, because a delegating tool
   * runs its own gate — the registry letting the call through while the envelope refuses it one layer
   * lower is the same stuck loop, just harder to see.
   */
  readonly approval?: OneTimeApprovalRef;
};

export interface Tool<T = unknown> {
  readonly descriptor: ToolDescriptor;
  execute(input: ToolExecutionInput): Promise<ToolResult<T>>;
}

/**
 * What a shadow run records instead of doing.
 *
 * A port rather than a store, because what "recording" means differs by deployment: a parity harness wants
 * it in memory, a migration wants it durable and comparable to the old runtime's output.
 *
 * Here rather than in `delegating.ts` because **two layers suppress**: the registry (which covers every
 * tool) and the delegating envelope (which covers the direct-execute path). One definition, for the reason
 * #113's duplicate `toPlatformError` had to be collapsed — two would drift, and a recorder the two layers
 * disagreed about would under-report exactly the writes it exists to catch.
 */
export type SuppressedWrite = {
  readonly runId?: string;
  readonly toolName: string;
  /** The function that would have been called. */
  readonly delegatesTo: string;
  readonly effect: ToolEffect;
  /** Validated input — what would have been sent. */
  readonly input: unknown;
  readonly idempotencyKey: IdempotencyKey;
  /**
   * Whether this action would have required a human's approval.
   *
   * Captured because suppression happens *before* the approval gate — a shadow run must not ask someone to
   * approve something that will not happen, since that teaches them approving is meaningless. Recording it
   * keeps the fact the parity report wants without asking the question.
   */
  readonly wouldRequireApproval: boolean;
};

export interface ShadowRecorder {
  record(context: ExecutionContext, write: SuppressedWrite): Promise<void> | void;
}

/**
 * Applications register providers rather than individual tools, so a provider can
 * resolve its tool list against tenant configuration.
 */
export interface ToolProvider {
  readonly id: string;
  listTools(context: ExecutionContext): Promise<readonly Tool[]>;
}

// The authorization port lives in `../authorization` (docs/11) — a single canonical definition
// used for both discovery filtering and execution permission.

/** Built-in meta-tools. Always present, never provider-supplied. */
export const META_TOOLS = [
  "learn_tools",
  "find_tools",
  "execute_tool",
  "load_skill",
  "ask_questions",
  "request_approval",
  "read_tool_output",
] as const;

export type MetaToolName = (typeof META_TOOLS)[number];

export * from "./budget.js";
export * from "./credentials.js";
export * from "./find.js";
export * from "./meta-tools.js";
export * from "./registry.js";
export * from "./delegating.js";

export * from "./define.js";
