/**
 * The release-gate CLI (#142).
 *
 * The deciding is tested in `backend/src/__tests__/release-gate.test.ts` against the pure function. What is
 * tested here is what only the CLI does: the exit code, the override parsing, and the trend append. Those are
 * three of AC-4's four words, and they are all in the wrapper — so testing only the pure function would leave
 * "the build actually fails" unverified.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;

// The CLI imports `@agentkit/backend`, so it needs the built dist -- and a *stale* dist is worse than a missing
// one, because the tests then pass or fail against last build's logic. Named here rather than left as a
// resolution error, which is what it cost me the first time.
if (!existsSync(join(ROOT, "backend/dist/index.js")))
  throw new Error("backend/dist is missing -- run `npm run build` before the release-gate CLI tests");

const caseResult = (caseId, dimension, score) => ({
  runId: "run",
  caseId,
  dimension,
  verdict: { score, passed: score >= 1, reason: "r", graderId: "contains", graderVersion: "1" },
});

const reportOf = (release, results) => {
  const byDimension = [...new Set(results.map((r) => r.dimension))].map((dimension) => {
    const rows = results.filter((r) => r.dimension === dimension);
    return {
      dimension,
      total: rows.length,
      passed: rows.filter((r) => r.verdict.passed).length,
      meanScore: rows.reduce((a, r) => a + r.verdict.score, 0) / rows.length,
    };
  });
  return {
    run: {
      id: `run-${release}`,
      release,
      startedAt: "2026-08-23T10:00:00.000Z",
      finishedAt: "2026-08-23T10:05:00.000Z",
      total: results.length,
      passed: results.filter((r) => r.verdict.passed).length,
      meanScore: results.reduce((a, r) => a + r.verdict.score, 0) / results.length,
      byDimension,
      costMinorUnits: 900,
      graderVersions: { contains: "1" },
    },
    results,
  };
};

/**
 * A copy of the repo's scripts and thresholds in a temp directory.
 *
 * Copied rather than run in place because `--record` *writes* `evals/trend.json`, and a test that appended to
 * the committed trend would put fake releases in the project's real quality history.
 */
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentkit-gate-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "evals"));
  cpSync(join(ROOT, "scripts/release-gate.mjs"), join(dir, "scripts/release-gate.mjs"));
  cpSync(join(ROOT, "evals/thresholds.json"), join(dir, "evals/thresholds.json"));
  cpSync(join(ROOT, "evals/trend.json"), join(dir, "evals/trend.json"));
  // node_modules *symlinked*, not copied, so `@agentkit/backend` resolves from the sandbox. Copying it
  // recursively silently produced a tree Node could not resolve through, and every test here failed with the
  // same exit code -- which looked like the script being broken rather than the fixture.
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
};

const run = (dir, args, env = {}) => {
  const reportPath = join(dir, "report.json");
  try {
    const stdout = execFileSync(process.execPath, ["scripts/release-gate.mjs", "--report", reportPath, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

const PASSING = [
  caseResult("a1", "authorization", 1),
  caseResult("e1", "external-action-safety", 1),
  caseResult("g1", "groundedness", 1),
  caseResult("s1", "tool-selection", 1),
  caseResult("t1", "task-completion", 1),
];

test("a passing run exits zero", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf("1.0", PASSING)));
  // The committed trend starts empty, so this is genuinely the first release: no comparison exists, the gate
  // must still exit zero on thresholds alone, and it must say that no regression check ran.
  const { code, stdout } = run(dir, []);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no baseline run to compare against/);
});

test("once the trend has an entry, a run with no baseline report fails", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf("1.0", PASSING)));
  assert.equal(run(dir, ["--record"]).code, 0);
  // Second release, same passing scores, no --baseline. The regression check would silently not run — which is
  // how a gate stops gating without anyone changing it — so this must fail, and name the release it wanted.
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf("1.1", PASSING)));
  const { code, stdout } = run(dir, []);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /release gate: FAIL/);
  assert.match(stdout, /newest entry is 1\.0/);
});

test("a run below a threshold exits non-zero and names the dimension", () => {
  const dir = sandbox();
  const failing = PASSING.map((r) => (r.caseId === "a1" ? caseResult("a1", "authorization", 0) : r));
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf("1.1", failing)));
  const { code, stdout } = run(dir, []);
  // The whole point of the gate: the *build* fails. A gate that printed a warning is a dashboard.
  assert.equal(code, 1);
  assert.match(stdout, /release gate: FAIL/);
  assert.match(stdout, /authorization scored 0\.000, below its threshold of 1/);
});

test("a named regression exits non-zero with the case id in the output", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "baseline.json"), JSON.stringify(reportOf("1.0", PASSING)));
  // Every dimension still above threshold and the overall mean above its line: only the named case moved.
  const regressed = PASSING.map((r) => (r.caseId === "t1" ? caseResult("t1", "task-completion", 0.9) : r));
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf("1.1", regressed)));
  const { code, stdout } = run(dir, ["--baseline", join(dir, "baseline.json")]);
  assert.equal(code, 1);
  assert.match(stdout, /1 case\(s\) regressed/);
  assert.match(stdout, /t1/);
});

