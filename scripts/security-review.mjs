#!/usr/bin/env node
/**
 * The security review, as a release checklist — REQ-033 (#145), AC-6.
 *
 * Usage:
 *   node scripts/security-review.mjs [--out <file>]
 *
 * Prints the checklist grouped by area, the findings register with each resolution, and — the part that makes
 * this a checklist rather than a report — **the manual checks a person must still walk**, plus any acceptance
 * whose revisit date has passed.
 *
 * Exits non-zero when an acceptance is overdue. An accepted finding with an expiry that nobody enforces is a
 * permanent exemption written in a moment of time pressure; the expiry is only real if something fails on it.
 *
 * Everything a machine can decide is asserted in `src/__tests__/security-audit.test.ts` and runs in `npm test`.
 * This script does not re-derive those; it reports the register and the human half, so the two cannot disagree.
 */

import { writeFileSync } from "node:fs";
import {
  CREDENTIAL_FIELD_EXEMPTIONS,
  FINDINGS,
  SECURITY_AREAS,
  SECURITY_CHECKS,
  manualChecks,
  overdueAcceptances,
} from "@retinue/agentkit/observability";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const today = new Date().toISOString().slice(0, 10);
const log = (...parts) => console.log(...parts);

const KIND_MARK = { test: "test", "build-gate": "gate", type: "type", manual: "MANUAL" };

log(`Security review — ${today}\n`);

for (const area of SECURITY_AREAS) {
  const checks = SECURITY_CHECKS.filter((c) => c.area === area);
  log(`## ${area} (${checks.length} checks)`);
  for (const check of checks) log(`  [${KIND_MARK[check.verifiedBy].padEnd(6)}] ${check.criterion}  ${check.property}`);
  log("");
}

log(`## findings (${FINDINGS.length})`);
for (const f of FINDINGS) {
  const r = f.resolution;
  const resolution =
    r.kind === "fixed" ? `fixed in ${r.reference}` : `accepted by ${r.owner}, revisit ${r.revisitBy}`;
  log(`  ${f.id}  ${f.severity.toUpperCase().padEnd(13)} ${f.title}`);
  log(`         ${resolution}`);
}

log(`\n## written exemptions (${CREDENTIAL_FIELD_EXEMPTIONS.length})`);
for (const e of CREDENTIAL_FIELD_EXEMPTIONS) log(`  ${e.file}`);

/**
 * The human half, printed last because it is the part someone has to act on.
 *
 * Printed as unchecked boxes on purpose: a checklist that prints its own ticks is a report.
 */
const manual = manualChecks();
log(`\n## walk these by hand (${manual.length})`);
for (const check of manual) {
  log(`  [ ] ${check.criterion}  ${check.property}`);
  log(`      where: ${check.evidence}`);
}

const overdue = overdueAcceptances(today);
if (overdue.length > 0) {
  log(`\n✗ ${overdue.length} acceptance(s) past their revisit date:`);
  for (const f of overdue) log(`    ${f.id} — ${f.title} (owner ${f.resolution.owner}, due ${f.resolution.revisitBy})`);
} else {
  log("\n✓ no acceptance is past its revisit date");
}

const out = arg("out");
if (out !== undefined) {
  writeFileSync(
    out,
    `${JSON.stringify({ at: today, checks: SECURITY_CHECKS, findings: FINDINGS, exemptions: CREDENTIAL_FIELD_EXEMPTIONS, manual, overdue }, null, 2)}\n`,
  );
  log(`\nwrote ${out}`);
}

// Non-zero on an overdue acceptance, and on nothing else: the automated properties are the test suite's job, and
// duplicating them here would create a second place for them to be wrong.
process.exit(overdue.length > 0 ? 1 : 0);
