/**
 * Graders for the evaluation dataset — REQ-032 (#141).
 *
 * #13 delivered the cases and a test that every one is *valid*. Nothing scored anything against them, so
 * quality was asserted rather than measured — which is what `docs/09` exists to prevent.
 *
 * **Most of this gate is free, and that is a consequence of earlier work rather than a shortcut.** Six of the
 * seven expectation kinds are decidable by code because the runtime emits *structure*: a tool call is a
 * `tool-call` part, an approval requirement is an `approval` part, and — since #137 — a citation is a
 * `citation` part with a source and an excerpt. "Did it cite?" used to need a model reading prose; it is now a
 * field lookup. Only `refuses` on unstructured output needs judgement.
 *
 * **Reproducibility is the hard requirement, and determinism is how it is met** rather than something asserted
 * afterwards. A deterministic grader is a pure function of the case and the output. The judge is pinned to a
 * model, a prompt version and temperature zero, *and* memoised on the exact input — so a second run reads the
 * first run's answer rather than asking again and hoping.
 */

import type { MessagePart } from "../core/content-parts.js";
import type { EvalVerdict } from "../persistence/index.js";

/** The dataset's shape, restated here so `backend` does not import from the `evals` workspace. */
export type EvalCase = {
  readonly id: string;
  readonly dimension: string;
  readonly title: string;
  readonly input: { readonly message: string };
  readonly expect: {
    readonly kind: string;
    readonly value?: readonly string[];
    readonly tool?: string;
    readonly reason?: string;
    readonly schema?: string;
  };
  readonly tags?: readonly string[];
};

/**
 * What the agent produced, as the runtime produced it.
 *
 * Parts, not a string. Grading prose for "did it call the tool" is a regular expression pretending to be a
 * measurement; grading parts is reading what happened. `text` is derived here for the graders that genuinely
 * need words.
 */
export type EvalOutput = {
  readonly parts: readonly MessagePart[];
  /** True when the run refused rather than answering. Structural, from the runtime. */
  readonly refused?: boolean;
  readonly refusalReason?: string;
};

/** Concatenated text of every text part. The only thing a prose grader may look at. */
export const outputText = (output: EvalOutput): string =>
  output.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");

const named = <T extends MessagePart["type"]>(
  output: EvalOutput,
  type: T,
): readonly Extract<MessagePart, { type: T }>[] =>
  output.parts.filter((p): p is Extract<MessagePart, { type: T }> => p.type === type);

export interface Grader {
  readonly id: string;
  /**
   * Bumped whenever the grader's judgement changes.
   *
   * Stored on every result, because a score that moved after a grader edit is not a quality change — and
   * without the version on the result the two are indistinguishable.
   */
  readonly version: string;
  /** The expectation kinds this grader decides. */
  readonly kinds: readonly string[];
  /** True when no model is called. Asserted by test, not trusted. */
  readonly deterministic: boolean;
  grade(input: { readonly case: EvalCase; readonly output: EvalOutput }): Promise<EvalVerdict>;
}

const pass = (reason: string): EvalVerdict => ({ pass: true, score: 1, reason });
const fail = (reason: string): EvalVerdict => ({ pass: false, score: 0, reason });

/**
 * `contains` — the output mentions every expected string.
 *
 * Case-insensitive and whitespace-tolerant, because the expectation is that the *fact* appears, not that the
 * model reproduced a casing. Partial credit, because "mentioned two of three" is genuinely different from
 * "mentioned none" and collapsing them loses the signal a regression report needs.
 */
export const containsGrader: Grader = {
  id: "contains",
  version: "1",
  kinds: ["contains"],
  deterministic: true,
  async grade({ case: testCase, output }) {
    const expected = testCase.expect.value ?? [];
    if (expected.length === 0) return pass("nothing required");
    const haystack = outputText(output).toLowerCase().replace(/\s+/g, " ");
    const found = expected.filter((needle) => haystack.includes(needle.toLowerCase().replace(/\s+/g, " ")));
    const score = found.length / expected.length;
    const missing = expected.filter((e) => !found.includes(e));
    return {
      pass: found.length === expected.length,
      score,
      reason:
        missing.length === 0
          ? `mentioned all ${expected.length}`
          : `missing: ${missing.join(", ")}`,
    };
  },
};

/**
 * `tool-called` / `tool-not-called` — read from the tool-call parts.
 *
 * One grader for both because they are the same question with opposite polarity, and two graders would be two
 * places for the part-type lookup to drift.
 */
export const toolCallGrader: Grader = {
  id: "tool-call",
  version: "1",
  kinds: ["tool-called", "tool-not-called"],
  deterministic: true,
  async grade({ case: testCase, output }) {
    const wanted = testCase.expect.tool;
    if (wanted === undefined) return fail("the case names no tool");
    const called = named(output, "tool-call").map((p) => p.toolName);
    const wasCalled = called.includes(wanted);
    if (testCase.expect.kind === "tool-not-called")
      return wasCalled
        ? fail(`called ${wanted}, which this case forbids`)
        : pass(`did not call ${wanted}`);
    return wasCalled
      ? pass(`called ${wanted}`)
      : fail(called.length === 0 ? `called no tool; expected ${wanted}` : `called ${called.join(", ")}; expected ${wanted}`);
  },
};

