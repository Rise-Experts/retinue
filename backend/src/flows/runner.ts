/**
 * The durable driver — REQ-038 (#187).
 *
 * `advance` decides; this performs. The loop is: ask the interpreter for an effect, perform it, **persist**, and
 * ask again — until the execution settles or parks. Persisting between every step is the whole of the durability
 * story: a crash anywhere in the loop leaves a stored execution that `resume` can pick up, and because the
 * interpreter is pure there is nothing else that was in flight.
 *
 * ## Persist after performing, not before
 *
 * The order matters and is worth stating, because both orders look reasonable. Persisting *before* performing
 * would record a step as complete that might not happen — a crash then skips it, silently. Persisting *after*
 * means a crash re-asks for the same effect, with the same idempotency key, and the idempotency store answers
 * with the first result. So the failure mode is a duplicate *attempt*, which the key absorbs, rather than a
 * skipped step, which nothing detects.
 *
 * That is why the key is derived from `(executionId, step, attempt)` rather than generated: a generated key would
 * be new on every resume and the "duplicate attempt" would become a duplicate *effect*.
 */

import { AgentPlatformError } from "../core/errors.js";
import { advance, beginExecution } from "./interpreter.js";
import type { FlowEffect, StepOutcome } from "./interpreter.js";
import type { FlowDefinition, FlowExecution } from "./index.js";
import type { FlowDefinitionStore, FlowExecutionStore, StoredFlowExecution } from "../persistence/index.js";
import type { ExecutionContext } from "../core/context.js";

/**
 * What a host has to be able to do for a flow to run.
 *
 * Ports, not a class: the platform cannot know how a deployment runs an agent or asks a person, and every one of
 * these is something the deployment already does for its assistant surface. A flow is composition over them, not
 * a second way of doing them.
 */
export type FlowEffectHandler = {
  /**
   * Run an agent step.
   *
   * A handler that creates a **child run** returns `parked-on-run` and the flow waits for it; one that runs a
   * turn inline returns `ok`. Both are legal, and the first is what #202 is for: a child run earns
   * checkpointing, recovery, quota admission and its own usage rows, and an inline turn earns none of them.
   *
   * `budgetRemaining` is what the flow has left, re-derived per step. A child given its own independent ceiling
   * is a member that can outspend the team.
   */
  runAgent(
    context: ExecutionContext,
    input: {
      readonly agentId: string;
      readonly prompt: string;
      readonly instructions?: string;
      readonly idempotencyKey: string;
      readonly budgetRemaining: { readonly steps: number; readonly costMinorUnits?: number; readonly wallClockMs?: number };
      readonly member?: string;
    },
  ): Promise<StepOutcome>;
  callTool(
    context: ExecutionContext,
    input: { readonly tool: string; readonly input: Readonly<Record<string, unknown>>; readonly idempotencyKey: string },
  ): Promise<StepOutcome>;
  /** Raises a question through the *existing* HITL path and returns `parked` with the interaction it raised. */
  askHuman(
    context: ExecutionContext,
    input: { readonly question: string; readonly options?: readonly string[] },
  ): Promise<StepOutcome>;
  /** A team, which is a compiled flow — so a handler may simply call the runner again. */
  runTeam?(
    context: ExecutionContext,
    input: { readonly teamId: string; readonly prompt: string; readonly idempotencyKey: string },
  ): Promise<StepOutcome>;
  runSubflow?(
    context: ExecutionContext,
    input: { readonly flowId: string; readonly depth: number; readonly idempotencyKey: string },
  ): Promise<StepOutcome>;
};

