/**
 * The shadow turn runner — #128 AC-4.
 *
 * Against a **stubbed model**, deliberately, and that is the division of labour with
 * `scripts/shadow-turn.mjs`: the script makes a real model call against a real ShareFlow database, because
 * only that produces data a gate may be evaluated on; this file pins the guarantees, because a real model
 * cannot be made to reliably call a particular tool on demand.
 *
 * The two that matter:
 *
 * - **A gated write is recorded and not performed.** If suppression failed, this suite would publish.
 * - **The approval gate is never consulted.** Suppression happens before it, because a shadow run must not
 *   ask a human to approve something that will not happen — doing so teaches people that approving is
 *   meaningless.
 */
import { describe, expect, it } from "vitest";

import { asId, type AgentManifest, type PrincipalId, type TenantId, type Tool } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import { z } from "zod";

import { createShadowTurnRunner } from "../runner.js";

const TENANT = asId<TenantId>("11111111-1111-1111-1111-111111111111");

/** Allows every tool by category, matching the rule `filterTools` uses. */
const allowAll = {
  async can() {
    return { allow: true };
  },
  async filterTools(_context: unknown, tools: readonly { name: string }[]) {
    return tools;
  },
  async scope() {
    return { kind: "all" as const };
  },
} as never;

/**
 * An approval gate that throws if consulted.
 *
 * The assertion is the wiring: a shadow run that reached this would fail the test rather than quietly ask
 * somebody to approve a write that is not going to happen.
 */
const explodingApprovals = {
  async request() {
    throw new Error("the approval gate was consulted during a shadow run");
  },
  async resolve() {
    throw new Error("the approval gate was consulted during a shadow run");
  },
} as never;

/** Records real calls, so "it was suppressed" is measured rather than assumed. */
const performed: unknown[] = [];

const publishTool = (): Tool =>
  defineDelegatingTool(
    { authorization: allowAll, approvals: explodingApprovals, idempotency: createMemoryIdempotencyStore() },
    {
      name: "publish_it",
      label: "Publish",
      description: "Publishes.",
      category: "publishing",
      effect: "external-write",
      inputSchema: z.object({ target: z.string() }).strict(),
      delegatesTo: "PublishingService.publish",
      delegate: async (input: { target: string }) => {
        // Reached only if suppression failed. In a real deployment this is the network call.
        performed.push(input);
        return { published: true };
      },
    },
  );

const MANIFEST: AgentManifest = {
  id: "shadow-test",
  version: 1,
  name: "Shadow test",
  description: "Exercises suppression.",
  instructions: "Publish when asked.",
  modelPolicy: { role: "primary" },
  responseFormat: { kind: "text" },
  toolPolicy: { preloaded: ["publish_it"], categories: ["publishing"], excluded: [] },
  limits: { maxSteps: 3, maxToolCalls: 3 },
  authorizationPolicyId: "default",
} as unknown as AgentManifest;

/**
 * A model that calls the tool once, then answers.
 *
 * **Hand-rolled rather than `MockLanguageModelV4` from `ai/test`**, and that is a boundary rather than a
 * preference: R10 refused the import because `shareflow` does not declare `ai`, and it should not — R3
 * confines the AI SDK to the platform's `models/`, so reaching for it here to save twenty lines would weaken
 * the rule in the one place a test is least likely to be reviewed for it.
 *
 * A provider stub is a `doStream` returning chunks, which is all `MockLanguageModelV4` is.
 *
 * Also worth recording: the engine **streams**, so a `doGenerate`-only stub is never called. My first attempt
 * was exactly that and the run came back `failed` with no parts — indistinguishable, from the assertions'
 * point of view, from suppression not working.
 */
const streamOf = (chunks: readonly unknown[]): ReadableStream<unknown> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const scriptedModel = () => {
  let turn = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "scripted",
    async doStream() {
      turn += 1;
      return {
        stream: streamOf(
          turn === 1
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "publish_it",
                  input: JSON.stringify({ target: "instagram" }),
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "0" },
                { type: "text-delta", id: "0", delta: "done" },
                { type: "text-end", id: "0" },
                { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              ],
        ),
      };
    },
  } as never;
};

const runnerWith = () =>
  createShadowTurnRunner({
    manifest: MANIFEST,
    providers: [{ id: "test", async listTools() { return [publishTool()]; } }],
    resolveModel: () => ({ model: scriptedModel(), modelId: "scripted", currency: "USD", price: () => 0 }),
    tenantId: TENANT,
    principalId: asId<PrincipalId>("22222222-2222-2222-2222-222222222222"),
    roleIds: ["editor"],
    authorization: allowAll,
  });

describe("a shadow turn", () => {
  it("records the external write and does not perform it", async () => {
    performed.length = 0;
    const result = await runnerWith().run({ conversationId: "c1", message: "publish it" });
    // The whole guarantee: recorded…
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]?.toolName).toBe("publish_it");
    expect(result.writes[0]?.effect).toBe("external-write");
    expect(result.writes[0]?.delegatesTo).toBe("PublishingService.publish");
    // …and the delegate never ran. If this array is non-empty, a shadow run published.
    expect(performed).toEqual([]);
  });

  it("records the validated input, which is what a parity diff compares", async () => {
    /**
     * The *validated* value, not the raw arguments. A diff over unvalidated input would compare two models'
     * spelling rather than two runtimes' behaviour.
     */
    performed.length = 0;
    const result = await runnerWith().run({ conversationId: "c2", message: "publish it" });
    expect(result.writes[0]?.input).toEqual({ target: "instagram" });
  });

  it("records whether the write would have needed approval, without asking", async () => {
    /**
     * Captured because suppression happens *before* the gate. The fact a parity report wants — "this would
     * have required a human" — is kept without putting the question to anyone, and the exploding gate above
     * is what proves the question was never put.
     */
    performed.length = 0;
    const result = await runnerWith().run({ conversationId: "c3", message: "publish it" });
    expect(result.writes[0]?.wouldRequireApproval).toBe(true);
  });

  it("hands back a ShadowRun the parity diff can consume", async () => {
    performed.length = 0;
    const result = await runnerWith().run({ conversationId: "c4", message: "publish it" });
    const run = result.asShadowRun("publish", "agentkit");
    expect(run).toMatchObject({ workflow: "publish", runtime: "agentkit" });
    expect(run.writes).toHaveLength(1);
  });

  it("carries the parts, so a harness can see a refusal the prose does not mention", async () => {
    /**
     * Two live runs made this necessary. One looked like a model that would not use its tools — the
     * authorization list matched none, so the catalogue was empty. Another looked like a model that gave up —
     * a tool had been refused by a validation rule. Neither was visible in the text.
     */
    performed.length = 0;
    const result = await runnerWith().run({ conversationId: "c5", message: "publish it" });
    expect(result.parts.some((part) => part.type === "tool-call")).toBe(true);
  });
});
