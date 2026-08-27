/**
 * A structured agent — task #243 AC-7.
 *
 * The reference host's second agent, and it exists to demonstrate one thing: an agent that answers with a
 * **validated object** rather than prose. `AgentManifest.responseFormat` had a `structured` variant from the day
 * the manifest existed and nothing read it, so an agent declared like this one silently returned text through
 * every release up to 0.2.0. Having it here means the capability is exercised by something that runs, rather
 * than by a unit test that calls the piece it is testing.
 *
 * Two details are load-bearing and neither is decoration:
 *
 * - **The schema is a Zod schema, not a JSON schema.** The platform refuses a bare JSON schema for a response
 *   format, because the AI SDK sends one to the provider and validates nothing coming back — so "structured"
 *   would be a request rather than a guarantee. Tools still take JSON schema; a tool's arguments are the
 *   provider's problem and a bad call is a tool error the model can see.
 * - **`requiredCapabilities: { structuredOutput: true }`** in the model policy. Without it, resolution can hand
 *   back a model that cannot do this and the run fails at the turn instead of at resolution. With it, the
 *   registry refuses up front and the message names the reason.
 */

import { z } from "zod";
import type { AgentManifest } from "@retinue/agentkit";

/**
 * What a triage answer has to contain.
 *
 * Deliberately not all-optional. A schema whose every field may be absent validates almost anything, which
 * makes the guarantee vacuous — the model can return `{}` and pass. `severity` is an enum rather than a string
 * for the same reason: "high" and "High" and "urgent" are three answers a caller would have to normalise.
 */
export const triageSchema = z.object({
  summary: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum(["bug", "feature-request", "question", "billing", "other"]),
  /** Present so a caller can route on confidence rather than treating every answer as equally good. */
  confidence: z.number().min(0).max(1),
  suggestedNextSteps: z.array(z.string()).min(1).max(5),
});

export type Triage = z.infer<typeof triageSchema>;

export const structuredAgentManifest: AgentManifest = {
  id: "example-triage",
  version: 1,
  name: "Triage",
  description: "Classifies an inbound support message into a validated triage record.",
  instructions: [
    "You triage inbound support messages.",
    "",
    "Read the message and classify it. Be decisive: pick the single closest category and the severity a support",
    "lead would agree with, not the highest one that could be argued for. `critical` means someone cannot work",
    "and there is no workaround.",
    "",
    "`confidence` is your own estimate that this classification is right — a vague one-line message deserves a",
    "low number, and saying so is more useful than guessing confidently.",
    "",
    "`suggestedNextSteps` are actions a human on the support team would take next. Concrete ones: 'ask for the",
    "browser console output', not 'investigate further'.",
  ].join("\n"),
  modelPolicy: {
    role: "smart",
    // The check that makes resolution refuse a model that cannot do this, rather than the turn discovering it.
    requiredCapabilities: { structuredOutput: true },
  },
  responseFormat: { kind: "structured", schema: triageSchema },
  toolPolicy: { preloaded: [], categories: [], excluded: [] },
  skillPolicy: { assigned: [], allowTenantSkills: false },
  authorizationPolicyId: "default",
  contextProviderIds: [],
  limits: {
    maxSteps: 2,
    maxToolCalls: 0,
    wallClockTimeoutMs: 60_000,
    maxInputTokens: 20_000,
    maxOutputTokens: 1_024,
    costCeilingMinorUnits: 10_000,
    maxRetries: 2,
    retryBackoffMs: 500,
    maxInlineToolOutputBytes: 4_096,
    // Zero, because a triage classification should be reproducible: the same message must not come back
    // `high` one minute and `medium` the next.
    temperature: 0,
  },
};
