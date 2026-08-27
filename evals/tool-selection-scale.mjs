#!/usr/bin/env node
/**
 * Does tool selection degrade with catalogue size? — REQ-045 (#204), task #221.
 *
 * The premise of #204 is that a large catalogue costs tokens *and* accuracy. Only the first half was measured:
 * a compact catalog entry costs ~35 tokens, so 588 tools is ~20,600 resident. Whether the model still picks the
 * right tool at that size was a hypothesis, and building `find_tools` first would have aimed a fix at a number
 * nobody took.
 *
 * ## The experiment
 *
 * The 26 `tool-selection` eval cases, scored at three catalogue sizes, through the **real** registry — the
 * compact catalog, `learn_tools`, authorization filtering and the default engine. Measuring a raw model call
 * with N tool definitions would measure the model; this measures our selection machinery.
 *
 * ## Why the distractors are confusable rather than merely numerous
 *
 * A catalogue degrades because entries *resemble* each other. 180 obviously-distinct tools would show nothing,
 * and reporting that as "no degradation at 200" would be evidence of nothing. So each distractor is generated
 * from a real tool by keeping the object and changing the verb — `publish_post` spawns `release_post`,
 * `push_post`, `broadcast_post` — with descriptions that differ only in a qualifier. That is the population a
 * real catalogue of a hundred integrations actually has: forty ways to send a message.
 *
 * ## Sizes: 20, 50, 200 — not 15
 *
 * The dataset references **20 distinct tools**. A 15-tool catalogue cannot contain them all, so at 15 some cases
 * would be unpassable by construction and the comparison would measure which cases were possible rather than how
 * well selection works. 20 is therefore the honest baseline: exactly the tools the dataset needs, no distractors.
 * Recorded here because the issue asked for 15 and this is a deviation with a reason.
 *
 * Usage: node evals/tool-selection-scale.mjs [--sizes 20,50] [--cases 5]
 * Writes `evals/tool-selection-scale.json`. Needs RETINUE_MODEL_API_KEY; costs real money (~$1–3 for a full run).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "@retinue/agentkit/providers";
import { defineTool } from "@retinue/agentkit/tools";
import { estimateTokens } from "@retinue/agentkit/runtime";

const CASES = "evals/cases/tool-selection.json";
const OUT = "evals/tool-selection-scale.json";

/**
 * The tools the dataset expects, with descriptions written to be *plausibly* confusable with each other.
 *
 * Not lifted from ShareFlow's real descriptors: those are the customer's domain and this harness must run in a
 * clean checkout. What matters for selection is that a description is realistic and that neighbours overlap.
 */
const BASE = [
  ["publish_post", "posts", "Publish a draft post to a connected social account immediately."],
  ["schedule_post", "posts", "Schedule a draft post to be published at a future date and time."],
  ["update_post", "posts", "Change the text, media or targeting of an existing draft post."],
  ["delete_post", "posts", "Permanently delete a post or draft."],
  ["duplicate_draft", "posts", "Copy an existing draft into a new one, leaving the original untouched."],
  ["validate_post", "posts", "Check a draft against a platform's rules and report problems without publishing."],
  ["retry_publish", "posts", "Retry a publish attempt that previously failed."],
  ["get_post_metrics", "analytics", "Read engagement metrics — impressions, clicks, reactions — for a published post."],
  ["get_campaign_metrics", "analytics", "Read aggregate performance metrics for a campaign."],
  ["create_campaign", "campaigns", "Create a campaign that groups posts under one objective and budget."],
  ["create_lead", "leads", "Record a new lead with its contact details and source."],
  ["list_accounts", "accounts", "List the social accounts connected to this workspace."],
  ["reply_to_comment", "engagement", "Post a reply to a comment on a published post."],
  ["attach_media", "media", "Attach an uploaded image or video to a draft post."],
  ["convert_media", "media", "Convert an uploaded image or video into a format a platform accepts."],
  ["read_attachment", "files", "Read the text content of a file the user attached to this conversation."],
  ["list_attachments", "files", "List the files attached to this conversation."],
  ["read_document", "knowledge", "Read a stored document from the workspace knowledge base."],
  ["read_source", "knowledge", "Read a knowledge source's raw contents by identifier."],
  ["search_web", "web", "Search the public web and return ranked results with snippets."],
];

/** Verbs that keep the object and change the action — the shape a real catalogue's near-duplicates take. */
const VERBS = ["release", "push", "broadcast", "submit", "dispatch", "sync", "queue", "draft", "archive", "review", "export", "import", "refresh", "resolve", "audit"];
const QUALIFIERS = [
  "Deprecated variant kept for compatibility.",
  "Bulk variant that accepts several identifiers.",
  "Variant scoped to a single connected account.",
  "Variant that skips validation.",
  "Legacy variant retained for older integrations.",
];

/**
 * Distractors, generated deterministically so a re-run measures the same population.
 *
 * `<verb>_<object>` with the base tool's own description plus a qualifier. Deliberately plausible: a model that
 * can tell `publish_post` from `release_post` on description alone is doing the job; one that cannot is the
 * finding.
 */
export const distractors = (count) => {
  const out = [];
  for (let i = 0; out.length < count; i += 1) {
    const [name, category, description] = BASE[i % BASE.length];
    const verb = VERBS[Math.floor(i / BASE.length) % VERBS.length];
    const object = name.split("_").slice(1).join("_") || name;
    const candidate = `${verb}_${object}`;
    if (BASE.some(([n]) => n === candidate) || out.some(([n]) => n === candidate)) continue;
    out.push([candidate, category, `${description} ${QUALIFIERS[i % QUALIFIERS.length]}`]);
  }
  return out;
};

