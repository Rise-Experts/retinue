/**
 * Runs a **real** ShareFlow shadow turn and writes the result as a `ShadowRun` — #128 AC-4.
 *
 * Every part of the parity machinery has existed for weeks except this: the recorder (#126), the diff, the
 * gates (#128), the flag (#127) and a report script that correctly refuses to run on an empty set. Nothing
 * could produce a run. This does.
 *
 * It is deliberately not a test. A test with a stubbed model proves the wiring; this makes a real model call
 * against a real ShareFlow database, which is the only thing that produces data a gate may be evaluated on.
 *
 * Usage:
 *   node --env-file=../.env scripts/shadow-turn.mjs \
 *     --workflow create-post \
 *     --message "Draft a post about our launch for instagram" \
 *     --out shadow-new.json
 *
 * Requires `RETINUE_MODEL_API_KEY` and a ShareFlow database in `RETINUE_TEST_SHAREFLOW_URL`.
 *
 * ## What it leaves behind
 *
 * Real rows. A shadow run suppresses `external-write` and `destructive` and **not** `internal-write`, so the
 * drafts and campaigns a turn creates are really created. That is the design — docs/07's "shadow execution
 * performs no external writes", not "performs no writes" — and it is why this runs in a workspace of its own
 * and prints what it made.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import {
  createShareFlowApp,
  createShareFlowServices,
  createShadowTurnRunner,
  CAMPAIGN_TOOL_FACTORIES,
  GENERATE_TOOL_FACTORIES,
  POSTS_TOOL_FACTORIES,
} from "../dist/index.js";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { createAuthorizationPolicy } from "@retinue/agentkit/hitl";
import { createProviderFactory } from "@retinue/agentkit/providers";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
/**
 * `--message` is repeatable, because **a workflow is not one turn**.
 *
 * The first run of this script sent a single message and the assistant did the right thing: it proposed three
 * angles and asked which to use, exactly as docs/07's create-post step 5 says. No draft was saved, and a
 * parity comparison of "asked a question" against a completed old-runtime workflow would be meaningless.
 * Driving the conversation to its end is what produces a comparable run.
 */
const flags = (name) => args.flatMap((arg, index) => (arg === `--${name}` ? [args[index + 1]] : []));

const die = (message, detail) => {
  console.error(`✗ ${message}`);
  for (const [key, value] of Object.entries(detail ?? {})) console.error(`  ${key}: ${value}`);
  process.exit(2);
};

const workflow = flag("workflow", "create-post");
const messages = flags("message");
if (messages.length === 0) {
  messages.push(
    "Draft a short Instagram post announcing our new cordless impact driver. Propose angles first.",
    "Use the durability angle. Save it as a draft for instagram.",
  );
}
const out = flag("out");
const keep = args.includes("--keep");

const databaseUrl = process.env.RETINUE_TEST_SHAREFLOW_URL;
const apiKey = process.env.RETINUE_MODEL_API_KEY?.trim();
const modelId = process.env.RETINUE_MODEL_ID?.trim() || "gpt-4o";

if (databaseUrl === undefined) die("RETINUE_TEST_SHAREFLOW_URL is required", { why: "a shadow run reads and writes ShareFlow's own tables" });
if (apiKey === undefined || apiKey === "")
  die("RETINUE_MODEL_API_KEY is required", { why: "a shadow turn with a stubbed model measures the stub" });

// ---------------------------------------------------------------------------------------------------
// The database, and a workspace of this run's own
// ---------------------------------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
const sql = {
  async query(text, params) {
    return (await pool.query(text, params ? [...params] : undefined)).rows;
  },
};

const owner = (await sql.query("select id from public.profiles limit 1"))[0]?.id;
if (owner === undefined) die("no rows in public.profiles", { why: "posts need an author, and authors are auth users" });

const workspace = (
  await sql.query("insert into public.workspaces (name) values ($1) returning id", [`retinue-shadow-${workflow}`])
)[0].id;

/**
 * A brand profile, so the generated text is grounded the way a real workspace's would be.
 *
 * Without it the run still works — `getBrandProfile` answers an empty profile for a workspace that has never
 * set one, which is the ordinary case — but the prose would be generic, and a parity comparison of generic
 * prose against a real workspace's is not a comparison.
 */
await sql.query(
  `insert into public.workspace_ai_profile (workspace_id, brand_name, company, audience, brand_voice)
   values ($1::uuid, 'Northwind', 'Northwind Tools', 'independent workshops', 'plain, concrete, no exclamation marks')`,
  [workspace],
);

// ---------------------------------------------------------------------------------------------------
// The application: three services, and only the capabilities that read them
// ---------------------------------------------------------------------------------------------------

const factory = createProviderFactory({ credentials: { openai: { apiKey, name: "shadow-turn" } } });

