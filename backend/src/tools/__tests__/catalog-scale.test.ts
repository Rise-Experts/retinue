/**
 * `find_tools`, the catalogue budget and per-tenant toolsets — REQ-045 (#204), task #210.
 *
 * The guarantee under test is not "fewer tokens". It is that **nothing is withheld quietly**: a shortened
 * catalogue is indistinguishable from a model choosing not to use a tool, so every drop has to be named
 * somewhere a reader will look. Most of what follows is that property from three sides — the returned outcome,
 * the catalogue a client renders, and (in `engine-catalog-budget.test.ts`) the run event.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import { createAuthorizationPolicy } from "../../authorization/index.js";
import { applyTokenBudget } from "../../core/budget.js";
import { createToolRegistry, categoryEnabled, type TenantToolset } from "../registry.js";
import { createToolSearch, keywordScore, termsOf, compactEntry, weightedKeywordScore } from "../find.js";
import { entryTokens } from "../budget.js";
import type { EmbeddingProvider } from "../../knowledge/index.js";
import type { Tool, ToolDescriptor, ToolProvider } from "../index.js";

const T = asId<TenantId>("t1");
const ctx = (roleIds: readonly string[] = ["editor"]): ExecutionContext => ({
  tenantId: T,
  principalId: asId("p1"),
  roleIds: roleIds.map((r) => asId(r)),
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  runId: asId<RunId>("run1"),
});

const descriptor = (over: Partial<ToolDescriptor> & { name: string }): ToolDescriptor => ({
  label: over.name,
  description: `the ${over.name} tool`,
  category: "general",
  inputSchema: {},
  outputSchema: {},
  effect: "read",
  approvalPolicy: "never",
  requiresIdempotencyKey: false,
  ...over,
});

const tool = (d: ToolDescriptor): Tool => ({ descriptor: d, execute: async () => ({ ok: true, data: d.name }) });

const CATALOGUE: readonly ToolDescriptor[] = [
  descriptor({
    name: "github_create_issue",
    label: "Open an issue",
    category: "project",
    description: "Open a new issue on a GitHub repository with a title and body.",
    effect: "external-write",
  }),
  descriptor({
    name: "slack_post_message",
    label: "Post to Slack",
    category: "communication",
    description: "Send a message to a Slack channel.",
    effect: "external-write",
  }),
  descriptor({
    name: "web_search",
    label: "Search the web",
    category: "web",
    description: "Search the public web and return links with snippets.",
  }),
  descriptor({
    name: "stock_quote",
    label: "Stock quote",
    category: "finance",
    description: "Look up the current share price of a listed company.",
  }),
  descriptor({
    name: "parse_csv",
    label: "Parse CSV",
    category: "data",
    description: "Turn comma-separated text into rows and columns.",
  }),
];

const provider = (tools: readonly ToolDescriptor[]): ToolProvider => ({
  id: "test",
  listTools: async () => tools.map(tool),
});

const authorization = createAuthorizationPolicy({
  roles: [
    {
      roleId: "editor",
      permissions: [{ action: "execute", resourceType: "tool" }],
      tools: CATALOGUE.map((d) => d.name),
    },
    {
      // No `github_create_issue`, which is what makes the enumeration-oracle test meaningful.
      roleId: "reader",
      permissions: [{ action: "execute", resourceType: "tool" }],
      tools: ["web_search", "parse_csv"],
    },
  ] as never,
});

describe("the keyword signal", () => {
  it("drops the words every phrasing of a need contains", () => {
    expect(termsOf("I need to open an issue on a repository")).toEqual(["open", "issue", "repository"]);
  });

  it("ranks a term in the name above the same term in prose", () => {
    const named = compactEntry(CATALOGUE[0] as ToolDescriptor);
    const prose = compactEntry(descriptor({ name: "notes_write", description: "Write a note about an issue." }));
    expect(keywordScore(named, ["issue"])).toBeGreaterThan(keywordScore(prose, ["issue"]));
  });

  it("prefers the focused description over the padded near-duplicate that matches identically", () => {
    /**
     * A defect the 200-tool measurement found: `find_tools` ranked `archive_post_metrics` above
     * `get_post_metrics`. Their term matches are identical, so the raw scores tied and the alphabetical
     * tie-break decided it — which in a catalogue of `<verb>_<object>` near-duplicates systematically prefers
     * whichever verb sorts earliest.
     */
    const wanted = compactEntry(
      descriptor({
        name: "get_post_metrics",
        label: "Post metrics",
        category: "analytics",
        description: "Read engagement metrics for a published post.",
      }),
    );
    const padded = compactEntry(
      descriptor({
        name: "archive_post_metrics",
        label: "Archive post metrics",
        category: "analytics",
        description: "Read engagement metrics for a published post. Deprecated variant kept for compatibility.",
      }),
    );
    const query = termsOf("how did my post perform, show me metrics");
    expect(keywordScore(wanted, query)).toBe(keywordScore(padded, query));
    expect(weightedKeywordScore(wanted, query)).toBeGreaterThan(weightedKeywordScore(padded, query));
  });

  it("scores nothing for a query with no overlap, rather than the least-bad tool", () => {
    expect(keywordScore(compactEntry(CATALOGUE[3] as ToolDescriptor), ["photosynthesis"])).toBe(0);
  });
});

