#!/usr/bin/env node
/**
 * Coverage report by dimension (SPEC #13). CLI: prints counts and exits non-zero when the
 * dataset is invalid, under 100 cases, or any dimension is empty — so CI enforces the gate.
 */
import { DIMENSIONS } from "./schema.mjs";
import { loadCases } from "./load.mjs";

const MIN_TOTAL = 100;
const { cases, errors } = loadCases();

if (errors.length) {
  console.error(`✗ ${errors.length} dataset error(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const counts = Object.fromEntries(DIMENSIONS.map((d) => [d, 0]));
for (const c of cases) counts[c.dimension]++;

console.log("Evaluation dataset coverage:");
for (const d of DIMENSIONS) console.log(`  ${d.padEnd(24)} ${counts[d]}`);
console.log(`  ${"TOTAL".padEnd(24)} ${cases.length}`);

const empty = DIMENSIONS.filter((d) => counts[d] === 0);
if (empty.length) {
  console.error(`✗ empty dimension(s): ${empty.join(", ")}`);
  process.exit(1);
}
if (cases.length < MIN_TOTAL) {
  console.error(`✗ ${cases.length} cases — need at least ${MIN_TOTAL}`);
  process.exit(1);
}
console.log(`✓ ${cases.length} cases, all ${DIMENSIONS.length} dimensions covered`);
