/**
 * The inventory, and the hole it closes — #194.
 *
 * The hole is worth restating because every test here is aimed at it: #128's gate compares **write sets**, and a
 * capability the new runtime does not implement writes **nothing**. Comparing nothing against nothing gives an
 * identical-write rate of 100%. So the strongest form of this defect is not a failing gate — it is a *passing*
 * one, on a workflow nobody built.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEHAVIOURAL_CONTRACT,
  CAPABILITY_INVENTORY,
  coverageOf,
  gateStatus,
  validateInventory,
  type CapabilityEntry,
} from "../index.js";
import { canRemoveOldRuntime, evaluateWorkflow } from "../../parity/index.js";
import { SHAREFLOW_BUILT_IN_SKILLS } from "../../skills/index.js";
import type { ParityReport } from "../../shadow/index.js";

const entry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  capability: "draft a post",
  oldRuntimePath: "old: writer",
  replacement: "create_post_draft",
  status: "implemented",
  invocation: "interactive",
  contractTest: "posts.test.ts",
  // AC-5: an entry with a replacement has to say which instruction set it runs under, and `none` is a value
  // somebody has to type rather than one they can reach by omission.
  instructions: "skills/post-composition",
  ...over,
});

/** A shadow run that agrees perfectly, which is what a missing capability produces. */
const agreeing = (tools: readonly string[]): ParityReport =>
  ({
    identical: true,
    approvalBearingWrites: { old: 0, new: 0 },
    toolsCalled: tools,
  }) as unknown as ParityReport;

describe("the verdict a missing capability produces", () => {
  it("is incomplete, not passed — the whole point of the issue", () => {
    /**
     * Without the coverage check this is a *pass*: 200 runs, every one identical, because both sides wrote
     * nothing. The rate is not wrong; the question it answers is.
     */
    const reports = Array.from({ length: 200 }, () => agreeing([]));
    const verdict = evaluateWorkflow("create-post", reports, [entry({ status: "missing", replacement: null })]);
    expect(verdict.verdict).toBe("incomplete");
    // And no rate at all, because computing one would be publishing a number that means nothing.
    expect(verdict.measured).toBeUndefined();
    expect(verdict.detail).toContain("writes nothing");
  });

  it("is incomplete for a partial capability too", () => {
    // Half-built is the harder case: the built half produces matching writes, so the rate looks *better* than
    // for a missing one while the unbuilt half is equally invisible.
    const reports = Array.from({ length: 200 }, () => agreeing(["create_post_draft"]));
    expect(evaluateWorkflow("create-post", reports, [entry({ status: "partial" })]).verdict).toBe("incomplete");
  });

  it("still passes when every capability is built", () => {
    // The control. Without it the tests above would pass against a gate that returned `incomplete` always.
    const reports = Array.from({ length: 200 }, () => agreeing(["create_post_draft"]));
    expect(evaluateWorkflow("create-post", reports, [entry()]).verdict).toBe("passed");
  });

  it("takes no capabilities as no *claim*, and leaves the existing behaviour alone", () => {
    // Every caller that predates this keeps compiling and keeps its verdict. "I did not look" is refused in
    // `canRemoveOldRuntime`, which is where the decision is actually made — not here.
    const reports = Array.from({ length: 200 }, () => agreeing(["create_post_draft"]));
    expect(evaluateWorkflow("create-post", reports).verdict).toBe("passed");
  });
});

describe("what an entry has to say", () => {
  it("accepts a complete implemented entry", () => {
    expect(validateInventory([entry()])).toEqual([]);
  });

  it("refuses a dropped capability with no signature", () => {
    // A capability removed silently is a customer's workflow removed silently.
    const problems = validateInventory([entry({ status: "dropped", replacement: null })]);
    expect(problems[0]?.problem).toContain("no signature");
  });

  it("refuses a signature missing its date", () => {
    // A decision without a date cannot be reviewed later, which is exactly when someone asks who agreed.
    const problems = validateInventory([
      entry({ status: "dropped", replacement: null, droppedBy: { by: "someone", at: "", reason: "not needed" } }),
    ]);
    expect(problems.some((p) => p.problem.includes("no usable date"))).toBe(true);
  });

  it("accepts a properly signed drop", () => {
    expect(
      validateInventory([
        entry({
          status: "dropped",
          replacement: null,
          droppedBy: { by: "a.person", at: "2026-08-26", reason: "no customer has used it in 18 months" },
        }),
      ]),
    ).toEqual([]);
  });

  it("refuses a dropped capability that also names a replacement", () => {
    const problems = validateInventory([
      entry({ status: "dropped", droppedBy: { by: "x", at: "2026-01-01", reason: "y" } }),
    ]);
    expect(problems.some((p) => p.problem.includes("one or the other"))).toBe(true);
  });

  it("refuses an implemented capability with no behavioural test", () => {
    // "The tool exists" is not "the tool matches" — AC-5.
    const problems = validateInventory([entry({ contractTest: "" })]);
    expect(problems.some((p) => p.problem.includes("no behavioural test"))).toBe(true);
  });

  it("refuses a scheduled or webhook capability with no coverage evidence", () => {
    // Nobody shadows 03:00. Requiring shadow runs of these would require something impossible; requiring
    // *evidence* is the thing that can actually be produced.
    for (const invocation of ["scheduled", "triggered", "webhook"] as const) {
      const problems = validateInventory([entry({ invocation })]);
      expect(problems.some((p) => p.problem.includes("its own coverage evidence")), invocation).toBe(true);
    }
  });

  it("refuses the same capability twice", () => {
    const problems = validateInventory([entry(), entry()]);
    expect(problems.some((p) => p.problem.includes("appears twice"))).toBe(true);
  });
});

