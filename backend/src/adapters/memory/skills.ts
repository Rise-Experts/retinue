/**
 * In-memory skill store — `docs/03` → Skills. Holds tenant-authored skill versions for the resolver.
 * Tenant-partitioned; validated on the way in against SKILL_LIMITS via `validateSkillInput`.
 */

import type { TenantScope } from "../../core/context.js";
import type { SkillStore } from "../../persistence/index.js";
import { validateSkillInput } from "../../skills/resolver.js";
import type { SkillCatalogEntry, SkillVersion } from "../../skills/index.js";

export const createMemorySkillStore = (seed: readonly SkillVersion[] = []): SkillStore & {
  add(tenantId: string, skill: SkillVersion): void;
} => {
  // tenantId -> `${name}@${version}` -> SkillVersion
  const byTenant = new Map<string, Map<string, SkillVersion>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  const add = (tenantId: string, skill: SkillVersion) => {
    validateSkillInput(skill);
    tenant(tenantId).set(`${skill.name}@${skill.version}`, skill);
  };
  for (const s of seed) if (s.tenantId) add(s.tenantId, s);

  return {
    add,
    async listCatalog({ tenantId }: TenantScope): Promise<readonly SkillCatalogEntry[]> {
      // Latest version per name, active only.
      const latest = new Map<string, SkillVersion>();
      for (const s of tenant(tenantId).values()) {
        if (s.status !== "active") continue;
        const prev = latest.get(s.name);
        if (!prev || s.version > prev.version) latest.set(s.name, s);
      }
      return [...latest.values()].map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source, version: s.version }));
    },
    async findVersion({ tenantId, name, version }) {
      return tenant(tenantId).get(`${name}@${version}`) ?? null;
    },
  };
};
