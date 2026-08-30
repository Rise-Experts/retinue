/**
 * The catalogue controls are reachable from the app — REQ-045 (#204), task #210.
 *
 * The mechanisms are tested in `backend/`. What is tested here is that they are *wired*: `find_tools` in the
 * model's hands, a budget that binds on the app's own tool list, a tenant toolset that removes a category, and a
 * skill catalogue that tells the model when it was shortened. Every one of these could pass its unit tests and
 * be reachable from nothing, which has happened seven times in this repository.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId } from "@retinue/agentkit";
import { asId, type ExecutionContext, type RoleId } from "@retinue/agentkit";
import {
  exampleCapabilities,
  exampleCatalogBudget,
  exampleRegistry,
  exampleSkillCatalogBudget,
  exampleToolset,
} from "../index.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asExampleBackend } from "../memory-composition.js";
import { createMemoryBackend } from "../memory-app.js";

const context: ExecutionContext = {
  tenantId: asId("t-scale"),
  principalId: asId("p-scale"),
  roleIds: [asId<RoleId>("editor")],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req-scale"),
  conversationId: asId<ConversationId>("c-scale"),
};

const backend = () => asExampleBackend(createMemoryBackend());

/** Every tool name the app's own registry offers this context — preloaded and discoverable. */
const namesFor = async (b: ReturnType<typeof backend>) => {
  const catalogue = await exampleRegistry(b).catalog(context, { preloaded: [], categories: [], excluded: [] });
  return [...catalogue.preloaded.map((d) => d.name), ...catalogue.discoverable.map((e) => e.name)];
};

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
    const asViewer = { ...context, roleIds: [asId<RoleId>("viewer")] } as ExecutionContext;
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

describe("the filesystem tools and the sandbox are reachable from the app — task #215", () => {
  it("adds the read tools when a root is configured, and only then", async () => {
    const root = mkdtempSync(join(tmpdir(), "retinue-example-files-"));
    setEnv({ RETINUE_FILES_ROOT: undefined });
    const without = await namesFor(backend());
    expect(without).not.toContain("fs_read");

    setEnv({ RETINUE_FILES_ROOT: root });
    const withRoot = await namesFor(backend());
    for (const name of ["fs_read", "fs_list", "fs_search"]) expect(withRoot, name).toContain(name);
    // The write tool needs the second root: reads without writes is the common case and the safer default.
    expect(withRoot).not.toContain("fs_write");

    setEnv({ RETINUE_FILES_WRITABLE_ROOT: mkdtempSync(join(tmpdir(), "retinue-example-scratch-")) });
    expect(await namesFor(backend())).toContain("fs_write");
  });

  it("refuses an escape through the app's own registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "retinue-example-files2-"));
    writeFileSync(join(root, "inside.txt"), "readable\n");
    setEnv({ RETINUE_FILES_ROOT: root });
    const registry = exampleRegistry(backend());

    const inside = await registry.execute(context, { name: "fs_read", input: { path: "inside.txt" }, toolCallId: "c-in" });
    expect(inside.ok && (inside.data as { content?: string }).content).toContain("readable");

    const outside = await registry.execute(context, {
      name: "fs_read",
      input: { path: "../../etc/passwd" },
      toolCallId: "c-out",
    });
    // A returned refusal, not a throw: the model can act on "that path is outside the root".
    expect(outside.ok).toBe(true);
    expect(outside.ok && (outside.data as { kind?: string }).kind).toBe("forbidden");
  });

  it("needs both switches before shell_exec exists at all", async () => {
    setEnv({ RETINUE_SANDBOX_IMAGE: undefined, RETINUE_SHELL: undefined });
    expect(await namesFor(backend())).not.toContain("shell_exec");

    // An image alone is not enough. Somebody who set one variable gets no shell tool, not a half-wired one.
    setEnv({ RETINUE_SANDBOX_IMAGE: "redis:7-alpine" });
    expect(await namesFor(backend())).not.toContain("shell_exec");

    setEnv({ RETINUE_SHELL: "1" });
    expect(await namesFor(backend())).toContain("shell_exec");
  });

  it("refuses to boot when shell is declared without a sandbox — the point of the declaration", () => {
    /**
     * `resolveCapabilities` will not return a runtime whose declaration and wiring disagree, and this is the one
     * capability where that is a security property rather than a diagnostic. A tool that quietly refused at the
     * first call would leave a deployment believing it had shell access it does not, or worse, the reverse.
     */
    setEnv({ RETINUE_SANDBOX_IMAGE: undefined, RETINUE_SHELL: "1" });
    expect(() => exampleCapabilities()).toThrow(/shell/);

    setEnv({ RETINUE_SANDBOX_IMAGE: "redis:7-alpine" });
    expect(exampleCapabilities().shell).toBe("on");
  });

  it("keeps shell off, and unwired, when nobody asked for it", () => {
    // Both halves: the declaration says off, and the sandbox is not built — so the capability check cannot
    // complain about something wired and undeclared, which it rightly would.
    setEnv({ RETINUE_SANDBOX_IMAGE: "redis:7-alpine", RETINUE_SHELL: undefined });
    expect(exampleCapabilities().shell).toBe("off");
  });
});