describe("find_tools", () => {
  const registry = (over: Parameters<typeof createToolRegistry>[0] extends infer C ? Partial<C> : never = {}) =>
    createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      search: createToolSearch(),
      ...over,
    });

  it("finds a tool from a description of the need", async () => {
    const outcome = await registry().find(ctx(), { query: "open an issue on a repository" });
    expect(outcome.hits[0]?.entry.name).toBe("github_create_issue");
    expect(outcome.modes).toEqual(["keyword"]);
  });

  it("returns nothing for a need no tool covers, rather than the closest thing", async () => {
    // The relevance floor. Without it every query returns *something*, and a model handed the least-bad tool
    // calls it — which is worse than being told there is nothing.
    const outcome = await registry().find(ctx(), { query: "translate this into Welsh" });
    expect(outcome.hits).toEqual([]);
  });

  it("cannot find a tool the principal is not authorized for — search is not an enumeration oracle", async () => {
    const asEditor = await registry().find(ctx(["editor"]), { query: "open an issue" });
    const asReader = await registry().find(ctx(["reader"]), { query: "open an issue" });
    expect(asEditor.hits.map((h) => h.entry.name)).toContain("github_create_issue");
    expect(asReader.hits.map((h) => h.entry.name)).not.toContain("github_create_issue");
  });

  it("is absent from the catalogue when no search is wired, rather than present and broken", async () => {
    const withSearch = await registry().catalog(ctx(), { preloaded: [], categories: [], excluded: [] });
    const without = await createToolRegistry({ providers: [provider(CATALOGUE)], authorization }).catalog(ctx(), {
      preloaded: [],
      categories: [],
      excluded: [],
    });
    expect(withSearch.meta.map((m) => m.name)).toContain("find_tools");
    expect(without.meta.map((m) => m.name)).not.toContain("find_tools");
  });

  it("is executable by the model through the registry, and says so when unwired", async () => {
    const found = await registry().execute(ctx(), { name: "find_tools", input: { query: "post a message" } });
    expect(found.ok).toBe(true);
    expect(found.ok && (found.data as { hits: { entry: { name: string } }[] }).hits[0]?.entry.name).toBe("slack_post_message");

    const unwired = await createToolRegistry({ providers: [provider(CATALOGUE)], authorization }).execute(ctx(), {
      name: "find_tools",
      input: { query: "post a message" },
    });
    expect(unwired.ok).toBe(false);
    if (!unwired.ok) expect(unwired.error.code).toBe("capability_unavailable");
  });

  it("refuses an empty query instead of ranking the whole catalogue", async () => {
    const result = await registry().execute(ctx(), { name: "find_tools", input: { query: "  " } });
    expect(result.ok).toBe(false);
  });

  it("uses both signals when embeddings are wired, and reports which", async () => {
    /**
     * A deterministic stand-in for an embedding model: one dimension per keyword, so "similar" means "mentions
     * the same words". Enough to prove the *plumbing* — that the semantic signal contributes ranks and fuses —
     * without pretending a test can measure a real model's semantics.
     */
    const axes = ["issue", "message", "search", "price", "csv"];
    const embeddings: EmbeddingProvider = {
      model: { modelId: "test-embeddings", version: "1", dimensions: axes.length },
      async embed(texts) {
        return texts.map((text) => axes.map((axis) => (text.toLowerCase().includes(axis) ? 1 : 0)));
      },
    };
    const outcome = await createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      search: createToolSearch({ embeddings }),
    }).find(ctx(), { query: "I want to send a message" });
    expect(outcome.modes).toEqual(["semantic", "keyword"]);
    expect(outcome.hits[0]?.entry.name).toBe("slack_post_message");
    expect(outcome.hits[0]?.signals).toContain("semantic");
  });

  it("embeds each document once across searches, so a catalogue is not re-embedded per query", async () => {
    let batches = 0;
    const embeddings: EmbeddingProvider = {
      model: { modelId: "counting", version: "1", dimensions: 1 },
      async embed(texts) {
        batches += 1;
        return texts.map(() => [1]);
      },
    };
    const search = createToolSearch({ embeddings });
    await search.search({ query: "issue", tools: CATALOGUE, limit: 5 });
    const afterFirst = batches;
    await search.search({ query: "issue", tools: CATALOGUE, limit: 5 });
    expect(batches).toBe(afterFirst);
  });
});

