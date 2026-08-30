/**
 * Parity gates and the cutover gate (#128).
 *
 * The assertions that matter here are all about **refusing**. This SPEC's job is to make the removal safe
 * when it happens, and its most important property is that it currently says no — so the tests check that
 * it says no for each of the right reasons, and that no single one of them can be forgotten.
 */
import { describe, expect, it } from "vitest";
import {
  CUTOVER_DECISION_MAKER,
  CUTOVER_RUNBOOK,
  DATA_DISPOSITION,
  OLD_RUNTIME_REFERENCE_SCOPE,
  PARITY_GATES,
  canRemoveOldRuntime,
  evaluateAgainstGate,
  evaluateParity,
  evaluateWorkflow,
  gateFor,
  measurableWorkflows,
  type ParityGate,
  type ParityReport,
} from "../../index.js";

const report = (over: Partial<ParityReport> = {}): ParityReport => ({
  workflow: "create-post",
  oldRuntime: "agno",
  newRuntime: "agentkit",
  identical: true,
  diffs: [],
  approvalBearingWrites: { old: 1, new: 1 },
  ...over,
});

const many = (n: number, over: Partial<ParityReport> = {}): ParityReport[] =>
  Array.from({ length: n }, () => report(over));

/** A gate as it would be once signed, for testing the paths a proposed gate cannot reach. */
const agreed = (gate: ParityGate): ParityGate => ({
  ...gate,
  status: "agreed",
  agreedBy: "a.person",
  agreedAt: "2026-08-01T00:00:00.000Z",
});

/**
 * The inverse, and now the one that needs injecting.
 *
 * Every shipped gate was `proposed`, so the refusal branch was reachable through `evaluateWorkflow` and the
 * *pass* branch needed `agreed()`. Since the gates were signed (2026-08-24) that is the other way round: the
 * refusal is the unreachable branch, and it is the one protecting a gate added later from passing on numbers
 * fitted to it. So it keeps its tests, through here.
 */
const proposed = (gate: ParityGate): ParityGate => {
  const { agreedBy: _by, agreedAt: _at, ...rest } = gate;
  return { ...rest, status: "proposed" };
};

