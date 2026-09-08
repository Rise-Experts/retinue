#!/usr/bin/env node
/**
 * Every package the built code actually reaches, from its entry points -- REQ-041 (#190).
 *
 * Half of a two-part check whose other half is `check-runtime-imports.mjs`. The split exists because
 * the two halves have to run in different places: this one needs TypeScript, which is a
 * devDependency, so it runs in the image's *build* stage; the verification needs the *runtime*
 * stage's `node_modules`, which is the only place that answers the real question.
 *
 * **Why this exists.** The runtime declares `pg`, `ioredis`, `bullmq`, `graphql-yoga`,
 * `@whatwg-node/server` and the `@ai-sdk/*` providers as **optional peers**, so the application has to
 * name the ones its wiring uses. Both Dockerfiles claimed their runtime install caught a missing one --
 * "an undeclared peer fails here rather than in production". It does not. Removing `pg` from
 * `shareflow/package.json` and rebuilding produced an image where `import("pg")` still resolved,
 * because `bullmq` depends on `pg` and brought it along. The claim was true by luck, and a guarantee
 * that depends on an unrelated package's dependency list is not one.
 *
 * **Derived, not listed.** The first version of this was a probe with fourteen specifiers typed into
 * it, which is a test whose expectation is the same hand-maintained list it checks: add a dependency
 * and the list is silently one short. So the specifiers come from walking the compiled graph.
 *
 * **Compiled output, not sources.** `import type { Pool } from "pg"` in the Postgres adapter is erased
 * by `tsc`, so the adapter needs no `pg` at runtime -- the caller supplies the pool. Scanning sources
 * would demand `pg` of every app that touches that adapter, which is a checker firing on correct
 * files. `dist` says what is really imported.
 *
 * Both static and dynamic imports are collected. A dynamic one fails later than a static one -- on the
 * first turn that reaches it rather than at load -- which is worse, not better.
 *
 * Usage: `node scripts/collect-runtime-imports.mjs <entry.js> [entry.js ...] > imports.json`
 * Exit codes: 0 wrote a list, 2 an entry point does not exist or the walk failed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";

import ts from "typescript";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * Resolve a relative specifier the way Node does for a directory or an extensionless path.
 *
 * `tsc` emits explicit `.js` extensions, so this is mostly a passthrough -- but a hand-written `.mjs`
 * in the graph may point at a directory, and silently dropping it would under-report.
 */