/** Zeroed pricing, deliberately: a cost derived from invented prices is worse than an obvious zero. */
const definition = {
  id: modelId,
  provider: "openai",
  modelId,
  displayName: modelId,
  capabilities: { tools: true, streaming: true, structuredOutput: true },
  limits: { contextWindow: 0, maxOutputTokens: 0 },
  pricing: { currency: "USD", inputPerMillion: 0, outputPerMillion: 0 },
};

/**
 * Structured generation for `ContentGenerator`, over the same model.
 *
 * `generateObject` rather than prose parsing, for the generator's own reason: asking for prose and parsing it
 * fails on the day a model writes "Here are three angles:" before the list, and that failure looks like the
 * model being bad at the task rather than the adapter being bad at reading.
 */
const { generateObject } = await import("ai");
const generate = async ({ system, prompt, schema }) => {
  const result = await generateObject({ model: factory.languageModel(definition), system, prompt, schema });
  return result.object;
};

const services = createShareFlowServices({ sql, generate });

/**
 * An approval gate that **throws if consulted**.
 *
 * Suppression happens before the approval gate — a shadow run must not ask a human to approve something that
 * will not happen, because doing so teaches people that approving is meaningless. Wiring a gate that cannot
 * be used is how this run proves that ordering rather than assuming it.
 */
const approvals = {
  async request() {
    throw new Error("the approval gate was consulted during a shadow run: suppression must precede approval");
  },
  async resolve() {
    throw new Error("the approval gate was consulted during a shadow run");
  },
};

/**
 * The role, and **`tools` names real categories** — there is no wildcard.
 *
 * `filterTools` is `allowed.has(t.name) || allowed.has(t.category)`, an exact match, and `can()` uses the
 * identical rule so discovery and execution cannot disagree. The first version of this script passed `"*"`,
 * which matches no tool: the model received an **empty catalogue**, called nothing, and answered the request
 * from what it already knew — a caption in prose, no draft saved, and a run that reported `completed`.
 *
 * Nothing anywhere said the catalogue was empty. That is the failure mode worth remembering from this run:
 * a shadow turn whose agent has no tools measures the model, not the runtime.
 */
const authorization = createAuthorizationPolicy({
  roles: [
    {
      roleId: "editor",
      permissions: [{ action: "*", resourceType: "*" }],
      tools: ["posts", "campaigns"],
    },
  ],
});

const app = createShareFlowApp({
  services,
  factories: [...POSTS_TOOL_FACTORIES, ...CAMPAIGN_TOOL_FACTORIES, ...GENERATE_TOOL_FACTORIES],
  deps: { authorization, approvals, idempotency: createMemoryIdempotencyStore() },
  authorization,
  manifest: {
    instructions:
      "You draft social content for one workspace. Use the tools to read context and to save drafts; " +
      "never claim a post is published unless a tool result says so. Keep captions within the platform's " +
      "limits, and respect the workspace's brand voice.",
    modelPolicy: { role: "primary", requires: { tools: true } },
    authorizationPolicyId: "shareflow-shadow",
    limits: { maxSteps: 8, maxToolCalls: 8 },
    categories: ["posts", "campaigns"],
  },
});

const runner = createShadowTurnRunner({
  manifest: app.manifest,
  providers: app.providers,
  resolveModel: () => ({
    model: factory.languageModel(definition),
    modelId,
    currency: "USD",
    price: () => 0,
  }),
  tenantId: workspace,
  principalId: owner,
  // Keyed by the id the manifest names. The platform refuses to construct an agent whose policy is missing,
  // rather than falling back to something permissive — so this is required, not optional.
  authorizationPolicies: { "shareflow-shadow": authorization },
  roleIds: ["editor"],
});

// ---------------------------------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------------------------------

console.log(`▶ shadow turn · workflow=${workflow} · model=${modelId} · ${messages.length} turn(s)`);
console.log(`  workspace ${workspace}\n`);

/** Every turn's suppressed writes, in order — the workflow's writes, not one message's. */
const allWrites = [];

