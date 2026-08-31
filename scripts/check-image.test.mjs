/**
 * Proves the image check's two parsers and the rule that took a second attempt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { builtProjects, carries, reachableProjects, workspaceDependenciesOf, workspacesOf , carriesReferenceApp, missingWorkspaceManifests, runtimeStageOf
} from "./check-image.mjs";

const DOCKERFILE = `FROM node:20-slim AS build
COPY package.json ./
COPY backend/package.json ./backend/
COPY tools/github/package.json ./tools/github/
COPY backend ./backend
COPY tools ./tools
RUN npx tsc -b backend examples

FROM node:20-slim AS runtime
COPY backend/package.json ./backend/
COPY tools/github/package.json ./tools/github/
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/tools/github/dist ./tools/github/dist
`;

test("a parent copy carries a nested workspace", () => {
  // `COPY tools ./tools` is how the real file carries three directories in one line.
  assert.equal(carries(DOCKERFILE, "tools/github", new Set(["tools/github"])).sources, true);
});

test("a manifest copied in only one stage is not enough", () => {
  // Each stage runs its own `npm ci`, so a manifest missing from the runtime stage fails the install there.
  const oneStage = DOCKERFILE.replace("COPY tools/github/package.json ./tools/github/\nCOPY --from=build", "COPY --from=build");
  assert.equal(carries(oneStage, "tools/github", new Set()).manifestInBothStages, false);
});

test("the build's named projects are read from the tsc line", () => {
  assert.deepEqual(builtProjects(DOCKERFILE), ["backend", "examples"]);
});

test("a project reached only through a reference counts as built", () => {
  /**
   * The rule that took a second attempt. The real Dockerfile names `backend … examples` and never names
   * `frontend`, which is compiled because `examples` references it — and the first version of this check
   * reported `frontend` as missing. A checker firing on a correct file is the false alarm that gets a check
   * deleted rather than fixed.
   */
  const configs = {
    "examples/tsconfig.json": { references: [{ path: "../backend" }, { path: "../frontend" }] },
    "backend/tsconfig.json": {},
    "frontend/tsconfig.json": {},
  };
  const reachable = reachableProjects(["examples"], (path) => configs[path] ?? null);
  assert.ok(reachable.has("frontend"));
  assert.ok(reachable.has("backend"));
});

test("a reference cycle terminates", () => {
  // Project references should not cycle, and a checker that hangs on one is worse than one that reports it.
  const configs = {
    "a/tsconfig.json": { references: [{ path: "../b" }] },
    "b/tsconfig.json": { references: [{ path: "../a" }] },
  };
  const reachable = reachableProjects(["a"], (path) => configs[path] ?? null);
  assert.deepEqual([...reachable].sort(), ["a", "b"]);
});

test("workspace globs are expanded from what is on disk", () => {
  const readJson = (path) =>
    ({
      "package.json": { workspaces: ["backend", "tools/*"] },
      "backend/package.json": { name: "@retinue/agentkit" },
      "tools/github/package.json": { name: "@retinue/tools-github" },
    })[path] ?? null;
  const found = workspacesOf(".", readJson, () => ["github"]);
  assert.deepEqual(found, [
    { dir: "backend", name: "@retinue/agentkit" },
    { dir: "tools/github", name: "@retinue/tools-github" },
  ]);
});

test("only the app's own workspace dependencies are demanded", () => {
  // `shareflow` and `services/*` are deliberately absent from the image; demanding them would be wrong.
  const needed = workspaceDependenciesOf(
    { dependencies: { "@retinue/agentkit": "^0.1.0", zod: "^3" } },
    [
      { dir: "backend", name: "@retinue/agentkit" },
      { dir: "shareflow", name: "@retinue/shareflow" },
    ],
  );
  assert.deepEqual(needed, ["backend"]);
});