export type FlowRunnerDeps = {
  readonly definitions: FlowDefinitionStore;
  readonly executions: FlowExecutionStore;
  readonly handler: FlowEffectHandler;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  /**
   * How a child run's terminal state is read — #202.
   *
   * Optional, and its absence is why `resume` can only *poll* when it is present: a deployment that runs agent
   * steps inline never parks on a run and needs none of this. Supplied, it is what makes the wake-up correct
   * rather than dependent on a notification arriving — a crash between the child completing and the parent being
   * told loses the message, and nothing would ever look again.
   */
  readonly runs?: {
    findById(input: { readonly tenantId: ExecutionContext["tenantId"]; readonly id: string }): Promise<
      { readonly status: string; readonly error?: { readonly message: string } } | null
    >;
  };
  /**
   * How many effects one call may perform before returning.
   *
   * Not a duplicate of the flow's step budget — that is the flow's own ceiling and this is the *worker's*. A long
   * flow should be able to hand its worker slot back and be picked up again rather than holding it for an hour,
   * and without this the two concerns share one number.
   */
  readonly maxEffectsPerCall?: number;
};

export type RunResult = {
  readonly execution: FlowExecution;
  /** Why this call stopped: the flow settled, it parked, or the worker's slice ran out. */
  readonly stopped: "settled" | "waiting" | "slice-exhausted";
};

const toStored = (execution: FlowExecution): StoredFlowExecution => ({
  id: execution.id,
  flowId: execution.flowId,
  flowVersion: execution.flowVersion,
  runId: execution.runId,
  status: execution.status,
  currentStep: execution.currentStep,
  steps: execution.spend.steps,
  execution,
  ...(execution.waitingFor?.kind === "signal" ? { waitingSignal: execution.waitingFor.signal } : {}),
  ...(execution.waitingFor?.kind === "run" ? { waitingRunId: execution.waitingFor.runId as never } : {}),
  startedAt: execution.startedAt,
  ...(execution.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt }),
});

