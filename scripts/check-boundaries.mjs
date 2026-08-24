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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, sep } from "node:path";

/**
 * The generic workspaces. `server` is the reference GraphQL host (#108). Scanned like the others: a
 * workspace the boundary checker does not read is a workspace with no boundary gate on it.
 *
 * "Generic" is the load-bearing word: docs/01 requires these to *"build and test without ShareFlow or
 * Twenty installed"*, which is what R5 and R8 enforce.
 */
const GENERIC_ROOTS = ["backend", "server", "frontend", "examples"];

/**
 * Integration workspaces (#114) — the one place a product name is allowed to appear.
 *
 * `owns` is the set of product names *this* workspace may name. Everything else in `PRODUCT_NAMES`
 * stays forbidden: `@agentkit/shareflow` importing Twenty is still a violation, because the
 * integration package is an integration for one product, not a place where every boundary stops
 * applying.
 */
const INTEGRATION_PACKAGES = {
  // ShareFlow's own repository calls itself Chorus (`CHORUS_TEST_MODE`), so both names are one product.
  shareflow: { specifier: "@agentkit/shareflow", owns: ["shareflow", "chorus"] },
};

const DEFAULT_ROOTS = [...GENERIC_ROOTS, ...Object.keys(INTEGRATION_PACKAGES)];

/** Product names that must not appear in a generic package's imports. */
const PRODUCT_NAMES = ["twenty", "shareflow", "chorus", "agno"];

const INTEGRATION_SPECIFIERS = Object.values(INTEGRATION_PACKAGES).map((p) => p.specifier);

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * Modules that reach outside the process. Named explicitly rather than pattern-matched, so adding one
 * is a decision someone made — a regex over "http" would also catch a local module called
 * `http-status`.
 */
const IO_MODULES = new Set([
  "node:http", "http", "node:https", "https", "node:net", "net", "node:dgram", "dgram",
  "node:fs", "fs", "node:fs/promises", "fs/promises", "node:child_process", "child_process",
  "undici", "axios", "node-fetch", "got", "pg", "ioredis", "bullmq",
]);

const ADAPTER_NAMES = ["memory","postgres","supabase","pgvector","qdrant","s3","local-files","bullmq","redis","nextjs"];

/**
 * The workspace a file belongs to: the directory name immediately above its `src/`.
 *
 * Derived from the path rather than passed in, because `scan()` is called with a temporary fixture
 * directory in tests — a rule keyed on the *scan root* would be untestable, and an untested rule is
 * the thing #113 spent four sabotages proving is worth avoiding.
 */
function workspaceOf(path) {
  const i = path.lastIndexOf("/src/");
  if (i < 0) return { name: null, dir: "" };
  const before = path.slice(0, i);
  const inside = path.slice(i + "/src/".length);
  const segments = inside.split("/");
  return {
    name: before.slice(before.lastIndexOf("/") + 1) || null,
    // Directory of the file, relative to its own `src/`. "" for `src/index.ts`.
    dir: segments.slice(0, -1).join("/"),
  };
}

/**
 * True when a relative specifier resolves outside the importing package's own `src/`.
 *
 * Counted rather than pattern-matched: `../../x` is fine from `src/a/b` and an escape from `src/a`,
 * so the depth of the importing file is the whole question and a regex over `../` cannot answer it.
 */
function escapesSrc(dir, spec) {
  if (!spec.startsWith(".")) return false;
  const parts = dir === "" ? [] : dir.split("/");
  for (const segment of spec.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") { parts.push(segment); continue; }
    if (parts.length === 0) return true;
    parts.pop();
  }
  return false;
}

/**
 * The bare specifiers a workspace has declared it may import, from its own package.json.
 *
 * This is what makes docs/01's *"generic packages build and test without ShareFlow or Twenty
 * installed"* checkable rather than aspirational: an import of something the package never declared
 * works on a developer's machine — npm workspaces hoist every dependency in the monorepo into one
 * `node_modules` — and fails only once the package is installed on its own. Returns null when there is
 * no package.json to read, in which case R10 does not apply.
 */
const declaredCache = new Map();
function declaredDependencies(workspaceDir) {
  if (declaredCache.has(workspaceDir)) return declaredCache.get(workspaceDir);
  const manifest = join(workspaceDir, "package.json");
  let declared = null;
  if (existsSync(manifest)) {
    try {
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      declared = new Set([
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
        ...Object.keys(json.peerDependencies ?? {}),
        ...Object.keys(json.optionalDependencies ?? {}),
      ]);
    } catch {
      declared = null;
    }
  }
  declaredCache.set(workspaceDir, declared);
  return declared;
}