describe("the catalogue budget", () => {
  it("keeps what fits, names what did not, and reports both numbers", () => {
    const items = [
      { name: "a", tokens: 40 },
      { name: "b", tokens: 40 },
      { name: "c", tokens: 40 },
    ];
    const outcome = applyTokenBudget({
      items,
      budget: { maxTokens: 90 },
      tokensOf: (item) => item.tokens,
      nameOf: (item) => item.name,
    });
    expect(outcome.resident.map((i) => i.name)).toEqual(["a", "b"]);
    expect(outcome.dropped).toEqual(["c"]);
    expect(outcome.residentTokens).toBe(80);
    expect(outcome.budgetTokens).toBe(90);
    expect(outcome.overBudget).toBe(false);
  });

  it("never drops a protected item, and says the budget could not be met", () => {
    // The misconfiguration case: a host preloaded more than its own ceiling. Reversing its instruction silently
    // would be worse than telling it, because it would believe the ceiling was holding.
    const outcome = applyTokenBudget({
      items: [
        { name: "meta", tokens: 100 },
        { name: "other", tokens: 10 },
      ],
      budget: { maxTokens: 50 },
      tokensOf: (item) => item.tokens,
      nameOf: (item) => item.name,
      protect: (item) => item.name === "meta",
    });
    expect(outcome.resident.map((i) => i.name)).toEqual(["meta"]);
    expect(outcome.dropped).toEqual(["other"]);
    expect(outcome.overBudget).toBe(true);
  });

  it("leaves a catalogue that fits completely alone", async () => {
    const catalogue = await createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      catalogBudget: { maxTokens: 10_000 },
    }).catalog(ctx(), { preloaded: [], categories: [], excluded: [] });
    expect(catalogue.discoverable).toHaveLength(CATALOGUE.length);
    expect(catalogue.truncation).toBeUndefined();
  });

  it("shortens the catalogue and reports what it withheld", async () => {
    const entries = CATALOGUE.map(compactEntry);
    const fixed = entryTokens(entries[0] as (typeof entries)[number]);
    const catalogue = await createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      search: createToolSearch(),
      // Deliberately tight: the meta-tools alone cost more than this, so the discoverable budget floors at 0.
      catalogBudget: { maxTokens: fixed },
    }).catalog(ctx(), { preloaded: [], categories: [], excluded: [] });

    expect(catalogue.discoverable).toEqual([]);
    expect(catalogue.truncation?.dropped).toEqual(CATALOGUE.map((d) => d.name));
    // Wired search, so the model can still get to them: a deferral, not an amputation.
    expect(catalogue.truncation?.findable).toBe(true);
  });

  it("reports findable: false when there is no search to recover through", async () => {
    const catalogue = await createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      catalogBudget: { maxTokens: 1 },
    }).catalog(ctx(), { preloaded: [], categories: [], excluded: [] });
    expect(catalogue.truncation?.findable).toBe(false);
  });

  it("does not silently withdraw a tool the host preloaded", async () => {
    const catalogue = await createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      catalogBudget: { maxTokens: 1 },
    }).catalog(ctx(), { preloaded: ["web_search"], categories: [], excluded: [] });
    expect(catalogue.preloaded.map((d) => d.name)).toEqual(["web_search"]);
    expect(catalogue.truncation?.overBudget).toBe(true);
  });
});

