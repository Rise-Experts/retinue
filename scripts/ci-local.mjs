#!/usr/bin/env node
/**
 * CI, on this machine — because the hosted kind has no minutes left.
 *
 * The workflow's jobs failed in two seconds without being assigned a runner: no steps, no logs, just a red cross
 * on every push. So the triggers are commented out and this runs the same commands here. The point is not
 * convenience; it is that a gate nobody runs is a gate that does not exist, and "we will check when CI is back"
 * is how a fortnight of broken commits accumulates.
 *
 * ## Why the command list is checked rather than trusted
 *
 * A list here and a list in `ci.yml`, neither derived from the other, is exactly the shape this repo keeps
 * finding defects in — two things that must agree, with nothing making them. So `--verify` reads the workflow,
 * extracts every `npm run …` it invokes, and fails if this file does not cover one. It runs as part of the test
 * suite, so the drift is caught while CI is off rather than discovered when it comes back.
 *
 * Usage:
 *   node scripts/ci-local.mjs             # run everything
 *   node scripts/ci-local.mjs --verify    # only check this file covers the workflow
 *   node scripts/ci-local.mjs --with-image # include the Docker build, which is slow
 *
 * Exit codes: 0 all green, 1 something failed, 2 the check could not run.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/ci.yml";

/**
 * What the workflow's jobs run, in the order a person wants the failures in.
 *
 * `npm ci` and `npm install` are deliberately absent: a hosted runner starts from nothing and has to install,
 * and doing that here would delete the working tree's `node_modules` to reinstall exactly what is in it.
 */
export const STEPS = [
  ["typecheck", "npm run typecheck"],
  ["build", "npm run build"],
  ["tests · boundaries · reachability · scripts · docs", "npm test"],
  ["boundary rules", "npm run check:boundaries"],
  ["eval coverage", "npm run evals:coverage"],
  ["conformance report", "npm run conformance:report"],
  ["conformance matrix", "npm run conformance:matrix"],
  ["docs site", "npm --prefix website run build"],
];

/** The workflow commands this file deliberately does not run, each with the reason. */
export const NOT_RUN = new Map([
  ["npm ci", "a hosted runner installs from nothing; here it would reinstall what is already present"],
  ["npm install", "same"],
  ["npm run ci:local", "this script — the workflow invoking it would be recursion"],
]);

const workflowCommands = () => {
  let source;
  try {
    source = readFileSync(WORKFLOW, "utf8");
  } catch (error) {
    console.error(`✗ cannot read ${WORKFLOW}: ${error.message}`);
    process.exit(2);
  }
  // Only `run:` lines. A command mentioned in a comment is not a command the workflow runs, and matching prose
  // would make this fail on its own explanations.
  const found = new Set();
  for (const line of source.split("\n")) {
    const run = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
    if (run === null) continue;
    for (const match of run[1].matchAll(/npm (?:run [a-z:]+|test|ci|install)/g)) found.add(match[0]);
  }
  if (found.size === 0) {
    console.error(`✗ found no commands in ${WORKFLOW} — the format changed, so this check is checking nothing`);
    process.exit(2);
  }
  return found;
};

const verify = () => {
  const declared = new Set(STEPS.map(([, command]) => command));
  // `npm --prefix website run build` is how the docs job's `working-directory: website` reads from here.
  declared.add("npm run build");
  const missing = [...workflowCommands()].filter((command) => !declared.has(command) && !NOT_RUN.has(command));
  if (missing.length > 0) {
    console.error(`✗ the workflow runs commands this script does not: ${missing.join(", ")}`);
    console.error("  add them to STEPS, or to NOT_RUN with the reason — a local gate missing a check is a gate that lies");
    return false;
  }
  console.log(`✓ covers every command ${WORKFLOW} runs (${workflowCommands().size} found, ${NOT_RUN.size} deliberately skipped)`);
  return true;
};

if (process.argv.includes("--verify")) process.exit(verify() ? 0 : 1);

if (!verify()) process.exit(1);

const steps = [...STEPS];
if (process.argv.includes("--with-image")) {
  // Off by default: the image build is minutes on a runner and a few minutes here, and it only changes when the
  // Dockerfile or a manifest does.
  steps.push(["docker image", "docker build -t retinue:local ."]);
}

const results = [];
for (const [label, command] of steps) {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    execSync(command, { stdio: "inherit" });
    results.push({ label, ok: true });
  } catch {
    // Keep going. Being told one failure at a time turns one red run into four.
    results.push({ label, ok: false });
  }
}

console.log("\n──────────────────────────────────────────────");
for (const { label, ok } of results) console.log(`${ok ? "✓" : "✗"} ${label}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "\n✓ local CI passed" : `\n✗ local CI failed: ${failed.map((f) => f.label).join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
