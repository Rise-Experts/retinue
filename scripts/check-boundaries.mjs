#!/usr/bin/env node
/**
 * Dependency-boundary checker (zero runtime deps).
 *
 * Enforces the architectural rules from `docs/01-architecture.md` by scanning the import
 * specifiers of every TypeScript file under a src directory. Any violation fails the build,
 * so a forbidden import can never merge.
 *
 * Usage:
 *   node scripts/check-boundaries.mjs [root ...]   # defaults to backend/ and frontend/
 * Exit code 0 = clean, 1 = violations found. Also exported as `scan(roots)` for tests.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// `server` is the reference GraphQL host (#108). Scanned like the others: a workspace the
// boundary checker does not read is a workspace with no boundary gate on it.
const DEFAULT_ROOTS = ["backend", "server", "frontend"];
const ADAPTER_NAMES = ["memory","postgres","supabase","pgvector","qdrant","s3","local-files","bullmq","redis","nextjs"];

/** Collect every .ts file under a `src/` directory, skipping node_modules and dist. */
function collect(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name.endsWith(".ts") && p.includes(`${sep}src${sep}`)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Extract { specifier, typeOnly } for every static import/export-from and side-effect import. */
function imports(text) {
  const found = [];
  const fromRe = /\b(import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = fromRe.exec(text))) {
    found.push({ specifier: m[3], typeOnly: /^\s*type\b/.test(m[2]) });
  }
  const sideRe = /\bimport\s*['"]([^'"]+)['"]/g;
  while ((m = sideRe.exec(text))) found.push({ specifier: m[1], typeOnly: false });
  return found;
}

const norm = (p) => p.split(sep).join("/");

/** Return an array of { file, specifier, rule } violations across the given roots. */
export function scan(roots = DEFAULT_ROOTS) {
  const violations = [];
  for (const root of roots) {
    for (const file of collect(root)) {
      const path = norm(file);
      const isFrontend = path.includes("/frontend/src/") || path.startsWith("frontend/src/");
      const inLayer = (layer) => path.includes(`/backend/src/${layer}/`) || path.startsWith(`backend/src/${layer}/`);
      const isCore = inLayer("core");
      const isPersistence = inLayer("persistence");
      const isModels = inLayer("models");

      for (const { specifier: spec, typeOnly } of imports(readFileSync(file, "utf8"))) {
        const add = (rule) => violations.push({ file: path, specifier: spec, rule });

        // R1 — no deep cross-workspace imports; use the package root.
        if (/^@agentkit\/[^/]+\/(src|dist)\//.test(spec)) add("R1 deep cross-workspace import (use the package root)");

        // R2 — frontend may only `import type` from the backend's public entry.
        if (isFrontend && /^@agentkit\/backend(\/|$)/.test(spec) && !typeOnly)
          add("R2 frontend must import type-only from @agentkit/backend");

        // R3 — the AI/provider SDK is confined to the models layer.
        if ((spec === "ai" || spec.startsWith("@ai-sdk/")) && !isModels)
          add("R3 AI SDK may only be imported inside backend/src/models");

        // R4 — ports must not import adapters.
        if (isPersistence &&
            (/(^|\/)adapters?\//.test(spec) || ADAPTER_NAMES.some((a) => spec === `@agentkit/${a}` || spec.startsWith(`@agentkit/${a}/`))))
          add("R4 ports must not import adapters");

        // R5 — no forbidden product names in any generic package import.
        if (/(^|[/@])(twenty|shareflow|chorus|agno)(\b|[/-])/i.test(spec)) add("R5 forbidden product name in import specifier");

        // R6 — core must be self-contained (no imports escaping core/).
        if (isCore && spec.startsWith("../")) add("R6 core must not import outside core/");
      }
    }
  }
  return violations;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = process.argv.slice(2);
  const violations = scan(roots.length ? roots : DEFAULT_ROOTS);
  if (violations.length) {
    console.error(`✗ ${violations.length} boundary violation(s):\n`);
    for (const v of violations) console.error(`  ${v.file}\n    imports "${v.specifier}"\n    ${v.rule}\n`);
    process.exit(1);
  }
  console.log("✓ no boundary violations");
}
