/**
 * The flow interpreter — REQ-038 (#187), REQ-037 (#186).
 *
 * A pure function. `advance` takes a definition, an execution and the outcome of whatever was asked for last, and
 * returns the next execution plus **one effect** for the caller to perform. It performs nothing itself: no agent
 * call, no tool call, no clock read, no store write.
 *
 * That is not stylistic. Everything both REQs ask for is a consequence:
 *
 * - **Durable resume** — the returned execution *is* the position. A host persists it and, after a restart, calls
 *   `advance` with the same execution and gets the same effect. There is no interpreter instance to rebuild.
 * - **Idempotency across a resume** — the effect's key is derived from `(executionId, step, attempt)`, so the
 *   same step asked for twice produces the same key and the idempotency store answers with the first result.
 *   #187 AC-9 is that derivation, not a rule anyone has to remember.
 * - **Budgets** — checked before the effect is produced, so an over-budget flow performs nothing at all rather
 *   than spending and then noticing.
 * - **Tests** — feeding outcomes to a function and asserting the next state needs no agent, no database, no clock.
 *
 * The clock is an argument for the same reason: a pure function that reads `Date.now()` is not pure, and a wall
 * clock ceiling that cannot be tested without waiting is a ceiling nobody tests.
 */

import { AgentPlatformError } from "../core/errors.js";
import { DEFAULT_FAILURE_POLICY, DEFAULT_MAX_DEPTH } from "./index.js";
import type {
  BranchCase,
  FailurePolicy,
  FlowDefinition,
  FlowExecution,
  FlowStep,
  StepRecord,
} from "./index.js";

// ---------------------------------------------------------------------------------------------------
// Effects — what the caller is asked to do
// ---------------------------------------------------------------------------------------------------

/**
 * One unit of work the host performs and reports back.
 *
 * Data, not a callback. A callback would put the host's control flow inside the interpreter's, which is exactly
 * what makes a host-written workflow undurable in the first place — the thing this module exists to replace.
 */
export type FlowEffect =
  | {
      readonly kind: "run-agent";
      readonly agentId: string;
      readonly prompt: string;
      readonly instructions?: string;
      readonly idempotencyKey: string;
      /**
       * What the flow has left to spend — #202 AC-3.
       *
       * Handed over rather than left for the handler to work out, and re-derived on every step because the
       * remainder changes. A child run given its own independent ceiling is a member that can outspend the team,
       * which is #186 AC-4 defeated by the composition that was supposed to honour it.
       */
      readonly budgetRemaining: { readonly steps: number; readonly costMinorUnits?: number; readonly wallClockMs?: number };
      /** Which team member this step is, so the child run and its usage carry the attribution. */
      readonly member?: string;
    }
  | { readonly kind: "run-team"; readonly teamId: string; readonly prompt: string; readonly idempotencyKey: string }
  | { readonly kind: "call-tool"; readonly tool: string; readonly input: Readonly<Record<string, unknown>>; readonly idempotencyKey: string }
  | { readonly kind: "ask-human"; readonly question: string; readonly options?: readonly string[] }
  | { readonly kind: "sleep"; readonly untilMs: number }
  | { readonly kind: "await-signal"; readonly signal: string }
  | { readonly kind: "run-subflow"; readonly flowId: string; readonly depth: number; readonly idempotencyKey: string }
  /** Nothing more to do. `status` says why. */
  | { readonly kind: "settled" };

/** What the host reports back. `advance` is called again with it. */
export type StepOutcome =
  | { readonly kind: "ok"; readonly value?: unknown; readonly costMinorUnits?: number }
  | { readonly kind: "failed"; readonly error: string; readonly costMinorUnits?: number }
  /** A checkpoint was raised and is now parked. Carries what to resume on. */
  | { readonly kind: "parked"; readonly interactionId: string }
  /**
   * An agent step became a child run, which is now queued — #202.
   *
   * Distinct from `parked` because what resumes it is different: a person answers a `parked` step, and a *run*
   * finishing resumes this one. Collapsing them would mean the runner could not tell which of the two it was
   * waiting for, and the poll-on-resume path needs to know there is a run to look at.
   */
  | { readonly kind: "parked-on-run"; readonly runId: string; readonly member?: string }
  /** A human answered, or a signal arrived. */
  | { readonly kind: "resumed"; readonly value?: unknown };