for (const [index, text] of messages.entries()) {
  console.log(`— turn ${index + 1} —\n> ${text}`);
  const started = Date.now();
  let result;
  try {
    // One conversation across the turns: the runner keeps the agent, so history carries.
    result = await runner.run({ conversationId: `shadow-${workflow}`, message: text });
  } catch (error) {
    console.error(`✗ turn ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!keep) await sql.query("delete from public.workspaces where id = $1::uuid", [workspace]);
    await pool.end();
    process.exit(1);
  }
  console.log(`✓ ${result.outcome} in ${Date.now() - started} ms · run ${result.runId}`);

  /**
   * The tool calls, printed before the prose.
   *
   * Because the prose lies by omission. One run of this read like a model that would not use its tools — the
   * authorization list matched no tool and the catalogue was empty. Another read like a model that gave up —
   * `create_post_draft` had been refused by a validation rule. A harness reading only text records both as
   * "the assistant answered".
   */
  const calls = result.parts.filter((part) => part.type === "tool-call");
  const outcomes = new Map(
    result.parts.filter((part) => part.type === "tool-result").map((part) => [part.toolCallId, part]),
  );
  console.log(`  tool calls: ${calls.length}`);
  for (const call of calls) {
    const outcome = outcomes.get(call.toolCallId);
    /**
     * A refusal is in the **payload**, not in `isError`.
     *
     * The first version read `isError` and printed "ok" for a tool whose result was
     * `{ok: false, error: {...}}` — so a run where `create_post_draft` failed with a uuid cast error looked
     * like a run where it succeeded. A harness that mislabels a refusal as a success is worse than no harness.
     */
    const payload = outcome?.output ?? outcome?.result;
    const failed = outcome?.isError === true || (payload !== null && typeof payload === "object" && payload.ok === false);
    const state = outcome === undefined ? "no result" : failed ? "REFUSED" : "ok";
    console.log(`    ${call.toolName} → ${state}`);
    console.log(`      input: ${JSON.stringify(call.input).slice(0, 260)}`);
    if (outcome !== undefined) {
      console.log(`      result: ${JSON.stringify(payload).slice(0, 700)}`);
      // The findings, in full. A refusal whose reasons are truncated is a refusal nobody can act on — and
      // these are the parity signal for a workflow with no external write.
      const details = payload?.error?.details;
      if (details !== undefined) console.log(`      details: ${JSON.stringify(details, null, 8).slice(0, 1600)}`);
    }
  }
  console.log(`\n${result.text.trim() || "(nothing)"}\n`);
  allWrites.push(...result.writes);
}

console.log(`— suppressed external writes across the workflow: ${allWrites.length} —`);
for (const write of allWrites) {
  console.log(`  ${write.toolName} → ${write.delegatesTo} (${write.effect})`);
  console.log(`    would require approval: ${write.wouldRequireApproval}`);
  console.log(`    input: ${JSON.stringify(write.input).slice(0, 200)}`);
}
if (allWrites.length === 0) {
  /**
   * Not a failure, and worth spelling out where an operator reads it.
   *
   * None of the twelve capabilities these three services can serve is an `external-write` — posts and
   * campaigns are `internal-write`, generation and reads are `read`. Publishing is where the external writes
   * are, and `PublishingService` has no adapter. So an empty list here is the *correct* answer for this
   * workflow, and it also means the suppressed-write diff has no signal for it.
   */
  console.log("  (none — and correctly so: no capability in this deployment is an external-write.");
  console.log("   Publishing is, and PublishingService has no adapter yet, so this workflow's parity");
  console.log("   signal is the rows it wrote and the prose, not a suppressed-write diff.)");
}

/**
 * What the turn really wrote, because an `internal-write` is not suppressed.
 *
 * Printed rather than left implicit: an operator reading "0 suppressed writes" should not conclude the run
 * did nothing. It created drafts, and those are real rows.
 */
const drafts = await sql.query(
  "select id, status, left(raw_content, 90) as head, target_platforms from public.posts where workspace_id = $1::uuid order by created_at",
  [workspace],
);
const campaigns = await sql.query("select id, name, cadence, status from public.campaigns where workspace_id = $1::uuid", [
  workspace,
]);
console.log(`\n— rows actually written (internal-write is NOT suppressed) —`);
console.log(`  posts: ${drafts.length}`);
for (const draft of drafts) console.log(`    [${draft.status}] ${draft.head}… → ${draft.target_platforms}`);
console.log(`  campaigns: ${campaigns.length}`);
for (const campaign of campaigns) console.log(`    [${campaign.status}] ${campaign.name} (${campaign.cadence})`);

if (out !== undefined) {
  const shadowRun = { workflow, runtime: "agentkit", writes: allWrites };
  await writeFile(resolve(out), `${JSON.stringify(shadowRun, null, 2)}\n`, "utf8");
  console.log(`\n✓ wrote ${out} — a \`ShadowRun\` for the new runtime`);
  console.log(`  Pair it with an \`old\` run from the Agno deployment to evaluate a gate; there is no way to`);
  console.log(`  synthesise that half, and a fabricated one is the single worst datum a parity gate can hold.`);
}

if (keep) {
  console.log(`\n· kept workspace ${workspace} (--keep)`);
} else {
  await sql.query("delete from public.workspaces where id = $1::uuid", [workspace]);
  console.log(`\n· removed workspace ${workspace}`);
}
await pool.end();
