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
const JENKINSFILE = "Jenkinsfile";

/**
 * What the workflow's jobs run, in the order a person wants the failures in.
 *
 * `npm ci` and `npm install` are deliberately absent: a hosted runner starts from nothing and has to install,
 * and doing that here would delete the working tree's `node_modules` to reinstall exactly what is in it.
 */
export const STEPS = [
  ["typecheck", "npm run typecheck"],
  ["build", "npm run build"],
  ["package boundary as installed", "npm run check:consumer"],
  ["tests · boundaries · reachability · scripts · docs", "npm test"],
  ["boundary rules", "npm run check:boundaries"],
  ["eval coverage", "npm run evals:coverage"],
  ["conformance report", "npm run conformance:report"],
  ["conformance matrix", "npm run conformance:matrix"],
  ["docs site", "npm --prefix website run build"],
  // Offline: the built output's canonical host must agree with the config. Before #203's cutover it passes
  // trivially; after it, it is what catches a config change that was never redeployed.
  ["docs site hostname", "npm run check:domain -- --offline"],
];

/** The workflow commands this file deliberately does not run, each with the reason. */
export const NOT_RUN = new Map([
  ["npm ci", "a hosted runner installs from nothing; here it would reinstall what is already present"],
  ["npm install", "same"],
  ["npm run ci:local", "this script — the workflow invoking it would be recursion"],
]);

// `[a-z:-]` includes the hyphen deliberately. No script name had one until `check:docs-domain` was added as
// `check:domain`, and without the hyphen a name like `check:docs-domain` would match as the *shorter*
// `check:docs` — so the drift check would report a command missing that was present. A check that lies about
// drift is worse than no check, and this one is load-bearing for three pipeline definitions.
const NPM_COMMAND = /npm (?:--prefix \S+ run [a-z:-]+|run [a-z:-]+|test|ci|install)/g;

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    console.error(`✗ cannot read ${path}: ${error.message}`);
    console.error("  a definition that cannot be read cannot be compared, and treating that as agreement is the");
    console.error("  mistake this whole check exists to prevent");
    process.exit(2);
  }
};

/**
 * Strip comments, then scan what is left.
 *
 * The first version matched only lines that *began* a command — `run:` in YAML, `sh` in Groovy — and reported
 * four false positives, because `stage('Typecheck') { steps { sh 'npm run typecheck' } }` is all on one line and
 * a `sh \'\'\'…\'\'\'` block puts its commands on the lines after the opener. Both files also explain
 * themselves in prose that names commands, so matching everything without removing comments would make each one
 * fail on its own documentation.
 *
 * Removing the comments and scanning the remainder handles both, and is the shorter rule.
 */
const commandsIn = (path, kind) => {
  let source = read(path);
  source =
    kind === "yaml"
      ? source
          .split("\n")
          .map((line) => line.replace(/(^|\s)#.*$/, ""))
          .join("\n")
      : source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const found = new Set();
  for (const match of source.matchAll(NPM_COMMAND)) found.add(match[0]);
  if (found.size === 0) {
    console.error(`✗ found no commands in ${path} — the format changed, so this check is checking nothing`);
    process.exit(2);
  }
  return found;
};

const workflowCommands = () => commandsIn(WORKFLOW, "yaml");
const jenkinsCommands = () => commandsIn(JENKINSFILE, "groovy");

/**
 * Three definitions of one pipeline, cross-checked — because there are three now.
 *
 * `ci.yml` on a self-hosted runner, `Jenkinsfile` on an agent, and this script on a workstation. Two would have
 * been a risk; three is the shape that reliably drifts, and the failure mode is that a check exists in one and
 * not the others, and the one nobody watches is the one that stops catching things.
 *
 * So the workflow is the reference and the other two must **cover** it. Covering, not equalling: Jenkins
 * legitimately does more (JUnit publishing, artifact archiving) and that is not drift. What is refused is a
 * command the workflow runs that another definition does not.
 */
const verify = () => {
  const workflow = workflowCommands();
  /**
   * The local steps go through the *same* extractor as the two files.
   *
   * They used to be compared as raw strings, which worked only because no step had an argument. The first one
   * that did — `npm run check:domain -- --offline` — was reported as missing, because the workflow side had
   * been normalised to `npm run check:domain` and the local side had not. Comparing two things that were
   * normalised differently is the same defect this check exists to catch, one level up.
   */
  const local = new Set(
    [...STEPS.map(([, command]) => command).join("\n").matchAll(NPM_COMMAND)].map((match) => match[0]),
  );
  // `npm --prefix website run build` is how the docs job's `working-directory: website` reads from here.
  local.add("npm run build");
  const jenkins = jenkinsCommands();

  let ok = true;
  for (const [label, covered] of [
    ["scripts/ci-local.mjs", local],
    [JENKINSFILE, jenkins],
  ]) {
    const missing = [...workflow].filter((command) => !covered.has(command) && !NOT_RUN.has(command));
    if (missing.length > 0) {
      console.error(`✗ ${WORKFLOW} runs commands ${label} does not: ${missing.join(", ")}`);
      console.error(`  add them there, or to NOT_RUN with the reason — a gate missing a check is a gate that lies`);
      ok = false;
    }
  }
  if (ok) {
    console.log(
      `✓ ${WORKFLOW} (${workflow.size} commands) is covered by scripts/ci-local.mjs and ${JENKINSFILE}` +
        ` — ${NOT_RUN.size} deliberately skipped`,
    );
  }
  return ok;
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
