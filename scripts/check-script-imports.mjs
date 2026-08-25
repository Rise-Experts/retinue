#!/usr/bin/env node
/**
 * Every named import in every runnable `.mjs` must be a real export.
 *
 * The `.mjs` runner scripts are the one part of this repo `tsc` never looks at, and #195 moved
 * `migrate`, `MIGRATIONS` and `rollback` off the package root onto `./adapters/postgres`. The full
 * gate stayed green while `npm run migrate` -- the documented first step of running the example --
 * died on `does not provide an export named 'MIGRATIONS'`, and `loadtest.mjs` was broken the same
 * way. Nothing could have caught it: the suite does not run these scripts, so a script that only
 * fails when executed fails for the person following the README.
 *
 * Two details matter for this to be right rather than merely green:
 *
 * - **Imports are matched anchored to the start of a line.** A static import is a top-level
 *   statement, so nothing else can be one -- and the boundary check's fixtures are full of import
 *   statements *inside string literals* that describe code that must not exist. An unanchored match
 *   reads those as real and reports a dozen violations that are the fixtures doing their job.
 * - **Each specifier is resolved from the importing file's own directory**, by running the probe with
 *   that directory as its cwd. `import.meta.resolve` ignores a parent argument here, so resolving in
 *   this process silently answers "what would *this script* get", which is a different question.
 *
 * Exit codes: 0 clean, 1 a name does not exist, 2 the scan itself could not run. Never zero for
 * "could not tell" -- a check that reports success when it did nothing is worse than no check.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOTS = ["scripts", "examples/scripts", "evals"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", ".claude", ".docusaurus"]);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    // Test files are excluded: their imports are checked by running them, and their fixtures are
    // deliberately-broken code that this check would report as real.
    else if (entry.endsWith(".mjs") && !entry.endsWith(".test.mjs")) out.push(full);
  }
  return out;
};

const files = ROOTS.flatMap((root) => {
  try {
    return walk(root);
  } catch {
    return []; // A root that moved is not itself a failure; all of them missing is, below.
  }
});

if (files.length === 0) {
  console.error("✗ found no runnable .mjs scripts — the roots moved, so this check is checking nothing");
  process.exit(2);
}

const NAMED = /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm;
const DEFAULTED = /^import\s+([A-Za-z_$][\w$]*)(?:\s*,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/gm;

/** specifier -> names, grouped by the directory it must resolve from. */
const byDirectory = new Map();
let sites = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const found = [];
  for (const m of source.matchAll(NAMED)) {
    found.push([
      m[2],
      m[1]
        .split(",")
        .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean),
    ]);
  }
  for (const m of source.matchAll(DEFAULTED)) found.push([m[2], ["default"]]);

  for (const [spec, names] of found) {
    // Relative and node: specifiers are the file's own business; this is about package surfaces.
    if (spec.startsWith(".") || spec.startsWith("node:")) continue;
    sites += 1;
    const dir = dirname(file);
    const entries = byDirectory.get(dir) ?? [];
    entries.push({ file, spec, names });
    byDirectory.set(dir, entries);
  }
}

const violations = [];

for (const [dir, entries] of byDirectory) {
  // One child per directory, not per import: resolution only depends on where you ask from.
  const probe = `
    const asked = ${JSON.stringify(entries.map((e) => ({ spec: e.spec, names: e.names })))};
    const out = [];
    for (const { spec, names } of asked) {
      try {
        const m = await import(spec);
        out.push({ spec, missing: names.filter((n) => !(n in m)) });
      } catch (error) {
        out.push({ spec, error: String(error && error.message).split("\\n")[0] });
      }
    }
    console.log(JSON.stringify(out));
  `;
  let results;
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    results = JSON.parse(stdout.trim().split("\n").at(-1));
  } catch (error) {
    console.error(`✗ cannot probe imports in ${dir}: ${String(error.message).split("\n")[0]}`);
    process.exit(2);
  }
  for (const result of results) {
    const where = entries.find((e) => e.spec === result.spec)?.file ?? dir;
    if (result.error) violations.push(`${where}: cannot load "${result.spec}" — ${result.error}`);
    else if (result.missing.length > 0)
      violations.push(`${where}: "${result.spec}" does not export ${result.missing.join(", ")}`);
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`✗ ${v}`);
  console.error(`\n${violations.length} broken import site(s) across ${files.length} scripts`);
  process.exit(1);
}

console.log(`✓ ${sites} package import sites resolve across ${files.length} scripts`);
