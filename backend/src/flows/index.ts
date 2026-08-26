/**
 * Flows and teams — REQ-038 (#187) and REQ-037 (#186).
 *
 * Designed as one thing because both issues say so, and they are right: a flow's step and a team's member turn
 * are the same idea, and modelling them separately produces two overlapping notions of "a step" that then have to
 * be kept in agreement forever. So **a team is a kind of step**, and a team's members execute steps.
 *
 * ## The one design decision everything else follows from
 *
 * **The interpreter is a pure function.** `advance(definition, execution, outcome)` returns the next execution
 * state and *one effect to perform* — it performs nothing itself. Every property these two REQs ask for falls out
 * of that rather than being arranged separately:
 *
 * - **Durability** is persisting the returned state. There is no in-flight interpreter state to lose, because
 *   there is no interpreter instance.
 * - **Resume after a restart** is loading the state and asking for the effect again. A host does not have to
 *   reconstruct where it was; the state *is* where it was.
 * - **Idempotency across a resume** works because the effect carries a key derived from the execution and step,
 *   not from a counter in memory. A step that wrote externally and then crashed produces the same key on resume,
 *   and the idempotency store answers with the stored result.
 * - **Testing** is exhaustive without mocks: feeding outcomes to a function and asserting the next state needs no
 *   agent, no database and no clock.
 *
 * The alternative — an async interpreter that awaits its own effects — is shorter to write and cannot be made
 * durable without a checkpoint after every await, which is the same state machine with the states implicit.
 *
 * ## A definition and an execution are different things
 *
 * `FlowExecution.flowVersion` is pinned when the execution starts, and the definition is read at that version
 * forever. Editing a flow does not change one already running. Conflating them is how a running automation
 * silently changes shape halfway through — the person who edited step 4 has no idea an execution is sitting at
 * step 3.
 */

import type { AgentId, ConversationId, PrincipalId, RunId, TenantId } from "../core/ids.js";

// ---------------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------------

/**
 * What a flow or a team may spend before it is stopped.
 *
 * Three dimensions because they fail differently, and a ceiling on one says nothing about the others. Steps bound
 * a loop that makes no progress. Cost bounds a loop that makes expensive progress. Wall-clock bounds a step that
 * hangs, which neither of the others catches — a flow waiting on a webhook consumes no steps and no money.
 */
export type FlowBudget = {
  readonly maxSteps: number;
  readonly maxCostMinorUnits?: number;
  readonly maxWallClockMs?: number;
};

/** Spent so far. Compared against the budget before every step, never after. */
export type FlowSpend = {
  readonly steps: number;
  readonly costMinorUnits: number;
  readonly startedAtMs: number;
};

// ---------------------------------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------------------------------

/**
 * What happens when a step fails — chosen in the definition, not by whichever error surfaced.
 *
 * `escalate` is the one worth explaining: it hands the failure to the enclosing scope rather than deciding here. A
 * team member escalates to its manager; a flow step escalates to its parent flow. Without it, "retry or die" is
 * the whole vocabulary, and a manager-led team cannot react to a member failing, which is most of the point of
 * having a manager.
 */
export const FAILURE_ACTIONS = ["retry", "skip", "escalate", "fail"] as const;
export type FailureAction = (typeof FAILURE_ACTIONS)[number];

export type FailurePolicy = {
  readonly action: FailureAction;
  /** Only meaningful for `retry`. Bounded, because an unbounded retry is a loop with a good excuse. */
  readonly maxAttempts?: number;
  /** Milliseconds before the first retry; doubles each attempt. */
  readonly backoffMs?: number;
};

export const DEFAULT_FAILURE_POLICY: FailurePolicy = { action: "fail" };

// ---------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------

/**
 * A reference into the execution's state, for a step's input and a branch's condition.
 *
 * A path, not an expression. `"$.order.total"` reads a value; there is no arithmetic, no comparison operators and
 * no function calls, because an expression language in a stored definition is an interpreter that runs whatever a
 * definition author typed — and the definitions will eventually be authored in a UI by someone who is not an
 * engineer (REQ-042). Comparison lives in the *branch*, which has a closed set of operators.
 */
export type StatePath = string;

export const BRANCH_OPERATORS = ["equals", "not-equals", "exists", "absent", "greater-than", "less-than", "contains"] as const;
export type BranchOperator = (typeof BRANCH_OPERATORS)[number];

export type BranchCase = {
  readonly path: StatePath;
  readonly operator: BranchOperator;
  /** Absent for `exists` and `absent`, which are about presence rather than value. */
  readonly value?: string | number | boolean;
  readonly next: string;
};

