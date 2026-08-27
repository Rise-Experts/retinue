#!/usr/bin/env node
/**
 * A structured agent, end to end, against a real model — task #243 AC-1.
 *
 *   npm run structured        (from examples/, reads ../.env)
 *
 * A model key and nothing else: no database, no queue, no second terminal. It runs the triage agent over four
 * support messages and prints the validated object each one produced.
 *
 * ## Why this exists rather than a unit test
 *
 * `responseFormat: { kind: "structured" }` shipped in 0.2.0 reading nothing at all — a unit test of every piece
 * passed the whole time, because each piece worked and none was connected. So the acceptance criterion asks for
 * a live model, and this is it: if the wiring breaks, this script returns prose or fails, and both are loud.
 *
 * It also re-checks each answer against the schema *here*, outside the platform. The platform validates before
 * emitting, so this second check is redundant by design — and a redundant check that has never disagreed is how
 * you know the first one runs.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { streamModelTurn } from "@retinue/agentkit/runtime";
import { structuredAgentManifest, triageSchema } from "../dist/structured.js";

const key = process.env.RETINUE_MODEL_API_KEY;
if (!key) {
  console.error("RETINUE_MODEL_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(2);
}

const model = createOpenAI({
  apiKey: key,
  ...(process.env.RETINUE_MODEL_BASE_URL ? { baseURL: process.env.RETINUE_MODEL_BASE_URL } : {}),
})(process.env.RETINUE_MODEL_ID ?? "gpt-4o");

const MESSAGES = [
  "The export button does nothing. Console shows a 500 from /api/export. Three of us are blocked, deadline is tomorrow.",
  "Would you consider adding dark mode? Not urgent, just easier on the eyes late at night.",
  "hi how do i change my password",
  "I was charged twice this month — invoice INV-2231 and INV-2232 are both for £49.",
];

let failures = 0;

for (const message of MESSAGES) {
  process.stdout.write(`\n─── ${message.slice(0, 70)}${message.length > 70 ? "…" : ""}\n`);
  const chunks = [];
  try {
    for await (const chunk of streamModelTurn({
      model,
      system: structuredAgentManifest.instructions,
      messages: [{ role: "user", content: message }],
      structuredOutput: { schema: structuredAgentManifest.responseFormat.schema },
      maxSteps: structuredAgentManifest.limits.maxSteps,
      maxOutputTokens: structuredAgentManifest.limits.maxOutputTokens,
      temperature: structuredAgentManifest.limits.temperature,
    })) {
      chunks.push(chunk);
    }
  } catch (error) {
    failures += 1;
    console.log(`  FAILED (${error.code ?? "error"}): ${error.message}`);
    continue;
  }

  const structured = chunks.find((c) => c.type === "structured-output");
  if (!structured) {
    // The original defect. If it ever comes back, it comes back here.
    failures += 1;
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    console.log(`  NO STRUCTURED OUTPUT — got text instead: ${JSON.stringify(text.slice(0, 120))}`);
    continue;
  }

  const verdict = triageSchema.safeParse(structured.value);
  if (!verdict.success) {
    failures += 1;
    console.log(`  EMITTED A NON-CONFORMING VALUE: ${verdict.error.message}`);
    continue;
  }

  const t = structured.value;
  console.log(`  severity   ${t.severity}   category ${t.category}   confidence ${t.confidence}`);
  console.log(`  summary    ${t.summary}`);
  for (const step of t.suggestedNextSteps) console.log(`   · ${step}`);
  // No text part should have escaped: with a structured format the model's text *is* the JSON, and forwarding it
  // would put half-built JSON in the transcript as prose.
  const leaked = chunks.filter((c) => c.type === "text-delta").length;
  if (leaked > 0) {
    failures += 1;
    console.log(`  LEAKED ${leaked} text delta(s) — a structured turn must not stream prose`);
  }
}

console.log(failures === 0 ? "\n✓ every message produced a validated triage record" : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
