#!/usr/bin/env node
/**
 * Every package an *application* imports is guaranteed to be installed — REQ-041 (#190).
 *
 * The runtime declares its heavy dependencies as **optional peers**: `pg`, `ioredis`, `bullmq`, the
 * `@ai-sdk/*` providers, `graphql-yoga`, `@whatwg-node/server`. Optional means npm installs them only
 * if something asks, so the application — the workspace a deployment actually loads — has to name the
 * ones its wiring uses. In the monorepo nothing notices when it doesn't: the root install has every
 * workspace's dependencies hoisted, so the import resolves for the same reason a typo in a comment
 * compiles.
 *
 * **Both Dockerfiles used to claim the runtime install caught this.** They said an undeclared peer
 * "fails here rather than in production", and it does not. Removing `pg` from `shareflow`'s manifest
 * and rebuilding produced an image where `import("pg")` still resolved — `bullmq` depends on `pg`, so
 * a package nobody declared arrived anyway, and the claim was true only by luck. A guarantee that
 * holds when a transitive dependency happens to cooperate is not a guarantee, so it lives here.
 *
 * **What "guaranteed" means, precisely.** A specifier is satisfied when the app's own manifest names
 * it, or when it is a hard `dependencies` entry of a package the app names — transitively. `ai` is not
 * declared by either app and is fine: it is a real dependency of `@retinue/agentkit`, so npm cannot
 * install the runtime without it. `pg` is an optional *peer* of the same package, which guarantees
 * nothing. That distinction is the whole check; a version of it that demanded every import be declared
 * directly would fire on correct files, which is the false alarm that gets a check deleted.
 *
 * Specifiers come from TypeScript's own `preProcessFile`, not a regex. The first version of this used
 * one and reported ten packages named "nothing out there" and "tried and failed twice" — prose from
 * comments, read as imports.
 *
 * Exit codes: 0 clean, 1 an import nothing guarantees, 2 the check could not run. Never zero for
 * "could not tell".
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

import ts from "typescript";

/**
 * The workspaces a deployment loads through `RETINUE_APP_MODULE`, each with the image that ships it.
 *
 * Not every workspace: a library may import what its own consumers are expected to provide, which is
 * what a peer dependency *is*. Only an application is the last place a dependency can be declared.
 */
export const APPS = [
  { dir: "examples", dockerfile: "Dockerfile" },
  { dir: "shareflow", dockerfile: "Dockerfile.shareflow" },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__tests__", "public"]);
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export const packageOf = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

export const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
};

/**
 * Bare import specifiers in a source file, by package.
 *
 * `preProcessFile` is the compiler's own scanner, so a string inside a comment is a comment and a
 * dynamic `import("x")` is an import. Both matter here: this repo's comments quote import statements,
 * and every optional peer in the app module is reached through a dynamic import.
 */
export const importedPackages = (source) => {
  const { importedFiles } = ts.preProcessFile(source, true, true);
  const out = new Set();
  for (const { fileName } of importedFiles) {
    if (fileName.startsWith(".") || BUILTINS.has(fileName)) continue;
    out.add(packageOf(fileName));
  }
  return out;
};

/**
 * Everything installing `names` is guaranteed to bring, following hard `dependencies` only.
 *
 * Optional and peer dependencies are deliberately not followed. A peer is a request to the consumer,
 * not a promise to it — following them would make this check pass for exactly the case it exists to
 * catch.
 */
export const guaranteedClosure = (names, manifestFor) => {
  const seen = new Set();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const manifest = manifestFor(name);
    if (manifest === null) continue;
    for (const dep of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
};

/** Why an import is not guaranteed, said in the terms the reader has to act on. */
export const explain = (pkg, manifestFor, declaredNames) => {
  for (const owner of declaredNames) {
    const manifest = manifestFor(owner);
    if (manifest === null) continue;
    if (manifest.peerDependencies?.[pkg] !== undefined) {
      const optional = manifest.peerDependenciesMeta?.[pkg]?.optional === true;
      return optional
        ? `an OPTIONAL peer of ${owner} — npm installs it only if something asks, so the app must ask`
        : `a peer of ${owner}, which the app must satisfy`;
    }
  }
  return "declared by nothing the app installs";
};

export const findUnguaranteed = (app, { readJson, listFiles, readFile, manifestFor }) => {
  const manifest = readJson(`${app.dir}/package.json`);
  if (manifest === null) return { error: `${app.dir}/package.json is unreadable` };
  const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
  const guaranteed = guaranteedClosure(declared, manifestFor);

  const files = listFiles(`${app.dir}/src`);
  if (files.length === 0) return { error: `${app.dir}/src has no sources to scan` };

  const offences = [];
  for (const file of files) {
    for (const pkg of importedPackages(readFile(file))) {
      if (guaranteed.has(pkg)) continue;
      offences.push({ file, pkg, why: explain(pkg, manifestFor, declared) });
    }
  }
  return { offences, scanned: files.length };
};

const main = () => {
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const manifestFor = (name) => readJson(`node_modules/${name}/package.json`);
  const io = { readJson, listFiles: (dir) => walk(dir), readFile: (path) => readFileSync(path, "utf8"), manifestFor };

  let failed = false;
  let scanned = 0;
  for (const app of APPS) {
    let result;
    try {
      result = findUnguaranteed(app, io);
    } catch (error) {
      console.error(`app imports: could not scan ${app.dir}: ${error.message}`);
      process.exit(2);
    }
    if (result.error !== undefined) {
      console.error(`app imports: ${result.error}`);
      process.exit(2);
    }
    scanned += result.scanned;
    for (const { file, pkg, why } of result.offences) {
      failed = true;
      console.error(`${file}: imports "${pkg}" — ${why}.`);
      console.error(`  Add it to ${app.dir}/package.json dependencies, or ${app.dockerfile} ships an image that`);
      console.error(`  boots and fails the first time this code path runs.`);
    }
  }

  if (failed) process.exit(1);
  console.log(`app imports: ${scanned} sources across ${APPS.length} apps — every import guaranteed installed`);
};

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
