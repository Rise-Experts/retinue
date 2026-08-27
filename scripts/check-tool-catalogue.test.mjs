/**
 * Proves the catalogue checker's two parsers, because both got this wrong once and each failure mode is quiet.
 *
 * `cataloguedTools` first required an underscore in a name — to avoid matching every backticked lowercase word
 * in a row — and therefore missed `now` and `calculate`, reporting two correctly-catalogued tools as
 * unclassified. A checker that fires on correct content is one somebody deletes rather than fixes, so the
 * scoping rule (first two cells only) gets a test, and so does the vocabulary it must *not* pick up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cataloguedTools,
  declarationCount,
  namesConstantFor,
  namesFrom,
  toolkitPackages,
  unclassified,
} from "./check-tool-catalogue.mjs";

const TABLE = [
  "| Tool | Category | Effect | Approval | Idem. | Status |",
  "|---|---|---|---|---|---|",
  "| `fetch_url` | web | `read` | `policy` | no | built |",
  "| `now` | general | `read` | `never` | no | built |",
  "| `shell_exec` | code | `destructive` | `always` | yes | #215 |",
  "",
  "| Package | Tools | Category | Notes |",
  "|---|---|---|---|",
  "| `tools-github` | `search_code`, `create_issue`, `merge_pr` | project | first one |",
].join("\n");

test("single-word tool names are found, not only snake_case ones", () => {
  // The original bug: `now` and `calculate` are catalogued and were reported missing.
  const names = cataloguedTools(TABLE);
  assert.ok(names.has("now"), "a single-word tool name must be found");
  assert.ok(names.has("fetch_url"));
});

test("several tools in one cell are all found", () => {
  // Wave 3 lists a package's tools in one cell; one-name-per-row would miss most of the catalogue and report
  // a clean result because it could not read it.
  const names = cataloguedTools(TABLE);
  for (const n of ["search_code", "create_issue", "merge_pr"]) assert.ok(names.has(n), n);
});

test("effects, approval policies and package names are not mistaken for tools", () => {
  const names = cataloguedTools(TABLE);
  // Backticked, but in cells 2 and 3 — which is why the scope is the first two cells rather than the whole row.
  for (const v of ["read", "policy", "never", "always", "destructive"]) {
    assert.ok(!names.has(v), `${v} must not be read as a tool`);
  }
  // Hyphenated, so a package is excluded by the name pattern itself.
  assert.ok(!names.has("tools-github"));
});

test("prose outside a table is ignored", () => {
  assert.equal(cataloguedTools("Some text mentioning `fetch_url` in a sentence.").size, 0);
});

test("registered names are read from a source array", () => {
  const src = 'export const STANDARD_TOOL_NAMES = [\n  "fetch_url",\n  "now",\n] as const;\n';
  assert.deepEqual(namesFrom(src, "STANDARD_TOOL_NAMES"), ["fetch_url", "now"]);
  // A renamed or moved constant is null, not an empty list — the caller exits 2 rather than passing.
  assert.equal(namesFrom(src, "META_TOOLS"), null);
});

test("only registered-but-uncatalogued is a failure", () => {
  const catalogued = new Set(["fetch_url", "now", "future_tool"]);
  assert.deepEqual(unclassified(["fetch_url", "now"], catalogued), []);
  assert.deepEqual(unclassified(["fetch_url", "brand_new"], catalogued), ["brand_new"]);
  // `future_tool` is catalogued and unbuilt: reported as a count, never a failure, because the specification is
  // written before the tools on purpose.
});

test("toolkit packages are discovered from the directory, not from a list in this repository", () => {
  // The point of discovery: the fourth toolkit is covered the day it lands, without anybody editing the checker.
  const found = toolkitPackages("tools");
  assert.ok(found.includes("github") && found.includes("slack") && found.includes("search"));
  assert.deepEqual(found, [...found].sort());
});

test("a missing tools directory yields nothing rather than throwing", () => {
  assert.deepEqual(toolkitPackages("tools-that-do-not-exist"), []);
});

test("the constant name follows the directory name", () => {
  assert.equal(namesConstantFor("slack"), "SLACK_TOOL_NAMES");
  assert.equal(namesConstantFor("google-workspace"), "GOOGLE_WORKSPACE_TOOL_NAMES");
});

test("declarations are counted at the call site, not by parsing names", () => {
  // A toolkit file has other `name:` fields — a search provider's, for one — so a name parser would report
  // providers as unclassified tools. Counting `defineTool`/`confirms`/`destroys` calls cannot make that mistake.
  const source = `
    const a = defineTool({ name: "x_read_thing", effect: "read" });
    const b = confirms({ name: "x_post_thing" });
    const c = destroys({ name: "x_delete_thing" });
    const provider = { name: "brave", endpoint: () => "" };
  `;
  assert.equal(declarationCount(source), 3);
});

test("an import of the helpers is not counted as a declaration", () => {
  assert.equal(declarationCount('import { confirms, defineTool, destroys } from "@retinue/agentkit/tools";'), 0);
});

test("a package declaring no tools counts zero, which is a claim and not a skip", () => {
  assert.equal(declarationCount('export const SEARCH_TOOL_NAMES = [] as const;'), 0);
  assert.deepEqual(namesFrom("export const SEARCH_TOOL_NAMES = [] as const;", "SEARCH_TOOL_NAMES"), []);
  assert.equal(namesFrom("export const NOTHING = 1;", "SEARCH_TOOL_NAMES"), null);
});
