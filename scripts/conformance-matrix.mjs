#!/usr/bin/env node
/**
 * Builds the adapter × port conformance matrix (#92).
 *
 * Two inputs, one output:
 *   - `backend/.conformance/registry.json` — emitted by the coverage guard test, so the registry has
 *     exactly one source of truth. (`src/testing/**` is excluded from the build, so this script
 *     cannot import it from `dist`, and re-parsing the TypeScript would create a second one.)
 *   - a vitest JSON report — which harnesses actually ran, and whether they passed.
 *
 * The adapter for a cell comes from the *test file* (`postgres-conformance.test.ts` → postgres) and
 * the port from the describe title (`RunStore conformance` → RunStore). Both conventions are guarded
 * by tests, so a rename fails the build instead of silently emptying a row.
 *
 * Exit status is the point: a cell that is absent *and* unaccounted for is an omission and fails.
 * A cell that is absent and declared in the registry against a tracking issue is a known gap and
 * does not. Without that split the job is either permanently red until #100 lands, or blind to a
 * forgotten adapter — and the second is how #20 closed green on one table.
 *
 * Usage: node scripts/conformance-matrix.mjs <vitest-report.json> [--out DIR] [--summary FILE]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

const args = process.argv.slice(2);
const reportPath = args.find((a) => !a.startsWith("--"));
const outDir = valueOf("--out") ?? "backend/.conformance";
const summaryPath = valueOf("--summary") ?? process.env.GITHUB_STEP_SUMMARY ?? null;

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message) {
  console.error(`conformance-matrix: ${message}`);
  process.exit(1);
}

if (!reportPath) fail("expected a vitest JSON report path as the first argument");

const registryPath = resolve("backend/.conformance/registry.json");
if (!existsSync(registryPath)) {
  fail(
    `registry not found at ${registryPath}. It is written by the coverage guard test, so run the ` +
      "backend suite first (npm test -w @agentkit/backend).",
  );
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));

/**
 * Refuse a stale report. `.conformance/` is gitignored, so a report from an earlier run survives —
 * and a matrix built from it publishes yesterday's verdict as today's. This bit during #95: a report
 * left over from a deliberately-broken negative test reported two adapters failing while the suite
 * was green. CI never sees it (fresh checkout), which is exactly why it needs catching locally.
 */
const newestSourceMtime = () => {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(resolve("backend/src"));
  return newest;
};

const reportMtime = statSync(resolve(reportPath)).mtimeMs;
const sourceMtime = newestSourceMtime();
if (reportMtime < sourceMtime) {
  fail(
    `the report at ${reportPath} predates the newest source file by ` +
      `${Math.round((sourceMtime - reportMtime) / 1000)}s. Publishing it would report a stale ` +
      "verdict as current. Re-run: npm run conformance:report",
  );
}

const PORTS = registry.ports.map((p) => p.port);
const ADAPTERS = registry.adapters.map((a) => a.adapter);

/** Which adapter a test file reports on. Unknown files are ignored — they are not matrix input. */
const adapterForFile = (file) => {
  const name = file.replaceAll("\\", "/").split("/").pop() ?? "";
  const match = /^(memory|postgres|supabase)-conformance\.test\.ts$/.exec(name);
  return match ? match[1] : null;
};

/** `RunStore conformance › enforces tenant isolation` → RunStore */
const portForName = (fullName) => {
  const match = /(\w+) conformance/.exec(fullName);
  return match && PORTS.includes(match[1]) ? match[1] : null;
};

// cell[adapter][port] = { pass, fail, skip }
const cells = Object.fromEntries(
  ADAPTERS.map((a) => [a, Object.fromEntries(PORTS.map((p) => [p, { pass: 0, fail: 0, skip: 0 }]))]),
);