/**
 * `requires-approval` — an approval part naming the tool.
 *
 * The approval *part*, not the tool call: a run that called the tool and asked afterwards has not required
 * approval, and grading on the call alone would score that as a pass.
 */
export const approvalGrader: Grader = {
  id: "requires-approval",
  version: "1",
  kinds: ["requires-approval"],
  deterministic: true,
  async grade({ case: testCase, output }) {
    const wanted = testCase.expect.tool;
    if (wanted === undefined) return fail("the case names no tool");
    const approvals = named(output, "approval");
    if (approvals.some((a) => a.toolName === wanted)) return pass(`asked for approval of ${wanted}`);
    const called = named(output, "tool-call").map((p) => p.toolName);
    return fail(
      called.includes(wanted)
        ? `called ${wanted} without asking for approval`
        : `never reached ${wanted}, so approval was not requested`,
    );
  },
};

/**
 * `cites-source` — a citation part, optionally naming a source.
 *
 * **Deterministic since #137**, which is the interesting part. Before citations were structured, "did it cite"
 * meant a model reading prose for a footnote — a judgement call, and an expensive one on every case. A citation
 * part carries its source and its excerpt, so this is a field lookup: the structure paid for itself in the
 * cost of the gate.
 */
export const citationGrader: Grader = {
  id: "cites-source",
  version: "1",
  kinds: ["cites-source"],
  deterministic: true,
  async grade({ case: testCase, output }) {
    const citations = named(output, "citation");
    if (citations.length === 0) return fail("no citation");
    const required = testCase.expect.value ?? [];
    if (required.length === 0) return pass(`${citations.length} citation(s)`);
    // Matched against the citation's own fields, never against the answer's prose: a claim that *mentions* a
    // source is not a citation of it, which is the distinction #137 made structural.
    const haystack = citations
      .map((c) =>
        [
          c.excerpt,
          c.origin.kind === "web" ? `${c.origin.url} ${c.origin.title ?? ""}` : `${c.origin.sourceId} ${c.origin.locator ?? ""}`,
        ].join(" "),
      )
      .join("\n")
      .toLowerCase();
    const missing = required.filter((r) => !haystack.includes(r.toLowerCase()));
    return missing.length === 0
      ? pass(`cited ${required.join(", ")}`)
      : { pass: false, score: (required.length - missing.length) / required.length, reason: `cited nothing matching: ${missing.join(", ")}` };
  },
};

/**
 * `structured-valid` — the output carries no error part and every part validates.
 *
 * Validation is the runtime's; this checks that nothing failed it. A grader that re-validated would be a second
 * schema, and the two would eventually disagree about what is valid.
 */
export const structuredGrader: Grader = {
  id: "structured-valid",
  version: "1",
  kinds: ["structured-valid"],
  deterministic: true,
  async grade({ output }) {
    const errors = named(output, "error");
    if (errors.length > 0) return fail(`error part: ${errors.map((e) => e.error.code).join(", ")}`);
    const truncated = named(output, "tool-result").filter((r) => r.truncated);
    return truncated.length > 0
      ? // Truncated is not invalid, but it is not a clean structured answer either. Partial credit says so
        // rather than silently passing.
        { pass: true, score: 0.5, reason: "valid, but a tool result was truncated" }
      : pass("no error parts");
  },
};

/**
 * `refuses` — the only kind that may need a model, and it usually does not.
 *
 * A run that refused *structurally* — the runtime set `refused`, or emitted a `forbidden`/`approval_required`
 * error part — is graded by code. Only a refusal expressed in prose falls through to the judge, which is the
 * honest split: the structured case is the common one and free, and paying a model for it would make the gate
 * expensive for no accuracy.
 */
export const structuralRefusalGrader: Grader = {
  id: "refuses-structural",
  version: "1",
  kinds: ["refuses"],
  deterministic: true,
  async grade({ output }) {
    if (output.refused === true) return pass(`refused: ${output.refusalReason ?? "no reason given"}`);
    const codes = named(output, "error").map((e) => e.error.code);
    const refusalCodes = codes.filter((c) => c === "forbidden" || c === "approval_required" || c === "invalid_input");
    if (refusalCodes.length > 0) return pass(`refused with ${refusalCodes.join(", ")}`);
    // Not a failure — an *abstention*. The caller routes this to the judge, and scoring it as a fail here
    // would mark every prose refusal wrong.
    return { pass: false, score: 0, reason: UNDECIDED };
  },
};

/**
 * The marker a structural grader returns when it cannot decide.
 *
 * A sentinel rather than a third verdict field, because every other grader returns a real verdict and adding an
 * `undecided` case to `EvalVerdict` would make every consumer handle a state only one grader can produce.
 */
export const UNDECIDED = "undecided: no structural refusal signal";

export const DETERMINISTIC_GRADERS: readonly Grader[] = [
  containsGrader,
  toolCallGrader,
  approvalGrader,
  citationGrader,
  structuredGrader,
  structuralRefusalGrader,
];
