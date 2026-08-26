#!/usr/bin/env node
/**
 * Run the triage flow against the real database — REQ-038 (#187).
 *
 * A command rather than a test, for the same reason `run-api.mjs` is: the interpreter's guarantees are covered by
 * unit tests, and what this shows is the part tests cannot — that a flow persists between steps in Postgres, parks
 * for a person, resumes, and can be read back afterwards by something that was not holding it in memory.
 *
 * The tool steps are answered from a small in-script store rather than the app's registry, deliberately: this is
 * about the *engine's* durability, and reaching into the notes tools would make a failure here ambiguous between
 * the flow and the tool.
 */
import pg from "pg";
import { asId } from "@retinue/agentkit";
import { createPostgresFlowDefinitionStore, createPostgresFlowExecutionStore } from "@retinue/agentkit/adapters/postgres";
import { createFlowRunner } from "@retinue/agentkit/flows";
import { RESEARCH_TEAM_FLOW, TRIAGE_FLOW } from "../dist/flows.js";

const SCHEMA = process.env.RETINUE_EXAMPLE_SCHEMA ?? "agentkit_example";
if (!process.env.RETINUE_DATABASE_URL) {
  console.error("✗ RETINUE_DATABASE_URL is required. Copy .env.example to .env first.");
  process.exit(2);
}
const url = new URL(process.env.RETINUE_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
const sql = { async query(text, params) { return (await pool.query(text, params ? [...params] : undefined)).rows; } };

const definitions = createPostgresFlowDefinitionStore(sql);
const executions = createPostgresFlowExecutionStore(sql);

const context = {
  tenantId: asId("demo"),
  principalId: asId("you"),
  roleIds: [asId("editor")],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req-flow"),
  runId: asId(`run-flow-${Date.now()}`),
};

try {
  await definitions.put({
    tenantId: context.tenantId,
    definition: {
      flowId: TRIAGE_FLOW.id,
      version: TRIAGE_FLOW.version,
      name: TRIAGE_FLOW.name,
      kind: "flow",
      definition: TRIAGE_FLOW,
      createdAt: new Date().toISOString(),
    },
  });
  console.log(`✓ published ${TRIAGE_FLOW.id} v${TRIAGE_FLOW.version}`);
} catch (error) {
  // Expected on every boot after the first: the store refuses to change a published version, which is what makes
  // an execution's version pin worth having.
  console.log(`· ${TRIAGE_FLOW.id} v${TRIAGE_FLOW.version} is already published (${error.code ?? "conflict"})`);
}

const notes = new Map([
  ["n-urgent", { text: "urgent: the disk is full" }],
  ["n-calm", { text: "remember to water the plants" }],
]);
const written = [];

const handler = {
  async runAgent(_context, input) {
    // See `flows.ts`: an agent step wants a child run, and stubbing it would make this look finished.
    return { kind: "failed", error: `agent steps are not wired in this app (${input.agentId})` };
  },
  async callTool(_context, input) {
    if (input.tool === "recall") {
      const note = notes.get(String(input.input.noteId));
      return note === undefined ? { kind: "failed", error: "no such note" } : { kind: "ok", value: note };
    }
    if (input.tool === "write_note") {
      // The key is recorded so a resumed step can be seen to reuse it rather than write twice.
      written.push({ text: input.input.text, key: input.idempotencyKey });
      return { kind: "ok", value: { id: `w${written.length}` } };
    }
    return { kind: "failed", error: `unexpected tool ${input.tool}` };
  },
  async askHuman() {
    return { kind: "parked", interactionId: `int-${Date.now()}` };
  },
};

const runner = createFlowRunner({ definitions, executions, handler });
const path = (execution) => execution.history.map((h) => `${h.step}(${h.outcome})`).join(" → ");

console.log("\n── a calm note: no checkpoint, straight through ──");
const calm = await runner.start(context, { flowId: TRIAGE_FLOW.id, runId: context.runId, state: { noteId: "n-calm" } });
console.log(`  ${calm.execution.status} in ${calm.execution.spend.steps} steps: ${path(calm.execution)}`);
console.log(`  wrote: ${written.at(-1)?.text}`);

console.log("\n── an urgent note: parks for a person ──");
const urgent = await runner.start(context, {
  flowId: TRIAGE_FLOW.id,
  runId: asId(`run-flow-u-${Date.now()}`),
  state: { noteId: "n-urgent" },
});
console.log(`  ${urgent.execution.status}, waiting on ${JSON.stringify(urgent.execution.waitingFor)}`);

console.log("\n── reloaded from Postgres by something that never held it ──");
const parked = await executions.get({ tenantId: context.tenantId, executionId: urgent.execution.id });
console.log(`  status ${parked.status}, step ${parked.currentStep}, state: ${JSON.stringify(parked.execution.state)}`);

console.log("\n── the person answers; it resumes and finishes ──");
const resumed = await runner.resumeWith(context, urgent.execution.id, "escalate");
console.log(`  ${resumed.execution.status}: ${path(resumed.execution)}`);
console.log(`  wrote: ${written.at(-1)?.text}`);

console.log("\n── a missing note fails, and says why ──");
const missing = await runner.start(context, {
  flowId: TRIAGE_FLOW.id,
  runId: asId(`run-flow-m-${Date.now()}`),
  state: { noteId: "nope" },
});
console.log(`  ${missing.execution.status}: ${missing.execution.detail}`);

console.log("\n── the version pin: publishing v2 does not change a parked v1 execution ──");
/**
 * On its **own** flow id, not `triage-note`.
 *
 * The first version of this probe published a junk v2 of the flow it had just been demonstrating, so the next
 * invocation's `latest` was the junk and every earlier section silently ran the wrong shape. A demonstration that
 * breaks the thing it demonstrates, one run later.
 */
/**
 * On its **own** flow id, and with a version per invocation.
 *
 * The first version of this probe published a junk v2 of the flow it had just demonstrated, so the *next* run's
 * `latest` was the junk and every earlier section silently ran the wrong shape — a demonstration that breaks the
 * thing it demonstrates, one run later. A fresh id per invocation also means the ordering below is real rather
 * than depending on what a previous run left behind.
 */
const PIN_ID = `pin-${Date.now()}`;
const pinShape = (version, steps) => ({
  flowId: PIN_ID,
  version,
  name: `pin v${version}`,
  kind: "flow",
  definition: { ...TRIAGE_FLOW, id: PIN_ID, version, ...steps },
  createdAt: new Date().toISOString(),
});

// v1 only. `start` takes `latest`, so the execution pins 1 — and then parks.
await definitions.put({ tenantId: context.tenantId, definition: pinShape(1, {}) });
const pinned = await runner.start(context, { flowId: PIN_ID, runId: asId(`run-pin-${Date.now()}`), state: { noteId: "n-urgent" } });
console.log(`  started on v${pinned.execution.flowVersion}, ${pinned.execution.status} at "${pinned.execution.currentStep}"`);

// Now v2 lands, with a completely different shape, while that execution is parked.
await definitions.put({
  tenantId: context.tenantId,
  definition: pinShape(2, { start: "done", steps: [{ name: "done", kind: "done", outcome: "v2 ran" }] }),
});
console.log("  published v2: a single done step");

const finished = await runner.resumeWith(context, pinned.execution.id, "leave it");
console.log(`  finished on v${finished.execution.flowVersion} through: ${path(finished.execution)}`);
console.log(`  (v2 would have been one step and outcome "v2 ran" — it was not used)`);

console.log("\n── a team: each member becomes a child run ──");
/**
 * The compiled team, published and started. The handler below is the *shape* a real host uses — it creates a
 * conversation-less child run and parks — with a fake run store so the child's lifecycle is something this probe
 * controls rather than waits on a worker for.
 */
try {
  await definitions.put({
    tenantId: context.tenantId,
    definition: {
      flowId: RESEARCH_TEAM_FLOW.id,
      version: RESEARCH_TEAM_FLOW.version,
      name: RESEARCH_TEAM_FLOW.name,
      kind: "team",
      definition: RESEARCH_TEAM_FLOW,
      createdAt: new Date().toISOString(),
    },
  });
  console.log(`✓ published ${RESEARCH_TEAM_FLOW.id} v${RESEARCH_TEAM_FLOW.version}`);
} catch (error) {
  console.log(`· ${RESEARCH_TEAM_FLOW.id} is already published`);
}

const childRuns = new Map();
let childN = 0;
const teamRunner = createFlowRunner({
  definitions,
  executions,
  runs: { async findById({ id }) { return childRuns.get(id) ?? null; } },
  handler: {
    async runAgent(_c, input) {
      const runId = `child-${++childN}`;
      childRuns.set(runId, { status: "queued" });
      console.log(`  → ${input.member} becomes run ${runId}, ceiling ${JSON.stringify(input.budgetRemaining)}`);
      return { kind: "parked-on-run", runId, member: input.member };
    },
    async callTool() { return { kind: "ok", value: null }; },
    async askHuman() { return { kind: "parked", interactionId: "int-x" }; },
  },
});

const team = await teamRunner.start(context, {
  flowId: RESEARCH_TEAM_FLOW.id,
  runId: asId(`run-team-${Date.now()}`),
  state: { brief: "Explain what caused the outage." },
});
console.log(`  parked on ${JSON.stringify(team.execution.waitingFor)}`);

childRuns.set("child-1", { status: "completed" });
const afterFirst = await teamRunner.notifyRunFinished(context, asId("child-1"));
console.log(`  after the researcher: parked on ${JSON.stringify(afterFirst.execution.waitingFor)}`);

console.log("\n── the notification is lost; a plain resume still finds the finished child ──");
childRuns.set("child-2", { status: "completed" });
const afterLost = await teamRunner.resume(context, team.execution.id);
console.log(`  ${afterLost.execution.status}: ${afterLost.execution.history.map((h) => h.step + "(" + h.outcome + ")").join(" → ")}`);

console.log("\n── a failing member routes into the step's policy ──");
const failing = await teamRunner.start(context, {
  flowId: RESEARCH_TEAM_FLOW.id,
  runId: asId(`run-team-f-${Date.now()}`),
  state: { brief: "This one fails." },
});
const failedChild = failing.execution.waitingFor.runId;
childRuns.set(failedChild, { status: "failed", error: { message: "the model refused" } });
const afterFail = await teamRunner.resume(context, failing.execution.id);
console.log(`  ${afterFail.execution.status}: ${afterFail.execution.detail}`);

await pool.end();
