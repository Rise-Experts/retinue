/**
 * The flow interpreter — REQ-038 (#187).
 *
 * Every test here is a function call and an assertion: no agent, no database, no clock, no mocks. That is the
 * payoff of a pure `advance`, and it is why the awkward cases — a restart mid-flow, a budget exhausted between
 * steps, a retry surviving a process death — are testable at all rather than being reasoned about.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import { advance, beginExecution, interpolate, readPath } from "../interpreter.js";
import type { FlowDefinition, FlowExecution, FlowStep } from "../index.js";
import type { PrincipalId, RunId, TenantId } from "../../core/ids.js";

const NOW = 1_700_000_000_000;
const ISO = "2026-08-26T12:00:00.000Z";

const flow = (steps: readonly FlowStep[], over: Partial<FlowDefinition> = {}): FlowDefinition => ({
  id: "f1",
  version: 1,
  name: "test",
  steps,
  start: steps[0]?.name ?? "a",
  budget: { maxSteps: 20 },
  ...over,
});

const start = (definition: FlowDefinition, state: Record<string, unknown> = {}): FlowExecution =>
  beginExecution({
    id: "x1",
    definition,
    tenantId: asId<TenantId>("t1"),
    runId: asId<RunId>("r1"),
    principalId: asId<PrincipalId>("p1"),
    state,
    nowMs: NOW,
    nowIso: ISO,
  });

const step = (definition: FlowDefinition, execution: FlowExecution, outcome?: Parameters<typeof advance>[0]["outcome"]) =>
  advance({ definition, execution, ...(outcome === undefined ? {} : { outcome }), nowMs: NOW, nowIso: ISO });

describe("state paths", () => {
  it("reads a nested value and returns undefined rather than throwing", () => {
    const state = { order: { total: 42, lines: [{ sku: "a" }] } };
    expect(readPath(state, "$.order.total")).toBe(42);
    expect(readPath(state, "order.lines.0.sku")).toBe("a");
    expect(readPath(state, "$.order.missing.deep")).toBeUndefined();
  });

  it("substitutes into a template, and an absent path becomes empty rather than the literal braces", () => {
    // A prompt containing `{{$.name}}` for a name nobody set is a prompt that reads as broken to the model. An
    // empty string is at least a sentence.
    expect(interpolate("Hello {{$.name}}, total {{$.order.total}}", { name: "Ada", order: { total: 7 } })).toBe(
      "Hello Ada, total 7",
    );
    expect(interpolate("Hello {{$.nobody}}!", {})).toBe("Hello !");
  });
});

describe("a step at a time", () => {
  it("asks for the first step, then the next, then settles", () => {
    const definition = flow([
      { name: "a", kind: "agent", agentId: asId("ag"), prompt: "do a", next: "b", assignTo: "first" },
      { name: "b", kind: "done" },
    ]);
    const first = step(definition, start(definition));
    expect(first.effect).toMatchObject({ kind: "run-agent", prompt: "do a" });

    const second = step(definition, first.execution, { kind: "ok", value: "done a" });
    // `b` is a `done`, so one call carries it through to settled rather than asking the host to perform nothing.
    expect(second.effect.kind).toBe("settled");
    expect(second.execution.status).toBe("completed");
    expect(second.execution.state).toEqual({ first: "done a" });
  });

  it("interpolates a prompt from state written by an earlier step", () => {
    const definition = flow([
      { name: "a", kind: "tool", tool: "lookup", input: {}, next: "b", assignTo: "customer" },
      { name: "b", kind: "agent", agentId: asId("ag"), prompt: "Write to {{$.customer.name}}", next: "c" },
      { name: "c", kind: "done" },
    ]);
    const first = step(definition, start(definition));
    const second = step(definition, first.execution, { kind: "ok", value: { name: "Ada" } });
    expect(second.effect).toMatchObject({ kind: "run-agent", prompt: "Write to Ada" });
  });

  it("sends a whole-value reference as the value, not as its JSON text", () => {
    /**
     * `{"id": "{{$.n}}"}` on a number must send a number. Stringifying it silently changes the tool's input type,
     * and the tool's schema then rejects it for a reason that points at the tool rather than at the flow.
     */
    const definition = flow([
      { name: "a", kind: "tool", tool: "charge", input: { amount: "{{$.total}}", note: "for {{$.total}} units" }, next: "b" },
      { name: "b", kind: "done" },
    ]);
    const result = step(definition, start(definition, { total: 42 }));
    expect(result.effect).toMatchObject({ kind: "call-tool", input: { amount: 42, note: "for 42 units" } });
  });

  it("discards a result when no assignTo is named", () => {
    // A step whose output nothing reads should say so, rather than accumulating state a later reader has to guess
    // the relevance of.
    const definition = flow([
      { name: "a", kind: "tool", tool: "ping", input: {}, next: "b" },
      { name: "b", kind: "done" },
    ]);
    const after = step(definition, step(definition, start(definition)).execution, { kind: "ok", value: "pong" });
    expect(after.execution.state).toEqual({});
  });
});

