#!/usr/bin/env node
/**
 * Every registered tool is classified — REQ-047 (#206), task #213, AC-6.
 *
 * `docs/23-tool-catalogue.md` decides, for each tool, its category, effect, approval policy, auth model, package
 * and wave. A specification nothing enforces drifts within a month, and the direction it drifts is predictable:
 * a tool gets added under deadline, its effect is whatever was convenient, and nobody notices until a `read`
 * tool turns out to write.
 *
 * ## Why the check is one-directional
 *
 * **Registered ⊆ catalogued** is enforced. A tool the runtime offers and the catalogue does not mention is a
 * tool whose effect nobody decided.
 *
 * **Catalogued ⊆ registered** is *reported, not enforced* — the catalogue is forward-looking by design, and
 * ~100 of its entries are not built yet. Failing on those would make the specification impossible to write
 * before the code, which is the whole point of writing it first. The count is printed so the gap stays visible
 * rather than becoming furniture; when REQ-047 finishes, that number is zero and this comment is what says the
 * check should tighten.
 *
 * Exit codes: 0 clean, 1 an unclassified tool, 2 the check could not run.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOGUE = "docs/23-tool-catalogue.md";

/**
 * Where the registered names live, read from **source** rather than from `dist`.
 *
 * Deliberate: this check runs inside `npm test`, which must work in a clean checkout with nothing built. A check
 * that needs a build is a check that gets skipped on the machine where the tool was just added — which is
 * exactly the machine it exists to stop.
 */
const SOURCES = [
  ["backend/src/tools/library/index.ts", "STANDARD_TOOL_NAMES"],
  ["backend/src/tools/index.ts", "META_TOOLS"],
];

/**
 * Shipping toolkit packages, **discovered** rather than listed.
 *
 * Listing them is the version of this check that quietly stops covering anything: the fourth toolkit lands,
 * nobody remembers the list in this file, and its tools ship unclassified while the check prints a tick. So the
 * directory decides, and every package in it must export `<DIR>_TOOL_NAMES` — an absent constant is a hard
 * failure, not a package silently skipped.
 */
export const toolkitPackages = (root = "tools") => {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
};

/** The name of the constant a toolkit package must export. */
export const namesConstantFor = (dir) => `${dir.toUpperCase().replace(/-/g, "_")}_TOOL_NAMES`;

/**
 * How many tools a source file actually declares.
 *
 * Cross-checked against the exported constant, because the constant is what this check reads and a constant that
 * has drifted from the code is a check that passes while covering less than it claims. Counting call sites rather
 * than parsing names is deliberate: a toolkit file has other `name:` fields — a search provider's name, for one —
 * and a name parser would report those as unclassified tools.
 */
export const declarationCount = (source) => [...withoutComments(source).matchAll(/\b(?:defineTool|confirms|destroys)\s*\(/g)].length;

/**
 * Source with comments removed, so a *mention* of a helper is not counted as a call to it.
 *
 * `tools/x` documents why `x_delete_post` uses `destroys()` — twice, in prose — and the count jumped to 8 for
 * six tools. That is a check firing on correct code, and the correct code is the well-commented kind this
 * repository writes everywhere, so the check is what had to change.
 *
 * Strings are left alone: `"destroys("` inside a string literal is not a shape anybody writes, and stripping
 * string contents properly would need a real lexer for no benefit.
 */
export const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * Every non-test source file in a toolkit package.
 *
 * The count used to read `src/index.ts` alone, which was right while a toolkit was one file. `tools/github`
 * reached 44 tools and split into four group modules with `index.ts` as assembly — and the check then reported
 * "lists 44 but declares 0", firing on the correct structure. The names constant still lives in `index.ts`,
 * because one array in one known place is what makes it readable; the declarations are wherever they are.
 */
export const sourceFilesOf = (dir) => {
  const files = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) files.push(child);
    }
  };
  walk(`tools/${dir}/src`);
  return files;
};

