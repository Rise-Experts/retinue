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

/**
 * `retained` is the fifth, and it was added deliberately rather than found convenient — REQ-041 AC-1 (#190).
 *
 * Six of the 51 capabilities the scan finds live in `web/`, not in `ai_backend`: five inbound webhooks and the
 * `chorus-schedule-sweep` cron job. Removing Agno does not remove them, and none of them calls the AI backend
 * — checked, not assumed. Calling them `missing` would say we failed to build a Stripe webhook; calling them
 * `dropped` would demand a signature for deleting something nobody is deleting. Both are false, and the
 * inventory would then block the cutover on work that is not part of it.
 *
 * The hazard in adding a status is that `gateStatus` branches on the value, so a new one falls through every
 * `if` and contributes **no problem** — a status that silently passes, which is the shape of defect this whole
 * REQ is about. So `statusProblem` below is an exhaustive `switch` with a `never` default: adding a sixth
 * status is a compile error until it is handled, and a test asserts every member of this list is covered.
 */
import { SHAREFLOW_TOOL_NAMES } from "../tools/index.js";
import {
  approvalParity,
  approvalParityProblems,
  manifestCapabilities,
  skillParity,
  verifyAgainstManifest,
  type OldRuntimeManifest,
} from "./manifest.js";
import { OLD_RUNTIME_MANIFEST } from "./old-runtime.js";

export const CAPABILITY_STATUSES = ["implemented", "partial", "missing", "dropped", "retained"] as const;
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
  /**
   * A reference into the old-runtime manifest: `tool:publish_now`, `route:POST /campaign`,
   * `webhook:/api/webhooks/stripe`, `cron:chorus-schedule-sweep` — REQ-041 AC-1.
   *
   * This replaced a hand-typed `oldRuntimePath` string, and the replacement is the substance of AC-1 rather
   * than a tidy-up. A prose path cannot be wrong about anything, and the first scan of the real repository
   * showed what that permits: entries for `post_writer`, `publish_guard`, `campaigns.create`, cron
   * `publish_due_posts` and `POST /webhooks/:platform/comments`, **none of which exist** — while most of what
   * does exist had no entry at all. A reference has to resolve, so a typo is a failing test, and the readable
   * `path:line` now comes from the scan instead of from a typist.
   */
  readonly oldRuntimeRef: string;
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
  /**
   * The docs/07 parity workflows whose runs reach this capability — REQ-041 AC-2.
   *
   * The link that was missing, and its absence made the `incomplete` verdict unreachable. #194 built the
   * verdict and wired it into `evaluateWorkflow`'s optional `capabilities` argument; `evaluateParity` — the
   * only thing the parity report calls — never passed one, so every workflow was evaluated against **no**
   * capabilities and could never report `incomplete`. A gate built, tested and unreachable from the script
   * whose job is to run it.
   *
   * Each name must be a real `PARITY_GATES` workflow and every gate must be named by at least one entry; both
   * directions are asserted, because either half going stale restores the hole quietly.
   *
   * `[]` is a legitimate and common value — artifacts, PDFs, branding and the agent-skill tools belong to no
   * docs/07 workflow — and it means **no gate covers this capability at all**. That is a worse position than
   * failing one, so the report prints those entries rather than letting an empty list read as "nothing to do".
   */
  readonly workflows: readonly string[];
  /**
   * What it changes outside this process — AC-1 lists side effects alongside tools and prompts, and the
   * previous shape had nowhere to put them.
   *
   * Required on **every** entry, with `"none — a read"` a legitimate value. Written rather than derived,
   * because the interesting cases are the ones a type cannot see: `check_media_storage` PUTs a diagnostic
   * object into a customer's bucket, and `reply_to_comment` writes to a customer's audience where a second
   * attempt is a second public message. An optional field would have been left unset on 51 of 51 entries and
   * would have documented an intention rather than a fact — the same reason `instructions` is required.
   */
  readonly sideEffects: string;
  /**
   * Why a `retained` capability stays where it is. Required for that status, and checked against the manifest:
   * a capability whose source is under `ai_backend/` **cannot** be retained, because that is the runtime being
   * removed. Without that guard, `retained` would be the escape hatch that empties this file of everything
   * inconvenient.
   */
  readonly retainedBecause?: string;
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
/**
 * What one entry must say, given its status — and an exhaustive `switch` so a new status cannot pass silently.
 *
 * The `default` arm assigns to `never`, which makes adding a sixth `CapabilityStatus` a compile error until it
 * is handled here. Without it a new value would fall through every branch and contribute no problem at all:
 * a status that means "we have not built this" and gates nothing.
 */
