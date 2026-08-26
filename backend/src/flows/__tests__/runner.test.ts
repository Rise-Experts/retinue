/**
 * The durable driver — REQ-038 (#187), AC-3 and AC-9.
 *
 * These run against the in-memory stores and a handler that records what it was asked to do. Two claims are the
 * point of the file, and both are about what happens when the process dies at the worst moment:
 *
 * - **A restart resumes at the last completed step**, from what was stored, with no in-flight state.
 * - **A step that performed an external write and then crashed does not repeat it** — the same idempotency key
 *   comes back, and the handler can answer from its own store.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import { createMemoryFlowDefinitionStore, createMemoryFlowExecutionStore } from "../../adapters/memory/flows.js";
import { createFlowRunner } from "../runner.js";
import type { FlowEffectHandler } from "../runner.js";
import type { FlowDefinition, FlowStep } from "../index.js";
import type { ExecutionContext } from "../../core/context.js";
import type { PrincipalId, RequestId, RunId, TenantId } from "../../core/ids.js";

const context = (): ExecutionContext => ({
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

const flow = (steps: readonly FlowStep[], over: Partial<FlowDefinition> = {}): FlowDefinition => ({
  id: "f1",
  version: 1,
  name: "test",
  steps,
  start: steps[0]!.name,
  budget: { maxSteps: 20 },
  ...over,
});

/** Records every call, and answers however the test says. */
const recorder = (over: Partial<FlowEffectHandler> = {}) => {
  const calls: { kind: string; key?: string; detail?: string }[] = [];
  const handler: FlowEffectHandler = {
    async runAgent(_c, input) {
      calls.push({ kind: "run-agent", key: input.idempotencyKey, detail: input.prompt });
      return { kind: "ok", value: `answer to ${input.prompt}` };
    },
    async callTool(_c, input) {
      calls.push({ kind: "call-tool", key: input.idempotencyKey, detail: input.tool });
      return { kind: "ok", value: { ok: true } };
    },
    async askHuman(_c, input) {
      calls.push({ kind: "ask-human", detail: input.question });
      return { kind: "parked", interactionId: "int-1" };
    },
    ...over,
  };
  return { handler, calls };
};

const setup = async (definition: FlowDefinition, over: Partial<FlowEffectHandler> = {}) => {
  const definitions = createMemoryFlowDefinitionStore();
  const executions = createMemoryFlowExecutionStore();
  const { handler, calls } = recorder(over);
  await definitions.put({
    tenantId: context().tenantId,
    definition: {
      flowId: definition.id,
      version: definition.version,
      name: definition.name,
      kind: "flow",
      definition,
      createdAt: "2026-08-26T10:00:00.000Z",
    },
  });
  let n = 0;
  const runner = createFlowRunner({ definitions, executions, handler, idFactory: () => `exec-${++n}` });
  return { definitions, executions, runner, calls };
};