/** The package a bare specifier belongs to: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

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

/**
 * Rewrite a source file so the import extractor below cannot read prose as code.
 *
 * **Two bugs, both found by R10 and both the same shape:** the extractor matches the *words* `import`
 * and `from`, and it was matching them inside comments and inside string literals. A doc comment
 * saying "derived from tenant" produced a phantom import of `tenant`; a message string reading
 * `"… a move from " +` produced a phantom import of the next string on the line. Six of them existed
 * in the tree. They were invisible while every rule looked for something specific — R10 is the first
 * rule that fires on anything it does not recognise, so it surfaced them all at once.
 *
 * Comments are removed. Every string literal is replaced by a placeholder holding no letters, so no
 * keyword can appear inside one, and the table lets the real specifier be recovered afterwards. What
 * remains is structure: `import` and `from` in the output are always the keywords.
 */
function sanitize(text) {
  const literals = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < text.length && text.slice(i, i + 2) !== "*/") i += 1;
      i += 2;
      continue;
    }
    const quote = text[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      i += 1;
      let body = "";
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") { body += text[i + 1] ?? ""; i += 2; continue; }
        body += text[i];
        i += 1;
      }
      i += 1;
      out += `"\u0000${literals.length}\u0000"`;
      literals.push(body);
      continue;
    }
    out += text[i];
    i += 1;
  }
  return { text: out, literals };
}

/** Extract { specifier, typeOnly } for every static import/export-from and side-effect import. */
function imports(source) {
  const { text, literals } = sanitize(source);
  const resolve = (token) => {
    const match = /^\u0000(\d+)\u0000$/.exec(token);
    return match === null ? null : literals[Number(match[1])];
  };
  const found = [];
  const push = (token, typeOnly) => {
    const specifier = resolve(token);
    // A computed or concatenated specifier resolves to null. Skipped rather than guessed at: this
    // checker reads static imports, and a dynamic one it cannot read is not a violation it can claim.
    if (specifier !== null && specifier !== "") found.push({ specifier, typeOnly });
  };

  const fromRe = /\b(import|export)\b([\s\S]*?)\bfrom\s*"([^"]*)"/g;
  let m;
  while ((m = fromRe.exec(text))) push(m[3], /^\s*type\b/.test(m[2]));

  const sideRe = /\bimport\s*"([^"]*)"/g;
  while ((m = sideRe.exec(text))) push(m[1], false);

  return found;
}

const norm = (p) => p.split(sep).join("/");

