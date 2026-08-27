/**
 * The catalogue controls are reachable from the app — REQ-045 (#204), task #210.
 *
 * The mechanisms are tested in `backend/`. What is tested here is that they are *wired*: `find_tools` in the
 * model's hands, a budget that binds on the app's own tool list, a tenant toolset that removes a category, and a
 * skill catalogue that tells the model when it was shortened. Every one of these could pass its unit tests and
 * be reachable from nothing, which has happened seven times in this repository.
 */
import { afterEach, describe, expect, it } from "vitest";
import { asId, type ExecutionContext } from "@retinue/agentkit";
import { exampleRegistry, exampleCatalogBudget, exampleToolset, exampleSkillCatalogBudget } from "../index.js";
import { asExampleBackend } from "../memory-composition.js";
import { createMemoryBackend } from "../memory-app.js";

const context: ExecutionContext = {
  tenantId: asId("t-scale"),
  principalId: asId("p-scale"),
  roleIds: ["editor"],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req-scale"),
  conversationId: asId("c-scale"),
};

const backend = () => asExampleBackend(createMemoryBackend());

const original = new Map<string, string | undefined>();
const setEnv = (values: Readonly<Record<string, string | undefined>>) => {
  for (const [key, value] of Object.entries(values)) {
    if (!original.has(key)) original.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  original.clear();
});

describe("find_tools is wired into the app", () => {
  it("appears in the catalogue the app builds", async () => {
    const catalogue = await exampleRegistry(backend()).catalog(context, { preloaded: [], categories: [], excluded: [] });
    expect(catalogue.meta.map((m) => m.name)).toContain("find_tools");
  });

  it("finds one of the app's own tools from a description of the need", async () => {
    const result = await exampleRegistry(backend()).execute(context, {
      name: "find_tools",
      input: { query: "remember a fact about this person for later" },
      toolCallId: "call-find",
    });
    expect(result.ok).toBe(true);
    const hits = result.ok ? (result.data as { hits: { entry: { name: string } }[] }).hits : [];
    expect(hits.map((h) => h.entry.name)).toContain("remember");
  });

  it("cannot find a tool the role may not use", async () => {
    // `viewer` has no `share_note`. A search that surfaced it would tell an unprivileged caller exactly what the
    // deployment can do — worse than not hiding it, because it looks hidden.
    const asViewer = { ...context, roleIds: ["viewer"] } as ExecutionContext;
    const result = await exampleRegistry(backend()).execute(asViewer, {
      name: "find_tools",
      input: { query: "share a note with someone outside" },
      toolCallId: "call-find-2",
    });
    const hits = result.ok ? (result.data as { hits: { entry: { name: string } }[] }).hits : [];
    expect(hits.map((h) => h.entry.name)).not.toContain("share_note");
  });
});

describe("the configuration seams read what a deployment sets", () => {
  it("has no budget, no toolset and no skill budget by default", () => {
    setEnv({
      RETINUE_CATALOG_BUDGET_TOKENS: undefined,
      RETINUE_DISABLED_TOOL_CATEGORIES: undefined,
      RETINUE_SKILL_CATALOGUE_BUDGET_TOKENS: undefined,
    });
    expect(exampleCatalogBudget()).toBeUndefined();
    expect(exampleToolset()).toBeUndefined();
    expect(exampleSkillCatalogBudget()).toBeUndefined();
  });

  it("reads a budget and a toolset when they are set", () => {
    setEnv({ RETINUE_CATALOG_BUDGET_TOKENS: "1500", RETINUE_DISABLED_TOOL_CATEGORIES: " web , data " });
    expect(exampleCatalogBudget()).toEqual({ maxTokens: 1500 });
    expect(exampleToolset()).toEqual({ disabledCategories: ["web", "data"] });
  });

  it("ignores a budget that is not a positive number, rather than capping at zero", () => {
    // A `0` or a typo becoming "withhold every tool" is the worst possible reading of a misconfiguration.
    setEnv({ RETINUE_CATALOG_BUDGET_TOKENS: "nonsense" });
    expect(exampleCatalogBudget()).toBeUndefined();
    setEnv({ RETINUE_CATALOG_BUDGET_TOKENS: "0" });
    expect(exampleCatalogBudget()).toBeUndefined();
  });
});

describe("a tenant toolset narrows the app's catalogue", () => {
  it("removes a whole category from discovery and from execution", async () => {
    setEnv({ RETINUE_DISABLED_TOOL_CATEGORIES: "web" });
    const registry = exampleRegistry(backend());
    const catalogue = await registry.catalog(context, { preloaded: [], categories: [], excluded: [] });
    const names = [...catalogue.preloaded.map((d) => d.name), ...catalogue.discoverable.map((e) => e.name)];
    expect(names).not.toContain("fetch_url");
    expect(names).toContain("calculate");

    const refused = await registry.execute(context, {
      name: "fetch_url",
      input: { url: "https://example.com" },
      toolCallId: "call-web",
    });
    expect(refused.ok).toBe(false);
  });

  it("states the toolset in the catalogue it returns", async () => {
    setEnv({ RETINUE_DISABLED_TOOL_CATEGORIES: "web" });
    const catalogue = await exampleRegistry(backend()).catalog(context, { preloaded: [], categories: [], excluded: [] });
    expect(catalogue.toolset).toEqual({ disabledCategories: ["web"] });
  });
});

describe("the budget binds on the app's own catalogue", () => {
  it("shortens it and names what it withheld", async () => {
    setEnv({ RETINUE_CATALOG_BUDGET_TOKENS: "200" });
    const catalogue = await exampleRegistry(backend()).catalog(context, { preloaded: [], categories: [], excluded: [] });
    expect(catalogue.truncation).toBeDefined();
    expect(catalogue.truncation?.dropped.length).toBeGreaterThan(0);
    // Search is wired in this app, so what was dropped is still reachable.
    expect(catalogue.truncation?.findable).toBe(true);
  });

  it("leaves the catalogue whole when no budget is configured", async () => {
    setEnv({ RETINUE_CATALOG_BUDGET_TOKENS: undefined });
    const catalogue = await exampleRegistry(backend()).catalog(context, { preloaded: [], categories: [], excluded: [] });
    expect(catalogue.truncation).toBeUndefined();
  });
});
