/**
 * Where ShareFlow's built-in skills live (AC-5).
 *
 * #122 migrates the existing skill content onto the skills port. The value #114 adds is that the
 * content is checked **at build time**: `defineShareFlowSkill` runs the platform's own
 * `validateSkillInput` at module load, so a skill whose slug is wrong or whose description is too
 * short fails the process that imports it rather than the first `load_skill` call in production.
 *
 * `validateSkillInput` is reused, not reimplemented. It already enforces exactly the limits
 * `workspace_agent_skills` enforces, and a second copy here would be a second copy to keep in step —
 * the duplicate-definition mistake #113 had to undo.
 *
 * A skill is instructions and data, never code. There is nothing to execute in this directory, and the
 * body of a skill cannot grant a tool or lower an effect classification.
 */
import { asId, validateSkillInput, type SkillId, type SkillVersion, SKILL_LIMITS } from "@agentkit/backend";
import { AgentPlatformError } from "@agentkit/backend";

export type ShareFlowSkillInput = {
  /** Slug, kebab-case. Becomes both the name and the id — built-in skills are referenced by name. */
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** Bumped whenever `instructions` changes, so a run records which text it executed. */
  readonly version: number;
  /** When this content was authored. Required rather than stamped, so it is a fact and not a build time. */
  readonly authoredAt: string;
};

/** Build a validated built-in skill. Throws `invalid_input` at import time on any breach. */
export const defineShareFlowSkill = (input: ShareFlowSkillInput): SkillVersion =>
  validateSkillInput({
    id: asId<SkillId>(`shareflow.${input.name}`),
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    source: "built-in",
    status: "active",
    version: input.version,
    createdAt: input.authoredAt,
  });

/**
 * Assemble the built-in set.
 *
 * Two checks the resolver cannot make for itself: duplicate names (its `Map` would silently keep the
 * last one, so a copy-paste would quietly shadow the skill it was copied from), and a set larger than
 * `SKILL_LIMITS.maxSkills` — the per-tenant ceiling the catalog was sized against, which built-ins
 * share context with.
 */
export const shareFlowBuiltInSkills = (
  skills: readonly SkillVersion[],
): readonly SkillVersion[] => {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name))
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `duplicate built-in ShareFlow skill: ${skill.name}`,
        retryable: false,
      });
    seen.add(skill.name);
  }
  if (skills.length > SKILL_LIMITS.maxSkills)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${skills.length} built-in skills exceeds the ${SKILL_LIMITS.maxSkills}-skill catalog ceiling`,
      retryable: false,
    });
  return skills;
};

/**
 * The built-in set. Empty until #122 — deliberately, rather than seeded with plausible-looking
 * instructions nobody wrote on purpose. An assistant shipping invented skill prose is worse than one
 * shipping none.
 */
export const SHAREFLOW_BUILT_IN_SKILLS: readonly SkillVersion[] = shareFlowBuiltInSkills([]);
