#!/usr/bin/env node
/**
 * What does prompt caching actually save? — REQ-058 (#246), task #247, AC-5 and AC-6.
 *
 * `docs/24` measured that a catalogue of 200 tools leaves selection accuracy flat and multiplies catalogue tokens
 * by 12.5×. That cost is paid on every turn, against an input that is byte-identical every turn. This measures
 * what caching that input is worth, and — the reason the AC insists on a number — whether the platform was
 * *already* receiving cache discounts it was not recording.
 *
 * ## What is measured
 *
 * A realistic prefix: a ~200-entry tool catalogue rendered into the system prompt, the shape `registry.catalog`
 * produces. Then a multi-turn conversation over it, each turn appending to the history, so turns 2..N have a
 * byte-identical prefix and a growing tail.
 *
 * Per turn: input tokens, the provider's own cache-read count, latency, and cost computed **two ways** — with the
 * old arithmetic (which read a field the SDK does not send, so cached tokens were billed as fresh) and with the
 * fixed arithmetic. The difference between those two columns is money the platform was over-reporting.
 *
 * ## AC-6: the compaction interaction
 *
 * A second run rewrites the prefix mid-conversation, which is what context compaction does. The hit rate across
 * that event is reported rather than assumed: if compaction destroys caching in the common case, a deployment
 * should learn it here and not from a bill.
 *
 * ## Honest limits
 *
 * One provider. `RETINUE_MODEL_API_KEY` is an OpenAI key, whose caching is **automatic and best-effort** — there
 * is no directive to send and no guarantee of a hit, which the results show directly. Anthropic's explicit
 * `cache_control` path is implemented and **not measured here**, for want of a key; that gap is stated in the
 * write-up rather than papered over.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { streamModelTurn } from "../backend/dist/models/streaming.js";
import { computeModelCostMinorUnits } from "../backend/dist/models/pricing.js";

const key = process.env.RETINUE_MODEL_API_KEY;
if (!key) {
  console.error("RETINUE_MODEL_API_KEY is not set.");
  process.exit(2);
}
const modelId = process.env.RETINUE_MODEL_ID ?? "gpt-4o";
const model = createOpenAI({ apiKey: key })(modelId);

/** GPT-4o's published rates, in minor units (tenths of a cent) per million tokens. */
const PRICING = {
  currency: "USD",
  inputPerMillion: 2_500,
  outputPerMillion: 10_000,
  // OpenAI's cached input is half price; it does not charge for a cache write.
  cacheReadPerMillion: 1_250,
  cacheWritePerMillion: 0,
};

const CATALOGUE_SIZE = 200;

/** A tool catalogue rendered as a stable prefix — the shape and roughly the size the real one has. */
const catalogue = Array.from({ length: CATALOGUE_SIZE }, (_, i) => {
  const verb = ["list", "get", "create", "update", "search"][i % 5];
  const object = ["issue", "message", "document", "record", "event", "file", "task", "page"][i % 8];
  return `- ${verb}_${object}_${i}: ${verb}s a ${object} in the configured provider. Takes a target identifier and an optional note; returns a structured result. Category: general. Effect: read. Approval: policy.`;
}).join("\n");

/**
 * Each scenario gets its own prefix, keyed by a unique marker on the **first line**.
 *
 * Without this the scenarios are not independent: the first run warms the provider's cache and every later run
 * inherits it, so the second scenario reports a hit rate that belongs to the first. The first version of this
 * script did exactly that and reported the compaction run as *better* than the stable one, which is impossible.
 * A distinct first line makes each prefix a different prefix.
 */
const systemFor = (marker) =>
  [
    `Session ${marker}.`,
    "You are a helpful assistant with access to the following tools.",
    "",
    "# Tools",
    catalogue,
    "",
    "Answer briefly.",
  ].join("\n");

/**
 * Twelve turns, not six.
 *
 * The first run of this used six and produced a hit pattern of hit/miss/hit/miss/hit — OpenAI's caching is
 * automatic and best-effort, so per-turn variance is large. Six turns was not enough to separate the scenarios
 * from the noise, and reporting the gap from that sample would have been a claim about the sample. Twelve, and
 * `CACHE_EVAL_REPEATS` for more.
 */
const QUESTIONS = [
  "In one short sentence, what kinds of things can you do?",
  "Which tool would list issues? Name it only.",
  "And which would create a document? Name it only.",
  "How many tools do you have, roughly?",
  "Name any tool that searches. Just the name.",
  "Name a tool that updates a record. Name only.",
  "Which tool gets a message? Name only.",
  "Which tool creates an event? Name only.",
  "Name a tool for files. Name only.",
  "Name a tool for tasks. Name only.",
  "Name a tool for pages. Name only.",
  "Thanks — one word reply please.",
];

/** One turn, returning the usage breakdown and the wall-clock. */
const turn = async (messages, systemPrompt) => {
  const startedAt = process.hrtime.bigint();
  let usage;
  for await (const chunk of streamModelTurn({
    model,
    system: systemPrompt,
    messages,
    maxOutputTokens: 60,
    temperature: 0,
  })) {
    if (chunk.type === "finish") usage = chunk.usage;
  }
  const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { usage, latencyMs };
};

/** Cost the old way: cached tokens invisible, so all input billed fresh. */
const costBefore = (u) =>
  computeModelCostMinorUnits(PRICING, { inputTokens: u.inputTokens, outputTokens: u.outputTokens });