/** The string literals of a `export const NAME = [ … ] as const;` array. */
export const namesFrom = (source, constant) => {
  const start = source.indexOf(`export const ${constant} = [`);
  if (start === -1) return null;
  const end = source.indexOf("]", start);
  if (end === -1) return null;
  return [...source.slice(start, end).matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
};

/**
 * Tool names the catalogue mentions — from the **first two cells** of a table row, and nowhere else.
 *
 * The first version required an underscore, to avoid matching every backticked lowercase word in a row. It
 * therefore missed `now` and `calculate`, which are catalogued, and reported them as unclassified — a checker
 * failing on correct content, which is the kind of false alarm that gets a check deleted rather than fixed.
 *
 * Scoping to the first two cells is what makes a permissive name pattern safe. Cell 0 is always the tool (or the
 * package, in wave 3); cell 1 is the tool list in wave 3 and an *unbackticked* category everywhere else. Effects
 * and approval policies are backticked but live in cells 2 and 3, so they cannot be mistaken for tools. Wave 3
 * lists several tools in one cell, and a parser demanding one name per row would silently miss most of them.
 *
 * Hyphens are excluded, which is how `tools-github` is not read as a tool.
 */
export const cataloguedTools = (markdown) => {
  const names = new Set();
  for (const line of markdown.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.slice(1).split("|");
    for (const cell of cells.slice(0, 2)) {
      for (const [, name] of cell.matchAll(/`([a-z][a-z0-9_]*)`/g)) names.add(name);
    }
  }
  return names;
};

/** Registered but unclassified — the failure this exists for. */
export const unclassified = (registered, catalogued) => registered.filter((name) => !catalogued.has(name));

const main = () => {
  let markdown;
  try {
    markdown = readFileSync(CATALOGUE, "utf8");
  } catch (error) {
    console.error(`✗ cannot read ${CATALOGUE}: ${error.message}`);
    console.error("  the catalogue is the specification; without it there is nothing to check against, and");
    console.error("  treating that as 'nothing to enforce' is how this check would pass having done nothing");
    return 2;
  }

  const catalogued = cataloguedTools(markdown);
  if (catalogued.size < 20) {
    console.error(`✗ ${CATALOGUE} yielded only ${catalogued.size} tool names — the tables changed shape`);
    return 2;
  }

  const registered = [];
  for (const [path, constant] of SOURCES) {
    let names;
    try {
      names = namesFrom(readFileSync(path, "utf8"), constant);
    } catch (error) {
      console.error(`✗ cannot read ${path}: ${error.message}`);
      return 2;
    }
    if (names === null || names.length === 0) {
      console.error(`✗ ${constant} not found in ${path} — the declaration moved, so this is checking nothing`);
      return 2;
    }
    registered.push(...names);
  }

  const shipsNoTools = [];
  for (const dir of toolkitPackages()) {
    const path = `tools/${dir}/src/index.ts`;
    const constant = namesConstantFor(dir);
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      console.error(`✗ cannot read ${path}: ${error.message}`);
      console.error("  every tools/* package is a shipping package; one this check cannot read is one whose");
      console.error("  tools nobody classified");
      return 2;
    }
    const names = namesFrom(source, constant);
    if (names === null) {
      console.error(`✗ tools/${dir} does not export ${constant}`);
      console.error("  a toolkit package declares its tool names in one array so this check can read them;");
      console.error(`  without it, tools/${dir} ships tools that no catalogue entry classifies`);
      return 2;
    }
    const declared = sourceFilesOf(dir).reduce((total, file) => total + declarationCount(readFileSync(file, "utf8")), 0);
    if (declared !== names.length) {
      console.error(`✗ ${constant} lists ${names.length} tool(s) but tools/${dir} declares ${declared}`);
      console.error("  the constant is what this check reads, so a stale one means it covers less than it says");
      return 2;
    }
    if (names.length === 0) shipsNoTools.push(dir);
    registered.push(...names);
  }

  const missing = unclassified(registered, catalogued);
  if (missing.length > 0) {
    console.error(`✗ ${missing.length} registered tool(s) are absent from ${CATALOGUE}: ${missing.join(", ")}`);
    console.error("  every tool needs a category, an effect and an approval policy decided before it ships —");
    console.error("  an unclassified tool defaults to whatever was convenient at the call site");
    return 1;
  }

  const notBuilt = [...catalogued].filter((name) => !registered.includes(name)).length;
  console.log(
    `✓ all ${registered.length} registered tools are classified in ${CATALOGUE}` +
      ` (${catalogued.size} catalogued, ${notBuilt} specified but not yet built)`,
  );
  if (shipsNoTools.length > 0) {
    console.log(`  tools/${shipsNoTools.join(", tools/")} declare no tools — providers behind a contract that exists`);
  }
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