export const createFlowRunner = (deps: FlowRunnerDeps) => {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.idFactory ?? (() => `flowexec-${crypto.randomUUID()}`);
  const slice = deps.maxEffectsPerCall ?? 50;

  /** Read the definition **at the execution's pinned version**, never the latest. */
  const definitionFor = async (context: ExecutionContext, execution: FlowExecution): Promise<FlowDefinition> => {
    const stored = await deps.definitions.get({
      tenantId: context.tenantId,
      flowId: execution.flowId,
      version: execution.flowVersion,
    });
    if (stored === null) {
      /**
       * A definition that has gone missing under a running execution.
       *
       * Refused rather than falling back to `latest`, which is the tempting repair and the wrong one: the whole
       * point of pinning is that the execution runs the shape it started with, and silently running a *different*
       * shape is worse than stopping.
       */
      throw new AgentPlatformError({
        code: "not_found",
        message: `flow ${execution.flowId} version ${execution.flowVersion} is not stored; execution ${execution.id} cannot continue on a different version`,
        retryable: false,
      });
    }
    return stored.definition as FlowDefinition;
  };

  const perform = async (context: ExecutionContext, effect: FlowEffect): Promise<StepOutcome | null> => {
    switch (effect.kind) {
      case "run-agent":
        return deps.handler.runAgent(context, effect);
      case "call-tool":
        return deps.handler.callTool(context, effect);
      case "ask-human":
        return deps.handler.askHuman(context, effect);
      case "run-team":
        if (deps.handler.runTeam === undefined) {
          // Named, and not a generic failure: a flow with a team step in a deployment that wired no team handler
          // is a wiring problem, and "unsupported step" would send someone reading the interpreter.
          return { kind: "failed", error: "this deployment has no team handler wired, so a team step cannot run" };
        }
        return deps.handler.runTeam(context, effect);
      case "run-subflow":
        if (deps.handler.runSubflow === undefined) {
          return { kind: "failed", error: "this deployment has no subflow handler wired" };
        }
        return deps.handler.runSubflow(context, effect);
      case "sleep":
        /**
         * Not slept through.
         *
         * A worker that blocks for a flow's `wait` is a worker holding a slot for something with no work in it —
         * and a wait measured in hours would hold it for hours. `untilMs` is stored on the execution, so whatever
         * wakes flows up reads it; a zero-length sleep (the retry backoff case) simply continues.
         */
        return effect.untilMs <= clock().getTime() ? { kind: "resumed" } : null;
      case "await-signal":
        return null;
      case "settled":
        return null;
      default: {
        const unreachable: never = effect;
        throw new AgentPlatformError({ code: "internal", message: `unhandled effect ${JSON.stringify(unreachable)}`, retryable: false });
      }
    }
  };

  /**
   * Has the child run this execution is parked on finished?
   *
   * The poll half of the wake-up. `notifyRunFinished` is the fast path and this is the correct one: a parent that
   * only ever woke on a notification would sit forever if the process died between the child settling and the
   * message being sent. Called at the top of `drive`, so any resume — a worker sweep, an operator, a retry —
   * notices.
   */
  const childOutcome = async (context: ExecutionContext, execution: FlowExecution): Promise<StepOutcome | null> => {
    if (execution.waitingFor?.kind !== "run" || deps.runs === undefined) return null;
    const child = await deps.runs.findById({ tenantId: context.tenantId, id: execution.waitingFor.runId });
    if (child === null) {
      // A parked parent whose child does not exist. Failing is the only honest answer: waiting forever for
      // something that was never created is the shape of a stuck automation nobody can explain.
      return { kind: "failed", error: `child run ${execution.waitingFor.runId} does not exist` };
    }
    if (child.status === "completed") return { kind: "resumed" };
    if (child.status === "failed" || child.status === "cancelled") {
      // Routed through the step's `onFailure`, so a team's `escalate` reaches its manager — #202 AC-6.
      return { kind: "failed", error: child.error?.message ?? `child run ${child.status}` };
    }
    return null;
  };

  const drive = async (context: ExecutionContext, initial: FlowExecution): Promise<RunResult> => {
    let execution = initial;
    const definition = await definitionFor(context, execution);

    // Before anything else: if this execution is parked on a run that has since settled, take that outcome.
    const settled = await childOutcome(context, execution);
    if (settled !== null) {
      const now = clock();
      const { execution: next } = advance({ definition, execution, outcome: settled, nowMs: now.getTime(), nowIso: now.toISOString() });
      execution = next;
      await deps.executions.save({ tenantId: context.tenantId, execution: toStored(execution) });
      if (execution.status === "completed" || execution.status === "failed" || execution.status === "cancelled") {
        return { execution, stopped: "settled" };
      }
    } else if (execution.waitingFor?.kind === "run") {
      // Still running. Nothing to do, and saying "waiting" is more useful than driving a step that cannot start.
      return { execution, stopped: "waiting" };
    }

    for (let performed = 0; performed < slice; performed += 1) {
      const { execution: next, effect } = advance({
        definition,
        execution,
        nowMs: clock().getTime(),
        nowIso: clock().toISOString(),
      });
      execution = next;
      // Persisted before the effect is performed *only* as a record of intent — the status and step, not a
      // completed step. The completed-step write happens below, after the outcome.
      await deps.executions.save({ tenantId: context.tenantId, execution: toStored(execution) });

      if (effect.kind === "settled") return { execution, stopped: "settled" };
      if (execution.status === "waiting" && (effect.kind === "ask-human" || effect.kind === "await-signal")) {
        // Parked. The outcome arrives later, from a person or a signal, through `resumeWith`.
        return { execution, stopped: "waiting" };
      }

      const outcome = await perform(context, effect);
      if (outcome === null) return { execution, stopped: "waiting" };

      const { execution: after } = advance({
        definition,
        execution,
        outcome,
        nowMs: clock().getTime(),
        nowIso: clock().toISOString(),
      });
      execution = after;
      await deps.executions.save({ tenantId: context.tenantId, execution: toStored(execution) });

      if (execution.status === "completed" || execution.status === "failed" || execution.status === "cancelled") {
        return { execution, stopped: "settled" };
      }
      if (execution.status === "waiting") return { execution, stopped: "waiting" };
    }

    // The worker's slice, not the flow's budget. It hands the slot back and something re-enqueues.
    return { execution, stopped: "slice-exhausted" };
  };

  return {
    /** Start a flow at its latest version, pinning that version for this execution's whole life. */
    async start(
      context: ExecutionContext,
      input: { readonly flowId: string; readonly runId: FlowExecution["runId"]; readonly state?: Readonly<Record<string, unknown>>; readonly depth?: number },
    ): Promise<RunResult> {
      const stored = await deps.definitions.latest({ tenantId: context.tenantId, flowId: input.flowId });
      if (stored === null) {
        throw new AgentPlatformError({ code: "not_found", message: `no flow named ${input.flowId}`, retryable: false });
      }
      const definition = stored.definition as FlowDefinition;
      const now = clock();
      const execution = beginExecution({
        id: newId(),
        // The version comes from the stored row rather than the document, so a definition whose body disagrees
        // with its row cannot pin a version that does not exist.
        definition: { ...definition, version: stored.version },
        tenantId: context.tenantId,
        runId: input.runId,
        principalId: context.principalId,
        ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.depth === undefined ? {} : { depth: input.depth }),
        nowMs: now.getTime(),
        nowIso: now.toISOString(),
      });
      await deps.executions.create({ tenantId: context.tenantId, execution: toStored(execution) });
      return drive(context, execution);
    },

    /** Continue a stored execution — after a restart, or after a slice ran out. */
    async resume(context: ExecutionContext, executionId: string): Promise<RunResult> {
      const stored = await deps.executions.get({ tenantId: context.tenantId, executionId });
      if (stored === null) {
        throw new AgentPlatformError({ code: "not_found", message: `no flow execution ${executionId}`, retryable: false });
      }
      return drive(context, stored.execution as FlowExecution);
    },

    /**
     * Deliver an answer or a signal to a parked execution.
     *
     * The value goes through the interpreter as a `resumed` outcome, so the parked step's `assignTo` receives it
     * exactly as any other step's result would. A separate "apply an answer" path would be a second way to write
     * state, and the two would eventually disagree about where an answer lands.
     */
    async resumeWith(context: ExecutionContext, executionId: string, value: unknown): Promise<RunResult> {
      const stored = await deps.executions.get({ tenantId: context.tenantId, executionId });
      if (stored === null) {
        throw new AgentPlatformError({ code: "not_found", message: `no flow execution ${executionId}`, retryable: false });
      }
      const execution = stored.execution as FlowExecution;
      const definition = await definitionFor(context, execution);
      const now = clock();
      const { execution: next } = advance({
        definition,
        execution,
        outcome: { kind: "resumed", value },
        nowMs: now.getTime(),
        nowIso: now.toISOString(),
      });
      await deps.executions.save({ tenantId: context.tenantId, execution: toStored(next) });
      if (next.status === "completed" || next.status === "failed") return { execution: next, stopped: "settled" };
      return drive(context, next);
    },

    /**
     * A child run settled — #202.
     *
     * The fast path. Correctness does not depend on it: `drive` polls the child's state on every resume, so a
     * lost notification costs latency rather than a stuck flow. Returns `null` when no execution was waiting for
     * this run, which is the common case in a deployment where most runs are chat turns.
     */
    async notifyRunFinished(context: ExecutionContext, runId: FlowExecution["runId"]): Promise<RunResult | null> {
      const stored = await deps.executions.waitingOnRun({ tenantId: context.tenantId, runId });
      if (stored === null) return null;
      return drive(context, stored.execution as FlowExecution);
    },

    /** Everything parked on a signal, so delivering one can wake what was waiting. */
    async deliverSignal(context: ExecutionContext, signal: string, value?: unknown): Promise<readonly RunResult[]> {
      const waiting = await deps.executions.waitingOnSignal({ tenantId: context.tenantId, signal });
      const results: RunResult[] = [];
      for (const stored of waiting) {
        // Sequentially, not in parallel: each of these can perform external writes, and a signal fanning out to
        // fifty executions at once is a thundering herd nobody asked for.
        results.push(await this.resumeWith(context, stored.id, value));
      }
      return results;
    },
  };
};

export type FlowRunner = ReturnType<typeof createFlowRunner>;