export type AdvanceInput = {
  readonly definition: FlowDefinition;
  readonly execution: FlowExecution;
  /** Absent on the first call, and on a call that only wants the current effect back (a resume after a restart). */
  readonly outcome?: StepOutcome;
  readonly nowMs: number;
  readonly nowIso: string;
};

export type AdvanceResult = {
  readonly execution: FlowExecution;
  readonly effect: FlowEffect;
};

// ---------------------------------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------------------------------

/**
 * Read a `$.a.b` path out of the state.
 *
 * A path walk, not an expression evaluator. The definitions will eventually be authored in a UI by someone who is
 * not an engineer (REQ-042), and an expression language in stored data is an interpreter for whatever they typed.
 */
export const readPath = (state: Readonly<Record<string, unknown>>, path: string): unknown => {
  const segments = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current: unknown = state;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

/** Substitute `{{$.a.b}}` in a string from state. Absent paths become empty, never the literal `{{…}}`. */
export const interpolate = (template: string, state: Readonly<Record<string, unknown>>): string =>
  template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const value = readPath(state, path.trim());
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });

/** Resolve `{{…}}` inside a tool's input, at any depth. */
const resolveInput = (input: unknown, state: Readonly<Record<string, unknown>>): unknown => {
  if (typeof input === "string") {
    // A whole-value reference returns the *value*, not its JSON text: `{"id": "{{$.order.id}}"}` on a number
    // should send a number, and stringifying it silently changes the tool's input type.
    const whole = /^\{\{([^}]+)\}\}$/.exec(input.trim());
    if (whole !== null) return readPath(state, whole[1]!.trim());
    return interpolate(input, state);
  }
  if (Array.isArray(input)) return input.map((item) => resolveInput(item, state));
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, resolveInput(v, state)]));
  }
  return input;
};

const matches = (state: Readonly<Record<string, unknown>>, branchCase: BranchCase): boolean => {
  const actual = readPath(state, branchCase.path);
  switch (branchCase.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "absent":
      return actual === undefined || actual === null;
    case "equals":
      return actual === branchCase.value;
    case "not-equals":
      return actual !== branchCase.value;
    case "greater-than":
      return typeof actual === "number" && typeof branchCase.value === "number" && actual > branchCase.value;
    case "less-than":
      return typeof actual === "number" && typeof branchCase.value === "number" && actual < branchCase.value;
    case "contains":
      // Strings and arrays, because both are things a person means by "contains" and refusing one would be a
      // definition that fails at run time for a reason the author cannot see.
      if (typeof actual === "string") return actual.includes(String(branchCase.value));
      if (Array.isArray(actual)) return actual.includes(branchCase.value);
      return false;
    default:
      return false;
  }
};

// ---------------------------------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------------------------------

const stepNamed = (definition: FlowDefinition, name: string): FlowStep | undefined =>
  definition.steps.find((step) => step.name === name);

const terminal = (
  execution: FlowExecution,
  status: FlowExecution["status"],
  nowIso: string,
  detail?: string,
): AdvanceResult => ({
  execution: {
    ...execution,
    status,
    currentStep: null,
    finishedAt: nowIso,
    ...(detail === undefined ? {} : { detail }),
  },
  effect: { kind: "settled" },
});

/** `(executionId, step, attempt)` — the same three on a resume, which is what makes a replay a no-op. */
const keyFor = (execution: FlowExecution, step: string, attempt: number): string =>
  `flow:${execution.id}:${step}:${attempt}`;

const record = (execution: FlowExecution, entry: StepRecord): readonly StepRecord[] => [...execution.history, entry];

