/**
 * Tool authoring helpers — `docs/03` → Tool registry. Ergonomic ways to build a `Tool` and a
 * `ToolProvider` from a plain spec: you write `execute(input, context) => data` and throw on error;
 * the helper wraps the result in the shared success/error envelope and fills descriptor defaults
 * (idempotency is required automatically for external/destructive effects).
 */

import type { ExecutionContext } from "../core/context.js";
// One definition of the error envelope, not two. `runtime/retry.ts` already exported
// `toPlatformError`; this module had a private duplicate, and exporting that for #113's delegating
// envelope made the package barrel ambiguous about which one it meant — the same collision
// `DEFAULT_SESSION_STATE_MAX_BYTES` caused in #97. Importing the existing one instead.
import { toPlatformError } from "../runtime/retry.js";
import type { ApprovalPolicy, Tool, ToolDescriptor, ToolEffect, ToolProvider } from "./index.js";

export type ToolSpec<I = unknown, O = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly label?: string;
  readonly category?: string;
  readonly effect?: ToolEffect;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly requiresIdempotencyKey?: boolean;
  execute(input: I, context: ExecutionContext): Promise<O> | O;
};

/** Build a `Tool` from a plain spec: `execute` returns data (or throws); the envelope is handled here. */
export const defineTool = <I = unknown, O = unknown>(spec: ToolSpec<I, O>): Tool<O> => {
  const effect = spec.effect ?? "read";
  const descriptor: ToolDescriptor = {
    name: spec.name,
    label: spec.label ?? spec.name,
    description: spec.description,
    category: spec.category ?? "general",
    inputSchema: spec.inputSchema ?? {},
    outputSchema: spec.outputSchema ?? {},
    effect,
    approvalPolicy: spec.approvalPolicy ?? (effect === "external-write" || effect === "destructive" ? "always" : "never"),
    requiresIdempotencyKey: spec.requiresIdempotencyKey ?? (effect === "external-write" || effect === "destructive"),
  };
  return {
    descriptor,
    async execute({ context, input }) {
      try {
        return { ok: true, data: await spec.execute(input as I, context) };
      } catch (error) {
        return { ok: false, error: toPlatformError(error) };
      }
    },
  };
};

/** A `ToolProvider` serving a fixed set of tools. For dynamic per-tenant tools, implement the port. */
export const toolProvider = (id: string, tools: readonly Tool[]): ToolProvider => ({
  id,
  async listTools() {
    return tools;
  },
});
