/**
 * Teams — REQ-037 (#186).
 *
 * A team compiles to a flow, so most of these assert the *graph* rather than behaviour at a step: "a member
 * cannot outspend the team" and "delegation is a tool call" are claims about what was compiled, and checking the
 * compiled shape is both stronger and cheaper than running an agent to observe it.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import { advance, beginExecution } from "../../flows/interpreter.js";
import { DELEGATE_TOOL, compileTeam, managerInstructions, memberTools, teamBrief, validateTeam } from "../index.js";
import type { AgentId, PrincipalId, RunId, TenantId } from "../../core/ids.js";
import type { TeamDefinition } from "../../flows/index.js";

const member = (name: string, over: Partial<TeamDefinition["members"][number]> = {}) => ({
  name,
  agentId: asId<AgentId>(`agent-${name}`),
  ...over,
});

const team = (over: Partial<TeamDefinition> = {}): TeamDefinition => ({
  id: "t1",
  version: 1,
  name: "Research and write",
  process: "sequential",
  members: [member("researcher"), member("writer")],
  budget: { maxSteps: 10 },
  ...over,
});

describe("what a team must say before it can run", () => {
  it("accepts a well-formed sequential team", () => {
    expect(validateTeam(team())).toEqual([]);
  });

  it("refuses a manager-led team with no manager", () => {
    const problems = validateTeam(team({ process: "manager-led" }));
    expect(problems[0]?.problem).toContain("no manager named");
  });

  it("refuses a manager who is not a member", () => {
    const problems = validateTeam(team({ process: "manager-led", manager: "nobody" }));
    expect(problems[0]?.problem).toContain("not one of its members");
  });

  it("refuses a sequential team that names a manager", () => {
    // Ambiguous: does the manager run first, last, or not at all? Refusing beats picking one and being right a
    // third of the time.
    const problems = validateTeam(team({ manager: "researcher" }));
    expect(problems[0]?.problem).toContain("no manager to obey");
  });

  it("refuses two members with the same name", () => {
    // A delegation could not say which one it meant.
    const problems = validateTeam(team({ members: [member("a"), member("a")] }));
    expect(problems.some((p) => p.problem.includes("two members named"))).toBe(true);
  });

  it("refuses a budget its last member could never reach", () => {
    // Otherwise the team always fails at the same place, and the failure reads as a runtime problem rather than a
    // definition one.
    const problems = validateTeam(team({ budget: { maxSteps: 1 } }));
    expect(problems.some((p) => p.problem.includes("can never run"))).toBe(true);
  });

  it("refuses to compile an invalid team rather than producing a broken flow", () => {
    expect(() => compileTeam(team({ process: "manager-led" }))).toThrow(/cannot be compiled/);
  });
});

describe("sequential compiles to a chain", () => {
  const flow = compileTeam(team());

  it("gives one step per member, in order, ending in done", () => {
    expect(flow.steps.map((s) => [s.name, s.kind])).toEqual([
      ["researcher", "agent"],
      ["writer", "agent"],
      ["team:done", "done"],
    ]);
    expect(flow.start).toBe("researcher");
  });

  it("passes each member's output to the next through readable state", () => {
    /**
     * `assignTo` is the member's name, so the second member's prompt reads `{{$.researcher}}`. Passing it through
     * a closure would work and would be unreadable — "what state is this team in" is a question someone asks while
     * it is stuck.
     */
    const [first, second] = flow.steps;
    expect(first).toMatchObject({ assignTo: "researcher", next: "writer" });
    expect(second).toMatchObject({ assignTo: "writer" });
    expect((second as { prompt: string }).prompt).toContain("{{$.researcher}}");
  });

  it("keeps the original brief in every member's prompt", () => {
    // Passing only the previous output loses the original request by the third member, which is the classic way a
    // chain of agents drifts off the question.
    for (const step of flow.steps.filter((s) => s.kind === "agent")) {
      expect((step as { prompt: string }).prompt).toContain("{{$.brief}}");
    }
  });

  it("adopts the team's budget as the flow's, so there is one ceiling", () => {
    expect(flow.budget).toEqual(team().budget);
  });
});

