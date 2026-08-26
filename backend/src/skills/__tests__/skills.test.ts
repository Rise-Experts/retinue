import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { SkillId, TenantId } from "../../core/ids.js";
import { createMemorySkillStore } from "../../adapters/memory/index.js";
import { type SkillVersion } from "../index.js";
import { createRunSkillTracker, createSkillResolver, validateSkillInput } from "../index.js";

const T = asId<TenantId>("t1");

const skill = (over: Partial<SkillVersion> & { name: string; version: number; source: SkillVersion["source"] }): SkillVersion => ({
  id: asId<SkillId>(`${over.name}-${over.version}`),
  description: "A helpful, sufficiently long skill description for tests.",
  instructions: `# ${over.name}\nDo the thing.`,
  status: "active",
  createdAt: "t",
  ...over,
});

const builtIn = [
  skill({ name: "summarize", version: 1, source: "built-in" }),
  skill({ name: "translate", version: 1, source: "built-in" }),
];

describe("skill catalog — compact, assigned, shadowing", () => {
  it("returns only assigned skills, as compact entries without bodies", async () => {
    const resolver = createSkillResolver({ builtIn, store: createMemorySkillStore() });
    const catalog = await resolver.listCatalog({ tenantId: T, assigned: ["summarize"], allowTenantSkills: false });
    expect(catalog.map((e) => e.name)).toEqual(["summarize"]);
    expect(catalog[0]).not.toHaveProperty("instructions"); // body never enters the catalog
  });

  it("lets a tenant skill shadow a built-in of the same name", async () => {
    const store = createMemorySkillStore();
    store.add(T, skill({ name: "summarize", version: 2, source: "tenant", tenantId: T }));
    const resolver = createSkillResolver({ builtIn, store });
    const catalog = await resolver.listCatalog({ tenantId: T, assigned: ["summarize"], allowTenantSkills: true });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ source: "tenant", version: 2 });
  });

  it("ignores tenant skills when the agent disallows them", async () => {
    const store = createMemorySkillStore();
    store.add(T, skill({ name: "custom", version: 1, source: "tenant", tenantId: T }));
    const resolver = createSkillResolver({ builtIn, store });
    const catalog = await resolver.listCatalog({ tenantId: T, assigned: ["custom"], allowTenantSkills: false });
    expect(catalog).toHaveLength(0);
  });
});

describe("skill loading — pinned versions, recorded per run", () => {
  it("loads a body pinned to an exact version and records it on the run", async () => {
    const resolver = createSkillResolver({ builtIn, store: createMemorySkillStore() });
    const tracker = createRunSkillTracker({ resolver, clock: () => "t" });
    const body = await tracker.load({ tenantId: T, runId: "run1", name: "summarize", version: 1 });
    expect(body.instructions).toContain("Do the thing");
    expect(tracker.recorded("run1")).toEqual([{ name: "summarize", version: 1, source: "built-in", loadedAt: "t" }]);
  });

  it("enforces the per-run load ceiling", async () => {
    const many = Array.from({ length: 6 }, (_, i) => skill({ name: `s${i}`, version: 1, source: "built-in" }));
    const resolver = createSkillResolver({ builtIn: many, store: createMemorySkillStore() });
    const tracker = createRunSkillTracker({ resolver, maxLoadedPerRun: 2 });
    await tracker.load({ tenantId: T, runId: "r", name: "s0", version: 1 });
    await tracker.load({ tenantId: T, runId: "r", name: "s1", version: 1 });
    await expect(tracker.load({ tenantId: T, runId: "r", name: "s2", version: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    // Re-loading an already-loaded skill is idempotent and does not count again.
    await expect(tracker.load({ tenantId: T, runId: "r", name: "s0", version: 1 })).resolves.toBeDefined();
  });
});

describe("tenant skill validation", () => {
  it("rejects an invalid slug and oversize instructions", () => {
    expect(() => validateSkillInput(skill({ name: "Bad Name", version: 1, source: "tenant" }))).toThrow(/slug/);
    expect(() =>
      validateSkillInput(skill({ name: "ok", version: 1, source: "tenant", instructions: "x".repeat(20_001) })),
    ).toThrow(/instructions/);
  });
});