describe("instructions are accounted for — AC-5", () => {
  /**
   * A tool-for-tool match under different instructions is a different product, and the difference produces
   * *identical write sets* on every run where the instructions did not happen to matter — so the parity gate is
   * the one thing that cannot catch it.
   */
  it("refuses an entry with a replacement and no instruction set named", () => {
    const problems = validateInventory([entry({ instructions: undefined })]);
    expect(problems.map((p) => p.problem).join(" ")).toContain("instruction set");
  });

  it("accepts `none` with a reason, because deterministic tools exist", () => {
    // The point of requiring the field rather than defaulting it: "no prose" and "nobody looked" have to be
    // distinguishable, and only one of them can be typed.
    expect(validateInventory([entry({ instructions: "none — a deterministic read" })])).toEqual([]);
  });

  it("does not demand instructions from a capability that is not built", () => {
    // A `missing` entry has no replacement to run under anything. Demanding it would be asking somebody to
    // invent the instructions for a tool that does not exist.
    expect(validateInventory([entry({ status: "missing", replacement: null, instructions: undefined, contractTest: undefined })])).toEqual([]);
  });

  it("every shipped entry with a replacement names one", () => {
    const silent = CAPABILITY_INVENTORY.filter(
      (candidate) => candidate.replacement !== null && (candidate.instructions ?? "").trim() === "",
    );
    expect(silent.map((candidate) => candidate.capability)).toEqual([]);
  });

  it("every named skill exists in the shipped skill set", () => {
    /**
     * The claim that would otherwise rot. `instructions: "skills/post-composition"` is a string; a renamed or
     * deleted skill leaves it pointing at nothing, and the inventory would keep reporting that instructions are
     * accounted for.
     */
    const known = new Set(SHAREFLOW_BUILT_IN_SKILLS.map((skill) => skill.name));
    const unknown: string[] = [];
    for (const candidate of CAPABILITY_INVENTORY) {
      for (const [, name] of (candidate.instructions ?? "").matchAll(/skills\/([a-z0-9-]+)/g)) {
        if (!known.has(name)) unknown.push(`${candidate.capability} → ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("coverage is counted, never supplied", () => {
  it("counts a shadow run only when it called the replacement", () => {
    const coverage = coverageOf({
      entries: [entry(), entry({ capability: "publish", replacement: "publish_post_now" })],
      shadowRuns: [agreeing(["create_post_draft"]), agreeing(["create_post_draft"]), agreeing(["list_accounts"])],
    });
    expect(coverage.find((c) => c.capability === "draft a post")?.shadowRuns).toBe(2);
    expect(coverage.find((c) => c.capability === "publish")?.shadowRuns).toBe(0);
  });

  it("gives a missing capability zero, since there is no tool to have been called", () => {
    const coverage = coverageOf({
      entries: [entry({ status: "missing", replacement: null })],
      shadowRuns: [agreeing(["create_post_draft"])],
    });
    expect(coverage[0]?.shadowRuns).toBe(0);
  });

  it("has no way for a caller to state a count — AC-3", () => {
    /**
     * Structural, not behavioural, and that is why it is a test.
     *
     * `coverageOf`'s input has no `shadowRuns` *per entry*: the only shadow input is the run list. An entry's
     * author is the person most likely to believe their capability is covered, so a number they could write is a
     * number that says what they expect rather than what happened.
     */
    const keys = Object.keys(entry());
    expect(keys).not.toContain("shadowRuns");
  });
});

describe("zero shadow runs cannot contribute to a pass — AC-4", () => {
  it("reports an implemented, unexercised capability", () => {
    const gate = gateStatus({ entries: [entry()], shadowRuns: [] });
    expect(gate.status).toBe("incomplete");
    expect(gate.unexercised).toEqual(["draft a post"]);
  });

  it("does not demand shadow runs of a capability shadow traffic cannot reach", () => {
    // A webhook with evidence is covered. Counting its (necessarily zero) shadow runs against it would be
    // demanding the impossible and then calling its absence a defect.
    const gate = gateStatus({
      entries: [entry({ invocation: "webhook", coverageEvidence: "replayed fixture: webhooks.test.ts" })],
      shadowRuns: [],
    });
    expect(gate.unexercised).toEqual([]);
    expect(gate.status).toBe("complete");
  });

  it("is complete when everything is built and exercised", () => {
    const gate = gateStatus({ entries: [entry()], shadowRuns: [agreeing(["create_post_draft"])] });
    expect(gate.status).toBe("complete");
    expect(gate.problems).toEqual([]);
  });
});

describe("the removal check reads the inventory — AC-6", () => {
  const passing = {
    evaluation: { blocking: [], unmeasurable: [], verdicts: [] },
    signedOffBy: "a.person",
    dataDispositionDecided: true,
    remainingReferences: 0,
  } as unknown as Parameters<typeof canRemoveOldRuntime>[0];

  it("blocks when the inventory was never evaluated", () => {
    // The same rule as the reference scan: "I did not look" is not evidence and must not be worth the same as
    // "there is nothing there".
    const check = canRemoveOldRuntime(passing);
    expect(check.allowed).toBe(false);
    expect(check.blockers.some((b) => b.includes("capability inventory has not been evaluated"))).toBe(true);
  });

  it("blocks on an incomplete inventory, naming each problem", () => {
    const check = canRemoveOldRuntime({
      ...passing,
      inventory: gateStatus({ entries: [entry({ status: "missing", replacement: null })], shadowRuns: [] }),
    });
    expect(check.allowed).toBe(false);
    expect(check.blockers.some((b) => b.includes("draft a post"))).toBe(true);
  });

  it("allows removal when the inventory is complete and everything else is signed", () => {
    // The control: without it every test above could pass against a check that refuses unconditionally.
    const check = canRemoveOldRuntime({
      ...passing,
      inventory: gateStatus({ entries: [entry()], shadowRuns: [agreeing(["create_post_draft"])] }),
    });
    expect(check.allowed, check.blockers.join("; ")).toBe(true);
  });
});

describe("the shipped inventory", () => {
  it("is structurally valid apart from the capabilities that genuinely are not built", () => {
    const problems = validateInventory(CAPABILITY_INVENTORY);
    /**
     * One problem, and it is a true statement about the world rather than a defect in the file: the scheduled
     * publish is `partial`, so AC-5 asks for a behavioural test it cannot have — the thing being tested is a
     * cron job in another repository that nothing here replaces.
     */
    expect(problems.map((p) => p.capability)).toEqual(["the scheduled publish itself"]);
  });

  it("reports incomplete, which is the honest answer today", () => {
    const gate = gateStatus({ entries: CAPABILITY_INVENTORY, shadowRuns: [] });
    expect(gate.status).toBe("incomplete");
    // The three that are genuinely not built. Named, so this test fails when one is finished — which is the
    // point: finishing a capability should require editing the inventory in the same commit.
    const notBuilt = CAPABILITY_INVENTORY.filter((c) => c.status === "missing" || c.status === "partial");
    expect(notBuilt.map((c) => c.capability).sort()).toEqual([
      "inbound comment webhook",
      "nightly metrics refresh",
      "the scheduled publish itself",
    ]);
  });

  it("every contract test it names is a file that exists", () => {
    /**
     * The other claim that rots. `contractTest: "…/posts.test.ts"` is a string, and a renamed or deleted test
     * leaves the entry asserting a behavioural comparison that nothing performs — while `validateInventory`
     * keeps reporting the entry as complete, because the field is non-empty.
     *
     * Paths are repository-relative, so this resolves them from the workspace root rather than from here.
     */
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const missing = [...new Set(CAPABILITY_INVENTORY.map((entry) => entry.contractTest).filter(Boolean))].filter(
      (path) => !existsSync(resolve(root, path as string)),
    );
    expect(missing).toEqual([]);
  });

  it("names a behavioural contract with the approval clause in it", () => {
    // The failure mode that matters most, because a runtime asking for fewer approvals looks like an improvement.
    expect(BEHAVIOURAL_CONTRACT.some((c) => c.includes("approval"))).toBe(true);
  });
});