describe("branching", () => {
  const definition = flow([
    {
      name: "check",
      kind: "branch",
      cases: [
        { path: "$.total", operator: "greater-than", value: 100, next: "big" },
        { path: "$.flagged", operator: "exists", next: "review" },
      ],
      otherwise: "small",
    },
    { name: "big", kind: "done", outcome: "big" },
    { name: "review", kind: "done", outcome: "review" },
    { name: "small", kind: "done", outcome: "small" },
  ]);

  it("takes the first matching case", () => {
    expect(step(definition, start(definition, { total: 500 })).execution.detail).toBe("big");
    expect(step(definition, start(definition, { total: 5, flagged: true })).execution.detail).toBe("review");
    expect(step(definition, start(definition, { total: 5 })).execution.detail).toBe("small");
  });

  it("costs a step, because a loop of branches is a loop", () => {
    const result = step(definition, start(definition, { total: 500 }));
    expect(result.execution.spend.steps).toBeGreaterThan(0);
  });

  it("fails rather than falling through when nothing matches and there is no otherwise", () => {
    // Completing would be guessing that falling through was intended. The message names the step.
    const strict = flow([
      { name: "check", kind: "branch", cases: [{ path: "$.x", operator: "equals", value: 1, next: "end" }] },
      { name: "end", kind: "done" },
    ]);
    const result = step(strict, start(strict, { x: 2 }));
    expect(result.execution.status).toBe("failed");
    expect(result.execution.detail).toContain("no branch matched");
  });

  it("compares only like types for the numeric operators", () => {
    // `"5" > 100` is a comparison somebody meant, and answering it either way is worse than not matching: the
    // definition is wrong and the flow should take `otherwise` rather than silently pick a branch.
    expect(step(definition, start(definition, { total: "500" })).execution.detail).toBe("small");
  });
});

describe("failure policy", () => {
  const withPolicy = (policy: FlowStep["onFailure"]) =>
    flow([
      { name: "a", kind: "tool", tool: "t", input: {}, next: "b", ...(policy === undefined ? {} : { onFailure: policy }) },
      { name: "b", kind: "done" },
    ]);

  it("fails the flow by default", () => {
    const definition = withPolicy(undefined);
    const after = step(definition, step(definition, start(definition)).execution, { kind: "failed", error: "boom" });
    expect(after.execution.status).toBe("failed");
    expect(after.execution.detail).toContain("boom");
  });

  it("retries up to the bound, then fails naming the count", () => {
    const definition = withPolicy({ action: "retry", maxAttempts: 3 });
    let execution = step(definition, start(definition)).execution;
    for (const expected of [1, 2]) {
      const retried = step(definition, execution, { kind: "failed", error: "boom" });
      expect(retried.execution.attempt).toBe(expected);
      expect(retried.execution.status).toBe("running");
      execution = retried.execution;
    }
    const final = step(definition, execution, { kind: "failed", error: "boom" });
    expect(final.execution.status).toBe("failed");
    expect(final.execution.detail).toContain("after 3 attempts");
  });

  it("gives a retry a different idempotency key, so it is an attempt and not a replay", () => {
    /**
     * The subtle one. If a retry reused the key, the idempotency store would answer with the *failed* first
     * result and the retry would never happen — a retry policy that silently does nothing.
     */
    const definition = withPolicy({ action: "retry", maxAttempts: 3 });
    const first = step(definition, start(definition));
    const retried = step(definition, first.execution, { kind: "failed", error: "boom" });
    const second = step(definition, retried.execution);
    expect(first.effect).toMatchObject({ idempotencyKey: "flow:x1:a:0" });
    expect(second.effect).toMatchObject({ idempotencyKey: "flow:x1:a:1" });
  });

  it("skips to the next step, keeping the flow alive", () => {
    const definition = withPolicy({ action: "skip" });
    const after = step(definition, step(definition, start(definition)).execution, { kind: "failed", error: "boom" });
    expect(after.execution.status).toBe("running");
    expect(after.execution.currentStep).toBe("b");
    expect(after.execution.history.at(-1)).toMatchObject({ outcome: "failed", step: "a" });
  });

  it("charges for a failed step that spent money", () => {
    // Not charging for failures is how a retrying flow costs more than its ceiling allows.
    const definition = withPolicy({ action: "skip" });
    const after = step(definition, step(definition, start(definition)).execution, {
      kind: "failed",
      error: "boom",
      costMinorUnits: 25,
    });
    expect(after.execution.spend.costMinorUnits).toBe(25);
  });

  it("records an escalation as such, so an enclosing scope can act on it", () => {
    const definition = withPolicy({ action: "escalate" });
    const after = step(definition, step(definition, start(definition)).execution, { kind: "failed", error: "boom" });
    expect(after.execution.status).toBe("failed");
    expect(after.execution.detail).toContain("escalated from a");
  });
});