export const advance = (input: AdvanceInput): AdvanceResult => {
  const { definition, execution, outcome, nowMs, nowIso } = input;

  if (execution.status === "completed" || execution.status === "failed" || execution.status === "cancelled") {
    // Idempotent: advancing a settled execution returns it unchanged rather than throwing. A worker that
    // re-delivers a job for a finished flow is a normal event, not an error.
    return { execution, effect: { kind: "settled" } };
  }

  const currentName = execution.currentStep ?? definition.start;
  const step = stepNamed(definition, currentName);
  if (step === undefined) {
    // A definition that names a step it does not contain. Failing the execution with the name is the only useful
    // answer; guessing the next step would run something nobody wrote.
    return terminal(execution, "failed", nowIso, `step "${currentName}" is not defined in flow ${definition.id}`);
  }

  // -------------------------------------------------------------------------------------------------
  // An outcome for the step we last asked about
  // -------------------------------------------------------------------------------------------------
  if (outcome !== undefined) {
    if (outcome.kind === "parked") {
      return {
        execution: {
          ...execution,
          status: "waiting",
          waitingFor: { kind: "human", interactionId: outcome.interactionId },
        },
        effect: { kind: "settled" },
      };
    }

    if (outcome.kind === "parked-on-run") {
      return {
        execution: {
          ...execution,
          status: "waiting",
          waitingFor: {
            kind: "run",
            runId: outcome.runId,
            ...(outcome.member === undefined ? {} : { member: outcome.member }),
          },
        },
        effect: { kind: "settled" },
      };
    }

    if (outcome.kind === "failed") {
      const policy = step.onFailure ?? DEFAULT_FAILURE_POLICY;
      return handleFailure({ definition, execution, step, policy, error: outcome.error, nowIso, cost: outcome.costMinorUnits ?? 0 });
    }

    // `ok` or `resumed`: write the result, charge the spend, move on.
    const value = outcome.kind === "ok" ? outcome.value : outcome.value;
    const cost = (outcome.kind === "ok" ? outcome.costMinorUnits : undefined) ?? 0;
    const state = step.assignTo === undefined ? execution.state : { ...execution.state, [step.assignTo]: value };
    const next = "next" in step ? step.next : undefined;

    const advanced: FlowExecution = {
      ...execution,
      state,
      status: "running",
      attempt: 0,
      spend: { ...execution.spend, steps: execution.spend.steps + 1, costMinorUnits: execution.spend.costMinorUnits + cost },
      history: record(execution, {
        step: step.name,
        kind: step.kind,
        startedAt: nowIso,
        finishedAt: nowIso,
        outcome: "ok",
        attempt: execution.attempt,
        ...(cost === 0 ? {} : { costMinorUnits: cost }),
      }),
      currentStep: next ?? null,
    };
    // `waitingFor` is cleared by omission rather than set to undefined, so a serialised execution does not carry
    // a null field that a reader has to interpret.
    const { waitingFor: _cleared, ...withoutWait } = advanced;
    void _cleared;

    if (next === undefined) return terminal(withoutWait as FlowExecution, "completed", nowIso);
    return advance({ definition, execution: withoutWait as FlowExecution, nowMs, nowIso });
  }

  // -------------------------------------------------------------------------------------------------
  // No outcome: produce the effect for the current step
  // -------------------------------------------------------------------------------------------------

  /**
   * Budgets **before** the effect, so an over-budget flow performs nothing.
   *
   * Checked here rather than after a step returns, because after is too late: the money is spent and the external
   * write has happened. A ceiling that stops the *next* step is the only kind that stops anything.
   */
  /**
   * Not applied to `done`, for the same reason `done` consumes no budget: a ceiling stops *work*, and finishing
   * is not work. Gating it meant a flow that did exactly its allowance of work then failed on the marker — so
   * "maxSteps: 3" actually meant two steps and a marker, which is not what anyone writing it believes.
   */
  const overBudget = step.kind === "done" ? null : budgetExceeded(definition, execution, nowMs);
  if (overBudget !== null) return terminal(execution, "failed", nowIso, overBudget);

  if ((execution.depth ?? 0) > (definition.maxDepth ?? DEFAULT_MAX_DEPTH)) {
    // A → B → A terminates here, and the message names the depth rather than the cycle: the chain is only known
    // at run time, because a subflow reference is resolved then.
    return terminal(
      execution,
      "failed",
      nowIso,
      `nesting depth ${execution.depth} exceeds the flow's limit of ${definition.maxDepth ?? DEFAULT_MAX_DEPTH}`,
    );
  }

  const key = keyFor(execution, step.name, execution.attempt);
  const running: FlowExecution = { ...execution, status: "running", currentStep: step.name };

  switch (step.kind) {
    case "agent":
      return {
        execution: running,
        effect: {
          kind: "run-agent",
          agentId: String(step.agentId),
          prompt: interpolate(step.prompt, execution.state),
          ...(step.instructions === undefined ? {} : { instructions: step.instructions }),
          idempotencyKey: key,
          budgetRemaining: remaining(definition, execution, nowMs),
          // The step's name is the member's name in a compiled team, which is what carries attribution through
          // to the child run and its usage rows.
          member: step.name,
        },
      };

    case "team":
      return {
        execution: running,
        effect: { kind: "run-team", teamId: step.teamId, prompt: interpolate(step.prompt, execution.state), idempotencyKey: key },
      };

    case "tool":
      return {
        execution: running,
        effect: {
          kind: "call-tool",
          tool: step.tool,
          input: resolveInput(step.input, execution.state) as Readonly<Record<string, unknown>>,
          idempotencyKey: key,
        },
      };

    case "branch": {
      /**
       * Evaluated here rather than as an effect: a branch performs nothing, so asking the host to "do" it would
       * be a round trip for a comparison. It still costs a step, because a loop of branches is a loop.
       */
      const taken = step.cases.find((branchCase) => matches(execution.state, branchCase));
      const next = taken?.next ?? step.otherwise;
      const withStep: FlowExecution = {
        ...running,
        spend: { ...execution.spend, steps: execution.spend.steps + 1 },
        history: record(execution, {
          step: step.name,
          kind: "branch",
          startedAt: nowIso,
          finishedAt: nowIso,
          outcome: "ok",
          attempt: execution.attempt,
        }),
        currentStep: next ?? null,
        attempt: 0,
      };
      if (next === undefined) {
        // No matching case and no `otherwise`. Completing would be guessing that falling through was intended.
        return terminal(withStep, "failed", nowIso, `no branch matched at "${step.name}" and no otherwise is defined`);
      }
      return advance({ definition, execution: withStep, nowMs, nowIso });
    }

    case "wait":
      if (step.forSignal !== undefined) {
        return {
          execution: { ...running, status: "waiting", waitingFor: { kind: "signal", signal: step.forSignal } },
          effect: { kind: "await-signal", signal: step.forSignal },
        };
      }
      return {
        execution: {
          ...running,
          status: "waiting",
          waitingFor: { kind: "time", untilMs: nowMs + (step.forMs ?? 0) },
        },
        effect: { kind: "sleep", untilMs: nowMs + (step.forMs ?? 0) },
      };

    case "checkpoint":
      return {
        execution: running,
        effect: {
          kind: "ask-human",
          question: interpolate(step.question, execution.state),
          ...(step.options === undefined ? {} : { options: step.options }),
        },
      };

    case "subflow":
      return {
        execution: running,
        effect: { kind: "run-subflow", flowId: step.flowId, depth: (execution.depth ?? 0) + 1, idempotencyKey: key },
      };

    case "done":
      /**
       * Does **not** consume a step of budget, and that is a correctness fix rather than a nicety.
       *
       * A budget is about work, and `done` performs none — it is a terminal marker. Counting it meant a flow
       * whose ceiling exactly matched its work always failed at the last step: a sequential team with three
       * members and `maxSteps: 3` ran all three and then died on the marker, with "step budget exhausted" as the
       * reason. That reads as a runtime problem and is a definition arithmetic problem, and nobody would find it
       * by reading either.
       *
       * A `branch` still counts, because a branch can loop and a loop of branches is a loop. A `done` cannot.
       */
      return terminal(running, "completed", nowIso, step.outcome);

    default: {
      // Exhaustiveness, as a value rather than a comment: adding a step kind without handling it fails to compile.
      const unreachable: never = step;
      throw new AgentPlatformError({
        code: "internal",
        message: `unhandled step kind: ${JSON.stringify(unreachable)}`,
        retryable: false,
      });
    }
  }
};