export const resolveRelative = (fromFile, specifier) => {
  const base = resolvePath(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/**
 * Workspace packages, as `name -> directory`, from the root manifest's `workspaces` globs.
 *
 * Needed because the walk has to cross the workspace boundary. Stopping at `@retinue/agentkit` reached
 * 113 files and reported twelve specifiers, none of them `bullmq`, `ioredis` or a single `@ai-sdk/*` --
 * every one of those is imported *inside* the runtime, which is exactly where an app forgets to declare
 * them. A check that stops at the boundary is blind to the whole class it was written for.
 */
export const workspacePackages = (readJson, listDir) => {
  const root = readJson("package.json");
  const out = new Map();
  for (const pattern of root?.workspaces ?? []) {
    const dirs = pattern.endsWith("/*")
      ? listDir(pattern.slice(0, -2)).map((name) => `${pattern.slice(0, -2)}/${name}`)
      : [pattern];
    for (const dir of dirs) {
      const manifest = readJson(`${dir}/package.json`);
      if (manifest?.name !== undefined) out.set(manifest.name, dir);
    }
  }
  return out;
};

/**
 * Where a workspace specifier's code lives, via that package's own `exports` map.
 *
 * The map is the authority, not a path convention: `@retinue/agentkit/hitl` is
 * `dist/entries/hitl.js`, which no amount of string surgery on the subpath would produce.
 */
export const resolveWorkspace = (specifier, workspaces, readJson) => {
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  const dir = workspaces.get(name);
  if (dir === undefined) return null;
  const manifest = readJson(`${dir}/package.json`);
  if (manifest === null) return null;
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  const target = manifest.exports?.[subpath];
  const file = typeof target === "string" ? target : (target?.default ?? target?.import);
  if (typeof file !== "string") return null;
  return resolvePath(dir, file);
};

/**
 * Bare specifiers reachable from `entries`, following relative imports and crossing into workspaces.
 *
 * `preProcessFile` is the compiler's own scanner, so an import statement quoted inside a comment stays
 * a comment. That matters here: a first attempt used a regex and reported packages named
 * "nothing out there" and "tried and failed twice", which are sentences from this repo's prose.
 */
export const collect = (
  entries,
  {
    readFile = (p) => readFileSync(p, "utf8"),
    readJson = (p) => {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        return null;
      }
    },
    /**
     * Tolerant of a directory that is not there: an image carries a *subset* of the workspaces, so
     * `services/` legitimately does not exist inside one. The guard against this hiding a real
     * problem is `blindCrossings` below — a missing directory that actually mattered shows up as a
     * workspace specifier the walk could not follow, which is an error rather than a smaller answer.
     */
    listDir = (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  } = {},
) => {
  const workspaces = workspacePackages(readJson, listDir);
  const seen = new Set();
  const queue = [...entries.map((entry) => resolvePath(entry))];
  const specifiers = new Map();
  const unreadable = [];
  const crossed = new Set();
  const blind = new Set();

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try {
      text = readFile(file);
    } catch {
      unreadable.push(file);
      continue;
    }
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      if (fileName.startsWith(".")) {
        const target = resolveRelative(file, fileName);
        if (target !== null) queue.push(target);
        continue;
      }
      if (BUILTINS.has(fileName)) continue;

      // The full specifier is kept, not only the package name: `@retinue/agentkit/adapters/postgres`
      // can be unresolvable while `@retinue/agentkit` resolves, and the exports map is where that
      // happens. Checking the package alone would pass an image whose subpath imports all fail.
      const importers = specifiers.get(fileName) ?? new Set();
      importers.add(file);
      specifiers.set(fileName, importers);

      // Cross into a sibling workspace and keep walking. Its own imports are the deployment's problem
      // just as much as the app's -- that is what an optional peer *means*.
      const local = resolveWorkspace(fileName, workspaces, readJson);
      if (local !== null) {
        crossed.add(fileName);
        queue.push(local);
      } else if (fileName.startsWith("@retinue/")) {
        /**
         * A sibling package the walk could not follow.
         *
         * Reported rather than skipped, because skipping is indistinguishable from success while
         * being far worse: the whole point of crossing into `@retinue/agentkit` is that `bullmq`,
         * `ioredis` and the six `@ai-sdk/*` providers are imported *inside* it. A walk that quietly
         * failed to cross returns twelve specifiers instead of twenty and reports "all resolvable".
         */
        blind.add(fileName);
      }
    }
  }

  return { specifiers, files: seen.size, unreadable, crossed, blind };
};

const main = () => {
  const entries = process.argv.slice(2);
  if (entries.length === 0) {
    console.error("collect-runtime-imports: name at least one built entry point");
    process.exit(2);
  }
  for (const entry of entries) {
    if (!existsSync(entry)) {
      // Never an empty list on a missing entry: that would write a file the next stage happily passes.
      console.error(`collect-runtime-imports: ${entry} does not exist -- nothing was built, or the path moved`);
      process.exit(2);
    }
  }

  const { specifiers, files, unreadable, crossed, blind } = collect(entries);
  if (unreadable.length > 0) {
    console.error(`collect-runtime-imports: could not read ${unreadable.length} file(s), e.g. ${unreadable[0]}`);
    process.exit(2);
  }
  if (blind.size > 0) {
    console.error(
      `collect-runtime-imports: could not follow ${[...blind].join(", ")} into its workspace — the walk would ` +
        `report only what the app imports directly, which is the smaller and wrong answer`,
    );
    process.exit(2);
  }
  if (specifiers.size === 0) {
    console.error(`collect-runtime-imports: ${files} files reached and not one bare import -- that cannot be right`);
    process.exit(2);
  }

  const out = {
    entries,
    files,
    specifiers: [...specifiers.keys()].sort(),
    // Kept so a failure names a file rather than only a specifier.
    firstImporter: Object.fromEntries([...specifiers].map(([spec, importers]) => [spec, [...importers][0]])),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  console.error(
    `collect-runtime-imports: ${out.specifiers.length} specifiers from ${files} files ` +
      `(crossed into ${crossed.size} workspace subpath(s))`,
  );
};

if (import.meta.url.endsWith(process.argv[1]?.split("/").pop() ?? " ")) main();