test("an override exits zero but records itself as overridden", () => {
  const dir = sandbox();
  const failing = PASSING.map((r) => (r.caseId === "a1" ? caseResult("a1", "authorization", 0) : r));
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf("1.2", failing)));
  const { code, stdout } = run(dir, ["--record"], {
    AGENTKIT_GATE_OVERRIDE_ACTOR: "azeem",
    AGENTKIT_GATE_OVERRIDE_REASON: "SEV-1 hotfix, ticket OPS-411",
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /OVERRIDDEN by azeem: SEV-1 hotfix, ticket OPS-411/);

  const trend = JSON.parse(readFileSync(join(dir, "evals/trend.json"), "utf8"));
  const entry = trend.entries.at(-1);
  // Both fields, on the record. An unrecordable override is how gates quietly die.
  assert.equal(entry.outcome, "overridden");
  assert.equal(entry.override.actor, "azeem");
  assert.equal(entry.override.reason, "SEV-1 hotfix, ticket OPS-411");
  // The exit code was zero and the record says overridden. They disagree on purpose: a green build that shipped
  // past the gate stays discoverable afterwards.
  assert.notEqual(entry.outcome, "pass");
});

test("half an override is refused rather than ignored", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf("1.3", PASSING)));
  for (const env of [
    { AGENTKIT_GATE_OVERRIDE_ACTOR: "azeem" },
    { AGENTKIT_GATE_OVERRIDE_REASON: "because" },
    // Whitespace is not a reason. Without the trim, a CI input left blank produces an override with an empty
    // reason, which reads in the trend exactly like no record at all.
    { AGENTKIT_GATE_OVERRIDE_ACTOR: "azeem", AGENTKIT_GATE_OVERRIDE_REASON: "   " },
  ]) {
    const { code, stdout } = run(dir, [], env);
    assert.equal(code, 2, stdout);
    assert.match(stdout, /needs both/);
  }
});

test("--record appends, accumulating across consecutive releases", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "baseline.json"), JSON.stringify(reportOf("prev", PASSING)));
  for (const release of ["1.0", "1.1", "1.2"]) {
    writeFileSync(join(dir, "report.json"), JSON.stringify(reportOf(release, PASSING)));
    // A baseline from the second release onward, because once the trend has an entry the gate *requires* one.
    // My first version of this test chained three releases with no baseline and failed on the second — which is
    // the gate working, and the test being wrong.
    const args = ["--record", ...(release === "1.0" ? [] : ["--baseline", join(dir, "baseline.json")])];
    const { code, stdout } = run(dir, args);
    assert.equal(code, 0, stdout);
  }
  const trend = JSON.parse(readFileSync(join(dir, "evals/trend.json"), "utf8"));
  assert.deepEqual(trend.entries.map((e) => e.release), ["1.0", "1.1", "1.2"]);
  // The file's own notes survive the append — they are the documentation of what the file is for, and a writer
  // that replaced the whole document would delete them on the first release.
  assert.ok(trend.notes.length > 0);
  // Each entry carries the thresholds it was judged against, so a later threshold change is visible here.
  for (const entry of trend.entries) assert.equal(entry.thresholds.dimensions.authorization, 1);
});

test("a missing report is a usage error, distinct from a quality failure", () => {
  const dir = sandbox();
  const { code, stdout } = run(dir, []);
  // Exit 2, not 1. A CI job that treated "the report did not exist" as "quality regressed" would send someone
  // hunting a regression that never happened — and, worse, a job that treated it as a pass would gate nothing.
  assert.equal(code, 2);
  assert.match(stdout, /cannot read/);
});

test("the committed thresholds file parses and gates every dimension in the dataset", async () => {
  const { DIMENSIONS } = await import("../evals/schema.mjs");
  const thresholds = JSON.parse(readFileSync(join(ROOT, "evals/thresholds.json"), "utf8"));
  for (const dimension of DIMENSIONS) {
    // A dimension in the dataset with no threshold is a dimension the gate does not enforce. The gate warns at
    // runtime; this fails at build time, which is when it can still be fixed cheaply.
    assert.ok(
      typeof thresholds.dimensions[dimension] === "number",
      `evals/thresholds.json has no threshold for "${dimension}"`,
    );
    // And a rationale, because AC-2 is "changed only by explicit review" and a number with no stated reason is
    // a number the next person will move without one.
    assert.ok(
      typeof thresholds.rationale[dimension] === "string" && thresholds.rationale[dimension].length > 40,
      `evals/thresholds.json has no rationale for "${dimension}"`,
    );
  }
  // The safety dimensions are 1.0 and must stay there. Asserted rather than reviewed: this is the one threshold
  // change that should require deleting a test, not editing a JSON value.
  assert.equal(thresholds.dimensions.authorization, 1);
  assert.equal(thresholds.dimensions["external-action-safety"], 1);
});
