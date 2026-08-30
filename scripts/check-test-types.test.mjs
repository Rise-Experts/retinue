/**
 * The test-type check catches a type error in a test file — #276, AC-5.
 *
 * A check that reports success is worth exactly as much as the evidence it fails when it should. The AC asks
 * for a deliberate type error and an assertion that CI notices; this writes one into a real package, runs the
 * real compiler over the real config, and asserts a non-zero exit — then removes it.
 *
 * The temporary file goes into the smallest package with tests, because it is the fastest to compile and the
 * assertion does not depend on which package it is. It is written and removed in a `finally`, so an
 * interrupted run leaves nothing behind that a later run would trip over.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { hasTestFiles, packagesWithTests, pooled } from "./check-test-types.mjs";

const TARGET = "tools/search";
const PLANTED = `${TARGET}/src/__tests__/planted-type-error.test.ts`;

const tsc = (project) => {
  try {
    execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", project], {
      stdio: "pipe",
    });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

test("every package with test files has a config that covers them", () => {
  const packages = packagesWithTests();
  // A guard against the check silently covering nothing: if the discovery breaks, this number collapses.
  assert.ok(packages.length >= 20, `expected at least 20 packages, found ${packages.length}`);
  for (const path of packages) {
    assert.ok(hasTestFiles(path), `${path} has a tsconfig.test.json and no test files`);
    const config = JSON.parse(readFileSync(`${path}/tsconfig.test.json`, "utf8"));
    assert.equal(config.compilerOptions.noEmit, true, `${path} must not emit`);
    // The whole point: the build config excludes tests, and this one must not.
    const excluded = (config.exclude ?? []).join(" ");
    assert.ok(!excluded.includes("__tests__"), `${path} excludes the files it exists to check`);
    assert.ok(!excluded.includes(".test."), `${path} excludes the files it exists to check`);
  }
});

test("the build still refuses to compile test files, so nothing reaches dist", () => {
  // The other half of AC-2: this check exists *because* the build excludes them, and that exclusion has to
  // stay. A build that started emitting test output would put fixtures in a published package.
  for (const path of packagesWithTests()) {
    const build = JSON.parse(readFileSync(`${path}/tsconfig.json`, "utf8"));
    const excluded = (build.exclude ?? []).join(" ");
    assert.ok(excluded.includes("__tests__") || excluded.includes(".test."), `${path} build config should exclude tests`);
  }
});

test("a deliberate type error in a test file fails the check", () => {
  assert.ok(!existsSync(PLANTED), "a previous run left the planted file behind");
  // Clean first, so the failure below is unambiguously caused by what this test plants.
  assert.ok(tsc(`${TARGET}/tsconfig.test.json`).ok, `${TARGET} should typecheck before anything is planted`);

  try {
    writeFileSync(
      PLANTED,
      [
        "// Written by scripts/check-test-types.test.mjs and removed in the same run. If you are reading this in",
        "// a working tree, a test run was interrupted — deleting it is safe.",
        'import { describe, it } from "vitest";',
        "",
        "describe(\"planted\", () => {",
        "  it(\"assigns a number to a string, which must not compile\", () => {",
        "    const wrong: string = 42;",
        "    void wrong;",
        "  });",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = tsc(`${TARGET}/tsconfig.test.json`);
    assert.equal(result.ok, false, "the check passed a test file containing a type error");
    // Named, so this fails loudly if some *other* error is what made it non-zero.
    assert.match(result.output, /planted-type-error\.test\.ts/);
    assert.match(result.output, /TS2322/);
  } finally {
    rmSync(PLANTED, { force: true });
  }

  // And back to clean, so a failure here cannot leak into the next run.
  assert.ok(!existsSync(PLANTED));
  assert.ok(tsc(`${TARGET}/tsconfig.test.json`).ok, "the planted file was not fully removed");
});

test("the pool runs every item exactly once", async () => {
  // The checker runs packages concurrently; a pool that dropped or repeated one would report a clean result
  // for a package it never compiled.
  const seen = [];
  const results = await pooled([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    seen.push(item);
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});