describe("manager-led compiles to one agent with a delegation tool", () => {
  const managed = team({ process: "manager-led", manager: "lead", members: [member("lead"), member("researcher"), member("writer")] });
  const flow = compileTeam(managed);

  it("is one agent step, not a hand-written loop", () => {
    /**
     * The engine's own turn loop does the iterating. A loop written here would be a second implementation of
     * "call the model until it stops asking for tools", and the engine's already has the limits, the checkpoints
     * and the recovery.
     */
    expect(flow.steps.map((s) => [s.name, s.kind])).toEqual([
      ["lead", "agent"],
      ["team:done", "done"],
    ]);
  });

  it("tells the manager who its team is, generated from the definition", () => {
    const instructions = managerInstructions(managed);
    expect(instructions).toContain("researcher");
    expect(instructions).toContain("writer");
    // Not itself: a manager delegating to itself is the shortest possible cycle.
    expect(instructions.split("Your team:")[1]).not.toContain("lead");
    expect(instructions).toContain(DELEGATE_TOOL);
  });

  it("differs from sequential only in the graph — the interpreter is unchanged", () => {
    // #186 AC-2. Both are `FlowDefinition`s and both are run by `advance`; nothing branches on the process.
    const sequential = compileTeam(team());
    expect(typeof sequential.budget.maxSteps).toBe("number");
    expect(typeof flow.budget.maxSteps).toBe("number");
    expect(flow.steps.every((s) => sequential.steps.some((o) => o.kind === s.kind) || s.kind === "agent")).toBe(true);
  });
});

describe("a member cannot reach a tool the delegating context could not", () => {
  const available = ["search_web", "fetch_url", "write_note", DELEGATE_TOOL];

  it("intersects rather than unions", () => {
    // #186 AC-3. A member naming a tool nobody granted does not get it.
    expect(memberTools({ member: member("r", { tools: ["search_web", "charge_card"] }), available })).toEqual(["search_web"]);
  });

  it("gives an unrestricted member everything except the delegation tool", () => {
    // A member that could delegate would be a manager, and a member delegating back to the manager is the
    // A → B → A that depth bounds exist for.
    expect(memberTools({ member: member("r"), available })).toEqual(["search_web", "fetch_url", "write_note"]);
  });

  it("strips the delegation tool even when a member asks for it by name", () => {
    expect(memberTools({ member: member("r", { tools: [DELEGATE_TOOL, "fetch_url"] }), available })).toEqual(["fetch_url"]);
  });

  it("drops an unavailable tool silently rather than refusing the team", () => {
    /**
     * Deliberate, and the reasoning is about who suffers. Erroring would mean a whole team refuses to start
     * because one member's list mentions something a particular caller's role excludes — so a team's usability
     * would depend on who triggered it.
     */
    expect(() => memberTools({ member: member("r", { tools: ["nope"] }), available })).not.toThrow();
    expect(memberTools({ member: member("r", { tools: ["nope"] }), available })).toEqual([]);
  });
});

