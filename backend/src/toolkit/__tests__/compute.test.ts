/**
 * Arithmetic and the clock — REQ-039 (#188).
 *
 * The security-relevant test in here is the last one in `calculate`: the expression comes from a model, and if
 * this were `eval` or `new Function` that would be remote code execution with a friendly description.
 */

import { describe, expect, it } from "vitest";
import { MAX_EXPRESSION_CHARS, calculate, currentTime } from "../compute.js";

const value = (expression: string) => {
  const result = calculate(expression);
  return result.ok ? result.value : `refused: ${result.reason}`;
};

describe("calculate", () => {
  it("does the arithmetic", () => {
    expect(value("2 + 3 * 4")).toBe(14);
    expect(value("(2 + 3) * 4")).toBe(20);
    expect(value("10 / 4")).toBe(2.5);
    expect(value("10 % 3")).toBe(1);
    expect(value("-5 + 2")).toBe(-3);
    expect(value("2.5 * 4")).toBe(10);
  });

  it("makes exponentiation right-associative, like every calculator", () => {
    // 2^(3^2) = 512, not (2^3)^2 = 64. Left-associativity here is a wrong answer, not a style choice.
    expect(value("2 ^ 3 ^ 2")).toBe(512);
  });

  it("has the functions and constants worth having", () => {
    expect(value("sqrt(16)")).toBe(4);
    expect(value("round(2.5)")).toBe(3);
    expect(value("min(3, 1, 2)")).toBe(1);
    expect(value("max(3, 1, 2)")).toBe(3);
    expect(value("pow(2, 10)")).toBe(1024);
    expect(value("pi")).toBeCloseTo(Math.PI, 12);
    expect(value("2 * pi")).toBeCloseTo(Math.PI * 2, 12);
  });

  it("refuses rather than evaluating anything that is not arithmetic", () => {
    // Each of these is a working expression under `eval`. None of them is arithmetic.
    for (const attempt of [
      "process.exit(1)",
      "require('fs')",
      "globalThis",
      "constructor.constructor('return 1')()",
      "1; console.log(2)",
      "[].map(x => x)",
    ]) {
      expect(calculate(attempt).ok).toBe(false);
    }
  });

  it("refuses division by zero rather than returning Infinity", () => {
    // `1/0` is `Infinity`, which a model will narrate as a number.
    expect(calculate("1 / 0").ok).toBe(false);
    expect(calculate("0 % 0").ok).toBe(false);
  });

  it("refuses a result that is not finite", () => {
    expect(calculate("ln(0)").ok).toBe(false);
    expect(calculate("sqrt(-1)").ok).toBe(false);
  });

  it("refuses an unclosed parenthesis and trailing junk, rather than answering the part it understood", () => {
    expect(calculate("(2 + 3").ok).toBe(false);
    expect(calculate("2 + 3 )").ok).toBe(false);
    expect(calculate("2 + 3 four").ok).toBe(false);
  });

  it("bounds the expression length", () => {
    expect(calculate(`1${"+1".repeat(MAX_EXPRESSION_CHARS)}`).ok).toBe(false);
  });

  it("refuses an empty expression", () => {
    expect(calculate("   ").ok).toBe(false);
  });
});

describe("currentTime", () => {
  const at = new Date("2026-03-15T12:34:56.000Z");

  it("answers in the zone it was asked for", () => {
    const result = currentTime({ timeZone: "Europe/Berlin", now: () => at });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.iso).toBe("2026-03-15T12:34:56.000Z");
    expect(result.timeZone).toBe("Europe/Berlin");
    // Berlin is UTC+1 in March before the change, so the formatted local time is 13:xx and not 12:xx.
    expect(result.formatted).toContain("13:34");
  });

  it("defaults to UTC", () => {
    const result = currentTime({ now: () => at });
    expect(result.ok && result.timeZone).toBe("UTC");
    expect(result.ok && result.formatted).toContain("12:34");
  });

  it("names an unknown zone rather than quietly answering in UTC", () => {
    // Guessing produces an answer that is confidently wrong by hours, and nothing in the reply would say so.
    const result = currentTime({ timeZone: "Middle/Earth", now: () => at });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Middle/Earth");
  });
});
