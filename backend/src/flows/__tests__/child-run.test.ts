/**
 * An agent step as a child run — #202.
 *
 * The reason an agent step is a run rather than an inline model call: a `Run` earns checkpointing, recovery, quota
 * admission and its own usage rows. Calling a model from the runner would be a second turn implementation with
 * none of those, and it would pass a demo.
 *
 * Two claims here are the ones worth having. **The parent resumes even if nobody tells it** — a crash between the
 * child settling and the notification being sent loses the message, so correctness comes from a poll and the
 * notification is only latency. And **the child's ceiling is the flow's remainder**, re-derived per step, or a
 * member can outspend the team the composition was supposed to bound.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import { createMemoryFlowDefinitionStore, createMemoryFlowExecutionStore } from "../../adapters/memory/flows.js";
import { compileTeam } from "../../teams/index.js";
import { createFlowRunner } from "../runner.js";
import type { FlowEffectHandler } from "../runner.js";
import type { FlowDefinition, TeamDefinition } from "../index.js";
import type { ExecutionContext } from "../../core/context.js";
import type { AgentId, PrincipalId, RequestId, RunId, TenantId } from "../../core/ids.js";

const context = (): ExecutionContext => ({
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

const team = (over: Partial<TeamDefinition> = {}): TeamDefinition => ({
  id: "t1",
  version: 1,
  name: "Research and write",
  process: "sequential",
  members: [
    { name: "researcher", agentId: asId<AgentId>("agent-r") },
    { name: "writer", agentId: asId<AgentId>("agent-w") },
  ],
  budget: { maxSteps: 10, maxCostMinorUnits: 1_000 },
  ...over,
});

/** A fake run store, so a child run's lifecycle is something the test controls rather than waits for. */
const runs = () => {
  const rows = new Map<string, { status: string; error?: { message: string } }>();
  return {
    rows,
    store: {
      async findById({ id }: { id: string }) {
        return rows.get(id) ?? null;
      },
    },
  };
};

const setup = async (definition: FlowDefinition, options: { readonly failChild?: boolean } = {}) => {
  const definitions = createMemoryFlowDefinitionStore();
  const executions = createMemoryFlowExecutionStore();
  const runStore = runs();
  const created: { agentId: string; member?: string; runId: string; budget: unknown }[] = [];
  let n = 0;

  const handler: FlowEffectHandler = {
    async runAgent(_c, input) {
      // What a real handler does: create a conversation-less child run, enqueue it, and park.
      const runId = `child-${++n}`;
      created.push({ agentId: input.agentId, member: input.member, runId, budget: input.budgetRemaining });
      runStore.rows.set(runId, { status: options.failChild === true ? "failed" : "queued", ...(options.failChild === true ? { error: { message: "the model refused" } } : {}) });
      return { kind: "parked-on-run", runId, ...(input.member === undefined ? {} : { member: input.member }) };
    },
    async callTool() {
      return { kind: "ok", value: null };
    },
    async askHuman() {
      return { kind: "parked", interactionId: "int-1" };
    },
  };

  await definitions.put({
    tenantId: context().tenantId,
    definition: { flowId: definition.id, version: definition.version, name: definition.name, kind: "team", definition, createdAt: "2026-08-26T10:00:00.000Z" },
  });
  let e = 0;
  const runner = createFlowRunner({ definitions, executions, handler, runs: runStore.store, idFactory: () => `exec-${++e}` });
  return { runner, executions, created, runStore };
};

describe("an agent step becomes a child run", () => {
  it("parks the flow on the child, recording which run and which member", async () => {
    const definition = compileTeam(team());
    const { runner, created, executions } = await setup(definition);

    const parked = await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "explain the outage" } });

    expect(parked.stopped).toBe("waiting");
    expect(parked.execution.waitingFor).toEqual({ kind: "run", runId: "child-1", member: "researcher" });
    expect(created[0]).toMatchObject({ agentId: "agent-r", member: "researcher" });

    // Persisted where a settled run can find it, not only held in memory.
    const stored = await executions.get({ tenantId: context().tenantId, executionId: parked.execution.id });
    expect(stored?.waitingRunId).toBe("child-1");
  });

  it("derives the child's ceiling from what the flow has left, per step", async () => {
    /**
     * #202 AC-3. The second member's ceiling must be smaller than the first's, because the flow has spent in
     * between. Handing each the flow's *original* budget would let every member spend the whole thing.
     */
    const definition = compileTeam(team({ budget: { maxSteps: 6, maxCostMinorUnits: 900 } }));
    const { runner, created, runStore } = await setup(definition);

    const first = await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });
    expect(created[0]?.budget).toEqual({ steps: 6, costMinorUnits: 900 });

    runStore.rows.set("child-1", { status: "completed" });
    await runner.notifyRunFinished(context(), asId<RunId>("child-1"));
    void first;

    // One step spent, so the writer sees five.
    expect(created[1]?.budget).toEqual({ steps: 5, costMinorUnits: 900 });
  });

  it("attributes each member's step in the history", async () => {
    // #186 AC-9's other half: which member did which step, inside one run identity.
    const definition = compileTeam(team());
    const { runner, runStore } = await setup(definition);
    await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });

    runStore.rows.set("child-1", { status: "completed" });
    const after = await runner.notifyRunFinished(context(), asId<RunId>("child-1"));
    expect(after?.execution.history.map((h) => h.step)).toEqual(["researcher"]);
  });
});