describe("budgets stop the next step, not the last one", () => {
  it("refuses to produce an effect once the step budget is gone", () => {
    /**
     * The ordering is the property. Checking after a step returns is too late — the money is spent and the
     * external write has happened. So an over-budget flow performs *nothing*: `settled`, not one more call.
     */
    const definition = flow(
      [
        { name: "a", kind: "tool", tool: "t", input: {}, next: "a" },
      ],
      { budget: { maxSteps: 3 } },
    );
    let result = step(definition, start(definition));
    let guard = 0;
    while (result.effect.kind !== "settled" && guard < 50) {
      result = step(definition, result.execution, { kind: "ok" });
      guard += 1;
    }
    expect(result.execution.status).toBe("failed");
    expect(result.execution.detail).toContain("step budget exhausted");
    expect(result.execution.spend.steps).toBe(3);
  });

  it("stops on cost even when steps remain", () => {
    const definition = flow(
      [{ name: "a", kind: "tool", tool: "t", input: {}, next: "a" }],
      { budget: { maxSteps: 100, maxCostMinorUnits: 50 } },
    );
    let result = step(definition, start(definition));
    let guard = 0;
    while (result.effect.kind !== "settled" && guard < 50) {
      result = step(definition, result.execution, { kind: "ok", costMinorUnits: 20 });
      guard += 1;
    }
    expect(result.execution.detail).toContain("cost budget exhausted");
  });

  it("stops on wall clock, which neither of the others catches", () => {
    // A flow parked on a webhook consumes no steps and no money. This is the only ceiling that ends it.
    const definition = flow([{ name: "a", kind: "tool", tool: "t", input: {}, next: "a" }], {
      budget: { maxSteps: 100, maxWallClockMs: 60_000 },
    });
    const execution = start(definition);
    const late = advance({ definition, execution, nowMs: NOW + 61_000, nowIso: ISO });
    expect(late.execution.status).toBe("failed");
    expect(late.execution.detail).toContain("wall-clock budget exhausted");
  });
});

describe("waiting and resuming", () => {
  it("parks on a human checkpoint through the HITL path and resumes with the answer", () => {
    const definition = flow([
      { name: "ask", kind: "checkpoint", question: "Approve {{$.what}}?", options: ["yes", "no"], next: "end", assignTo: "answer" },
      { name: "end", kind: "done" },
    ]);
    const asked = step(definition, start(definition, { what: "the refund" }));
    expect(asked.effect).toMatchObject({ kind: "ask-human", question: "Approve the refund?", options: ["yes", "no"] });

    const parked = step(definition, asked.execution, { kind: "parked", interactionId: "int-1" });
    expect(parked.execution.status).toBe("waiting");
    expect(parked.execution.waitingFor).toEqual({ kind: "human", interactionId: "int-1" });

    const resumed = step(definition, parked.execution, { kind: "resumed", value: "yes" });
    expect(resumed.execution.status).toBe("completed");
    // Both: the flow started with `what` and the checkpoint added `answer`. State accumulates, which is the
    // point of it — a later step reading `$.what` must still find it.
    expect(resumed.execution.state).toEqual({ what: "the refund", answer: "yes" });
    // The wait is cleared by omission, so a serialised execution carries no null field to interpret.
    expect("waitingFor" in resumed.execution).toBe(false);
  });

  it("parks on a signal and names it", () => {
    const definition = flow([
      { name: "hold", kind: "wait", forSignal: "invoice.paid", next: "end" },
      { name: "end", kind: "done" },
    ]);
    const waiting = step(definition, start(definition));
    expect(waiting.effect).toEqual({ kind: "await-signal", signal: "invoice.paid" });
    expect(waiting.execution.waitingFor).toEqual({ kind: "signal", signal: "invoice.paid" });
  });

  it("parks on a duration, computed from the clock it was given", () => {
    const definition = flow([
      { name: "hold", kind: "wait", forMs: 5_000, next: "end" },
      { name: "end", kind: "done" },
    ]);
    const waiting = step(definition, start(definition));
    expect(waiting.effect).toEqual({ kind: "sleep", untilMs: NOW + 5_000 });
  });
});

