/**
 * The capability inventory — #194.
 *
 * #128's parity gate has a hole, and it is the kind that reads as success. The gate compares **write sets**
 * between the two runtimes: for each shadow run, what the old runtime wrote against what the new one would have.
 * A capability the new runtime does not implement produces **no writes at all** — which is indistinguishable from
 * agreeing perfectly. A missing feature reads as a passing gate.
 *
 * So coverage becomes a *precondition* of comparison rather than a conclusion from it. Three properties do that,
 * and each of them is the same principle in a different place: **"did not look" must never equal "clean".**
 *
 * 1. **`missing` blocks, with its own verdict.** `incomplete` is distinct from `passed` and from `failed`,
 *    because "we did not build it" is a different fact from "it diverged" and collapsing them loses the one
 *    piece of information a reviewer needs.
 * 2. **`dropped` needs a name and a date.** A capability removed silently is a customer's workflow removed
 *    silently. The signature is data, not a comment, so it cannot be omitted.
 * 3. **`shadowRuns` is counted, never supplied.** Derived from the shadow data by matching tool calls, so a
 *    capability nobody exercised cannot be reported as covered by whoever wrote the entry.
 *
 * ## What is in scope and usually forgotten
 *
 * A tool-for-tool match with different *instructions* is a different product, so the instruction set is part of
 * an entry. And nobody shadows 03:00: scheduled, triggered and webhook paths never appear in normal traffic, so
 * they carry their own coverage kind rather than borrowing the shadow count they will never earn.
 */