const statusProblems = (entry: CapabilityEntry): readonly string[] => {
  switch (entry.status) {
    case "dropped": {
      const problems: string[] = [];
      // Both halves, and a reason. A signature without a date cannot be reviewed later, which is exactly when
      // somebody asks who agreed to remove a customer's workflow.
      if (entry.droppedBy === undefined) problems.push("is dropped with no signature — AC-1 requires a named decision");
      else {
        if (entry.droppedBy.by.trim() === "") problems.push("is dropped with an empty name");
        if (!/^\d{4}-\d{2}-\d{2}/.test(entry.droppedBy.at)) problems.push("is dropped with no usable date");
        if (entry.droppedBy.reason.trim() === "") problems.push("is dropped with no reason");
      }
      if (entry.replacement !== null) problems.push("is dropped but names a replacement; one or the other");
      return problems;
    }
    case "missing":
      return entry.replacement === null ? [] : ["is missing but names a replacement; one or the other"];
    case "retained":
      return [
        ...(entry.replacement === null ? [] : ["is retained but names a replacement; a retained capability is not replaced, it stays"]),
        ...((entry.retainedBecause ?? "").trim() === ""
          ? ["is retained and does not say why it stays or where — AC-1. Name the runtime that keeps it"]
          : []),
      ];
    case "implemented":
    case "partial": {
      const problems: string[] = [];
      if (entry.replacement === null || entry.replacement.trim() === "") {
        problems.push(`is ${entry.status} but names no replacement`);
      }
      if ((entry.contractTest ?? "").trim() === "") {
        problems.push("has a replacement and no behavioural test against the old contract — AC-5");
      }
      /**
       * Instructions, for anything with a replacement — AC-5.
       *
       * The AC is "prompts and instructions are accounted for", and an unset optional field accounts for
       * nothing. `none` is allowed and has to be *written*, because the difference between "deterministic
       * tool, no prose" and "nobody checked" is the whole point of the column.
       */
      if ((entry.instructions ?? "").trim() === "") {
        problems.push(
          "has a replacement and does not say which instruction set it runs under — AC-5. Name the skill, or " +
            'write "none — …" with the reason',
        );
      }
      return problems;
    }
    default: {
      // Unreachable while the switch is exhaustive, and a compile error the moment it is not.
      const unhandled: never = entry.status;
      return [`has status ${String(unhandled)}, which no rule in validateInventory covers`];
    }
  }
};

/**
 * Is the inventory usable as a precondition?
 *
 * Structural checks, plus the ones that need the old runtime — because the file alone cannot tell whether it
 * describes anything real, and that turned out to be the defect rather than a hypothetical. The *counted* half
 * (`shadowRuns`) still cannot come from here: `coverageOf` does that, from the shadow data.
 *
 * The manifest is a **parameter with a committed default**, not an option. Making it optional would recreate
 * the hole one level up: a caller that omitted it would get a clean report for an inventory nothing had
 * checked, which is the "did not look equals clean" this module exists to refuse.
 */
export const validateInventory = (
  entries: readonly CapabilityEntry[],
  manifest: OldRuntimeManifest = OLD_RUNTIME_MANIFEST,
): readonly InventoryProblem[] => {
  const problems: InventoryProblem[] = [];
  const seen = new Set<string>();
  const capabilities = manifestCapabilities(manifest);
  const toolNames = new Set(SHAREFLOW_TOOL_NAMES);

  for (const entry of entries) {
    const at = (problem: string) => problems.push({ capability: entry.capability, problem });

    if (seen.has(entry.capability)) at("appears twice; one capability, one entry");
    seen.add(entry.capability);

    for (const problem of statusProblems(entry)) at(problem);

    if (entry.sideEffects.trim() === "") {
      at('does not say what it changes outside this process — AC-1. Write "none — a read" if that is the answer');
    }

    /**
     * Nobody shadows 03:00. A scheduled capability with no evidence is not covered, and its shadow count will
     * be zero forever — so treating the zero as the answer would report it as uncovered rather than as
     * un-evidenced, and those need different actions.
     *
     * **Not asked of a `dropped` entry**, and the exemption is the point rather than a convenience: a dropped
     * capability has nothing to evidence, and demanding coverage for one would force a sentence that is not
     * true. Two of the eight signed drops are `triggered` routes, and the text they carried
     * ("the cutover runbook has to carry it") became false the moment somebody signed them off — a stale
     * reassurance is worse than a blank. The decision is recorded in `droppedBy`, which is required instead.
     */
    if (
      entry.status !== "dropped" &&
      entry.invocation !== "interactive" &&
      (entry.coverageEvidence ?? "").trim() === ""
    ) {
      at(`is ${entry.invocation} and shadow traffic cannot reach it — AC-7 requires its own coverage evidence`);
    }

    const capability = capabilities.get(entry.oldRuntimeRef);

    /**
     * A `replacement` on a tool entry has to be a tool the new runtime actually serves.
     *
     * The recurring defect in this package is a name that typechecks and resolves to nothing, and
     * `replacement` was the last free-text field where one could hide: an entry naming `get_branding` as
     * implemented would have read as covered forever, because nothing looked the name up. Checked only for
     * `tool:` refs — a route or a webhook is replaced by a subsystem, not by a tool, and requiring a tool name
     * there would force a false one.
     */
    if (
      capability?.kind === "tool" &&
      entry.replacement !== null &&
      !toolNames.has(entry.replacement)
    ) {
      at(
        `names "${entry.replacement}" as its replacement and the new runtime serves no tool by that name — ` +
          "a replacement nothing resolves reads as covered and is not",
      );
    }

    /**
     * `retained` is only available to capabilities that are not in the runtime being removed.
     *
     * Without this, `retained` is the escape hatch: anything inconvenient becomes "it stays where it is" and
     * the inventory empties. A capability under `ai_backend/` is in the Agno service, which the cutover
     * deletes, so it has to be replaced or signed off — it cannot stay.
     */
    if (entry.status === "retained" && capability !== undefined && capability.source.startsWith("ai_backend/")) {
      at(
        `is marked retained and lives at ${capability.source}, inside the runtime the cutover removes — ` +
          "a capability there cannot stay; replace it or have someone sign a drop",
      );
    }
  }

  return problems;
};