describe("per-tenant toolsets", () => {
  const toolsetRegistry = (toolset: TenantToolset) =>
    createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      search: createToolSearch(),
      toolsets: { resolve: async () => toolset },
    });

  it("removes a disabled category from discovery, from find_tools, and from execution", async () => {
    const registry = toolsetRegistry({ disabledCategories: ["communication"] });
    const catalogue = await registry.catalog(ctx(), { preloaded: [], categories: [], excluded: [] });
    expect(catalogue.discoverable.map((e) => e.name)).not.toContain("slack_post_message");

    const found = await registry.find(ctx(), { query: "post a message to a channel" });
    expect(found.hits.map((h) => h.entry.name)).not.toContain("slack_post_message");

    const executed = await registry.execute(ctx(), { name: "slack_post_message", input: {} });
    expect(executed.ok).toBe(false);
  });

  it("treats an allow-list as the whole toolset", async () => {
    const catalogue = await toolsetRegistry({ enabledCategories: ["web", "data"] }).catalog(ctx(), {
      preloaded: [],
      categories: [],
      excluded: [],
    });
    expect(catalogue.discoverable.map((e) => e.name).sort()).toEqual(["parse_csv", "web_search"]);
  });

  it("states the toolset in the catalogue, so a narrowed deployment is not mistaken for a small one", async () => {
    const catalogue = await toolsetRegistry({ disabledCategories: ["finance"] }).catalog(ctx(), {
      preloaded: [],
      categories: [],
      excluded: [],
    });
    expect(catalogue.toolset).toEqual({ disabledCategories: ["finance"] });
  });

  it("cannot disable the meta category, because that removes the way back", () => {
    expect(categoryEnabled({ disabledCategories: ["meta"] }, "meta")).toBe(true);
    expect(categoryEnabled({ enabledCategories: ["web"] }, "meta")).toBe(true);
    expect(categoryEnabled({ enabledCategories: ["web"] }, "finance")).toBe(false);
  });

  it("is applied before authorization, not after", async () => {
    /**
     * The order the AC asks for, and it is observable: a tool a tenant switched off must never reach the
     * authorization policy. If the order were reversed the policy would be asked about tools that do not exist
     * for this tenant, and its own audit of what it filtered would be wrong.
     */
    const asked: string[] = [];
    const spying = createAuthorizationPolicy({
      roles: [{ roleId: "editor", permissions: [{ action: "execute", resourceType: "tool" }], tools: CATALOGUE.map((d) => d.name) }] as never,
    });
    const registry = createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization: {
        ...spying,
        async filterTools(context, descriptors) {
          asked.push(...descriptors.map((d) => d.name));
          return spying.filterTools(context, descriptors);
        },
      },
      toolsets: { resolve: async () => ({ disabledCategories: ["finance"] }) },
    });
    await registry.catalog(ctx(), { preloaded: [], categories: [], excluded: [] });
    expect(asked).not.toContain("stock_quote");
    expect(asked).toContain("web_search");
  });
});