describe("running a flow to completion", () => {
  it("performs each step and settles", async () => {
    const definition = flow([
      { name: "look", kind: "tool", tool: "lookup", input: {}, next: "write", assignTo: "found" },
      { name: "write", kind: "agent", agentId: asId("ag"), prompt: "write it up", next: "end", assignTo: "draft" },
      { name: "end", kind: "done" },
    ]);
    const { runner, calls, executions } = await setup(definition);

    const result = await runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") });
    expect(result.stopped).toBe("settled");
    expect(result.execution.status).toBe("completed");
    expect(calls.map((c) => c.kind)).toEqual(["call-tool", "run-agent"]);
    expect(result.execution.state).toMatchObject({ found: { ok: true }, draft: "answer to write it up" });

    // Persisted, not only returned: the stored document is what a restart or an inspector reads.
    const stored = await executions.get({ tenantId: context().tenantId, executionId: result.execution.id });
    expect(stored?.status).toBe("completed");
    // Two: the tool and the agent. `done` performs no work and consumes no budget — see the interpreter's note.
    expect(stored?.steps).toBe(2);
  });

  it("pins the version at start, so editing the flow does not change a running execution", async () => {
    /**
     * #187 AC-1. The runner reads the definition at the execution's pinned version on every drive, so publishing
     * v2 mid-flight cannot change the shape of something already running — the person who edited step 4 has no
     * idea an execution is sitting at step 3.
     */
    const v1 = flow([
      { name: "a", kind: "checkpoint", question: "wait here", next: "end" },
      { name: "end", kind: "done" },
    ]);
    const { runner, definitions } = await setup(v1);
    const parked = await runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") });
    expect(parked.stopped).toBe("waiting");

    // A new version lands while the first execution is parked, with a completely different shape.
    await definitions.put({
      tenantId: context().tenantId,
      definition: {
        flowId: "f1",
        version: 2,
        name: "changed",
        kind: "flow",
        definition: flow([{ name: "totally-different", kind: "done" }], { version: 2 }),
        createdAt: "2026-08-26T11:00:00.000Z",
      },
    });

    const resumed = await runner.resumeWith(context(), parked.execution.id, "answered");
    expect(resumed.execution.flowVersion).toBe(1);
    expect(resumed.execution.status).toBe("completed");
    // It finished through v1's `end`, not v2's `totally-different`.
    expect(resumed.execution.history.map((h) => h.step)).toEqual(["a"]);
  });

  it("refuses to continue on a different version rather than falling back to the latest", async () => {
    // The tempting repair is `latest`, and it is wrong: running a different shape silently is worse than stopping.
    const definition = flow([
      { name: "a", kind: "checkpoint", question: "hold", next: "end" },
      { name: "end", kind: "done" },
    ]);
    const { runner, executions } = await setup(definition);
    const parked = await runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") });

    // The definition disappears from under it.
    const empty = createMemoryFlowDefinitionStore();
    const orphaned = createFlowRunner({
      definitions: empty,
      executions,
      handler: recorder().handler,
    });
    await expect(orphaned.resume(context(), parked.execution.id)).rejects.toThrow(/cannot continue on a different version/);
  });
});

