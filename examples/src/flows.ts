/**
 * A flow and a team this app actually runs — REQ-038 (#187), REQ-037 (#186).
 *
 * Here rather than in the platform because a flow *is* application data: the platform stores and runs definitions,
 * and what the definitions say is the deployment's business. These two exist so the engine has a consumer — a
 * workflow engine nothing runs is a library, and #187 says so in as many words.
 *
 * The handler below is the interesting part. Every effect the interpreter can ask for is satisfied through
 * machinery this app already had: an agent turn through the engine, a tool through the registry, a question
 * through the HITL path. Nothing here is a second way of doing any of them, which is what "composition over what
 * exists" has to mean if it means anything.
 */

import { asId } from "@retinue/agentkit";
import { compileTeam } from "@retinue/agentkit/flows";
import type { FlowDefinition, FlowEffectHandler, StepOutcome, TeamDefinition } from "@retinue/agentkit/flows";
import type { AgentId, ExecutionContext, ToolRegistry } from "@retinue/agentkit";

/**
 * Triage a note, then act on it — the smallest flow that exercises every interesting step kind.
 *
 * Branch, tool, agent, human checkpoint and a terminal step, in one graph. Deliberately not a demo of one feature
 * at a time: the cases that break are the joins between kinds — a branch reading state a tool wrote, a checkpoint
 * resuming into an agent step — and a flow per kind would never exercise one.
 */
export const TRIAGE_FLOW: FlowDefinition = {
  id: "triage-note",
  version: 1,
  name: "Triage a note",
  description: "Read a note, decide whether it needs a person, and record the outcome.",
  start: "read",
  budget: { maxSteps: 12, maxCostMinorUnits: 5_000, maxWallClockMs: 10 * 60_000 },
  steps: [
    {
      name: "read",
      kind: "tool",
      tool: "recall",
      input: { noteId: "{{$.noteId}}" },
      assignTo: "note",
      next: "route",
      // A missing note is the caller's mistake, not a transient fault: retrying reads the same absence.
      onFailure: { action: "fail" },
    },
    {
      name: "route",
      kind: "branch",
      // On the note's own text, so the branch exercises reading state a previous step wrote.
      cases: [{ path: "$.note.text", operator: "contains", value: "urgent", next: "ask" }],
      otherwise: "record",
    },
    {
      name: "ask",
      kind: "checkpoint",
      question: "This note looks urgent:\n\n{{$.note.text}}\n\nShould I escalate it?",
      options: ["escalate", "leave it"],
      assignTo: "decision",
      next: "record",
    },
    {
      name: "record",
      kind: "tool",
      tool: "write_note",
      input: { text: "Triaged: {{$.note.text}} — decision: {{$.decision}}" },
      assignTo: "recorded",
      next: "done",
      // An internal write is worth retrying; a lock or a blip is the usual cause.
      onFailure: { action: "retry", maxAttempts: 3, backoffMs: 500 },
    },
    { name: "done", kind: "done", outcome: "triaged" },
  ],
};

/**
 * Two agents in sequence, which is the shape a buyer asks about first.
 *
 * **Defined and compiled, not yet runnable here**, and it is worth saying which rather than leaving a reader to
 * find out. `compileTeam` turns this into a flow whose steps are agent steps, and an agent step needs a *child
 * run* — a `Run` row of its own, so it gets checkpointing, recovery, quota admission and usage attribution like
 * any other run. That is a design rather than a wiring detail, and the shipped flow above deliberately uses the
 * step kinds that work end to end today instead of a stub that would make this look finished.
 *
 * Sequential rather than manager-led for a separate reason: manager-led needs a delegation tool in the registry.
 * The compiler produces either from the same definition, so that is a data change rather than a build.
 */
export const RESEARCH_TEAM: TeamDefinition = {
  id: "research-and-write",
  version: 1,
  name: "Research and write",
  process: "sequential",
  budget: { maxSteps: 6, maxCostMinorUnits: 10_000 },
  members: [
    {
      name: "researcher",
      agentId: asId<AgentId>("example-notes-agent"),
      instructions: "Gather what the notes say. Quote them; do not speculate.",
      // Narrowed, and the narrowing is the point: this member reads and does not write.
      tools: ["recall", "search_notes", "list_notes"],
    },
    {
      name: "writer",
      agentId: asId<AgentId>("example-notes-agent"),
      instructions: "Write the answer from what the researcher found. Do not add facts they did not report.",
      tools: ["calculate"],
    },
  ],
};

/** The compiled team, as a flow. One interpreter runs both. */
export const RESEARCH_TEAM_FLOW: FlowDefinition = compileTeam(RESEARCH_TEAM);

export const EXAMPLE_FLOWS: readonly FlowDefinition[] = [TRIAGE_FLOW, RESEARCH_TEAM_FLOW];

/**
 * How this app performs what the interpreter asks for.
 *
 * The registry and the engine, unchanged. A flow's tool call is authorised, approved, deduplicated and accounted
 * for exactly as a chat turn's is — because it *is* one: `registry.execute` is the same call the assistant makes.
 */
export const createExampleFlowHandler = (deps: {
  readonly registry: ToolRegistry;
  /** Runs one agent turn and returns its text. Supplied by the app, which owns the engine. */
  readonly runAgentTurn: (
    context: ExecutionContext,
    input: { readonly agentId: string; readonly prompt: string; readonly instructions?: string },
  ) => Promise<string>;
  /** Raises a question through the platform's HITL path and returns the interaction it created. */
  readonly askQuestion: (
    context: ExecutionContext,
    input: { readonly question: string; readonly options?: readonly string[] },
  ) => Promise<string>;
}): FlowEffectHandler => ({
  async runAgent(context, input) {
    try {
      const text = await deps.runAgentTurn(context, input);
      return { kind: "ok", value: text };
    } catch (error) {
      // The message only. A flow's stored state is durable and readable, and a stack trace in it is a stack trace
      // in something a person opens.
      return { kind: "failed", error: (error as Error).message };
    }
  },

  async callTool(context, input): Promise<StepOutcome> {
    /**
     * `idempotencyKey` passed straight through.
     *
     * This is the whole of #187 AC-9 on this side: the interpreter derives a key from
     * `(executionId, step, attempt)`, the registry deduplicates on it, and a step that wrote externally and then
     * crashed is answered from the store rather than performed again. Generating a key here would break it, and
     * the breakage would only show up as a double charge after a crash.
     */
    const result = await deps.registry.execute(context, {
      name: input.tool,
      input: input.input,
      idempotencyKey: input.idempotencyKey,
    });
    if (result.ok) return { kind: "ok", value: result.data };
    return { kind: "failed", error: `${result.error.code}: ${result.error.message}` };
  },

  async askHuman(context, input) {
    const interactionId = await deps.askQuestion(context, input);
    // `parked`, not `ok`: the answer arrives later, and reporting success now would run the next step against an
    // answer nobody gave.
    return { kind: "parked", interactionId };
  },
});
