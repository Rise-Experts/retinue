/**
 * Dataset integrity (SPEC #13 acceptance criteria), zero external test runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIMENSIONS, validateCase } from "./schema.mjs";
import { loadCases } from "./load.mjs";

test("every case is valid and ids are unique", () => {
  const { cases, errors } = loadCases();
  assert.deepEqual(errors, [], errors.join("\n"));
  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, cases.length, "duplicate case ids");
});

test("each case has an input and a graded expectation", () => {
  const { cases } = loadCases();
  for (const c of cases) {
    assert.ok(c.input && c.input.message, `${c.id} missing input.message`);
    assert.ok(c.expect && c.expect.kind, `${c.id} missing expect`);
    assert.deepEqual(validateCase(c), [], `${c.id} invalid`);
  }
});

test("at least 100 cases and every dimension is covered", () => {
  const { cases } = loadCases();
  assert.ok(cases.length >= 100, `only ${cases.length} cases`);
  for (const d of DIMENSIONS) {
    assert.ok(cases.some((c) => c.dimension === d), `dimension ${d} is empty`);
  }
});