/**
 * Everything the inventory has to satisfy, including the two directions only the old runtime can decide.
 *
 * Separate from `validateInventory` because it composes rather than checks: the entry-shape rules above are
 * per-entry, while `verifyAgainstManifest` compares *sets* (which capability has no entry) and `skillParity`
 * and `approvalParity` compare the two runtimes. Kept in one function so no caller can run the cheap half and
 * report a clean inventory.
 */
export const inventoryProblems = (input: {
  readonly entries: readonly CapabilityEntry[];
  readonly manifest?: OldRuntimeManifest;
  /** The new runtime's built tools, for the approval comparison. Omitted skips only that check. */
  readonly descriptors?: readonly { readonly name: string; readonly approvalPolicy: string }[];
}): readonly InventoryProblem[] => {
  const manifest = input.manifest ?? OLD_RUNTIME_MANIFEST;
  const problems = [...validateInventory(input.entries, manifest)];

  for (const problem of verifyAgainstManifest({ entries: input.entries, manifest })) {
    problems.push({ capability: problem.ref, problem: problem.problem });
  }
  for (const problem of skillParity(manifest)) {
    problems.push({ capability: problem.ref, problem: problem.problem });
  }
  if (input.descriptors !== undefined) {
    const parity = approvalParity({ entries: input.entries, manifest, descriptors: input.descriptors });
    for (const problem of approvalParityProblems(parity)) {
      problems.push({ capability: problem.ref, problem: problem.problem });
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
  readonly manifest?: OldRuntimeManifest;
  readonly descriptors?: readonly { readonly name: string; readonly approvalPolicy: string }[];
}): InventoryGate => {
  const problems = [
    ...inventoryProblems({
      entries: input.entries,
      ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
      ...(input.descriptors === undefined ? {} : { descriptors: input.descriptors }),
    }),
  ];
  const coverage = coverageOf(input);

  /**
   * Which statuses block, decided by an exhaustive `switch` rather than a pair of `if`s.
   *
   * The `if (status === "missing")` / `if (status === "partial")` pair this replaced is what made adding a
   * status dangerous: `retained` would have matched neither and contributed nothing, so six capabilities would
   * have gone from blocking to invisible with no test failing. Here a sixth status is a compile error.
   */
  for (const entry of input.entries) {
    switch (entry.status) {
      case "missing":
        problems.push({
          capability: entry.capability,
          problem:
            "is missing — a capability the new runtime does not implement writes nothing, which the parity gate cannot tell from perfect agreement",
        });
        break;
      case "partial":
        problems.push({
          capability: entry.capability,
          problem: "is partial — the unimplemented half writes nothing and is invisible to a write-set comparison",
        });
        break;
      case "retained":
      case "dropped":
      case "implemented":
        // None of these blocks: a retained capability is not part of the cutover, a dropped one carries a
        // signature, and an implemented one is judged on its shadow coverage below rather than on its status.
        break;
      default: {
        const unhandled: never = entry.status;
        problems.push({
          capability: entry.capability,
          problem: `has status ${String(unhandled)}, which the gate has no rule for — refusing rather than passing it`,
        });
      }
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

/** How the inventory breaks down by status, for a report that has to say more than pass or fail. */
export const inventoryTally = (
  entries: readonly CapabilityEntry[],
): Readonly<Record<CapabilityStatus, number>> => {
  const tally = Object.fromEntries(CAPABILITY_STATUSES.map((status) => [status, 0])) as Record<
    CapabilityStatus,
    number
  >;
  for (const entry of entries) tally[entry.status] += 1;
  return tally;
};

export * from "./manifest.js";
export { OLD_RUNTIME_MANIFEST } from "./old-runtime.js";
export { CAPABILITY_INVENTORY } from "./capabilities.js";
