/**
 * Proves the image check's two parsers and the rule that took a second attempt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { builtProjects, carries, reachableProjects, workspaceDependenciesOf, workspacesOf } from "./check-image.mjs";

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