/** Cost the fixed way: the provider's own breakdown, priced per kind. */
const costAfter = (u) =>
  computeModelCostMinorUnits(PRICING, {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.cachedInputTokens,
    ...(u.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: u.cacheWriteTokens }),
  });

/**
 * `mutateAt` changes the prompt mid-conversation, in one of two ways — the AC-6 question.
 *
 * - `"append"`: the summary goes *after* the stable prefix. A provider matches on a **prefix**, so everything
 *   before the insertion point is still a match.
 * - `"prepend"`: the summary goes *before* it, which changes byte 0 and invalidates everything.
 *
 * Both are plausible readings of "compaction rewrites history", and they differ by the entire discount. That is
 * the finding, and it is only visible if the measurement tries both.
 */
const runConversation = async (label, { mutateAt, mutation = "append", marker } = {}) => {
  const messages = [];
  const rows = [];
  const base = systemFor(marker ?? label);
  let activeSystem = base;
  for (const [i, question] of QUESTIONS.entries()) {
    if (mutateAt !== undefined && i === mutateAt) {
      const summary = "# Summary of earlier turns\nThe user asked about the available tools.";
      activeSystem = mutation === "append" ? `${base}\n\n${summary}` : `${summary}\n\n${base}`;
    }
    messages.push({ role: "user", content: question });
    const { usage, latencyMs } = await turn(messages, activeSystem);
    messages.push({ role: "assistant", content: "ok" });
    const hitRate = usage.inputTokens === 0 ? 0 : usage.cachedInputTokens / usage.inputTokens;
    rows.push({
      turn: i + 1,
      ...(mutateAt === i ? { mutated: mutation } : {}),
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens ?? null,
      outputTokens: usage.outputTokens,
      hitRate: Number(hitRate.toFixed(4)),
      costBeforeMinorUnits: costBefore(usage),
      costAfterMinorUnits: costAfter(usage),
      latencyMs: Number(latencyMs.toFixed(0)),
    });
    process.stdout.write(
      `${label} turn ${i + 1}: in=${usage.inputTokens} cached=${usage.cachedInputTokens} ` +
        `hit=${(hitRate * 100).toFixed(1)}% cost ${costBefore(usage)}→${costAfter(usage)} ` +
        `${latencyMs.toFixed(0)}ms\n`,
    );
  }
  return rows;
};

const totals = (rows) => {
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const input = sum("inputTokens");
  return {
    turns: rows.length,
    inputTokens: input,
    cachedInputTokens: sum("cachedInputTokens"),
    hitRate: Number((sum("cachedInputTokens") / input).toFixed(4)),
    costBeforeMinorUnits: sum("costBeforeMinorUnits"),
    costAfterMinorUnits: sum("costAfterMinorUnits"),
    savingFraction: Number((1 - sum("costAfterMinorUnits") / sum("costBeforeMinorUnits")).toFixed(4)),
    medianLatencyMs: [...rows.map((r) => r.latencyMs)].sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  };
};

const stamp = process.env.CACHE_EVAL_STAMP ?? String(process.hrtime.bigint());
console.log(`catalogue: ${CATALOGUE_SIZE} tools, system prompt ${systemFor("x").length} chars, stamp ${stamp}\n`);

const REPEATS = Number(process.env.CACHE_EVAL_REPEATS ?? 2);
const MUTATE_AT = 5; // turn 6 of 12, so there is a run-up and a tail either side

/** Several independent conversations per scenario, pooled — one is not a sample. */
const scenario = async (label, opts) => {
  const rows = [];
  for (let r = 0; r < REPEATS; r += 1) {
    rows.push(...(await runConversation(`${label}#${r + 1}`, { ...opts, marker: `${stamp}-${label}-${r}` })));
    console.log("");
  }
  return rows;
};

// Distinct markers, so no scenario or repeat inherits another's warm cache.
const stable = await scenario("stable ", {});
const appended = await scenario("append ", { mutateAt: MUTATE_AT, mutation: "append" });
const prepended = await scenario("prepend", { mutateAt: MUTATE_AT, mutation: "prepend" });

const report = {
  model: modelId,
  catalogueSize: CATALOGUE_SIZE,
  systemPromptChars: systemFor("x").length,
  pricing: PRICING,
  note:
    "OpenAI's prompt caching is automatic and best-effort: there is no directive to send and no guarantee of a " +
    "hit, which the per-turn rows show directly. Each scenario uses a distinct first line so the scenarios do " +
    "not share a cache.",
  turnsPerConversation: QUESTIONS.length,
  conversationsPerScenario: REPEATS,
  stablePrefix: { rows: stable, totals: totals(stable) },
  summaryAppendedAfterPrefix: { rows: appended, totals: totals(appended), mutatedAtTurn: MUTATE_AT + 1 },
  summaryPrependedBeforePrefix: { rows: prepended, totals: totals(prepended), mutatedAtTurn: MUTATE_AT + 1 },
};

const out = resolve(import.meta.dirname, "prompt-caching.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nstable prefix:      ${JSON.stringify(totals(stable))}`);
console.log(`summary appended:   ${JSON.stringify(totals(appended))}`);
console.log(`summary prepended:  ${JSON.stringify(totals(prepended))}`);
console.log(`\nwritten to ${out}`);
