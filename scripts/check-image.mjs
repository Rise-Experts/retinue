#!/usr/bin/env node
/**
 * The image carries every workspace the reference app needs — REQ-047 (#206), after CI found it did not.
 *
 * The image job is one of the three workflow steps `ci:local` deliberately does not run: building a container is
 * minutes of work for a step that fails for one reason, and that reason is almost always this one. So the reason
 * gets a static check instead.
 *
 * **What happened.** #214 added `tools/*` workspaces and wired them into `examples`. The Dockerfile copies named
 * directories, learned about none of them, and the image build failed on `examples/tsconfig.json` referencing
 * `../tools/github` — after two green local gates and two red CI runs. A container that cannot build is a
 * deployment that cannot ship, discovered at the last possible moment.
 *
 * **What is checked.** Every workspace the *example app depends on* is copied in both stages and built in the
 * compile step. Not every workspace: `shareflow` and `services/*` are deliberately absent from the image, and a
 * check demanding them would be demanding the wrong thing.
 *
 * Exit codes: 0 clean, 1 a workspace the image would miss, 2 the check could not run.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCKERFILE = "Dockerfile";
const APP = "examples/package.json";

/** Workspace directories a manifest depends on, by reading `@retinue/*` deps against the root's workspace list. */
export const workspaceDependenciesOf = (manifest, workspaceDirs) => {
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
  const byName = new Map(workspaceDirs.map(({ dir, name }) => [name, dir]));
  return names.filter((name) => byName.has(name)).map((name) => byName.get(name));
};

/** Every workspace on disk, as `{ dir, name }`. Globs are expanded by reading each candidate's manifest. */
export const workspacesOf = (root, readJson, listDir) => {
  const rootManifest = readJson("package.json");
  const out = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    const dirs = pattern.endsWith("/*") ? listDir(pattern.slice(0, -2)).map((name) => `${pattern.slice(0, -2)}/${name}`) : [pattern];
    for (const dir of dirs) {
      const manifest = readJson(`${dir}/package.json`);
      if (manifest !== null) out.push({ dir, name: manifest.name });
    }
  }
  return out;
};

/** The projects a `tsc -b` line names. */
export const builtProjects = (dockerfile) =>
  (/RUN npx tsc -b ([^\n]+)/.exec(dockerfile)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);

/**
 * Every project a build reaches, following `references` transitively.
 *
 * Needed because a named project builds its references too: the Dockerfile says `tsc -b backend … examples`, and
 * `frontend` is compiled because `examples` references it. The first version of this check demanded the name and
 * reported `frontend` as missing — a checker firing on a correct file, which is the false alarm that gets a
 * check deleted rather than fixed.
 */
export const reachableProjects = (named, readJson) => {
  const seen = new Set();
  const queue = [...named];
  while (queue.length > 0) {
    const dir = queue.pop().replace(/\/tsconfig\.json$/, "");
    if (seen.has(dir)) continue;
    seen.add(dir);
    const config = readJson(`${dir}/tsconfig.json`);
    for (const reference of config?.references ?? []) {
      // A reference path is relative to the config that declares it.
      const target = new URL(`${reference.path}/`, new URL(`${dir}/`, "file:///root/")).pathname
        .replace("/root/", "")
        .replace(/\/$/, "");
      queue.push(target);
    }
  }
  return seen;
};

/** Whether the Dockerfile carries a directory: its manifest in both stages, its sources, and its build output. */
export const carries = (dockerfile, dir, reachable) => {
  const stages = dockerfile.split(/^FROM /m);
  const manifestCopies = stages.filter((stage) => stage.includes(`COPY ${dir}/package.json`)).length;
  return {
    manifestInBothStages: manifestCopies >= 2,
    // `COPY tools ./tools` covers `tools/github`, so a parent copy counts.
    sources: new RegExp(`^COPY (${dir}|${dir.split("/")[0]}) `, "m").test(dockerfile),
    built: reachable.has(dir),
    output: dockerfile.includes(`/app/${dir}/dist`),
  };
};

const main = () => {
  let dockerfile;
  try {
    dockerfile = readFileSync(DOCKERFILE, "utf8");
  } catch (error) {
    console.error(`✗ cannot read ${DOCKERFILE}: ${error.message}`);
    return 2;
  }

  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const listDir = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  const workspaces = workspacesOf(".", readJson, listDir);
  if (workspaces.length < 4) {
    console.error(`✗ only ${workspaces.length} workspace(s) found — the root manifest changed shape`);
    return 2;
  }

  const app = readJson(APP);
  if (app === null) {
    console.error(`✗ cannot read ${APP}, which is what the image exists to run`);
    return 2;
  }

  const needed = workspaceDependenciesOf(app, workspaces);
  if (needed.length === 0) {
    console.error(`✗ ${APP} declares no workspace dependency — either it changed or this check is reading it wrong`);
    return 2;
  }

  const reachable = reachableProjects(builtProjects(dockerfile), readJson);
  const problems = [];
  for (const dir of needed) {
    const state = carries(dockerfile, dir, reachable);
    if (!state.manifestInBothStages) problems.push(`${dir}: its package.json is not copied in both stages (npm ci needs it in each)`);
    if (!state.sources) problems.push(`${dir}: its sources are not copied, so the build stage cannot compile it`);
    if (!state.built)
      problems.push(`${dir}: the tsc build does not reach it, directly or through a reference, so its dist would be empty`);
    if (!state.output) problems.push(`${dir}: its dist is not copied into the runtime stage, so an import of it fails at boot`);
  }

  if (problems.length > 0) {
    console.error(`✗ ${DOCKERFILE} would not carry ${problems.length} thing(s) the app imports:`);
    for (const problem of problems) console.error(`  · ${problem}`);
    console.error("  the image job is not run by ci:local, so this is the only place that catches it before CI");
    return 1;
  }

  console.log(`✓ ${DOCKERFILE} carries all ${needed.length} workspace(s) ${APP} imports: ${needed.join(", ")}`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
