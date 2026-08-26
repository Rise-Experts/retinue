#!/usr/bin/env node
/**
 * The gate, on the release path — REQ-040 (#189), AC-9.
 *
 * "The gate that already exists runs on the release path, and a failure blocks publication rather than warning."
 * The gate did exist; nothing connected it to a release. A checklist in a document is a promise, and the
 * difference between a promise and a gate is that one of them can be answered with "I thought it passed".
 *
 * Every step runs even after one fails, and the summary lists all of them. A release blocked for three reasons
 * where the operator was told one is a release attempted three times.
 *
 * Exit codes: 0 everything passed, 1 something failed, 2 the check could not run.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const STEPS = [
  ["typecheck", "npm run typecheck"],
  ["build", "npm run build"],
  // Before the tests, deliberately: this one asks whether the artifact a consumer installs is usable at all,
  // and a suite that passes against a package whose entry points do not resolve is the wrong thing to learn first.
  ["package boundary as installed", "npm run check:consumer"],
  ["tests, boundaries, reachability, scripts, docs", "npm test"],
  ["boundary rules", "npm run check:boundaries"],
  ["conformance matrix", "npm run conformance:report"],
  ["security review revisit dates", "npm run security:review"],
  ["documentation site", "npm run docs:build"],
];

/**
 * Checks that need no subprocess, because they are about the manifests rather than the code.
 *
 * Here rather than as tests because they are questions about *publishing*, and a package's own suite is the
 * wrong place to assert facts about how it is released.
 */
const manifestChecks = () => {
  const problems = [];
  const shipping = ["backend", "frontend"];
  for (const dir of shipping) {
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    const at = (problem) => problems.push(`${manifest.name}: ${problem}`);

    if (manifest.version === "0.0.0") at("version is still 0.0.0");
    if (!manifest.license) at("no license field");
    /**
     * A licence, and the text of it.
     *
     * `UNLICENSED` was correct while nobody had chosen; it is `Apache-2.0` since #184, and the field alone is
     * not enough. A manifest claiming a licence over a tarball carrying no licence text is what fails somebody
     * else's compliance review rather than ours — so the file has to be there, in the package, not only at the
     * repository root where `npm pack` will not pick it up.
     */
    if (manifest.license === "UNLICENSED") {
      at("license is UNLICENSED — the licence was chosen in #184 (Apache-2.0); this is a regression");
    }
    if (!existsSync(`${dir}/LICENSE`)) {
      at(`no ${dir}/LICENSE — npm ships one whatever \`files\` says, but only if the package has one`);
    }
    if (!manifest.description) at("no description");
    if (!manifest.repository) at("no repository field, so npm cannot link the source");
    if (!manifest.author) at("no author");

    for (const field of ["dependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        // `"*"` resolves only because these are workspaces. Published, it means "any version, forever".
        if (name.startsWith("@retinue/") && range === "*") at(`${field}.${name} is "*" — pin a published range`);
      }
    }
  }

  /**
   * The publish gate itself.
   *
   * `private: true` is what stops an accidental publish, and it is deliberate rather than an oversight — see
   * `docs/19-versioning.md`. This check states the reason so that whoever removes it has to have read why it was
   * there.
   *
   * Both original reasons are now gone: the `retinue` npm organisation exists and is ours (#192 AC-1, confirmed
   * by an authenticated `npm org ls`, not by a 404 on the registry), and the licence is Apache-2.0 (#184). What
   * is left is the publish itself — #193 — which is a pipeline, a provenance identity and a decision about when.
   * So the note names one reason rather than three, and if that reason is also gone, flipping this flag is a
   * one-line change somebody should make deliberately.
   */
  const notes = [];
  for (const dir of shipping) {
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    if (manifest.private === true) {
      notes.push(
        `${manifest.name} is private: true, so this check cannot be a publish. The scope and the licence are ` +
          `settled; what remains is #193 — the release pipeline and its provenance identity.`,
      );
    }

  }
  return { problems, notes };
};

const results = [];
for (const [label, command] of STEPS) {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    execSync(command, { stdio: "inherit" });
    results.push({ label, ok: true });
  } catch {
    // Continue rather than stopping: a release blocked for three reasons where the operator was told one is a
    // release attempted three times.
    results.push({ label, ok: false });
  }
}

const { problems, notes } = manifestChecks();
results.push({ label: "publishable manifests", ok: problems.length === 0 });

console.log("\n──────────────────────────────────────────────");
for (const { label, ok } of results) console.log(`${ok ? "✓" : "✗"} ${label}`);
for (const problem of problems) console.log(`  ✗ ${problem}`);
for (const note of notes) console.log(`  · ${note}`);

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? "\n✓ release check passed — every gate is green"
    : `\n✗ release check failed: ${failed.map((f) => f.label).join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
