/**
 * Agent manifests — `docs/03-intelligence-runtime.md`.
 *
 * Agents are declarative, stored, versioned and auditable. A run records the manifest
 * version it executed, so editing an agent never rewrites history.
 */

import type { ModelPolicy } from "../models/index.js";
import type { ExecutionLimits } from "../runtime/index.js";

export type ResponseFormat =
  | { readonly kind: "text" }
  | { readonly kind: "structured"; readonly schema: unknown };

export type ToolPolicy = {
  /** Loaded into context up front. Keep small — everything else is discovered lazily. */
  readonly preloaded: readonly string[];
  readonly categories: readonly string[];
  readonly excluded: readonly string[];
};

export type SkillPolicy = {
  readonly assigned: readonly string[];
  /** Whether tenant-authored skills may be layered over the built-in set. */
  readonly allowTenantSkills: boolean;
};

export type AgentManifest = {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly modelPolicy: ModelPolicy;
  readonly responseFormat: ResponseFormat;
  readonly toolPolicy: ToolPolicy;
  readonly skillPolicy: SkillPolicy;
  readonly authorizationPolicyId: string;
  readonly contextProviderIds: readonly string[];
  readonly limits: ExecutionLimits;
};