test("the real Dockerfile and the real workspaces agree", () => {
  // The integration case: this is the assertion that failed CI twice before the check existed.
  const { readFileSync, readdirSync } = fs;
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const listDir = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const workspaces = workspacesOf(".", readJson, listDir);
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const reachable = reachableProjects(builtProjects(dockerfile), readJson);
  for (const dir of workspaceDependenciesOf(readJson("examples/package.json"), workspaces)) {
    const state = carries(dockerfile, dir, reachable);
    assert.ok(state.manifestInBothStages, `${dir} manifest`);
    assert.ok(state.sources, `${dir} sources`);
    assert.ok(state.built, `${dir} built`);
    assert.ok(state.output, `${dir} output`);
  }
});

test("the image carries what the reference app needs to start — #267, AC-3", () => {
  const dockerfile = fs.readFileSync("Dockerfile", "utf8");
  const state = carriesReferenceApp(dockerfile);

  // Each of these was individually false, and each on its own is enough to ship a page that does nothing.
  assert.ok(state.launcher, "examples/scripts is not copied, so run-app.mjs is not in the image");
  assert.ok(state.bundlerRuns, "build-composer.mjs does not run in the build stage, so there is no composer.js");
  assert.ok(state.publicFromBuildStage, "examples/public is not copied from the build stage");
  /**
   * And not from the context, which is the shape of the original bug: the context's `public/` has no bundle in
   * it, so that COPY satisfies "public is present" while shipping nothing the page can load.
   */
  assert.ok(!state.publicFromContext, "examples/public is copied from the build context, which has no bundle");
});

test("carriesReferenceApp tells the two COPY sources apart", () => {
  // The check's own discrimination, asserted directly — a check that could not tell these apart would pass on
  // the broken Dockerfile.
  const fromContext = "COPY examples/public ./examples/public\n";
  const fromBuild = "COPY --from=build /app/examples/public ./examples/public\n";
  assert.equal(carriesReferenceApp(fromContext).publicFromBuildStage, false);
  assert.equal(carriesReferenceApp(fromContext).publicFromContext, true);
  assert.equal(carriesReferenceApp(fromBuild).publicFromBuildStage, true);
  assert.equal(carriesReferenceApp(fromBuild).publicFromContext, false);
});

test("every workspace manifest reaches the runtime stage, not just the app's dependencies — #267", () => {
  /**
   * The check that would have caught `tools/browser`. It shipped in #239 as a `tools/*` workspace, was never
   * added to the runtime stage, and made the image unbuildable — `npm ci` in a workspace root needs every
   * declared workspace's manifest, whether the app imports it or not. The existing `carries` check asks only
   * about the app's dependencies, so it passed the whole time.
   */
  const { readFileSync, readdirSync } = fs;
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const listDir = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const workspaces = workspacesOf(".", readJson, listDir);
  const dockerfile = readFileSync("Dockerfile", "utf8");

  /**
   * `shareflow` and `services/*` are deliberately not carried — the image ships neither's sources — so they
   * are excluded here the same way the build's `tsc -b` list excludes them.
   *
   * `workspacesOf` yields `{ dir, name }`, not strings. Worth saying because the first version of this test
   * filtered as if they were strings, and `d.startsWith is not a function` is a friendlier failure than the
   * alternative: a filter that silently matched nothing and an assertion that passed on an empty list.
   */
  const expected = workspaces
    .map((workspace) => workspace.dir)
    .filter((dir) => dir !== "shareflow" && !dir.startsWith("services/"));
  const missing = missingWorkspaceManifests(dockerfile, expected);
  assert.deepEqual(missing, [], `these workspaces have no package.json in the runtime stage: ${missing.join(", ")}`);
});

test("runtimeStageOf takes the last stage, not the first", () => {
  const two = "FROM node AS build\nCOPY a/package.json ./a/\nFROM node\nCOPY b/package.json ./b/\n";
  const runtime = runtimeStageOf(two);
  assert.ok(runtime.includes("b/package.json"));
  // The build stage's copies must not count: it does `COPY tools ./tools` wholesale, which would make every
  // workspace look present while the runtime stage carried none of them.
  assert.ok(!runtime.includes("a/package.json"));
  assert.deepEqual(missingWorkspaceManifests(two, ["a", "b"]), ["a"]);
});