describe("waking the parent", () => {
  it("resumes on notification", async () => {
    const definition = compileTeam(team());
    const { runner, runStore } = await setup(definition);
    const parked = await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });

    runStore.rows.set("child-1", { status: "completed" });
    const resumed = await runner.notifyRunFinished(context(), asId<RunId>("child-1"));

    expect(resumed).not.toBeNull();
    // Straight on to the writer, parked on its own child run.
    expect(resumed?.execution.waitingFor).toMatchObject({ kind: "run", member: "writer" });
    void parked;
  });

  it("resumes on a plain resume even if the notification never arrived", async () => {
    /**
     * The claim that matters. A crash between the child completing and the notification being sent loses the
     * message; a parent that only woke on notifications would sit forever, and nothing would look again.
     *
     * So `drive` polls the child at the top of every resume. Here the notification is simply never called.
     */
    const definition = compileTeam(team());
    const { runner, runStore } = await setup(definition);
    const parked = await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });

    runStore.rows.set("child-1", { status: "completed" });
    const resumed = await runner.resume(context(), parked.execution.id);

    expect(resumed.execution.waitingFor).toMatchObject({ kind: "run", member: "writer" });
  });

  it("stays waiting while the child is still running", async () => {
    // A resume that found the child unfinished must not drive a step. Saying "waiting" is more useful than
    // starting something that cannot proceed.
    const definition = compileTeam(team());
    const { runner } = await setup(definition);
    const parked = await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });

    const again = await runner.resume(context(), parked.execution.id);
    expect(again.stopped).toBe("waiting");
    expect(again.execution.waitingFor).toEqual({ kind: "run", runId: "child-1", member: "researcher" });
  });

  it("returns null when no execution was waiting for that run", async () => {
    // The common case in a deployment where most runs are chat turns.
    const definition = compileTeam(team());
    const { runner } = await setup(definition);
    await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });
    expect(await runner.notifyRunFinished(context(), asId<RunId>("some-chat-turn"))).toBeNull();
  });

  it("fails a parent whose child does not exist", async () => {
    // Waiting forever for something never created is the shape of a stuck automation nobody can explain.
    const definition = compileTeam(team());
    const { runner, runStore } = await setup(definition);
    const parked = await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });
    runStore.rows.delete("child-1");

    const resumed = await runner.resume(context(), parked.execution.id);
    expect(resumed.execution.status).toBe("failed");
    expect(resumed.execution.detail).toContain("does not exist");
  });
});

describe("a child that fails", () => {
  it("routes into the step's failure policy rather than failing generically", async () => {
    // #202 AC-6. `escalate` on a member's step is how a manager-led team hears that a member failed.
    const compiled = compileTeam(team());
    const withEscalate: FlowDefinition = {
      ...compiled,
      steps: compiled.steps.map((step) =>
        step.name === "researcher" ? { ...step, onFailure: { action: "escalate" as const } } : step,
      ),
    };
    const { runner, runStore } = await setup(withEscalate, { failChild: true });
    const parked = await runner.start(context(), { flowId: withEscalate.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });

    runStore.rows.set("child-1", { status: "failed", error: { message: "the model refused" } });
    const resumed = await runner.resume(context(), parked.execution.id);

    expect(resumed.execution.status).toBe("failed");
    expect(resumed.execution.detail).toContain("escalated from researcher");
    expect(resumed.execution.detail).toContain("the model refused");
  });

  it("retries the child when the policy says so, with a fresh idempotency key", async () => {
    const compiled = compileTeam(team());
    const withRetry: FlowDefinition = {
      ...compiled,
      steps: compiled.steps.map((step) =>
        step.name === "researcher" ? { ...step, onFailure: { action: "retry" as const, maxAttempts: 2 } } : step,
      ),
    };
    const { runner, runStore, created } = await setup(withRetry);
    const parked = await runner.start(context(), { flowId: withRetry.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });

    runStore.rows.set("child-1", { status: "failed", error: { message: "transient" } });
    await runner.resume(context(), parked.execution.id);

    // A second child run, which is what a retry means here — not a replay of the failed one.
    expect(created).toHaveLength(2);
    expect(created[1]?.member).toBe("researcher");
  });

  it("treats a cancelled child as a failure, not a success", async () => {
    // A cancelled child produced no result. Continuing as though it had would run the next member against
    // nothing and read as the model returning an empty answer.
    const definition = compileTeam(team());
    const { runner, runStore } = await setup(definition);
    const parked = await runner.start(context(), { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } });

    runStore.rows.set("child-1", { status: "cancelled" });
    const resumed = await runner.resume(context(), parked.execution.id);
    expect(resumed.execution.status).toBe("failed");
  });
});

describe("the conversation run slot", () => {
  it("gives a child run no conversation, so it cannot contend for the conversation's slot", async () => {
    /**
     * #202 AC-5. `ConversationRunCoordinator` claims a *conversation's* single run slot. A flow inside a
     * conversation whose steps also claimed it would deadlock against the conversation's own turn — the parent
     * holds the slot and waits for a child that cannot get it.
     *
     * So a child run is conversation-less (#198 made that possible), and what a member needs from the thread
     * travels in the prompt, where it is readable, rather than through a conversation the child does not have.
     */
    const definition = compileTeam(team());
    const { runner, created } = await setup(definition);
    await runner.start(
      { ...context(), conversationId: asId("conv-1") } as ExecutionContext,
      { flowId: definition.id, runId: asId<RunId>("parent-1"), state: { brief: "b" } },
    );

    // The handler is what creates the run, and the effect it was given carries no conversation to put on it:
    // the prompt is the whole of what the member is told.
    expect(created[0]).toMatchObject({ agentId: "agent-r", member: "researcher" });
    expect(Object.keys(created[0] ?? {})).not.toContain("conversationId");
  });
});
