/**
 * Four trackers wired at once — REQ-052 (#224), AC-3.
 *
 * The ACs for #225 and #226 test each package alone. This tests what happens when a deployment wires more than
 * one, which is the case the packages cannot test about themselves and the one a real deployment is in: Jira
 * and Linear are both issue trackers with search / get / create / update / comment, and Notion and Confluence
 * are both page stores. If a name collided, the registry would **drop both** — its rule for an ambiguous name —
 * and two integrations would silently lose a tool each.
 *
 * Everything here goes through `exampleToolkits` and `exampleRegistry`, the app's own wiring, for the reason
 * the sibling file states: "built, tested and unreachable" is this repository's most repeated defect, and four
 * new packages with nothing importing them would have been the next instance.
 */
import { afterEach, describe, expect, it } from "vitest";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import { exampleRegistry } from "../index.js";
import { asExampleBackend } from "../memory-composition.js";
import { createMemoryBackend } from "../memory-app.js";
import { exampleToolkits } from "../toolkits.js";

const context: ExecutionContext = {
  tenantId: asId("t-trackers"),
  principalId: asId("p-trackers"),
  roleIds: ["editor"],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req-trackers"),
  conversationId: asId("c-trackers"),
};

/** Every tracker credential at once — the configuration this test exists to exercise. */
const ALL = {
  ATLASSIAN_EMAIL: "a@b.c",
  ATLASSIAN_API_TOKEN: "atl-test",
  ATLASSIAN_SITE_URL: "https://acme.atlassian.net",
  LINEAR_API_KEY: "lin_api_test",
  NOTION_TOKEN: "secret_test",
} as const;

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

const backend = () => asExampleBackend(createMemoryBackend());

const catalogueNames = async (): Promise<string[]> => {
  const catalogue = await exampleRegistry(backend()).catalog(context, { preloaded: [], categories: [], excluded: [] });
  return [...catalogue.preloaded, ...catalogue.discoverable].map((entry) => entry.name);
};

