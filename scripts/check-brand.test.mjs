/**
 * Proves the contrast arithmetic against WCAG's published examples, and the external-asset rule against the
 * shapes it must and must not fire on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrastRatio, cssUsesTokens, luminance, round } from "./check-brand.mjs";

test("the ratio matches the values WCAG publishes", () => {
  // Black on white is exactly 21:1, and a mid grey on white is a value anybody can check independently.
  assert.equal(round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(round(contrastRatio("#ffffff", "#ffffff")), 1);
  assert.equal(round(contrastRatio("#777777", "#ffffff")), 4.48);
});

test("the ratio does not depend on which colour is named first", () => {
  assert.equal(round(contrastRatio("#234b7e", "#ffffff")), round(contrastRatio("#ffffff", "#234b7e")));
});

test("luminance is the linearised sum, not the naive average", () => {
  // The green channel carries most of the weight; a naive average would make these equal.
  assert.ok(luminance("#00ff00") > luminance("#0000ff"));
});

test("every documented pair in the real token file passes the ratio it claims", () => {
  const tokens = JSON.parse(readFileSync("brand/tokens.json", "utf8"));
  for (const { pair, use, min } of tokens.contrast) {
    const ratio = contrastRatio(tokens.colour[pair[0]].value, tokens.colour[pair[1]].value);
    assert.ok(ratio >= min, `${pair.join(" on ")} is ${round(ratio)}:1, ${use} needs ${min}`);
  }
});

test("the dark palette is designed rather than inverted, which the navy proves", () => {
  const tokens = JSON.parse(readFileSync("brand/tokens.json", "utf8"));
  // The light-mode primary on the dark ground: unreadable. An inversion would have shipped this.
  assert.ok(contrastRatio(tokens.colour.navy.value, tokens.colour.ink.value) < 3);
  assert.ok(contrastRatio(tokens.colour.sky.value, tokens.colour.ink.value) >= 4.5);
});

test("a stylesheet missing a token is named, not counted", () => {
  const missing = cssUsesTokens("--a: #234b7e;", {
    navy: { value: "#234b7e" },
    sky: { value: "#7aa6d8" },
  });
  assert.deepEqual(missing, ["sky (#7aa6d8)"]);
});

test("the real stylesheet uses every colour in the token file", () => {
  const tokens = JSON.parse(readFileSync("brand/tokens.json", "utf8"));
  const css = readFileSync("website/src/css/custom.css", "utf8");
  assert.deepEqual(cssUsesTokens(css, tokens.colour), []);
});
