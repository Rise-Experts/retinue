/**
 * Skills — `docs/03-intelligence-runtime.md`.
 *
 * A skill is a compact catalog entry plus a lazily loaded instruction body. Only the
 * entry sits in context; the body arrives when the model calls `load_skill`.
 *
 * Two rules the type system helps enforce:
 *
 * 1. Arbitrary skill scripts are disabled by default — a skill is instructions and
 *    data, never executable code.
 * 2. A tenant-authored body is untrusted text. It cannot grant a tool, lower an effect
 *    classification or bypass an approval; it only shapes how the model works.
 */

import type { SkillId, TenantId } from "../core/ids.js";

export const SKILL_SOURCES = ["built-in", "tenant", "plugin"] as const;

export type SkillSource = (typeof SKILL_SOURCES)[number];

export type SkillStatus = "draft" | "active" | "archived";

/** What discovery puts in context. Deliberately excludes the body. */
export type SkillCatalogEntry = {
  readonly id: SkillId;
  /** Slug form, matching the existing workspace-skill constraint. */
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly version: number;
};

export type SkillVersion = SkillCatalogEntry & {
  readonly instructions: string;
  readonly status: SkillStatus;
  readonly tenantId?: TenantId;
  readonly createdAt: string;
  readonly createdBy?: string;
};

/**
 * Limits mirroring the constraints already enforced on `workspace_agent_skills`, so a
 * ported tenant skill cannot violate them on the way in.
 */
export const SKILL_LIMITS = {
  namePattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  nameMaxLength: 64,
  descriptionMinLength: 20,
  descriptionMaxLength: 1024,
  instructionsMaxLength: 20_000,
  /** Per tenant. */
  maxSkills: 25,
  /** Per run, to bound what `load_skill` can pull into context. */
  maxLoadedPerRun: 5,
} as const;

/**
 * Resolution layers built-in skills first, then tenant skills, so a tenant skill of the
 * same name shadows a built-in one — matching the current `build_skills_for` behaviour.
 */
export interface SkillResolver {
  listCatalog(input: {
    tenantId: TenantId;
    assigned: readonly string[];
    allowTenantSkills: boolean;
  }): Promise<readonly SkillCatalogEntry[]>;

  /** Pins to an exact version so a mid-run edit cannot change behaviour. */
  loadBody(input: {
    tenantId: TenantId;
    name: string;
    version: number;
  }): Promise<SkillVersion>;
}