export const STEP_KINDS = ["agent", "team", "tool", "branch", "wait", "checkpoint", "subflow", "done"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

type StepBase = {
  readonly name: string;
  readonly onFailure?: FailurePolicy;
  /**
   * Where the step's result is written in the execution state.
   *
   * Absent means the result is discarded, which is a real choice: a step whose output nothing reads should say so,
   * rather than accumulating state a later reader has to guess the relevance of.
   */
  readonly assignTo?: string;
};

export type FlowStep =
  | (StepBase & {
      readonly kind: "agent";
      readonly agentId: AgentId;
      /** Appended to the agent's own instructions for this step only. */
      readonly instructions?: string;
      /** What the agent is asked, with `{{path}}` interpolated from state. */
      readonly prompt: string;
      readonly next?: string;
    })
  | (StepBase & { readonly kind: "team"; readonly teamId: string; readonly prompt: string; readonly next?: string })
  | (StepBase & {
      readonly kind: "tool";
      readonly tool: string;
      /** Literal values, or `{{path}}` references resolved from state. */
      readonly input: Readonly<Record<string, unknown>>;
      readonly next?: string;
    })
  | (StepBase & { readonly kind: "branch"; readonly cases: readonly BranchCase[]; readonly otherwise?: string })
  | (StepBase & {
      readonly kind: "wait";
      /** A duration, or a named signal something outside the flow delivers. */
      readonly forMs?: number;
      readonly forSignal?: string;
      readonly next?: string;
    })
  | (StepBase & {
      readonly kind: "checkpoint";
      /** Asked through the existing HITL path, so a parked flow is the object the assistant surface already answers. */
      readonly question: string;
      readonly options?: readonly string[];
      readonly next?: string;
    })
  | (StepBase & { readonly kind: "subflow"; readonly flowId: string; readonly next?: string })
  | (StepBase & { readonly kind: "done"; readonly outcome?: string });

// ---------------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------------

export type FlowDefinition = {
  readonly id: string;
  /** Immutable per version. An execution pins one and reads it forever — see the module comment. */
  readonly version: number;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly FlowStep[];
  readonly start: string;
  readonly budget: FlowBudget;
  /**
   * How deep a subflow or a team may nest.
   *
   * Enforced rather than documented, and it is what makes A → B → A terminate: each level carries its depth, and
   * a step that would exceed the bound fails the flow with a message naming the chain. A cycle detector over the
   * definition graph would not be enough, because a subflow reference is resolved at run time and the graph is
   * only known then.
   */
  readonly maxDepth?: number;
};

export const DEFAULT_MAX_DEPTH = 5;

/** One member of a team. Its own instructions, its own tools, its own limits. */
export type TeamMember = {
  readonly name: string;
  readonly agentId: AgentId;
  readonly instructions?: string;
  /**
   * Tool names this member may use, narrowing the team's own set.
   *
   * A narrowing, never a widening: the delegation tool intersects this with what the delegating context could
   * reach, so a member cannot be granted something the team was not. #186 AC-3 — "a delegated agent cannot reach
   * a tool the delegating one could not" — is that intersection, and it is enforced where the tool set is built
   * rather than checked afterwards.
   */
  readonly tools?: readonly string[];
  readonly maxSteps?: number;
};

export const TEAM_PROCESSES = ["sequential", "manager-led"] as const;
export type TeamProcess = (typeof TEAM_PROCESSES)[number];

export type TeamDefinition = {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  /**
   * Sequential or manager-led, as a **property** rather than two code paths — #186 AC-2.
   *
   * The interpreter branches on this in one place: which member runs next. Everything else — budgets, delegation,
   * failure handling, attribution — is identical, which is the point. Two code paths would mean two places for
   * every later property to be added, and one of them would eventually not get it.
   */
  readonly process: TeamProcess;
  readonly members: readonly TeamMember[];
  /** Required when `process` is `manager-led`, and refused otherwise: a sequential team with a manager is ambiguous. */
  readonly manager?: string;
  readonly budget: FlowBudget;
  readonly maxDelegationDepth?: number;
};

// ---------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------

export const FLOW_STATUSES = [
  "running",
  /** Parked on a `checkpoint` or a `wait` for a signal. Not failed, and not finished. */
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export type StepRecord = {
  readonly step: string;
  readonly kind: StepKind;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome: "ok" | "failed" | "skipped" | "waiting";
  readonly attempt: number;
  /** Which team member ran it, when a team step did — #186 AC-9, so "which agent costs the money" is answerable. */
  readonly member?: string;
  readonly costMinorUnits?: number;
  readonly error?: string;
};

export type FlowExecution = {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly flowId: string;
  /** Pinned at start. The definition is read at this version for the execution's whole life. */
  readonly flowVersion: number;
  /** The platform run this execution is, so quotas, usage and events apply as they do to any run. */
  readonly runId: RunId;
  readonly principalId: PrincipalId;
  readonly conversationId?: ConversationId;
  readonly status: FlowStatus;
  /** The step about to run, or the one being waited on. `null` once terminal. */
  readonly currentStep: string | null;
  /**
   * State between steps, durable, and **readable by a person** — #187 AC-3.
   *
   * A flat JSON object rather than an opaque blob, because "what state is this flow in" is a question someone
   * asks while it is stuck, and an answer they cannot read is not an answer.
   */
  readonly state: Readonly<Record<string, unknown>>;
  readonly spend: FlowSpend;
  readonly history: readonly StepRecord[];
  /** Attempts for the current step, so a retry policy survives a restart. */
  readonly attempt: number;
  readonly depth: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** Why it stopped, when it stopped for a reason worth reading. */
  readonly detail?: string;
  /** Set while `waiting`: the interaction a checkpoint is parked on, or the signal a wait needs. */
  readonly waitingFor?: { readonly kind: "human"; readonly interactionId: string } | { readonly kind: "signal"; readonly signal: string } | { readonly kind: "time"; readonly untilMs: number };
};
