/**
 * Skill resolution & per-run recording — `docs/03-intelligence-runtime.md` → Skills.
 *
 * A skill is a compact catalog entry plus a lazily loaded instruction body. Only the entry sits in
 * context; the body arrives when the model calls `load_skill`. Resolution layers built-in skills
 * first, then tenant skills, so a tenant skill of the same name shadows a built-in one. Two rules
 * are enforced structurally: a skill is instructions and data — never executable code — and a
 * tenant body is untrusted text that cannot grant a tool or lower an effect. And every load is
 * recorded against the run, so skill versions are auditable per run.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { SkillStore } from "../persistence/index.js";
import {
  SKILL_LIMITS,
  type SkillCatalogEntry,
  type SkillResolver,
  type SkillSource,
  type SkillVersion,
} from "./index.js";

const invalid = (message: string) =>
  new AgentPlatformError({ code: "invalid_input", message, retryable: false });

/**
 * Validate a tenant-authored skill against the same limits as `workspace_agent_skills`, so a ported
 * skill cannot violate them on the way in. Returns the value; throws `invalid_input` on any breach.
 * There is no executable field to validate — a skill body is always plain instructions.
 */
export const validateSkillInput = (skill: SkillVersion): SkillVersion => {
  if (!SKILL_LIMITS.namePattern.test(skill.name) || skill.name.length > SKILL_LIMITS.nameMaxLength)
    throw invalid(`Skill name "${skill.name}" is not a valid slug`);
  if (
    skill.description.length < SKILL_LIMITS.descriptionMinLength ||
    skill.description.length > SKILL_LIMITS.descriptionMaxLength
  )
    throw invalid(`Skill "${skill.name}" description length is out of bounds`);
  if (skill.instructions.length > SKILL_LIMITS.instructionsMaxLength)
    throw invalid(`Skill "${skill.name}" instructions exceed ${SKILL_LIMITS.instructionsMaxLength} chars`);
  return skill;
};

const toEntry = (s: SkillVersion): SkillCatalogEntry => ({
  id: s.id,
  name: s.name,
  description: s.description,
  source: s.source,
  version: s.version,
});

/**
 * Resolver over a static built-in set plus a tenant `SkillStore`. Tenant skills shadow built-ins of
 * the same name. `listCatalog` returns compact entries only (never bodies); `loadBody` pins to an
 * exact version so a mid-run edit cannot change behaviour.
 */
export const createSkillResolver = (config: {
  readonly builtIn: readonly SkillVersion[];
  readonly store: SkillStore;
}): SkillResolver => {
  const builtInByName = new Map(config.builtIn.map((s) => [s.name, s] as const));

  return {
    async listCatalog({ tenantId, assigned, allowTenantSkills }) {
      const assignedSet = new Set(assigned);
      const byName = new Map<string, SkillCatalogEntry>();
      // Built-ins first, and only the active ones.
      //
      // The store adapters already filter discovery to the latest *active* version per name —
      // deliberate and tested: "a run pinned to an archived version keeps working and no new run picks
      // it up." This layer did not, so `status` was load-bearing for a tenant skill and inert for a
      // built-in. Same field, two meanings, which is an inconsistency rather than a decision (#122).
      for (const s of config.builtIn)
        if (s.status === "active" && assignedSet.has(s.name)) byName.set(s.name, toEntry(s));
      // ...then tenant skills shadow them by name.
      if (allowTenantSkills) {
        for (const entry of await config.store.listCatalog({ tenantId })) {
          if (assignedSet.has(entry.name)) byName.set(entry.name, entry);
        }
      }
      return [...byName.values()];
    },

    async loadBody({ tenantId, name, version }) {
      // Tenant skill of this name+version shadows the built-in.
      const tenantSkill = await config.store.findVersion({ tenantId, name, version });
      if (tenantSkill) return tenantSkill;
      // Resolved regardless of status, matching `findVersion`: a run pinned to a version that has since
      // been archived must keep working. Only *discovery* hides it.
      const builtIn = builtInByName.get(name);
      if (builtIn && builtIn.version === version) return builtIn;
      throw new AgentPlatformError({
        code: "not_found",
        message: `Skill ${name}@${version} not found`,
        retryable: false,
      });
    },
  };
};

/** What a run records for each skill it loaded — the audit trail of "skill versions per run". */
export type SkillLoadRecord = {
  readonly name: string;
  readonly version: number;
  readonly source: SkillSource;
  readonly loadedAt: string;
};

/**
 * Per-run skill loader: loads a body on demand, enforces `maxLoadedPerRun`, and records every load
 * so the run's manifest of skill versions is complete and auditable. Loading the same skill twice
 * is idempotent and does not count against the limit again.
 */
export const createRunSkillTracker = (config: {
  readonly resolver: SkillResolver;
  readonly maxLoadedPerRun?: number;
  readonly clock?: () => string;
}) => {
  const max = config.maxLoadedPerRun ?? SKILL_LIMITS.maxLoadedPerRun;
  const clock = config.clock ?? (() => new Date().toISOString());
  const byRun = new Map<string, Map<string, SkillLoadRecord>>();
  const runLog = (runId: string) => {
    let m = byRun.get(runId);
    if (!m) byRun.set(runId, (m = new Map()));
    return m;
  };

  return {
    async load(input: {
      readonly tenantId: string;
      readonly runId: string;
      readonly name: string;
      readonly version: number;
    }): Promise<SkillVersion> {
      const log = runLog(input.runId);
      const already = log.get(input.name);
      const body = await config.resolver.loadBody({
        tenantId: input.tenantId as never,
        name: input.name,
        version: input.version,
      });
      if (!already) {
        if (log.size >= max)
          throw invalid(`Run ${input.runId} has already loaded the maximum ${max} skills`);
        log.set(input.name, { name: body.name, version: body.version, source: body.source, loadedAt: clock() });
      }
      return body;
    },
    /** The skill versions loaded during a run — recorded on the run per the acceptance criteria. */
    recorded(runId: string): readonly SkillLoadRecord[] {
      return [...runLog(runId).values()];
    },
  };
};