/**
 * What is left, not what was allowed.
 *
 * The child run's ceiling is derived from this, so a member's limits shrink as the flow spends. Handing it the
 * flow's *original* budget would let each member spend the whole thing.
 */
const remaining = (
  definition: FlowDefinition,
  execution: FlowExecution,
  nowMs: number,
): { steps: number; costMinorUnits?: number; wallClockMs?: number } => {
  const { budget } = definition;
  return {
    steps: Math.max(0, budget.maxSteps - execution.spend.steps),
    ...(budget.maxCostMinorUnits === undefined
      ? {}
      : { costMinorUnits: Math.max(0, budget.maxCostMinorUnits - execution.spend.costMinorUnits) }),
    ...(budget.maxWallClockMs === undefined
      ? {}
      : { wallClockMs: Math.max(0, budget.maxWallClockMs - (nowMs - execution.spend.startedAtMs)) }),
  };
};

const budgetExceeded = (definition: FlowDefinition, execution: FlowExecution, nowMs: number): string | null => {
  const { budget } = definition;
  if (execution.spend.steps >= budget.maxSteps) {
    return `step budget exhausted: ${execution.spend.steps} of ${budget.maxSteps}`;
  }
  if (budget.maxCostMinorUnits !== undefined && execution.spend.costMinorUnits >= budget.maxCostMinorUnits) {
    return `cost budget exhausted: ${execution.spend.costMinorUnits} of ${budget.maxCostMinorUnits}`;
  }
  if (budget.maxWallClockMs !== undefined && nowMs - execution.spend.startedAtMs >= budget.maxWallClockMs) {
    // The one a step and cost ceiling both miss: a flow parked on a webhook consumes neither.
    return `wall-clock budget exhausted: ${nowMs - execution.spend.startedAtMs}ms of ${budget.maxWallClockMs}ms`;
  }
  return null;
};

