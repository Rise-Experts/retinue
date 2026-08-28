#!/usr/bin/env node
/**
 * Every import in the documentation must be one the package actually offers.
 *
 * The root is the semver boundary (#199), which makes a documented import a promise: someone copies it into
 * their editor, and either it resolves or their first minute with this package is spent finding out we were
 * wrong. Nothing checked these — markdown is not compiled, so the surface cut moved 386 names and every code
 * sample in `website/content` kept importing them from the root, silently.
 *
 * Checked against the built package rather than against a list, so it cannot drift: the entries are imported and
 * their exports compared with what each sample claims. A name that moves subpath fails here on the same commit
 * that moves it.
 *
 * Exit codes: 0 clean, 1 a sample imports something that is not there, 2 the scan could not run. Never zero for
 * "could not tell".
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOTS = ["website/content", "backend", "examples", "services", "shareflow", "frontend", "docs"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", ".claude", ".docusaurus", "coverage"]);

/**
 * Every published subpath, **derived from the manifest** rather than listed here.
 *
 * It used to be a hardcoded list, which is a second copy of `exports` — and it drifted the first time a subpath
 * was added: `./testing` (#253) landed and every documented import of it was reported as "not a published
 * subpath", a checker firing on correct documentation. That is how a check gets loosened until it fires on
 * nothing. `check:consumer` already reads the manifest for the same reason; this now does too.
 *
 * `./package.json` is skipped — it is an export, and it is not something a sample imports from.
 */
const MANIFEST = JSON.parse(readFileSync(resolve(import.meta.dirname, "../backend/package.json"), "utf8"));
const SUBPATHS = Object.entries(MANIFEST.exports)
  .filter(([key]) => key !== "./package.json")
  .map(([key, value]) => {
    const target = typeof value === "string" ? value : (value.default ?? value.import);
    // `.` → "", `./runtime` → "/runtime": the suffix a sample writes after the package name.
    return [key === "." ? "" : key.slice(1), `../backend/${target.replace(/^\.\//, "")}`];
  });


const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
};

const files = ROOTS.flatMap((root) => {
  try {
    return walk(root);
  } catch {
    return [];
  }
});

if (files.length === 0) {
  console.error("✗ found no markdown to check — the roots moved, so this check is checking nothing");
  process.exit(2);
}

/** subpath suffix -> exported names. */
const exported = new Map();
for (const [suffix, module] of SUBPATHS) {
  try {
    exported.set(suffix, new Set(Object.keys(await import(module))));
  } catch (error) {
    console.error(`✗ cannot load the built package (${module}): ${error.message.split("\n")[0]}`);
    console.error("  run `npm run build` first — this check reads the build, because the build is what ships.");
    process.exit(2);
  }
}

// Only the ones a reader would copy. A prose mention of a name is not a claim that it is importable.
/**
 * The `type` keyword is *captured*, not merely tolerated.
 *
 * It was optional-and-discarded, which handled the inline form (`import { type Foo }`) via the per-name check
 * below and silently mishandled the statement form (`import type { Foo }`): the keyword sits before the brace,
 * so each name arrives without a prefix and a perfectly valid type import was reported as a missing export.
 * Found by documenting `Guardrail`, which is type-only — a checker firing on correct documentation, which is how
 * a check gets loosened until it fires on nothing.
 */
const IMPORT = /import\s*(type\s*)?\{([^}]*)\}\s*from\s*"@retinue\/agentkit([^"]*)"/g;

const violations = [];
let checked = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT)) {
    const typeOnlyStatement = match[1] !== undefined;
    const suffix = match[3];
    if (!exported.has(suffix)) {
      violations.push(`${file}: "@retinue/agentkit${suffix}" is not a published subpath`);
      continue;
    }
    const names = exported.get(suffix);
    for (const raw of match[2].split(",").map((n) => n.trim()).filter(Boolean)) {
      const name = raw.split(" as ")[0].replace(/^type\s+/, "").trim();
      checked += 1;
      /**
       * A type is not visible at runtime, so a name absent from the module may still be a valid type import.
       * Only a *value* import can be checked this way, and claiming otherwise would make this check fire on
       * correct documentation — which is how a check gets loosened until it fires on nothing.
       */
      if (typeOnlyStatement || raw.trim().startsWith("type ")) continue;
      if (!names.has(name)) {
        const home = [...exported].find(([, set]) => set.has(name))?.[0];
        violations.push(
          `${file}: ${name} is not exported by "@retinue/agentkit${suffix}"` +
            (home === undefined ? "" : ` — it lives at "@retinue/agentkit${home}"`),
        );
      }
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`✗ ${v}`);
  console.error(`\n${violations.length} documented import(s) that do not resolve`);
  process.exit(1);
}

console.log(`✓ ${checked} documented imports resolve across ${files.length} markdown files`);
