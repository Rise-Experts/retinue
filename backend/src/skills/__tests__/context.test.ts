/**
 * `AgentManifest.skillPolicy` reaches a turn — REQ-057 (#242), task #244.
 *
 * The field was read by nothing, and that was not one missing line: the *subsystem* was complete and unreachable.
 * `SkillResolver.listCatalog` already took `{ tenantId, assigned, allowTenantSkills }` — the manifest's two
 * fields verbatim — the store had memory and Postgres adapters under a conformance suite, and
 * `ContextKind`/`ContextBudget` already reserved a `skills` bucket for a section nothing produced. `load_skill`
 * had been in `META_TOOLS` since the registry was written with nothing implementing it: the third instance of
 * that pattern after `execute_tool` and `learn_tools`.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { SKILL_LIMITS, type SkillCatalogEntry, type SkillResolver, type SkillVersion } from "../index.js";
import { createSkillBodyLoader, createSkillCatalogueProvider, neutralise } from "../context.js";
import { MAX_SKILLS_LOADED_PER_RUN, createToolRegistry } from "../../tools/registry.js";
import type { ToolDescriptor } from "../../tools/index.js";

const T = asId<TenantId>("t1");
const ctx: ExecutionContext = {
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  runId: asId<RunId>("run1"),
};

const entry = (name: string, source: "built-in" | "tenant" = "built-in"): SkillCatalogEntry =>
  ({ name, description: `does ${name} properly and repeatably`, version: 3, source, status: "active" }) as never;

/** A resolver that honours the policy, so the tests exercise the policy and not a stub that ignores it. */
const resolver = (all: readonly SkillCatalogEntry[]): SkillResolver & { loads: string[] } => {
  const loads: string[] = [];
  return {
    loads,
    async listCatalog({ assigned, allowTenantSkills }) {
      return all
        .filter((e) => (e.source === "tenant" ? allowTenantSkills : true))
        .filter((e) => assigned.length === 0 || assigned.includes(e.name));
    },
    async loadBody({ name, version }) {
      loads.push(`${name}@${version}`);
      return { ...entry(name), version, instructions: `# ${name}\nDo it like this.` } as SkillVersion;
    },
  };
};

describe("the catalogue section", () => {
  it("lists the skills the policy allows, and says how to get one", async () => {
    const provider = createSkillCatalogueProvider({
      resolver: resolver([entry("triage"), entry("summarise")]),
      policy: { assigned: [], allowTenantSkills: false },
    });
    const [section] = await provider.provide(ctx);
    expect(section?.kind).toBe("skills");
    expect(section?.body).toContain("`triage`");
    expect(section?.body).toContain("`summarise`");
    // A catalogue with no way to fetch a body is a dead end, so the instruction is part of the section.
    expect(section?.body).toContain("load_skill");
  });

  it("emits no section at all when the policy allows nothing", async () => {
    // Rather than an empty "Skills" heading, which tells the model it has a capability and shows it none — and
    // still costs tokens.
    const provider = createSkillCatalogueProvider({
      resolver: resolver([entry("tenant-thing", "tenant")]),
      policy: { assigned: [], allowTenantSkills: false },
    });
    expect(await provider.provide(ctx)).toEqual([]);
  });

  it("honours assigned", async () => {
    const provider = createSkillCatalogueProvider({
      resolver: resolver([entry("triage"), entry("summarise")]),
      policy: { assigned: ["triage"], allowTenantSkills: false },
    });
    const [section] = await provider.provide(ctx);
    expect(section?.body).toContain("`triage`");
    expect(section?.body).not.toContain("`summarise`");
  });

  it("honours allowTenantSkills", async () => {
    const all = [entry("built"), entry("customer", "tenant")];
    const off = createSkillCatalogueProvider({ resolver: resolver(all), policy: { assigned: [], allowTenantSkills: false } });
    const on = createSkillCatalogueProvider({ resolver: resolver(all), policy: { assigned: [], allowTenantSkills: true } });
    expect((await off.provide(ctx))[0]?.body).not.toContain("`customer`");
    expect((await on.provide(ctx))[0]?.body).toContain("`customer`");
  });

  it("is `platform` origin, and neutralises the customer-authored values it interpolates", async () => {
    // A skill body may instruct — that is what a skill is — so an untrusted envelope round the whole section
    // would be false and would break skills. The values inside it are the untrusted part.
    const nasty = { ...entry("x"), description: "line one\nline two ``` fenced" } as SkillCatalogEntry;
    const provider = createSkillCatalogueProvider({
      resolver: resolver([nasty]),
      policy: { assigned: [], allowTenantSkills: false },
    });
    const [section] = await provider.provide(ctx);
    expect(section?.origin).toBe("platform");
    expect(section?.body).not.toContain("line one\nline two");
    expect(section?.body).not.toContain("```");
    expect(neutralise("a\nb")).toBe("a b");
  });
});

describe("loading a body is gated by the same policy as listing", () => {
  it("loads a permitted skill at the version the catalogue advertised", async () => {
    // Not a version from the model's arguments: that would be a model choosing which revision of an instruction
    // to follow.
    const r = resolver([entry("triage")]);
    const loader = createSkillBodyLoader({ resolver: r, policy: { assigned: [], allowTenantSkills: false } });
    const loaded = await loader.load(ctx, "triage");
    expect(loaded?.instructions).toContain("Do it like this");
    expect(r.loads).toEqual(["triage@3"]);
  });

  it("refuses a skill the policy filtered out of the catalogue", async () => {
    // The hole this closes: a policy that filtered the *list* but not the *load* is no policy at all, because a
    // model that guessed or remembered a name would get it.
    const r = resolver([entry("triage"), entry("secret")]);
    const loader = createSkillBodyLoader({ resolver: r, policy: { assigned: ["triage"], allowTenantSkills: false } });
    expect(await loader.load(ctx, "secret")).toBeNull();
    expect(r.loads).toEqual([]);
  });

  it("refuses a tenant skill when tenant skills are off", async () => {
    const r = resolver([entry("customer", "tenant")]);
    const loader = createSkillBodyLoader({ resolver: r, policy: { assigned: [], allowTenantSkills: false } });
    expect(await loader.load(ctx, "customer")).toBeNull();
  });
});