const handleFailure = (input: {
  readonly definition: FlowDefinition;
  readonly execution: FlowExecution;
  readonly step: FlowStep;
  readonly policy: FailurePolicy;
  readonly error: string;
  readonly nowIso: string;
  readonly cost: number;
}): AdvanceResult => {
  const { definition, execution, step, policy, error, nowIso, cost } = input;
  const spend = {
    ...execution.spend,
    steps: execution.spend.steps + 1,
    // A failed step that spent money still spent it. Not charging for failures is how a retrying flow costs more
    // than its ceiling allows.
    costMinorUnits: execution.spend.costMinorUnits + cost,
  };
  const history = record(execution, {
    step: step.name,
    kind: step.kind,
    startedAt: nowIso,
    finishedAt: nowIso,
    outcome: "failed",
    attempt: execution.attempt,
    error,
    ...(cost === 0 ? {} : { costMinorUnits: cost }),
  });

  switch (policy.action) {
    case "retry": {
      const attempts = policy.maxAttempts ?? 3;
      if (execution.attempt + 1 >= attempts) {
        return terminal({ ...execution, spend, history }, "failed", nowIso, `${step.name} failed after ${attempts} attempts: ${error}`);
      }
      // The attempt number is in the execution, so a retry policy survives a restart — and it is in the
      // idempotency key, so a retry is genuinely a new attempt rather than a replay of the failed one.
      return {
        execution: { ...execution, spend, history, attempt: execution.attempt + 1, status: "running" },
        effect: { kind: "sleep", untilMs: 0 },
      };
    }
    case "skip": {
      const next = "next" in step ? step.next : undefined;
      const skipped: FlowExecution = { ...execution, spend, history, attempt: 0, currentStep: next ?? null, status: "running" };
      if (next === undefined) return terminal(skipped, "completed", nowIso, `${step.name} was skipped after failing`);
      return { execution: skipped, effect: { kind: "settled" } };
    }
    case "escalate":
      /**
       * Handed to the enclosing scope rather than decided here.
       *
       * The execution fails, and `detail` says it escalated — so a team's manager or a parent flow can act on it.
       * Without this, the vocabulary is "retry or die", and a manager-led team cannot react to a member failing,
       * which is most of the reason to have a manager.
       */
      return terminal({ ...execution, spend, history }, "failed", nowIso, `escalated from ${step.name}: ${error}`);
    case "fail":
    default:
      return terminal({ ...execution, spend, history }, "failed", nowIso, `${step.name} failed: ${error}`);
  }
};

/** A fresh execution, at the start step, with nothing spent. */
export const beginExecution = (input: {
  readonly id: string;
  readonly definition: FlowDefinition;
  readonly tenantId: FlowExecution["tenantId"];
  readonly runId: FlowExecution["runId"];
  readonly principalId: FlowExecution["principalId"];
  readonly conversationId?: FlowExecution["conversationId"];
  readonly state?: Readonly<Record<string, unknown>>;
  readonly depth?: number;
  readonly nowMs: number;
  readonly nowIso: string;
}): FlowExecution => ({
  id: input.id,
  tenantId: input.tenantId,
  flowId: input.definition.id,
  // Pinned here, once. Editing the flow afterwards does not change this execution.
  flowVersion: input.definition.version,
  runId: input.runId,
  principalId: input.principalId,
  ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
  status: "running",
  currentStep: input.definition.start,
  state: input.state ?? {},
  spend: { steps: 0, costMinorUnits: 0, startedAtMs: input.nowMs },
  history: [],
  attempt: 0,
  depth: input.depth ?? 0,
  startedAt: input.nowIso,
});
