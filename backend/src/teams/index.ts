/**
 * Teams — REQ-037 (#186).
 *
 * ## A team compiles to a flow
 *
 * There is no team interpreter. `compileTeam` turns a `TeamDefinition` into a `FlowDefinition`, and the flow
 * interpreter runs it. That is the whole design, and it is what makes #186's acceptance criteria properties rather
 * than features to add:
 *
 * - **AC-2, "the difference is a property of the team rather than two code paths"** — both processes compile to a
 *   flow. `sequential` produces a chain of agent steps; `manager-led` produces one agent step whose tools include
 *   a delegation tool. The interpreter does not know which it is running.
 * - **AC-4, budgets compose** — a team's budget *is* the compiled flow's budget, checked by the same code that
 *   checks a flow's. A member cannot exceed the team's remaining budget because the check is on the execution's
 *   spend, and there is one execution.
 * - **AC-5, bounded recursion** — `maxDepth` on the compiled flow, enforced by the interpreter. A → B → A
 *   terminates for the same reason a nested subflow does.
 * - **AC-6, one run identity** — one `FlowExecution`, so one `runId`. Each member's steps are attributable inside
 *   it through `StepRecord.member`.
 * - **AC-7, HITL inside a team** — a member's question parks the execution exactly as a flow's checkpoint does,
 *   because it *is* the same mechanism.
 * - **AC-8, a member failing is modelled** — `onFailure` per step, chosen by the team.
 *
 * Writing a second interpreter would have meant a second answer to each of those, and the second answer is the one
 * that gets a fix late.
 *
 * ## Manager-led is one agent turn with a delegation tool
 *
 * The obvious design is a loop: ask the manager who is next, run them, ask again. The better one is to give the
 * manager a *tool* that runs a member, and let the engine's existing turn loop do the iterating — because #186
 * AC-3 asks that "delegation is a tool call, so it inherits authorization, approval, idempotency and accounting
 * unchanged", and the way to inherit those unchanged is to be a tool call rather than to resemble one.
 *
 * So a delegation is a real entry in the registry. It is authorised like any tool, its result is recorded like any
 * tool's, its cost lands on the run like any tool's, and a retry deduplicates like any tool's.
 */

import { AgentPlatformError } from "../core/errors.js";
import { DEFAULT_MAX_DEPTH } from "../flows/index.js";
import type { FlowDefinition, FlowStep, TeamDefinition, TeamMember } from "../flows/index.js";

export const DEFAULT_DELEGATION_DEPTH = 3;

/**
 * The tool a manager calls to hand work to a member.
 *
 * Named once, here, because three things have to agree on it: the compiled flow that puts it in the manager's
 * tool set, the registry entry that implements it, and the guard that stops a member reaching it recursively.
 */
export const DELEGATE_TOOL = "delegate_to_member";

export type TeamCompileProblem = { readonly team: string; readonly problem: string };

/**
 * Is this team runnable at all?
 *
 * Checked before compiling rather than discovered while running, because every one of these produces a flow that
 * fails at a step rather than a definition that fails to load — and a definition that only fails once someone
 * triggers it is a definition that fails in front of a customer.
 */
export const validateTeam = (team: TeamDefinition): readonly TeamCompileProblem[] => {
  const problems: TeamCompileProblem[] = [];
  const at = (problem: string) => problems.push({ team: team.id, problem });

  if (team.members.length === 0) at("has no members");

  const names = new Set<string>();
  for (const member of team.members) {
    if (member.name.trim() === "") at("has a member with no name");
    if (names.has(member.name)) at(`has two members named "${member.name}" — a delegation could not say which`);
    names.add(member.name);
  }

  if (team.process === "manager-led") {
    if (team.manager === undefined) at("is manager-led with no manager named");
    else if (!names.has(team.manager)) at(`names "${team.manager}" as manager, which is not one of its members`);
  } else if (team.manager !== undefined) {
    // A sequential team with a manager is ambiguous: does the manager run first, last, or not at all? Refusing is
    // better than picking one and being right a third of the time.
    at("is sequential but names a manager — a sequential team has no manager to obey");
  }

  if (team.budget.maxSteps < team.members.length && team.process === "sequential") {
    // A sequential team whose budget cannot reach its last member is a team that always fails at the same place,
    // and the failure would read as a runtime problem rather than a definition one.
    at(`has ${team.members.length} members and a budget of ${team.budget.maxSteps} steps, so its last member can never run`);
  }

  return problems;
};

/**
 * Turn a team into the flow that runs it.
 *
 * Pure, so a team's shape can be asserted without executing anything — which matters more than usual here,
 * because the interesting claims are about the *graph* ("a member cannot outspend the team", "delegation is a
 * tool") rather than about behaviour at a step.
 */
