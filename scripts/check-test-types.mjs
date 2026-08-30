#!/usr/bin/env node
/**
 * Test files are typechecked — #276.
 *
 * Every package's `tsconfig.json` excludes `src/**` + `/__tests__/**` and `*.test.ts`, and `npm run typecheck`
 * is `tsc -b`. Vitest transpiles without typechecking. So until this existed, **nothing anywhere typechecked a
 * test file**, and a type error in one was invisible unless the assertion happened to fail at runtime.
 *
 * ## Why that is worse than it sounds
 *
 * It was found in #225. A test resolver was written as `{ scheme: "basic", username: "a@b.c", secret: "tok" }`
 * — the field on a `basic` credential is `password`, not `secret`. A plain type error. It compiled, ran, and
 * produced a wrong `Authorization` header, and was caught only because that particular test asserted the
 * header's exact bytes. A test asserting anything less specific would have passed against a credential that
 * was silently wrong.
 *
 * This repository's sabotage discipline rests entirely on fixtures being right. A test that constructs a
 * subtly wrong fixture proves something other than what it claims — and the cost of the gap is not broken
 * tests, it is **tests that pass for the wrong reason**, which is indistinguishable from working software.
 *
 * ## Why `tsc -p` rather than `vitest --typecheck`
 *
 * Both were considered, as the issue asks.
 *
 * `vitest --typecheck` couples typechecking to the test runner: it typechecks as part of a run, so a full
 * check means running every test, and a developer who wants only the types pays for the suite. It also
 * typechecks *through* Vitest's own transform pipeline rather than through the package's real config, so what
 * it enforces can drift from what the build enforces.
 *
 * `tsc -p <package>/tsconfig.test.json` is the same compiler the build already uses, reading a config that
 * `extends` the package's own — identical `lib`, `jsx`, `strict` and `noUncheckedIndexedAccess`. It runs
 * without touching the test runner, it is faster, and a failure names a file and a line rather than a failing
 * test. The packages are checked in parallel, bounded by the CPU count.
 *
 * The configs are checked in rather than generated here, so a developer can run
 * `npx tsc -p tools/email/tsconfig.test.json` directly on the package they are working in.
 *
 * Exit codes: 0 clean, 1 a type error in a test file, 2 the check could not run.
 */

import { execFile } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages with a test config, **discovered** rather than listed.
 *
 * Listing them is the version of this check that quietly stops covering anything: the twenty-third package
 * lands, nobody remembers the list in this file, and its tests go unchecked while the check prints a tick.
 */
export const packagesWithTests = (root = ".") => {
  const roots = ["backend", "frontend", "shareflow", "examples"];
  for (const group of ["services", "tools"]) {
    try {
      for (const entry of readdirSync(`${root}/${group}`, { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(`${group}/${entry.name}`);
      }
    } catch {
      // A group that does not exist is not an error; the repository has had both added over time.
    }
  }
  return roots.filter((path) => existsSync(`${root}/${path}/tsconfig.test.json`)).sort();
};

/** Whether a package has any test file at all, so a config without tests is reported rather than passing. */
export const hasTestFiles = (path) => {
  const walk = (dir) => {
    let found = false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) found = walk(child) || found;
      else if (/\.test\.tsx?$/.test(entry.name)) found = true;
      if (found) return true;
    }
    return found;
  };
  try {
    return statSync(`${path}/src`).isDirectory() && walk(`${path}/src`);
  } catch {
    return false;
  }
};

const check = (path) =>
  new Promise((done) => {
    execFile(
      process.execPath,
      [resolve("node_modules/typescript/bin/tsc"), "-p", `${path}/tsconfig.test.json`],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        done({ path, ok: error === null, output: `${stdout}${stderr}`.trim() });
      },
    );
  });

/** Runs `worker` over `items` with at most `limit` in flight. */
export const pooled = async (items, limit, worker) => {
  const results = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
};

const main = async () => {
  const packages = packagesWithTests();
  if (packages.length < 5) {
    console.error(`✗ found only ${packages.length} package(s) with a tsconfig.test.json — the root is wrong, so a clean result means nothing`);
    return 2;
  }

  const missing = packages.filter((path) => !hasTestFiles(path));
  const limit = Math.max(2, Math.min(8, availableParallelism() - 1));
  const results = await pooled(packages, limit, check);
  const failed = results.filter((result) => !result.ok);

  for (const result of failed) {
    console.error(`✗ ${result.path} — type errors in test files:`);
    console.error(result.output.split("\n").map((line) => `    ${line}`).join("\n"));
  }
  if (missing.length > 0) {
    // A config with nothing to check is a check that passes vacuously.
    console.error(`✗ ${missing.join(", ")} has a tsconfig.test.json and no test files — remove one or add the other.`);
  }

  if (failed.length > 0 || missing.length > 0) {
    console.error(
      `\n✗ ${failed.length} package(s) have type errors in their tests. Fix them rather than suppressing them: ` +
        "a test that does not typecheck is a test that may be proving something other than what it claims.",
    );
    return 1;
  }
  console.log(`✓ test files typecheck in all ${packages.length} package(s) that have them`);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`✗ the check could not run: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