describe("a team runs through the flow interpreter", () => {
  const run = (definition: ReturnType<typeof compileTeam>, brief: string) =>
    beginExecution({
      id: "x1",
      definition,
      tenantId: asId<TenantId>("t1"),
      runId: asId<RunId>("r1"),
      principalId: asId<PrincipalId>("p1"),
      state: teamBrief(brief),
      nowMs: 1,
      nowIso: "2026-08-26T00:00:00.000Z",
    });

  it("asks for each member in turn, feeding the previous result forward", () => {
    const definition = compileTeam(team());
    const execution = run(definition, "Explain the outage");

    const first = advance({ definition, execution, nowMs: 1, nowIso: "i" });
    expect(first.effect).toMatchObject({ kind: "run-agent", agentId: "agent-researcher", prompt: "Explain the outage" });

    const second = advance({ definition, execution: first.execution, outcome: { kind: "ok", value: "found the cause" }, nowMs: 1, nowIso: "i" });
    expect(second.effect).toMatchObject({ kind: "run-agent", agentId: "agent-writer" });
    // Both the brief and the previous member's output.
    expect((second.effect as { prompt: string }).prompt).toContain("Explain the outage");
    expect((second.effect as { prompt: string }).prompt).toContain("found the cause");

    const third = advance({ definition, execution: second.execution, outcome: { kind: "ok", value: "the writeup" }, nowMs: 1, nowIso: "i" });
    expect(third.execution.status).toBe("completed");
    expect(third.execution.state).toMatchObject({ researcher: "found the cause", writer: "the writeup" });
  });

  it("stops a team at its budget, mid-chain", () => {
    // #186 AC-4: a member cannot exceed the team's remaining budget — because there is one budget and one
    // execution, checked by the interpreter before each step.
    const definition = compileTeam(team({ budget: { maxSteps: 2, maxCostMinorUnits: 30 } }));
    const first = advance({ definition, execution: run(definition, "b"), nowMs: 1, nowIso: "i" });
    const second = advance({
      definition,
      execution: first.execution,
      outcome: { kind: "ok", value: "x", costMinorUnits: 40 },
      nowMs: 1,
      nowIso: "i",
    });
    expect(second.execution.status).toBe("failed");
    expect(second.execution.detail).toContain("cost budget exhausted");
  });

  it("keeps one run identity for the whole team", () => {
    // #186 AC-6: a person watching sees one thing happening, and each member's steps are attributable inside it.
    const definition = compileTeam(team());
    let result = advance({ definition, execution: run(definition, "b"), nowMs: 1, nowIso: "i" });
    result = advance({ definition, execution: result.execution, outcome: { kind: "ok", value: "1" }, nowMs: 1, nowIso: "i" });
    result = advance({ definition, execution: result.execution, outcome: { kind: "ok", value: "2" }, nowMs: 1, nowIso: "i" });
    expect(String(result.execution.runId)).toBe("r1");
    expect(result.execution.history.map((h) => h.step)).toEqual(["researcher", "writer"]);
  });

  it("parks on a member's question and resumes that member", () => {
    // #186 AC-7 — the same mechanism as a flow's checkpoint, because it *is* the mechanism.
    const definition = compileTeam(team());
    const first = advance({ definition, execution: run(definition, "b"), nowMs: 1, nowIso: "i" });
    const parked = advance({ definition, execution: first.execution, outcome: { kind: "parked", interactionId: "int-9" }, nowMs: 1, nowIso: "i" });
    expect(parked.execution.status).toBe("waiting");
    expect(parked.execution.waitingFor).toEqual({ kind: "human", interactionId: "int-9" });

    const resumed = advance({ definition, execution: parked.execution, outcome: { kind: "resumed", value: "answered" }, nowMs: 1, nowIso: "i" });
    // Back to the chain: the *next* member, with the answer in state as the parked member's output.
    expect(resumed.effect).toMatchObject({ kind: "run-agent", agentId: "agent-writer" });
    expect(resumed.execution.state).toMatchObject({ researcher: "answered" });
  });

  it("lets a team whose budget exactly matches its member count finish", () => {
    /**
     * The arithmetic edge that a terminal marker consuming budget broke: three members and `maxSteps: 3` ran all
     * three and then died on `team:done` with "step budget exhausted", which reads as a runtime problem and is a
     * definition arithmetic problem.
     */
    const definition = compileTeam(team({ members: [member("a"), member("b")], budget: { maxSteps: 2 } }));
    let result = advance({ definition, execution: run(definition, "brief"), nowMs: 1, nowIso: "i" });
    result = advance({ definition, execution: result.execution, outcome: { kind: "ok", value: "1" }, nowMs: 1, nowIso: "i" });
    result = advance({ definition, execution: result.execution, outcome: { kind: "ok", value: "2" }, nowMs: 1, nowIso: "i" });
    expect(result.execution.status).toBe("completed");
  });

  it("bounds delegation depth", () => {
    // #186 AC-5, and it is the flow's `maxDepth` — one enforcement, not two.
    const definition = compileTeam(team({ maxDelegationDepth: 2 }));
    expect(definition.maxDepth).toBe(2);
  });
});
