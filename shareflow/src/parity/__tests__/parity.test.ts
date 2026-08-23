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

  it("is entirely unagreed, which is the honest current state", () => {
    // I have seen no results, so proposing is legitimate. Agreeing is a product decision about an
    // acceptable quality bar, and it is not mine to make.
    for (const gate of PARITY_GATES) {
      expect(gate.status, gate.workflow).toBe("proposed");
      expect(gate.agreedBy, gate.workflow).toBeUndefined();
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
    const verdict = evaluateWorkflow("create-post", many(1_000));
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
    const verdict = evaluateWorkflow("publish", many(3));
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
    expect(evaluation.unmeasurable.sort()).toEqual(["analytics", "engagement-read"]);
    expect(evaluation.blocking).not.toContain("analytics");
  });

  it("blocks on every unpassed measurable workflow today", () => {
    const evaluation = evaluateParity({});
    expect(evaluation.allMeasurablePassed).toBe(false);
    expect(evaluation.blocking.sort()).toEqual([
      "campaign-planning",
      "create-post",
      "engagement-reply",
      "publish",
      "repurpose",
    ]);
  });
});

/** AC-4 — the enforcement. */
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
    const check = canRemoveOldRuntime({ evaluation: passing, signedOffBy: "a.person" });
    expect(check.allowed).toBe(false);
    expect(check.blockers.join()).toMatch(/historical Agno conversation data/);
  });

  it("treats an empty signature as no signature", () => {
    expect(
      canRemoveOldRuntime({
        evaluation: passing,
        signedOffBy: "   ",
        dataDispositionDecided: true,
        remainingReferences: 0,
      }).allowed,
    ).toBe(false);
  });

  it("refuses while an unmeasurable workflow has had no explicit decision", () => {
    const check = canRemoveOldRuntime({
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
      evaluation: passing,
      signedOffBy: "a.person",
      dataDispositionDecided: true,
      remainingReferences: 0,
    });
    expect(check).toEqual({ allowed: true, blockers: [] });
  });

  it("blocks again if references remain after a removal attempt", () => {
    const check = canRemoveOldRuntime({
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
  it("is deliberately unanswered", () => {
    // What happens to a customer's conversation history is a retention and expectation decision, not an
    // implementation one. An unfilled record is visibly unfilled; a guess dressed as a decision would not
    // be.
    expect(DATA_DISPOSITION.decision).toBeNull();
    expect(DATA_DISPOSITION.decidedBy).toBeNull();
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
  it("does not name a decision-maker, and blocks because of it", () => {
    // AC-3 requires one named. I do not know who it is, and writing a plausible role in would be worse than
    // the blank: a blank gets filled, a plausible guess gets followed.
    expect(CUTOVER_DECISION_MAKER).toBeNull();
    expect(CUTOVER_RUNBOOK).toMatch(/not\s+yet\s+named/);
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