/** Return an array of { file, specifier, rule } violations across the given roots. */
export function scan(roots = DEFAULT_ROOTS) {
  const violations = [];
  // Cleared per scan, not per file: within one scan the manifest cannot change, and across scans it
  // can — tests point `scan` at a series of fixture trees, and a cache that outlived them would answer
  // for the wrong package.
  declaredCache.clear();
  for (const root of roots) {
    for (const file of collect(root)) {
      const path = norm(file);
      const { name: workspace, dir } = workspaceOf(path);
      const integration = workspace === null ? undefined : INTEGRATION_PACKAGES[workspace];
      /**
       * An unrecognised workspace is treated as generic, not as unclassified.
       *
       * The two mistakes are not symmetric: classifying a new generic package as generic by default
       * costs nothing, while defaulting to "exempt" would mean a workspace added without touching this
       * file silently arrives with no product-name gate on it.
       */
      const isGeneric = integration === undefined;
      const isFrontend = workspace === "frontend";
      const inLayer = (layer) => workspace === "backend" && (dir === layer || dir.startsWith(`${layer}/`));
      const isCore = inLayer("core");
      const isPersistence = inLayer("persistence");
      const isModels = inLayer("models");
      // The OTel adapter *and its test*, since the test's whole job is to import the real `@opentelemetry/api`
      // and prove the structural types are satisfied by it -- see R11. Excluding the test would leave the claim
      // "vendor-neutral" resting on interfaces nobody had checked against the actual package.
      const isOtelAdapter = inLayer("adapters/otel") || /adapters\/otel\//.test(path);
      // Only the shipped envelope, not its tests. A test legitimately wires an in-memory store to
      // exercise the pipeline, and test files are excluded from the published build — the rule is about
      // what the envelope does in production, not what a test needs to construct one.
      const isTest = /\/__tests__\/|\.test\.ts$/.test(path);
      const isTools = inLayer("tools") && !isTest;

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

        // R11 — OpenTelemetry is confined to its adapter (#143 AC-6).
        //
        // Exactly R3's shape, for exactly R3's reason. "Vendor-neutral instrumentation" is only true if it is
        // enforced: one convenience import of `@opentelemetry/api` in a hot path acquires a vendor for the whole
        // platform, and it is invisible in review because the import looks like every other import.
        if (/^@opentelemetry\//.test(spec) && !isOtelAdapter)
          add("R11 OpenTelemetry may only be imported inside backend/src/adapters/otel");

        // R4 — ports must not import adapters.
        if (isPersistence &&
            (/(^|\/)adapters?\//.test(spec) || ADAPTER_NAMES.some((a) => spec === `@agentkit/${a}` || spec.startsWith(`@agentkit/${a}/`))))
          add("R4 ports must not import adapters");

        // R5 — no forbidden product names in a generic package's imports.
        //
        // An integration package is exempt for the names it owns and no others (#114). The rule's
        // wording always said "generic package"; until there was an integration package, every scanned
        // file happened to be in one, so the distinction had never had to be real.
        const forbiddenNames = PRODUCT_NAMES.filter((n) => !integration?.owns.includes(n));
        if (new RegExp(`(^|[/@])(${forbiddenNames.join("|")})(\\b|[/-])`, "i").test(spec))
          add("R5 forbidden product name in import specifier");

        // R6 — core must be self-contained (no imports escaping core/).
        if (isCore && spec.startsWith("../")) add("R6 core must not import outside core/");

        // R7 — the tool envelope performs no I/O of its own (#113 AC-4).
        //
        // A delegating tool is "a thin, agent-facing envelope over a deterministic function": it adds
        // authorisation, the approval gate and the idempotency key, then *delegates* the side effect.
        // An envelope that reached the network itself would be doing the work it exists to delegate,
        // and the guarantee would hold only as long as everyone remembered. This makes it a build
        // failure instead of a convention.
        if (isTools && !typeOnly && (IO_MODULES.has(spec) || /(^|\/)adapters?\//.test(spec)))
          add("R7 the tools layer must delegate I/O, not perform it");

        // R8 — a generic workspace must not import an integration package (#114 AC-2).
        //
        // Keyed on the package name, not on the word "shareflow". R5 already catches
        // `@agentkit/shareflow` today, but only because of how it happens to be spelled — rename the
        // package to `@agentkit/social` and R5 goes quiet while the architectural rule it was standing
        // in for is just as broken.
        if (isGeneric && INTEGRATION_SPECIFIERS.some((s) => spec === s || spec.startsWith(`${s}/`)))
          add("R8 a generic package must not import an integration package");

        // R9 — an integration package must not reach into application internals (#114 AC-3).
        //
        // Two shapes, because those are the two ways it actually happens. `@/…` is the path alias
        // ShareFlow's Next.js app uses, so it arrives with any copy-paste out of `web/src/lib`; a
        // relative specifier escaping `src/` is what someone writes when the app is a sibling
        // directory on their disk. Either one makes the package unbuildable without the application
        // checked out beside it, which is the coupling this workspace exists to prevent.
        if (integration !== undefined) {
          if (spec.startsWith("@/"))
            add("R9 integration package must not import application internals (@/ app path alias)");
          else if (escapesSrc(dir, spec))
            add("R9 integration package must not import application internals (path escapes src/)");
        }

        // R10 — a package may only import what it declares.
        //
        // npm workspaces hoist every dependency in the monorepo into one `node_modules`, so an
        // undeclared import resolves perfectly on a developer's machine and on CI, and breaks only
        // when the package is installed somewhere on its own. That makes docs/01's "generic packages
        // build and test without ShareFlow or Twenty installed" unverifiable by running the tests —
        // the manifest is the only place the truth is written down.
        if (
          workspace !== null &&
          !spec.startsWith(".") &&
          !NODE_BUILTINS.has(spec) &&
          !spec.startsWith("@/")
        ) {
          const declared = declaredDependencies(path.slice(0, path.lastIndexOf("/src/")));
          if (declared !== null && !declared.has(packageOf(spec)))
            add(`R10 undeclared dependency "${packageOf(spec)}" (add it to ${workspace}/package.json)`);
        }
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