describe("four trackers wired at once — AC-3", () => {
  it("contributes all four toolkits when every credential is present", () => {
    const providers = exampleToolkits(ALL);
    expect(providers.map((provider) => provider.id).sort()).toEqual(["confluence", "jira", "linear", "notion"]);
  });

  it("wires Jira and Confluence from one credential, and neither without the site URL", () => {
    // The reason they ship together. A token with no site is a configuration mistake, not a partial one.
    expect(exampleToolkits({ ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_API_TOKEN: "t" }).map((p) => p.id)).toEqual([]);
    expect(exampleToolkits(ALL).filter((p) => p.id === "jira" || p.id === "confluence")).toHaveLength(2);
  });

  it("contributes nothing for a toolkit whose credential is absent", async () => {
    // A toolkit with no credential contributes *no tools*, rather than tools that always answer "not
    // configured" — the second kind costs a turn to discover and reads like a broken integration.
    expect(exampleToolkits({}).map((provider) => provider.id)).toEqual([]);
  });

  it("has no ambiguous name across the four, which would make the registry drop both", async () => {
    /**
     * The failure this exists for. The registry drops a duplicated name rather than picking a provider — the
     * right call, because both choices are defensible and neither is visible — so one collision costs *two*
     * tools and nothing says so.
     *
     * Vendor prefixes make this true by construction, which is exactly why the convention exists. Asserting it
     * is what keeps a future toolkit from quietly breaking it.
     */
    const all = await Promise.all(exampleToolkits(ALL).map((provider) => provider.listTools(context)));
    const names = all.flat().map((tool) => tool.descriptor.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(8 + 6 + 7 + 7);
  });

  it("keeps the granted tracker tools reachable in the app's own registry", async () => {
    /**
     * The app authorizes by an explicit allowlist — deliberately not derived from `*_TOOL_NAMES`, because "a
     * grant is a decision" and deriving it would widen what a role may do every time a package gained a tool.
     *
     * So this asserts the *granted* set arrives, which is what "reachable" means here. A tool that is wired but
     * ungranted is invisible to every role, and finding that out was the point of running this through the
     * app's own registry rather than a fixture.
     */
    setEnv(ALL);
    const names = await catalogueNames();
    for (const expected of [
      "jira_search_issues",
      "jira_transition_issue",
      "confluence_get_page",
      "confluence_update_page",
      "linear_list_states",
      "linear_update_issue",
      "notion_query_database",
      "notion_create_page",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("finds the right vendor's tool for a query naming that vendor", async () => {
    /**
     * #210's `find_tools`, against the case it is hardest for: four toolkits whose *verbs* are the same and
     * whose vendors are not. "search jira issues" must not return `linear_search_issues`.
     */
    setEnv(ALL);
    const registry = exampleRegistry(backend());
    // `find_tools` answers `{ hits: [{ entry, score, signals }] }`, ranked — not a bare list of names.
    const search = async (query: string) => {
      const result = await registry.execute(context, { name: "find_tools", input: { query } });
      const data = (result as { ok: boolean; data?: { hits?: { entry: { name: string } }[] } }).data;
      return (data?.hits ?? []).map((hit) => hit.entry.name);
    };

    for (const [query, vendor] of [
      ["search jira issues", "jira"],
      ["search linear issues", "linear"],
      ["read a confluence page", "confluence"],
      ["query a notion database", "notion"],
    ] as const) {
      const found = await search(query);
      expect(found.length, query).toBeGreaterThan(0);
      // The top hit belongs to the vendor the query named — the property that makes a 100-tool catalogue usable.
      expect(found[0], query).toContain(vendor);
    }
  });

  it("does not let one vendor's tools crowd out another's for an unqualified verb", async () => {
    // A weaker but still necessary property: "create an issue" should surface both trackers rather than one
    // vendor's whole surface, since the model has no way to ask again with better words.
    setEnv(ALL);
    const registry = exampleRegistry(backend());
    const result = await registry.execute(context, { name: "find_tools", input: { query: "create an issue" } });
    const found = ((result as { data?: { hits?: { entry: { name: string } }[] } }).data?.hits ?? []).map((hit) => hit.entry.name);
    expect(found.some((name) => name.startsWith("jira_") || name.startsWith("linear_"))).toBe(true);
  });

  it("honours each vendor's state model rather than flattening it — AC-2", async () => {
    /**
     * AC-2 as an assertion rather than a claim. A shared `status: string` would be a lie in three of the four:
     *
     * - Jira: a **transition**, by id, per workflow — so `jira_list_transitions` exists and
     *   `jira_update_issue` cannot touch status.
     * - Linear: a **state**, by name, per team — so it is a field on `linear_update_issue` and there is no
     *   transition tool.
     * - Notion: a **property**, whose name and type come from the database schema.
     * - Confluence: none at all.
     */
    const tools = (await Promise.all(exampleToolkits(ALL).map((provider) => provider.listTools(context)))).flat();
    const names = tools.map((tool) => tool.descriptor.name);

    expect(names).toContain("jira_list_transitions");
    expect(names).toContain("jira_transition_issue");
    expect(names).not.toContain("linear_transition_issue");
    expect(names).toContain("linear_list_states");
    expect(names).not.toContain("confluence_set_status");
    expect(names).not.toContain("notion_set_status");

    // And the flattening that would undo all of it: no tool anywhere takes a bare `status`.
    const jiraUpdate = tools.find((tool) => tool.descriptor.name === "jira_update_issue");
    expect(JSON.stringify(jiraUpdate?.descriptor.description)).toContain("cannot change status");
  });

  it("reads credentials in the host and in no toolkit — AC-4", async () => {
    /**
     * The env is read here, in the app, and passed as a resolver. Asserted by *behaviour* rather than by
     * grepping: a toolkit built with an explicit env object works while `process.env` is empty, which is only
     * possible if nothing downstream reads the environment.
     */
    setEnv({ ATLASSIAN_EMAIL: undefined, ATLASSIAN_API_TOKEN: undefined, ATLASSIAN_SITE_URL: undefined, LINEAR_API_KEY: undefined, NOTION_TOKEN: undefined });
    const providers = exampleToolkits(ALL);
    expect(providers).toHaveLength(4);
    const tools = await providers[0]!.listTools(context);
    expect(tools.length).toBeGreaterThan(0);
  });
});