export const compileTeam = (team: TeamDefinition): FlowDefinition => {
  const problems = validateTeam(team);
  if (problems.length > 0) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `team ${team.id} cannot be compiled: ${problems.map((p) => p.problem).join("; ")}`,
      retryable: false,
    });
  }

  const steps: FlowStep[] =
    team.process === "sequential" ? sequentialSteps(team) : managerLedSteps(team);

  return {
    id: `team:${team.id}`,
    version: team.version,
    name: team.name,
    description: `Compiled from team ${team.id} (${team.process})`,
    steps,
    start: steps[0]!.name,
    // The team's budget *is* the flow's. One budget, checked by one piece of code — so "a member cannot exceed
    // the team's remaining budget" needs no separate enforcement.
    budget: team.budget,
    maxDepth: team.maxDelegationDepth ?? DEFAULT_DELEGATION_DEPTH,
  };
};

/**
 * Each member in turn, each reading the previous one's output.
 *
 * `assignTo` is the member's name, so a later member's prompt can reference `{{$.researcher}}` — which is how one
 * agent's output becomes another's input "inside a single unit of work", and it is readable in the stored state
 * rather than threaded through a closure nobody can inspect.
 */
const sequentialSteps = (team: TeamDefinition): FlowStep[] => {
  const steps: FlowStep[] = team.members.map((member, index) => {
    const next = index + 1 < team.members.length ? team.members[index + 1]!.name : "team:done";
    return {
      name: member.name,
      kind: "agent",
      agentId: member.agentId,
      ...(member.instructions === undefined ? {} : { instructions: member.instructions }),
      /**
       * The task, plus what came before.
       *
       * The first member sees the team's brief; every later one sees the brief *and* the previous member's output.
       * Passing only the previous output would lose the original request by the third member, which is the classic
       * way a chain of agents drifts off the question.
       */
      prompt:
        index === 0
          ? "{{$.brief}}"
          : `{{$.brief}}\n\nWhat ${team.members[index - 1]!.name} produced:\n{{$.${team.members[index - 1]!.name}}}`,
      assignTo: member.name,
      next,
    };
  });
  steps.push({ name: "team:done", kind: "done" });
  return steps;
};

/**
 * One step: the manager, with a delegation tool.
 *
 * The engine's own turn loop does the iterating, bounded by the agent's execution limits — so there is no
 * hand-written loop here to get wrong, and a delegation is a tool call rather than something shaped like one.
 */
const managerLedSteps = (team: TeamDefinition): FlowStep[] => [
  {
    name: team.manager!,
    kind: "agent",
    agentId: team.members.find((m) => m.name === team.manager)!.agentId,
    instructions: managerInstructions(team),
    prompt: "{{$.brief}}",
    assignTo: "result",
    next: "team:done",
  },
  { name: "team:done", kind: "done" },
];

/**
 * What the manager is told about its team.
 *
 * Generated from the definition rather than written by hand, because a manager whose instructions list a member
 * the team no longer has will delegate to it and get a refusal it cannot act on — and that is a definition and a
 * prompt disagreeing, which nothing would catch.
 */
export const managerInstructions = (team: TeamDefinition): string => {
  const others = team.members.filter((member) => member.name !== team.manager);
  const roster = others.map((member) => `- ${member.name}: ${member.instructions ?? "no stated speciality"}`).join("\n");
  return [
    `You lead a team. Delegate work with the ${DELEGATE_TOOL} tool; do not do a member's work yourself when one of them is better placed.`,
    "",
    "Your team:",
    roster,
    "",
    `Delegate one task at a time and read the result before deciding what is next. When the work is done, answer directly — do not delegate again to confirm.`,
  ].join("\n");
};

/**
 * The tools a member may use.
 *
 * An **intersection**, never a union — #186 AC-3's second half: "a delegated agent cannot reach a tool the
 * delegating one could not." A member's `tools` narrows; it cannot widen. Enforced where the set is built rather
 * than checked afterwards, because a check afterwards is a check somebody can forget to call.
 *
 * A member that names a tool the delegating context does not have gets it silently dropped rather than an error:
 * the team is still runnable, and the alternative is a whole team refusing to start because one member's list
 * mentions something a particular caller's role happens to exclude — which would make a team's usability depend
 * on who triggered it.
 */
export const memberTools = (input: {
  readonly member: TeamMember;
  /** What the delegating context can reach. The ceiling. */
  readonly available: readonly string[];
}): readonly string[] => {
  const available = new Set(input.available);
  if (input.member.tools === undefined) {
    // No narrowing stated: the member gets what the team has, minus the delegation tool — a member that could
    // delegate would be a manager, and a member delegating back to the manager is the A → B → A this bounds.
    return [...available].filter((tool) => tool !== DELEGATE_TOOL);
  }
  return input.member.tools.filter((tool) => available.has(tool) && tool !== DELEGATE_TOOL);
};

/** The brief a team execution starts from, under the key the compiled prompts read. */
export const teamBrief = (brief: string): Readonly<Record<string, unknown>> => ({ brief });

