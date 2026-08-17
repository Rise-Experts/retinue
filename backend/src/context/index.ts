/**
 * Context providers and prompt budgeting — `docs/03-intelligence-runtime.md`.
 */

import type { ExecutionContext } from "../core/context.js";

export type ContextSensitivity = "public" | "internal" | "confidential" | "restricted";

/** Budget bucket a section draws from. Mirrors the fields of `ContextBudget`. */
export type ContextKind = "base-policy" | "user-context" | "tools" | "skills" | "knowledge" | "history";

export type ContextSection = {
  readonly providerId: string;
  readonly title: string;
  readonly body: string;
  /** Higher priority survives pruning longer. */
  readonly priority: number;
  readonly estimatedTokens: number;
  /** Where this came from, so a claim in the output can be traced back. */
  readonly provenance: string;
  readonly sensitivity: ContextSensitivity;
  readonly cacheable: boolean;
  readonly expiresAt?: string;
  /** Budget bucket. Defaults to `user-context` when a provider does not specify one. */
  readonly kind?: ContextKind;
  /** When set, this section is eligible for pruning in that stage. Unset ⇒ preserved (recent turns,
   * open tool continuity, base policy). */
  readonly pruneStage?: PruneStage;
};

export interface ContextProvider {
  readonly id: string;
  provide(context: ExecutionContext): Promise<readonly ContextSection[]>;
}

/** Explicit per-section budgets rather than one undifferentiated window. */
export type ContextBudget = {
  readonly basePolicyTokens: number;
  readonly userContextTokens: number;
  readonly toolTokens: number;
  readonly skillTokens: number;
  readonly knowledgeTokens: number;
  readonly historyTokens: number;
};

/**
 * Pruning order. Old reasoning and tool detail go first; recent semantic turns and tool
 * continuity are preserved. If the prompt still will not fit, assembly fails loudly
 * rather than silently truncating critical instructions.
 */
export const PRUNE_ORDER = [
  "old-reasoning",
  "old-tool-detail",
  "old-knowledge",
  "old-turns",
] as const;

export type PruneStage = (typeof PRUNE_ORDER)[number];

/** Per-section token estimates, so prompt composition is previewable. */
export type PromptPreview = {
  readonly sections: readonly {
    readonly title: string;
    readonly estimatedTokens: number;
    readonly included: boolean;
  }[];
  readonly totalTokens: number;
  readonly budget: ContextBudget;
};

export * from "./assembler.js";

export * from "./compaction.js";