const toolFrom = ([name, category, description]) =>
  defineTool({
    name,
    description,
    category,
    // `read`, so nothing is approval-gated: this measures *selection*, and a gate would stop the run before the
    // choice could be scored.
    effect: "read",
    execute: () => ({ ok: true, note: `${name} executed (harness stub)` }),
  });

const providerOf = (tools) => ({ id: "scale-harness", async listTools() { return tools; } });

/** The compact catalog's cost, computed the way the registry builds it. */
export const catalogTokens = (specs) =>
  estimateTokens(JSON.stringify(specs.map(([name, category, description]) => ({ name, label: name, description, category, effect: "read" }))));

const MODEL = process.env.RETINUE_MODEL_ID ?? "gpt-4o";
const catalogue = [
  {
    provider: "openai",
    modelId: MODEL,
    label: MODEL,
    lifecycle: "generally-available",
    inputModalities: ["text"],
    capabilities: { tools: true, structuredOutput: true, reasoning: false, nativeSearch: false },
    limits: { contextTokens: 128_000, maxOutputTokens: 4_096 },
    pricing: { currency: "USD", inputPerMillion: 2_500, outputPerMillion: 10_000 },
    dataResidency: ["us"],
  },
];

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const main = async () => {
  if (!process.env.RETINUE_MODEL_API_KEY) {
    console.error("✗ RETINUE_MODEL_API_KEY is unset. This harness scores against a live model on purpose:");
    console.error("  selection accuracy is a property of the model reading our catalogue, and a stub would");
    console.error("  measure the stub.");
    return 2;
  }

  const cases = JSON.parse(readFileSync(CASES, "utf8"));
  const limit = Number(arg("--cases", String(cases.length)));
  const chosen = cases.slice(0, limit);
  const sizes = arg("--sizes", "20,50,200").split(",").map(Number);

  const results = [];
  for (const size of sizes) {
    const specs = [...BASE, ...distractors(Math.max(0, size - BASE.length))].slice(0, Math.max(size, BASE.length));
    const tools = specs.map(toolFrom);
    const tokens = catalogTokens(specs);
    const agent = createAgent({
      manifest: {
        id: "selector",
        name: "Selector",
        instructions: "Use the available tools to satisfy the request. Prefer the single most specific tool.",
        modelPolicy: { role: "smart" },
      },
      models: catalogue,
      roleAssignments: { smart: [MODEL], fast: [MODEL] },
      providerCredentials: { openai: { apiKey: process.env.RETINUE_MODEL_API_KEY, ...(process.env.RETINUE_MODEL_BASE_URL ? { baseURL: process.env.RETINUE_MODEL_BASE_URL } : {}) } },
      tools: [providerOf(tools)],
    });

    let passed = 0;
    let errored = 0;
    let elapsed = 0;
    const misses = [];
    for (const testCase of chosen) {
      const started = Date.now();
      let called = [];
      try {
        const result = await agent.run({ conversationId: `scale-${size}-${testCase.id}`, message: testCase.input.message });
        called = result.parts.filter((p) => p.type === "tool-call").map((p) => p.toolName);
      } catch (error) {
        errored += 1;
        misses.push({ id: testCase.id, why: `run failed: ${error?.message ?? error}` });
        elapsed += Date.now() - started;
        continue;
      }
      elapsed += Date.now() - started;

      const wanted = testCase.expect.tool;
      const hit = testCase.expect.kind === "tool-called" ? called.includes(wanted) : !called.includes(wanted);
      if (hit) passed += 1;
      else misses.push({ id: testCase.id, title: testCase.title, expected: `${testCase.expect.kind} ${wanted}`, called });
      process.stdout.write(hit ? "." : "✗");
    }

    const accuracy = passed / chosen.length;
    results.push({ size, tools: specs.length, catalogTokens: tokens, cases: chosen.length, passed, errored, accuracy, msPerCase: Math.round(elapsed / chosen.length), misses });
    console.log(`\n  ${specs.length} tools · catalog ${tokens} tokens · ${passed}/${chosen.length} = ${(accuracy * 100).toFixed(1)}% · ${Math.round(elapsed / chosen.length)} ms/case`);
  }

  const baseline = results[0];
  const report = {
    model: MODEL,
    cases: chosen.length,
    note: "Sizes start at 20 because the dataset references 20 distinct tools; 15 cannot contain them all.",
    results: results.map((r) => ({ ...r, deltaFromBaseline: Number((r.accuracy - baseline.accuracy).toFixed(4)) })),
  };
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n| tools | catalog tokens | accuracy | Δ baseline | ms/case |`);
  console.log(`|---|---|---|---|---|`);
  for (const r of report.results) {
    console.log(`| ${r.tools} | ${r.catalogTokens.toLocaleString()} | ${(r.accuracy * 100).toFixed(1)}% | ${(r.deltaFromBaseline * 100).toFixed(1)} pp | ${r.msPerCase} |`);
  }
  console.log(`\nwrote ${OUT}`);
  return 0;
};

/**
 * Only as an entry point — the fourth script in this repository to need this guard, which by now is the default
 * assumption rather than a discovery. Without it, importing the pure helpers below (to test the distractor
 * generator, say) runs the whole experiment and spends money.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
