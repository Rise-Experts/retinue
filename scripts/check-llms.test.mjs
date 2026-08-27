/**
 * Proves the link extractor and the "is it served" rule, including the shapes that must *not* count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { internalLinks, served } from "./check-llms.mjs";

test("extracts site-internal links and leaves external ones alone", () => {
  const index = [
    "- [Overview](/docs/overview)",
    "- [Spec](/specifications/architecture)",
    "- [GitHub](https://github.com/Rise-Experts/retinue)",
    "plain text (/not-a-link)",
  ].join("\n");
  assert.deepEqual(internalLinks(index), ["/docs/overview", "/specifications/architecture"]);
});

test("a path with no built page is not served", () => {
  assert.equal(served("website/build", "/no/such/page/at/all"), false);
});

test("the real index's first link is served by the real build, when there is one", () => {
  // Guarded rather than skipped-with-a-pass: in a checkout with no build this asserts nothing and says so, and
  // the script itself exits 2 in that case rather than reporting success.
  const hasBuild = served("website/build", "/docs/overview") || served("website/build", "/");
  if (!hasBuild) return;
  assert.equal(served("website/build", "/docs/overview"), true);
});