describe("a restart mid-flow", () => {
  it("resumes at the last completed step, from what was stored", async () => {
    const definition = flow([
      { name: "one", kind: "tool", tool: "t1", input: {}, next: "two", assignTo: "a" },
      { name: "two", kind: "tool", tool: "t2", input: {}, next: "three", assignTo: "b" },
      { name: "three", kind: "done" },
    ]);
    // A handler that dies on the second step, the first time it is asked.
    let died = false;
    const { runner, executions, calls } = await setup(definition, {
      async callTool(_c, input) {
        calls.push({ kind: "call-tool", key: input.idempotencyKey, detail: input.tool });
        if (input.tool === "t2" && !died) {
          died = true;
          throw new Error("process died");
        }
        return { kind: "ok", value: input.tool };
      },
    });
    const calls2: { kind: string; key?: string; detail?: string }[] = [];
    void calls2;

    await expect(runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") })).rejects.toThrow("process died");

    // What is on disk after the crash: step one done, step two in progress.
    const stored = await executions.get({ tenantId: context().tenantId, executionId: "exec-1" });
    expect(stored?.steps).toBe(1);
    expect(stored?.currentStep).toBe("two");

    const resumed = await runner.resume(context(), "exec-1");
    expect(resumed.execution.status).toBe("completed");
    // `one` was not performed again — its result was already in state.
    expect(resumed.execution.state).toMatchObject({ a: "t1", b: "t2" });
  });

  it("asks for the crashed step with the same idempotency key, so an external write is not repeated", async () => {
    /**
     * #187 AC-9, end to end. The handler here is a stand-in for an idempotent tool: it records keys it has seen
     * and answers from memory on a repeat. What the flow guarantees is that the *key is the same*, which is the
     * part the handler cannot do for itself.
     */
    const definition = flow([
      { name: "charge", kind: "tool", tool: "charge_card", input: { amount: 100 }, next: "end", assignTo: "receipt" },
      { name: "end", kind: "done" },
    ]);
    const seen = new Map<string, string>();
    let charges = 0;
    let crash = true;
    const { runner, executions } = await setup(definition, {
      async callTool(_c, input) {
        const prior = seen.get(input.idempotencyKey);
        if (prior !== undefined) return { kind: "ok", value: prior };
        // The write happens, and *then* the process dies — the worst ordering.
        charges += 1;
        const receipt = `receipt-${charges}`;
        seen.set(input.idempotencyKey, receipt);
        if (crash) {
          crash = false;
          throw new Error("died after charging");
        }
        return { kind: "ok", value: receipt };
      },
    });

    await expect(runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") })).rejects.toThrow();
    const again = await runner.resume(context(), "exec-1");

    expect(again.execution.status).toBe("completed");
    // Charged once. The second attempt was answered from the key.
    expect(charges).toBe(1);
    expect(again.execution.state).toMatchObject({ receipt: "receipt-1" });
    void executions;
  });
});

describe("parking and resuming", () => {
  it("parks on a human checkpoint and finishes when the answer arrives", async () => {
    const definition = flow([
      { name: "approve", kind: "checkpoint", question: "Approve?", options: ["yes", "no"], next: "end", assignTo: "decision" },
      { name: "end", kind: "done" },
    ]);
    const { runner, executions } = await setup(definition);

    const parked = await runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") });
    expect(parked.stopped).toBe("waiting");
    expect(parked.execution.waitingFor).toEqual({ kind: "human", interactionId: "int-1" });
    expect((await executions.get({ tenantId: context().tenantId, executionId: "exec-1" }))?.status).toBe("waiting");

    const done = await runner.resumeWith(context(), "exec-1", "yes");
    expect(done.execution.status).toBe("completed");
    expect(done.execution.state).toMatchObject({ decision: "yes" });
  });

  it("wakes everything parked on a signal, and only that signal", async () => {
    const definition = flow([
      { name: "hold", kind: "wait", forSignal: "invoice.paid", next: "end", assignTo: "payment" },
      { name: "end", kind: "done" },
    ]);
    const { runner, definitions, executions } = await setup(definition);
    await definitions.put({
      tenantId: context().tenantId,
      definition: {
        flowId: "other",
        version: 1,
        name: "other",
        kind: "flow",
        definition: flow([{ name: "hold", kind: "wait", forSignal: "shipped", next: "end" }, { name: "end", kind: "done" }], { id: "other" }),
        createdAt: "2026-08-26T10:00:00.000Z",
      },
    });

    const a = await runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") });
    const b = await runner.start(context(), { flowId: "other", runId: asId<RunId>("r2") });
    expect(a.stopped).toBe("waiting");
    expect(b.stopped).toBe("waiting");

    const woken = await runner.deliverSignal(context(), "invoice.paid", { amount: 100 });
    expect(woken).toHaveLength(1);
    expect(woken[0]?.execution.state).toMatchObject({ payment: { amount: 100 } });
    // The other one is untouched: a signal must not resume something that never asked for it.
    expect((await executions.get({ tenantId: context().tenantId, executionId: b.execution.id }))?.status).toBe("waiting");
  });
});

describe("the worker's slice is not the flow's budget", () => {
  it("hands the slot back rather than holding it, and continues on the next call", async () => {
    /**
     * Two different concerns that would otherwise share one number: the flow's ceiling is how much work it may
     * do, and the slice is how long one worker holds a slot. A long flow should be resumable rather than owning a
     * worker for an hour.
     */
    const steps: FlowStep[] = Array.from({ length: 8 }, (_, index) => ({
      name: `s${index}`,
      kind: "tool" as const,
      tool: "t",
      input: {},
      next: index === 7 ? "end" : `s${index + 1}`,
    }));
    const definition = flow([...steps, { name: "end", kind: "done" }], { budget: { maxSteps: 50 } });

    const definitions = createMemoryFlowDefinitionStore();
    const executions = createMemoryFlowExecutionStore();
    await definitions.put({
      tenantId: context().tenantId,
      definition: { flowId: "f1", version: 1, name: "t", kind: "flow", definition, createdAt: "2026-08-26T10:00:00.000Z" },
    });
    const runner = createFlowRunner({
      definitions,
      executions,
      handler: recorder().handler,
      idFactory: () => "exec-1",
      maxEffectsPerCall: 3,
    });

    const first = await runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") });
    expect(first.stopped).toBe("slice-exhausted");
    expect(first.execution.status).toBe("running");

    let result = first;
    for (let i = 0; i < 5 && result.stopped === "slice-exhausted"; i += 1) {
      result = await runner.resume(context(), "exec-1");
    }
    expect(result.execution.status).toBe("completed");
  });
});

describe("a step kind the deployment did not wire", () => {
  it("says which handler is missing rather than failing generically", async () => {
    const definition = flow([{ name: "t", kind: "team", teamId: "team-1", prompt: "go", next: "end" }, { name: "end", kind: "done" }]);
    const { runner } = await setup(definition);
    const result = await runner.start(context(), { flowId: "f1", runId: asId<RunId>("r1") });
    expect(result.execution.status).toBe("failed");
    expect(result.execution.detail).toContain("no team handler wired");
  });
});