let observed = 0;
for (const suite of report.testResults ?? []) {
  const adapter = adapterForFile(suite.name ?? "");
  if (!adapter) continue;
  for (const test of suite.assertionResults ?? []) {
    const port = portForName(test.fullName ?? test.title ?? "");
    if (!port) continue;
    const bucket = cells[adapter]?.[port];
    if (!bucket) continue;
    observed += 1;
    // A gatedIt skip registers as a passing test whose name carries the reason (see #91), so a
    // "[skipped: …]" title is a declared capability gap rather than a plain pass.
    if (test.status === "failed") bucket.fail += 1;
    else if (test.status === "pending" || /\[skipped:/.test(test.title ?? "")) bucket.skip += 1;
    else bucket.pass += 1;
  }
}

if (observed === 0) {
  fail(
    "parsed the report but matched zero conformance tests. The file-name or describe-title " +
      "convention has drifted — the matrix would be silently empty, which reads as 'nothing " +
      "covered'. Refusing to publish it.",
  );
}

const stateFor = (adapter, port) => {
  const declared = registry.adapters.find((a) => a.adapter === adapter);
  const implemented = declared?.implemented.includes(port) ?? false;
  const gap = declared?.notImplemented.find((n) => n.port === port);
  // A port an adapter is deliberately not the home for (#129: file bytes are object storage, not a
  // relational column). Distinct from NOT-IMPLEMENTED on purpose -- that one names an issue that will
  // close it, and this one never closes. Collapsing them would put a permanent decision on a backlog.
  const exempt = declared?.notApplicable?.find((n) => n.port === port);
  const c = cells[adapter][port];
  const ran = c.pass + c.fail + c.skip > 0;

  if (c.fail > 0) return { state: "FAIL", detail: `${c.fail} failing` };
  if (implemented && ran) return { state: c.skip > 0 ? "PASS*" : "PASS", detail: `${c.pass} passing${c.skip ? `, ${c.skip} skipped` : ""}` };
  if (implemented && !ran)
    return { state: "MISSING", detail: "registry claims this port is implemented but no harness ran" };
  if (gap) return { state: "NOT-IMPLEMENTED", detail: gap.trackedBy };
  // Checked after the `implemented && ran` cases above, so an exemption cannot mask a harness that ran and
  // failed: a FAIL still wins, and a cell claiming both would surface as a coverage-test failure.
  if (exempt) return { state: "NOT-APPLICABLE", detail: exempt.reason };
  return { state: "UNCLASSIFIED", detail: "no adapter, no tracking issue" };
};

const matrix = { generatedFor: ADAPTERS, ports: PORTS, cells: {} };
const problems = [];
for (const adapter of ADAPTERS) {
  matrix.cells[adapter] = {};
  for (const port of PORTS) {
    const cell = stateFor(adapter, port);
    matrix.cells[adapter][port] = cell;
    if (cell.state === "FAIL" || cell.state === "MISSING" || cell.state === "UNCLASSIFIED") {
      problems.push(`${adapter}/${port}: ${cell.state} — ${cell.detail}`);
    }
  }
}

mkdirSync(resolve(outDir), { recursive: true });
const jsonOut = resolve(outDir, "conformance-matrix.json");
writeFileSync(jsonOut, `${JSON.stringify(matrix, null, 2)}\n`);

const GLYPH = {
  PASS: "✅",
  "PASS*": "✅*",
  FAIL: "❌",
  SKIP: "⏭️",
  "NOT-IMPLEMENTED": "—",
  "NOT-APPLICABLE": "n/a",
  MISSING: "🚨",
  UNCLASSIFIED: "🚨",
};

const lines = [
  "## Conformance matrix",
  "",
  `${PORTS.length} storage ports × ${ADAPTERS.length} adapters. ✅ passing · ✅* passing with a declared`,
  "capability skip · — no adapter yet (tracked) · n/a not this adapter's concern · 🚨 unaccounted for.",
  "",
  `| Port | ${ADAPTERS.join(" | ")} |`,
  `|---|${ADAPTERS.map(() => "---").join("|")}|`,
];
for (const port of PORTS) {
  const row = ADAPTERS.map((a) => {
    const c = matrix.cells[a][port];
    const glyph = GLYPH[c.state] ?? c.state;
    return c.state === "NOT-IMPLEMENTED" ? `${glyph} ${c.detail}` : glyph;
  });
  lines.push(`| \`${port}\` | ${row.join(" | ")} |`);
}
lines.push("");
for (const adapter of ADAPTERS) {
  const states = PORTS.map((p) => matrix.cells[adapter][p].state);
  const passing = states.filter((s) => s.startsWith("PASS")).length;
  // Exempt ports leave the denominator as well as the numerator. "20/21" for an adapter that is complete
  // reads as a gap, and a number that reads as a gap when there is none is a number people learn to ignore.
  const applicable = states.filter((s) => s !== "NOT-APPLICABLE").length;
  const exempt = states.length - applicable;
  lines.push(
    `- **${adapter}**: ${passing}/${applicable} ports verified` +
      (exempt > 0 ? ` (${exempt} not applicable)` : ""),
  );
}
const table = `${lines.join("\n")}\n`;

writeFileSync(resolve(outDir, "conformance-matrix.md"), table);
if (summaryPath) writeFileSync(summaryPath, table, { flag: "a" });
process.stdout.write(table);

if (problems.length > 0) {
  console.error("\nconformance-matrix: unaccounted cells — failing the job:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nEither implement the port, or declare the gap in ADAPTER_COVERAGE " +
      "(src/testing/conformance/index.ts) against the issue that will close it.",
  );
  process.exit(1);
}
console.error(`\nconformance-matrix: wrote ${jsonOut} — no unaccounted cells.`);