describe("execute_tool — what makes truncation a deferral instead of an amputation", () => {
  const registry = () =>
    createToolRegistry({ providers: [provider(CATALOGUE)], authorization, search: createToolSearch() });

  it("runs a tool the model names, even one absent from its own list", async () => {
    const result = await registry().execute(ctx(), {
      name: "execute_tool",
      input: { name: "parse_csv", input: {} },
      toolCallId: "call-exec",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe("parse_csv");
  });

  it("does not become a way around authorization", async () => {
    /**
     * The whole reason `execute_tool` unwraps rather than dispatches: the inner call goes through every check.
     *
     * A *throw* rather than a refused result, which is the registry's existing behaviour for an unauthorized
     * tool — `assertToolAuthorized` raises `forbidden`. Asserted as a rejection rather than loosened to "either
     * shape is fine": the difference between a thrown platform error and a returned refusal is what the caller
     * has to handle, and a test that accepted both would pass if the distinction broke.
     */
    await expect(
      registry().execute(ctx(["reader"]), {
        name: "execute_tool",
        input: { name: "github_create_issue", input: {} },
        toolCallId: "call-exec-2",
      }),
    ).rejects.toThrow(/not permitted/);
  });

  it("does not become a way around the tenant's toolset", async () => {
    const narrowed = createToolRegistry({
      providers: [provider(CATALOGUE)],
      authorization,
      search: createToolSearch(),
      toolsets: { resolve: async () => ({ disabledCategories: ["data"] }) },
    });
    const result = await narrowed.execute(ctx(), {
      name: "execute_tool",
      input: { name: "parse_csv", input: {} },
      toolCallId: "call-exec-3",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses to call another meta-tool, so one call cannot start a recursion", async () => {
    for (const name of ["execute_tool", "find_tools", "learn_tools"]) {
      const result = await registry().execute(ctx(), {
        name: "execute_tool",
        input: { name, input: {} },
        toolCallId: `call-meta-${name}`,
      });
      expect(result.ok, name).toBe(false);
    }
  });

  it("refuses a missing name rather than running something arbitrary", async () => {
    const result = await registry().execute(ctx(), { name: "execute_tool", input: {}, toolCallId: "call-exec-4" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });
});

describe("learn_tools, and naming what actually ran", () => {
  const registry = () =>
    createToolRegistry({ providers: [provider(CATALOGUE)], authorization, search: createToolSearch() });

  it("returns the schema of a tool the model has not been shown", async () => {
    // The leg that was missing: search returns a name, and a model that cannot see the schema guesses the
    // arguments. In the 200-tool measurement it guessed, and the call failed.
    const result = await registry().execute(ctx(), {
      name: "learn_tools",
      input: { names: ["github_create_issue"] },
      toolCallId: "call-learn",
    });
    expect(result.ok).toBe(true);
    const tools = result.ok ? (result.data as { tools: { name: string }[] }).tools : [];
    expect(tools.map((t) => t.name)).toEqual(["github_create_issue"]);
  });

  it("will not teach a tool the principal may not use", async () => {
    const result = await registry().execute(ctx(["reader"]), {
      name: "learn_tools",
      input: { names: ["github_create_issue"] },
      toolCallId: "call-learn-2",
    });
    const tools = result.ok ? (result.data as { tools: { name: string }[] }).tools : [];
    expect(tools).toEqual([]);
  });

  it("refuses an empty request rather than dumping the whole catalogue", async () => {
    const result = await registry().execute(ctx(), { name: "learn_tools", input: {}, toolCallId: "call-learn-3" });
    expect(result.ok).toBe(false);
  });

  it("names the tool that ran, not the mechanism that ran it", async () => {
    /**
     * The audit-trail property. Without `ranToolName`, a `destructive` tool called through `execute_tool` appears
     * in the run event log as "execute_tool" — which is not an answer to the question an audit trail exists to
     * answer, and it is how this indirection would have shipped.
     */
    const result = await registry().execute(ctx(), {
      name: "execute_tool",
      input: { name: "parse_csv", input: {} },
      toolCallId: "call-attr",
    });
    expect(result.ranToolName).toBe("parse_csv");
  });

  it("leaves ranToolName absent on a direct call, so its presence means something", async () => {
    const result = await registry().execute(ctx(), { name: "parse_csv", input: {}, toolCallId: "call-direct" });
    expect(result.ranToolName).toBeUndefined();
  });
});
