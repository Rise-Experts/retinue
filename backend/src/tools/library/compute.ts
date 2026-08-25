/**
 * Time and arithmetic — REQ-039 (#188).
 *
 * The two things worth shipping because a model is reliably bad at them: it has no clock, and it does arithmetic
 * by pattern rather than by calculation. Both delegate to pure functions in `toolkit/compute.ts`.
 */

import { z } from "zod";
import { defineDelegatingTool } from "../delegating.js";
import type { DelegatingToolDeps } from "../delegating.js";
import type { Tool } from "../index.js";
import { calculate, currentTime } from "../../toolkit/compute.js";
import type { CalculationResult, TimeResult } from "../../toolkit/index.js";

const timeSchema = z
  .object({
    timeZone: z.string().min(1).max(64).optional().describe("An IANA zone like 'Europe/Berlin'. Defaults to the caller's."),
  })
  .strict();

export const createNowTool = (deps: DelegatingToolDeps, now?: () => Date): Tool =>
  defineDelegatingTool(deps, {
    name: "now",
    label: "Current date and time",
    description:
      "The current date and time. Call this before any answer that depends on today — you do not have a clock, " +
      "and the date you would otherwise assume is the one you were trained on.",
    category: "general",
    effect: "read",
    inputSchema: timeSchema,
    delegatesTo: "toolkit/compute.currentTime",
    delegate: (input: z.infer<typeof timeSchema>, context): TimeResult =>
      // The context's timezone when the caller named none: "today" is a different day depending on where the
      // person asking is, and the execution context already knows which.
      currentTime({ timeZone: input.timeZone ?? context.timezone, now }),
  });

const calculateSchema = z
  .object({
    expression: z.string().min(1).max(500).describe("Arithmetic: + - * / % ^, parentheses, and functions like sqrt, round, min."),
  })
  .strict();

export const createCalculateTool = (deps: DelegatingToolDeps): Tool =>
  defineDelegatingTool(deps, {
    name: "calculate",
    label: "Calculate",
    description:
      "Evaluate an arithmetic expression exactly. Use this for any arithmetic that matters rather than doing it " +
      "yourself. Supports + - * / % ^, parentheses, and abs, ceil, floor, round, sqrt, ln, log10, min, max, pow, " +
      "and the trigonometric functions. Results are double-precision floats.",
    category: "general",
    effect: "read",
    inputSchema: calculateSchema,
    delegatesTo: "toolkit/compute.calculate",
    delegate: (input: z.infer<typeof calculateSchema>): CalculationResult => calculate(input.expression),
  });