/** AC-1. */
describe("the gates", () => {
  it("covers every docs/07 workflow", () => {
    expect(PARITY_GATES.map((g) => g.workflow).sort()).toEqual([
      "analytics",
      "campaign-planning",
      "create-post",
      "engagement-read",
      "engagement-reply",
      "publish",
      "repurpose",
    ]);
  });

  it("gives every gate a metric, a reason, and a sample size where one applies", () => {
    for (const gate of PARITY_GATES) {
      // The reason is the part a reviewer reads before agreeing. A threshold with no rationale is a number
      // someone has to take on trust, which is how it gets changed later without argument.
      expect(gate.rationale.length, gate.workflow).toBeGreaterThan(80);
      if (gate.metric === "unmeasurable-by-shadow") {
        expect(gate.threshold, gate.workflow).toBeUndefined();
        expect(gate.minimumSample, gate.workflow).toBeUndefined();
        // And it must say what would measure it, or "unmeasurable" is just a shrug.
        expect(gate.needsInstead, gate.workflow).toBeTruthy();
      } else {
        expect(gate.threshold, gate.workflow).toBeGreaterThan(0);
        // A threshold without a sample size is not a gate: 100% of three runs is noise.
        expect(gate.minimumSample, gate.workflow).toBeGreaterThan(0);
      }
    }
  });

  it("is entirely agreed, by a named person, with a date", () => {
    /**
     * This asserted every gate was `proposed` until 2026-08-24, when they were agreed. The assertion had not
     * become wrong so much as *expired* — it described a state, and the state legitimately changed.
     *
     * What replaces it asserts the properties that make a signature mean something: somebody is named, and there
     * is a date. The date is the load-bearing half — AC-1 is about thresholds not being fitted to results, and
     * these were signed before shadow mode had run against production traffic at all.
     */
    for (const gate of PARITY_GATES) {
      expect(gate.status, gate.workflow).toBe("agreed");
      expect(gate.agreedBy, gate.workflow).toBeTruthy();
      expect(gate.agreedAt, gate.workflow).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it("has no gate agreed without a signature or a date", () => {
    // The shape of the claim, separate from today's values: a gate cannot be `agreed` while leaving either
    // field empty, because "agreed by nobody on no date" is the state this whole mechanism exists to refuse.
    for (const gate of PARITY_GATES) {
      if (gate.status !== "agreed") continue;
      expect(gate.agreedBy?.trim(), gate.workflow).not.toBe("");
      expect(gate.agreedAt?.trim(), gate.workflow).not.toBe("");
    }
  });

  it("holds the irreversible workflows to zero tolerance", () => {
    // Not my judgement: REQ-021 already states it as "zero unauthorized or duplicate actions", so 1.0 is
    // transcribed. Both public-and-irreversible workflows inherit it.
    for (const workflow of ["publish", "engagement-reply"]) {
      const gate = gateFor(workflow);
      expect(gate?.metric, workflow).toBe("no-additional-approved-writes");
      expect(gate?.threshold, workflow).toBe(1.0);
    }
  });

  it("declares the read-only workflows unmeasurable rather than giving them a bar they always meet", () => {
    // Shadow mode compares writes, and these make none — so a write-based gate would pass vacuously on
    // every run. A green tick nobody earned is worse than no gate.
    for (const workflow of ["analytics", "engagement-read"]) {
      expect(gateFor(workflow)?.metric, workflow).toBe("unmeasurable-by-shadow");
    }
    expect(measurableWorkflows()).not.toContain("analytics");
    expect(measurableWorkflows()).toHaveLength(5);
  });
});

/** AC-2. */
describe("evaluating a workflow", () => {
  it("refuses to pass an unagreed gate, however good the data is", async () => {
    // Checked *before* the numbers, deliberately. A threshold agreed after the results are visible is
    // exactly what AC-1 forbids, and refusing to compute a pass against an unsigned one is how that is
    // enforced rather than hoped for.
    // Through `proposed()`, because the shipped gates are agreed now — so this is the branch that is no longer
    // reachable by default, and it is the one stopping a *newly added* gate from passing on fitted numbers.
    const verdict = evaluateAgainstGate(proposed(gateFor("create-post") as ParityGate), many(1_000));
    expect(verdict.verdict).toBe("gate-not-agreed");
    expect(verdict.measured).toBeUndefined();
    expect(verdict.detail).toMatch(/before results are visible/);
  });

  it("passes once the gate is agreed and the data clears the bar", () => {
    // Through `evaluateAgainstGate`, because every shipped gate is proposed by design — so this branch is
    // unreachable via `evaluateWorkflow`, and it is the branch that eventually lets a removal through. My
    // first version of this test recomputed the rate by hand and asserted arithmetic rather than the code.
    const gate = agreed(gateFor("create-post") as ParityGate);
    const verdict = evaluateAgainstGate(gate, [...many(190), ...many(10, { identical: false })]);
    expect(verdict.verdict).toBe("passed");
    expect(verdict.measured).toBeCloseTo(0.95, 5);
    expect(verdict.detail).toMatch(/95\.0% over 200 runs/);
  });

  it("fails when the data is below the bar", () => {
    const gate = agreed(gateFor("create-post") as ParityGate);
    const verdict = evaluateAgainstGate(gate, [...many(100), ...many(100, { identical: false })]);
    expect(verdict.verdict).toBe("failed");
    expect(verdict.detail).toMatch(/below the bar/);
  });

  it("fails a zero-tolerance gate on a single additional approved write", () => {
    // The one that matters most: 500 clean runs and one where the new runtime would publish more is a
    // failure, not 99.8% of a pass.
    const gate = agreed(gateFor("publish") as ParityGate);
    const verdict = evaluateAgainstGate(gate, [
      ...many(499),
      report({ approvalBearingWrites: { old: 1, new: 2 } }),
    ]);
    expect(verdict.verdict).toBe("failed");
  });

  it("reports too little data as insufficient, not as a failure", () => {
    // "Not enough to say" and "said no" are different answers. Collapsing them would either block a cutover
    // that has no evidence against it, or pass one that has none for it. My first version accepted either
    // verdict, which made it pass regardless.
    const gate = agreed(gateFor("publish") as ParityGate);
    const verdict = evaluateAgainstGate(gate, many(3));
    expect(verdict.verdict).toBe("insufficient-sample");
    expect(verdict.detail).toMatch(/3 runs, and the gate needs 500/);
    expect(verdict.measured).toBeUndefined();
  });

  it("says a proposed gate needs a signature, not more data", () => {
    // The ordering the agreed-check's position exists for, and the case my first pass did not cover: a
    // proposed gate with too few runs must say "get it signed", not "get more data". Sabotage moving the
    // check after the sample test passed all 368 without this — the safety was unchanged, but the advice
    // was wrong, and wrong advice during a cutover sends someone to collect a fortnight of data they did
    // not need.
    const verdict = evaluateAgainstGate(proposed(gateFor("publish") as ParityGate), many(3));
    expect(verdict.verdict).toBe("gate-not-agreed");
    expect(verdict.detail).not.toMatch(/the gate needs/);
  });

  it("reports an unmeasurable workflow as such, whatever data it is given", () => {
    const verdict = evaluateWorkflow("analytics", many(10_000));
    expect(verdict.verdict).toBe("not-measurable");
    expect(verdict.detail).toMatch(/Needs instead:/);
  });

  it("refuses a workflow that has no gate at all", () => {
    const verdict = evaluateWorkflow("invented-workflow", many(500));
    expect(verdict.verdict).toBe("gate-not-agreed");
    expect(verdict.detail).toMatch(/no parity gate is defined/);
  });

  it("does not let an unmeasurable workflow block the cutover on its own", () => {
    // A judgement worth naming: blocking forever on something nobody can measure is how a gate gets quietly
    // removed. It is surfaced separately so proceeding without it is a visible decision.
    const evaluation = evaluateParity({});
    expect([...evaluation.unmeasurable].sort()).toEqual(["analytics", "engagement-read"]);
    expect(evaluation.blocking).not.toContain("analytics");
  });

  it("blocks on every unpassed measurable workflow today", () => {
    const evaluation = evaluateParity({});
    expect(evaluation.allMeasurablePassed).toBe(false);
    expect([...evaluation.blocking].sort()).toEqual([
      "campaign-planning",
      "create-post",
      "engagement-reply",
      "publish",
      "repurpose",
    ]);
  });
});

/** AC-4 — the enforcement. */
/**
 * A complete inventory, so the tests below stay about the blocker each one names — #194.
 *
 * `canRemoveOldRuntime` blocks on an unevaluated inventory now, which is correct and which made every test here
 * fail with a second blocker they were not written about. Supplying a complete one keeps each test's assertion
 * exact: one blocker, the one it is testing.
 */
const completeInventory = {
  status: "complete" as const,
  problems: [] as { capability: string; problem: string }[],
  unexercised: [] as string[],
};

describe("the removal gate", () => {
  const passing = { verdicts: [], allMeasurablePassed: true, unmeasurable: [], blocking: [] };

  it("refuses today, and says every reason", () => {
    const check = canRemoveOldRuntime({ evaluation: evaluateParity({}) });
    expect(check.allowed).toBe(false);
    // Every reason, not the first: a reviewer fixing one blocker wants to know whether there are three
    // more.
    expect(check.blockers.length).toBeGreaterThan(5);
    expect(check.blockers.join("\n")).toMatch(/signed off/);
    expect(check.blockers.join("\n")).toMatch(/historical Agno conversation data/);
  });

  it("still refuses when the gates pass but nobody has signed", () => {
    const check = canRemoveOldRuntime({
      inventory: completeInventory,
      evaluation: passing,
      dataDispositionDecided: true,
      remainingReferences: 0,
    });
    expect(check.allowed).toBe(false);
    expect(check.blockers).toEqual([
      "no one has signed off the removal — AC-3 requires a named decision-maker",
    ]);
  });

  it("still refuses when signed but the data question is open", () => {
    const check = canRemoveOldRuntime({ inventory: completeInventory, evaluation: passing, signedOffBy: "a.person" });
    expect(check.allowed).toBe(false);
    expect(check.blockers.join()).toMatch(/historical Agno conversation data/);
  });

  it("treats an empty signature as no signature", () => {
    expect(
      canRemoveOldRuntime({
        inventory: completeInventory,
        evaluation: passing,
        signedOffBy: "   ",
        dataDispositionDecided: true,
        remainingReferences: 0,
      }).allowed,
    ).toBe(false);
  });

  it("refuses while an unmeasurable workflow has had no explicit decision", () => {
    const check = canRemoveOldRuntime({
      inventory: completeInventory,
      evaluation: { ...passing, unmeasurable: ["analytics"] },
      signedOffBy: "a.person",
      dataDispositionDecided: true,
      remainingReferences: 0,
    });
    // Proceeding past a workflow nobody could measure has to be a decision, not a default.
    expect(check.allowed).toBe(false);
    expect(check.blockers.join()).toMatch(/explicit decision to proceed without them/);
  });

  it("allows removal only when everything is satisfied", () => {
    const check = canRemoveOldRuntime({
      inventory: completeInventory,
      evaluation: passing,
      signedOffBy: "a.person",
      dataDispositionDecided: true,
      remainingReferences: 0,
    });
    expect(check).toEqual({ allowed: true, blockers: [] });
  });

  it("blocks again if references remain after a removal attempt", () => {
    const check = canRemoveOldRuntime({
      inventory: completeInventory,
      evaluation: passing,
      signedOffBy: "a.person",
      dataDispositionDecided: true,
      remainingReferences: 4,
    });
    expect(check.allowed).toBe(false);
    expect(check.blockers.join()).toMatch(/still reference the old runtime/);
  });

  it("does not treat an unrun scan as a clean one", () => {
    // "I did not look" is not evidence. The first version of this asserted both were allowed and called
    // them "different claims" — which sabotage showed was overclaiming, because the field's presence
    // carried no behavioural weight at all. Now an unrun scan blocks, matching #124's fail-soft search and
    // #125's unmeasured metric.
    const notRun = canRemoveOldRuntime({
      inventory: completeInventory,
      evaluation: passing,
      signedOffBy: "a.person",
      dataDispositionDecided: true,
    });
    expect(notRun.allowed).toBe(false);
    expect(notRun.blockers.join()).toMatch(/scan has not been run/);
  });
});

/** AC-5. */
describe("the removal scope", () => {
  it("records where the old runtime still is, as data rather than prose", () => {
    expect(OLD_RUNTIME_REFERENCE_SCOPE.repository).toBe("social_integgration");
    expect(OLD_RUNTIME_REFERENCE_SCOPE.terms).toEqual(["agno", "agentos"]);
    // The honest current state: the removal has not happened and must not until the gates pass.
    expect(OLD_RUNTIME_REFERENCE_SCOPE.baselineFileCount).toBe(71);
  });

  it("names the hotspots, so the removal can be sequenced rather than attempted at once", () => {
    const total = OLD_RUNTIME_REFERENCE_SCOPE.baselineHotspots.reduce((n, h) => n + h.files, 0);
    expect(OLD_RUNTIME_REFERENCE_SCOPE.baselineHotspots.length).toBeGreaterThan(3);
    expect(total).toBeLessThan(OLD_RUNTIME_REFERENCE_SCOPE.baselineFileCount);
  });

  it("points at another repository, and does not reach into it", () => {
    // A checker in this package that read a sibling directory on someone's disk is exactly the coupling R9
    // exists to prevent. This is the specification of the check; the check runs where the code is.
    expect(OLD_RUNTIME_REFERENCE_SCOPE.repository).not.toBe("packages");
    expect(OLD_RUNTIME_REFERENCE_SCOPE.roots).toEqual(["web/src", "ai_backend/app"]);
  });
});

/** AC-6. */
describe("the historical-data decision", () => {
  it("records the decision, who made it, and the words it was made in", () => {
    /**
     * Answered on 2026-08-24: **out of scope** — "We do not want the previous runs in our new systems."
     *
     * The reason is stored verbatim beside the enum on purpose. `"out-of-scope"` alone leaves a later reader
     * inferring intent, and the two readings — "we chose not to carry it" and "nobody got round to it" — imply
     * very different things about whether customers were told.
     */
    expect(DATA_DISPOSITION.decision).toBe("out-of-scope");
    expect(DATA_DISPOSITION.decidedBy).toBeTruthy();
    expect(DATA_DISPOSITION.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(DATA_DISPOSITION.reason).toMatch(/previous runs/i);
  });

  it("carries the obligations the decision creates, rather than treating it as finished", () => {
    /**
     * "Out of scope" settles what is *not* built and creates two duties that are easy to lose: telling customers
     * before their history disappears from view, and giving the old rows a retention clock.
     *
     * Asserted because a decision whose consequences are unrecorded is one that reads as complete. Deleting
     * nothing is not the same as deciding nothing needs deleting.
     */
    expect(DATA_DISPOSITION.followUps.length).toBeGreaterThanOrEqual(2);
    expect(DATA_DISPOSITION.followUps.join(" ")).toMatch(/before/i);
    expect(DATA_DISPOSITION.followUps.join(" ")).toMatch(/retention/i);
  });

  it("lays out each option with what it costs", () => {
    expect(DATA_DISPOSITION.options.map((o) => o.option)).toEqual([
      "migrate",
      "retain-read-only",
      "out-of-scope",
    ]);
    for (const option of DATA_DISPOSITION.options) {
      expect(option.consequence.length, option.option).toBeGreaterThan(100);
    }
    // The one that would go wrong quietly: telling customers after rather than before.
    expect(DATA_DISPOSITION.options[2]?.consequence).toMatch(/before\s+cutover,\s+not\s+after/);
  });
});

/** AC-3. */
describe("the cutover runbook", () => {
  it("names one decision-maker, in the constant and in the runbook", () => {
    /**
     * AC-3. It was `null` until a person said so — a blank gets filled, a plausible guess gets followed.
     *
     * Both places, because the runbook is what someone reads at 2am and the constant is what code checks. If they
     * could disagree, the one that is wrong is whichever the reader happens to look at.
     */
    expect(CUTOVER_DECISION_MAKER).toBeTruthy();
    expect(CUTOVER_RUNBOOK).toContain(CUTOVER_DECISION_MAKER!);
    expect(CUTOVER_RUNBOOK).not.toMatch(/not\s+yet\s+named/);
  });

  it("does not require a second person to roll back", () => {
    // One name, not a committee: the four roll-back triggers are ones you act on in minutes, and a rollback
    // that waits for consensus happens after the second duplicate publish.
    expect(CUTOVER_RUNBOOK).toMatch(/does not need anyone else to roll back/);
  });

  it("orders the workflows least-reversible-last", () => {
    const publishAt = CUTOVER_RUNBOOK.indexOf("**publish**");
    const analyticsAt = CUTOVER_RUNBOOK.indexOf("**analytics**");
    const draftAt = CUTOVER_RUNBOOK.indexOf("**create-post**");
    expect(analyticsAt).toBeGreaterThan(-1);
    expect(analyticsAt).toBeLessThan(draftAt);
    expect(draftAt).toBeLessThan(publishAt);
  });

  it("names the campaign trap", () => {
    // The non-obvious one: a campaign's drafts are created days before they publish, so a create-post
    // regression only becomes visible at publish time.
    expect(CUTOVER_RUNBOOK).toMatch(/only\s+becomes\s+visible\s+at\s+publish\s+time/);
  });

  it("lists the four failures that mean roll back immediately", () => {
    for (const failure of ["duplicate publish", "destination the user did not name", "forbidden claim", "wrong comment"]) {
      expect(CUTOVER_RUNBOOK, failure).toContain(failure);
    }
    // And why those four are different: rolling back cannot undo them, only stop the next one.
    expect(CUTOVER_RUNBOOK).toMatch(/cannot\s+be\s+undone\s+by\s+rolling\s+back/);
  });

  it("says to watch for a workspace still flagged shadow while believed live", () => {
    // The silent failure of the whole migration: a workspace doing nothing while everyone thinks it works.
    expect(CUTOVER_RUNBOOK).toMatch(/silently\s+doing\s+nothing/);
  });

  it("keeps the removal out of the cutover", () => {
    expect(CUTOVER_RUNBOOK).toMatch(/\*\*Not part of cutover\.\*\*/);
    expect(CUTOVER_RUNBOOK).toMatch(/deletes\s+and\s+does\s+nothing\s+else/);
  });
});