describe("load_skill through the registry", () => {
  const allowAll = {
    async can() { return { allow: true as const }; },
    async filterTools(_c: ExecutionContext, t: readonly ToolDescriptor[]) { return t; },
    async scope(context: ExecutionContext) { return { tenantId: String(context.tenantId), roleIds: [] }; },
  };
  const withSkills = (names: readonly string[]) =>
    createToolRegistry({
      providers: [],
      authorization: allowAll,
      skills: createSkillBodyLoader({
        resolver: resolver(names.map((n) => entry(n))),
        policy: { assigned: [], allowTenantSkills: false },
      }),
    });

  it("is not advertised when no resolver is wired", async () => {
    // The rule `find_tools` already follows. A descriptor that fails at execution costs the model a call to
    // discover and reads in a transcript exactly like a broken platform — which is what it did.
    const registry = createToolRegistry({ providers: [], authorization: allowAll });
    const catalog = await registry.catalog(ctx, { preloaded: [], categories: [], excluded: [] });
    expect(catalog.meta.map((m) => m.name)).not.toContain("load_skill");
  });

  it("is advertised when one is", async () => {
    const catalog = await withSkills(["triage"]).catalog(ctx, { preloaded: [], categories: [], excluded: [] });
    expect(catalog.meta.map((m) => m.name)).toContain("load_skill");
  });

  it("returns the instructions", async () => {
    const result = await withSkills(["triage"]).execute(ctx, { name: "load_skill", input: { name: "triage" } });
    expect(result.ok).toBe(true);
    expect((result as { data: { instructions: string } }).data.instructions).toContain("Do it like this");
  });

  it("refuses an unknown name with a message pointing at the context", async () => {
    const result = await withSkills(["triage"]).execute(ctx, { name: "load_skill", input: { name: "nope" } });
    expect(result.ok).toBe(false);
    expect((result as { error: { message: string } }).error.message).toMatch(/listed in\s+your context/);
  });

  it("refuses a missing name rather than loading something arbitrary", async () => {
    const result = await withSkills(["triage"]).execute(ctx, { name: "load_skill", input: {} });
    expect(result.ok).toBe(false);
  });

  it("bounds how many one run may pull into context", async () => {
    // A model that loads every skill it can see has undone the point of a catalogue plus on-demand bodies.
    const names = Array.from({ length: MAX_SKILLS_LOADED_PER_RUN + 1 }, (_, i) => `skill-${i}`);
    const registry = withSkills(names);
    for (const n of names.slice(0, MAX_SKILLS_LOADED_PER_RUN)) {
      expect((await registry.execute(ctx, { name: "load_skill", input: { name: n } })).ok).toBe(true);
    }
    const over = await registry.execute(ctx, { name: "load_skill", input: { name: names.at(-1) } });
    expect(over.ok).toBe(false);
    expect((over as { error: { message: string } }).error.message).toMatch(/ceiling/);
  });

  it("does not spend the ceiling twice on the same skill", async () => {
    const registry = withSkills(["triage", "other"]);
    for (let i = 0; i < MAX_SKILLS_LOADED_PER_RUN + 2; i += 1) {
      expect((await registry.execute(ctx, { name: "load_skill", input: { name: "triage" } })).ok).toBe(true);
    }
    // Still room for a genuinely new one.
    expect((await registry.execute(ctx, { name: "load_skill", input: { name: "other" } })).ok).toBe(true);
  });

  it("keeps the registry's ceiling equal to SKILL_LIMITS.maxLoadedPerRun", () => {
    // The constant is duplicated to avoid a tools→skills dependency. A copy nobody compares is a copy that
    // drifts, so this is the comparison.
    expect(MAX_SKILLS_LOADED_PER_RUN).toBe(SKILL_LIMITS.maxLoadedPerRun);
  });
});

describe("the registry's load_skill is a default, not a claim on the name", () => {
  const allowAll = {
    async can() { return { allow: true as const }; },
    async filterTools(_c: ExecutionContext, t: readonly ToolDescriptor[]) { return t; },
    async scope(context: ExecutionContext) { return { tenantId: String(context.tenantId), roleIds: [] }; },
  };

  it("falls through to a provider's own load_skill when no resolver is wired", async () => {
    // The regression this caught: the reference host registers `load_skill` as a provider tool and does not use
    // the registry's resolver. Intercepting the name unconditionally answered `capability_unavailable` for a
    // tool that worked — a platform change breaking a host that was doing nothing wrong.
    let ran = false;
    const registry = createToolRegistry({
      providers: [
        {
          id: "host",
          async listTools() {
            return [
              {
                descriptor: {
                  name: "load_skill",
                  label: "Load skill",
                  description: "the host's own skill loader",
                  category: "meta",
                  inputSchema: {},
                  outputSchema: {},
                  effect: "read" as const,
                  approvalPolicy: "never" as const,
                  requiresIdempotencyKey: false,
                },
                execute: async () => {
                  ran = true;
                  return { ok: true as const, data: { loaded: true } };
                },
              },
            ];
          },
        },
      ],
      authorization: allowAll,
    });
    const result = await registry.execute(ctx, { name: "load_skill", input: { name: "anything" } });
    expect(result.ok).toBe(true);
    expect(ran).toBe(true);
  });
});