describe("a restart mid-flow", () => {
  it("asks for the same effect, with the same idempotency key", () => {
    /**
     * #187 AC-9, and the reason it is a property rather than a mechanism: a host that persisted the execution and
     * then died reloads it and calls `advance` with no outcome. Because the key is derived from
     * `(executionId, step, attempt)` and all three are in the stored state, the key is identical — so a step that
     * performed an external write and crashed before reporting is answered from the idempotency store rather than
     * performed twice.
     */
    const definition = flow([
      { name: "charge", kind: "tool", tool: "charge_card", input: { amount: 100 }, next: "end" },
      { name: "end", kind: "done" },
    ]);
    const before = step(definition, start(definition));

    // The process dies here. The execution is what was on disk.
    const reloaded: FlowExecution = JSON.parse(JSON.stringify(before.execution));
    const after = advance({ definition, execution: reloaded, nowMs: NOW + 30_000, nowIso: ISO });

    expect(after.effect).toEqual(before.effect);
  });

  it("resumes a settled execution as a no-op rather than an error", () => {
    // A worker re-delivering a job for a finished flow is a normal event.
    const definition = flow([{ name: "a", kind: "done" }]);
    const done = step(definition, start(definition));
    const again = step(definition, done.execution);
    expect(again.execution).toEqual(done.execution);
    expect(again.effect.kind).toBe("settled");
  });
});

describe("bounded nesting", () => {
  it("refuses a subflow past the depth limit, naming the depth", () => {
    // A → B → A terminates here. The cycle is only knowable at run time, because a subflow reference is resolved
    // then — so the bound is on depth rather than on a graph walk.
    const definition = flow([{ name: "a", kind: "subflow", flowId: "other", next: "end" }, { name: "end", kind: "done" }], {
      maxDepth: 2,
    });
    const deep: FlowExecution = { ...start(definition), depth: 3 };
    const result = advance({ definition, execution: deep, nowMs: NOW, nowIso: ISO });
    expect(result.execution.status).toBe("failed");
    expect(result.execution.detail).toContain("nesting depth 3");
  });

  it("passes the incremented depth to the subflow, so the bound accumulates", () => {
    const definition = flow([{ name: "a", kind: "subflow", flowId: "other", next: "end" }, { name: "end", kind: "done" }]);
    const result = step(definition, { ...start(definition), depth: 1 });
    expect(result.effect).toMatchObject({ kind: "run-subflow", depth: 2 });
  });
});

describe("a definition that names a step it does not have", () => {
  it("fails with the name rather than guessing", () => {
    const definition = flow([{ name: "a", kind: "tool", tool: "t", input: {}, next: "nowhere" }]);
    const after = step(definition, step(definition, start(definition)).execution, { kind: "ok" });
    expect(after.execution.status).toBe("failed");
    expect(after.execution.detail).toContain('"nowhere" is not defined');
  });
});

describe("history is attributable", () => {
  it("records every step with its outcome and attempt", () => {
    const definition = flow([
      { name: "a", kind: "tool", tool: "t", input: {}, next: "b", onFailure: { action: "retry", maxAttempts: 2 } },
      { name: "b", kind: "done" },
    ]);
    const asked = step(definition, start(definition));
    const failed = step(definition, asked.execution, { kind: "failed", error: "boom" });
    const retried = step(definition, failed.execution);
    const ok = step(definition, retried.execution, { kind: "ok", costMinorUnits: 5 });

    expect(ok.execution.history.map((h) => [h.step, h.outcome, h.attempt])).toEqual([
      ["a", "failed", 0],
      ["a", "ok", 1],
    ]);
    expect(ok.execution.history.at(-1)?.costMinorUnits).toBe(5);
  });
});