export const CAPABILITY_STATUSES = ["implemented", "partial", "missing", "dropped"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/**
 * How a capability is reached, because it decides how coverage can be evidenced.
 *
 * `interactive` capabilities appear in shadow traffic. The other three do not — a schedule fires at 03:00, a
 * webhook arrives when a third party decides, and a trigger fires on a state change nobody replays — so counting
 * shadow runs for them would count zero forever and read as "never covered" rather than "covered differently".
 */
export const INVOCATION_KINDS = ["interactive", "scheduled", "triggered", "webhook"] as const;
export type InvocationKind = (typeof INVOCATION_KINDS)[number];

/** Who agreed to drop a capability, and when. Required for `dropped`, and useless without both halves. */
export type DropSignature = {
  readonly by: string;
  /** ISO date. A decision without a date cannot be reviewed later, which is when it matters. */
  readonly at: string;
  readonly reason: string;
};

export type CapabilityEntry = {
  /** The old runtime's name for it — a tool id, an endpoint, a job name. */
  readonly capability: string;
  /** Where it lives in the old runtime, so a reviewer can read the thing being replaced. */
  readonly oldRuntimePath: string;
  /** The new tool id, or `null` when `status` is `missing` or `dropped`. */
  readonly replacement: string | null;
  readonly status: CapabilityStatus;
  readonly invocation: InvocationKind;
  /** Required when `status` is `dropped`. */
  readonly droppedBy?: DropSignature;
  /**
   * The instruction set the replacement runs under — REQ-041 AC-5.
   *
   * Part of the inventory because a tool-for-tool match with different instructions is a different product, and
   * that difference produces *identical write sets* on the runs where the instructions did not happen to matter.
   *
   * **Required for every entry that has a replacement**, and `"none — …"` is a legitimate value with a reason
   * after it. Optional-and-usually-absent is what this field was, and it said nothing: 26 of 27 entries left it
   * unset, which is indistinguishable between "this tool is deterministic and carries no prose" and "nobody
   * looked". A sentinel that has to be typed out cannot be reached by omission.
   */
  readonly instructions?: string;
  /**
   * How coverage is evidenced for a capability shadow traffic cannot reach.
   *
   * Required for every non-`interactive` entry, and deliberately a free-text pointer rather than a boolean: the
   * evidence is a test name, a replayed webhook fixture, a manual run with a date — and a boolean would let
   * someone tick it.
   */
  readonly coverageEvidence?: string;
  /** A behavioural test against the *old* tool's observable contract. See `BEHAVIOURAL_CONTRACT`. */
  readonly contractTest?: string;
};

/**
 * What a replacement's behavioural test has to cover, as a list rather than prose.
 *
 * "The tool exists" is not "the tool matches". Each of these is a way two tools can agree on the happy path and
 * differ where it counts, and the last one is why the list is not advisory: a new runtime that asks for *fewer*
 * approvals looks like an improvement in every metric anyone plots.
 */
export const BEHAVIOURAL_CONTRACT = [
  "the same inputs are refused, with a comparable reason",
  "the same shape is written for accepted inputs",
  "the same side effects, in the same order",
  "the same idempotency behaviour on retry",
  "approval-bearing operations still require approval",
] as const;

export type InventoryProblem = {
  readonly capability: string;
  readonly problem: string;
};

/**
 * Is the inventory usable as a precondition?
 *
 * Structural checks only — that an entry says what it must — because the *counted* half (`shadowRuns`) cannot
 * come from the file. `coverageOf` does that, from the shadow data.
 */
export const validateInventory = (entries: readonly CapabilityEntry[]): readonly InventoryProblem[] => {
  const problems: InventoryProblem[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const at = (problem: string) => problems.push({ capability: entry.capability, problem });

    if (seen.has(entry.capability)) at("appears twice; one capability, one entry");
    seen.add(entry.capability);

    if (entry.status === "dropped") {
      // Both halves, and a reason. A signature without a date cannot be reviewed later, which is exactly when
      // somebody asks who agreed to remove a customer's workflow.
      if (entry.droppedBy === undefined) at("is dropped with no signature — AC-1 requires a named decision");
      else {
        if (entry.droppedBy.by.trim() === "") at("is dropped with an empty name");
        if (!/^\d{4}-\d{2}-\d{2}/.test(entry.droppedBy.at)) at("is dropped with no usable date");
        if (entry.droppedBy.reason.trim() === "") at("is dropped with no reason");
      }
      if (entry.replacement !== null) at("is dropped but names a replacement; one or the other");
    } else if (entry.status === "missing") {
      if (entry.replacement !== null) at("is missing but names a replacement; one or the other");
    } else if (entry.replacement === null || entry.replacement.trim() === "") {
      at(`is ${entry.status} but names no replacement`);
    }

    if (entry.invocation !== "interactive" && (entry.coverageEvidence ?? "").trim() === "") {
      // Nobody shadows 03:00. A scheduled capability with no evidence is not covered, and its shadow count will
      // be zero forever — so treating the zero as the answer would report it as uncovered rather than as
      // un-evidenced, and those need different actions.
      at(`is ${entry.invocation} and shadow traffic cannot reach it — AC-7 requires its own coverage evidence`);
    }

    if ((entry.status === "implemented" || entry.status === "partial") && (entry.contractTest ?? "").trim() === "") {
      at("has a replacement and no behavioural test against the old contract — AC-5");
    }

    /**
     * Instructions, for anything with a replacement — AC-5.
     *
     * The AC is "prompts and instructions are accounted for", and an unset optional field accounts for nothing.
     * `none` is allowed and has to be *written*, because the difference between "deterministic tool, no prose"
     * and "nobody checked" is the whole point of the column.
     */
    if (
      (entry.status === "implemented" || entry.status === "partial") &&
      (entry.instructions ?? "").trim() === ""
    ) {
      at(
        "has a replacement and does not say which instruction set it runs under — AC-5. Name the skill, or " +
          'write "none — …" with the reason',
      );
    }
  }

  return problems;
};

export type CapabilityCoverage = {
  readonly capability: string;
  readonly status: CapabilityStatus;
  /** Counted from the shadow data. Never supplied by a caller — AC-3. */
  readonly shadowRuns: number;
  readonly invocation: InvocationKind;
  readonly coverageEvidence?: string;
};

/**
 * How many shadow runs actually exercised each capability — AC-3.
 *
 * Counted by matching tool calls in the shadow data against each entry's `replacement`, and *not* accepted as an
 * argument. The distinction is the whole control: an entry's author is the person most likely to believe their
 * capability is covered, and a number they can write is a number that says what they expect.
 *
 * A capability that shadow traffic cannot reach reports `0` and is *not* thereby uncovered — `validateInventory`
 * requires its evidence separately, and `gateStatus` reads both.
 */
export const coverageOf = (input: {
  readonly entries: readonly CapabilityEntry[];
  /** One entry per shadow run: which tools the run called. */
  readonly shadowRuns: readonly { readonly toolsCalled: readonly string[] }[];
}): readonly CapabilityCoverage[] =>
  input.entries.map((entry) => ({
    capability: entry.capability,
    status: entry.status,
    invocation: entry.invocation,
    ...(entry.coverageEvidence === undefined ? {} : { coverageEvidence: entry.coverageEvidence }),
    shadowRuns:
      entry.replacement === null
        ? 0
        : input.shadowRuns.filter((run) => run.toolsCalled.includes(entry.replacement as string)).length,
  }));

export type InventoryGate = {
  /**
   * `incomplete` is its own answer — AC-2.
   *
   * Distinct from `passed` and from `blocked`, because "we did not build it" and "it diverged" call for
   * different work by different people, and a single failure state loses which one it is.
   */
  readonly status: "complete" | "incomplete";
  readonly problems: readonly InventoryProblem[];
  /** Capabilities that are implemented, reachable by shadow traffic, and exercised by none of it — AC-4. */
  readonly unexercised: readonly string[];
};

export const gateStatus = (input: {
  readonly entries: readonly CapabilityEntry[];
  readonly shadowRuns: readonly { readonly toolsCalled: readonly string[] }[];
}): InventoryGate => {
  const problems = [...validateInventory(input.entries)];
  const coverage = coverageOf(input);

  for (const entry of input.entries) {
    if (entry.status === "missing") {
      problems.push({
        capability: entry.capability,
        problem: "is missing — a capability the new runtime does not implement writes nothing, which the parity gate cannot tell from perfect agreement",
      });
    }
    if (entry.status === "partial") {
      problems.push({
        capability: entry.capability,
        problem: "is partial — the unimplemented half writes nothing and is invisible to a write-set comparison",
      });
    }
  }

  /**
   * AC-4. Zero shadow runs cannot contribute to a passing gate.
   *
   * Only for `interactive` capabilities: the others are covered by evidence rather than traffic, and requiring
   * shadow runs of a webhook would be requiring something impossible and then treating its absence as a defect.
   */
  const unexercised = coverage
    .filter((c) => c.invocation === "interactive" && c.status === "implemented" && c.shadowRuns === 0)
    .map((c) => c.capability);
  for (const capability of unexercised) {
    problems.push({
      capability,
      problem: "is implemented and no shadow run exercised it — an untested replacement contributes nothing to parity",
    });
  }

  return { status: problems.length === 0 ? "complete" : "incomplete", problems, unexercised };
};

export { CAPABILITY_INVENTORY } from "./capabilities.js";
