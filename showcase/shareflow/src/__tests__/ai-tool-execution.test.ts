/**
 * A scripted tool call is executed, end to end, through `createAgent` — the regression `ai` is pinned against.
 *
 * `dependencies.test.ts` pins `ai` because 7.0.70 and later emit `tool-call` and then `finish` without ever
 * calling the tool's `execute`. That regression used to be caught by the shadow-runner suite; the shadow
 * runner was removed in #712 (it existed to compare against the old runtime, which is gone), so the check it
 * carried incidentally lives here on its own.
 *
 * Against a **stubbed model**: a real model cannot be made to call a particular tool on demand. The stub is a
 * hand-rolled `doStream`, not `MockLanguageModelV4` from `ai/test` — the engine streams, so a `doGenerate`
 * stub is never called.
 */
import { describe, expect, it } from "vitest";

import { asId, type AgentManifest, type PrincipalId, type TenantId, type Tool } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { createAgent } from "@retinue/agentkit/providers";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import { z } from "zod";

const TENANT = asId<TenantId>("11111111-1111-1111-1111-111111111111");

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

const noApprovals = {
  async request() {
    throw new Error("a read-only tool must not reach the approval gate");
  },
  async resolve() {
    throw new Error("a read-only tool must not reach the approval gate");
  },
} as never;

const executed: unknown[] = [];

const lookupTool = (): Tool =>
  defineDelegatingTool(
    { authorization: allowAll, approvals: noApprovals, idempotency: createMemoryIdempotencyStore() },
    {
      name: "look_up",
      label: "Look up",
      description: "Looks something up.",
      category: "analytics",
      effect: "read",
      inputSchema: z.object({ target: z.string() }).strict(),
      delegatesTo: "AnalyticsService.lookUp",
      delegate: async (input: { target: string }) => {
        executed.push(input);
        return { found: true };
      },
    },
  );

const MANIFEST = {
  id: "ai-pin-test",
  version: 1,
  name: "ai pin test",
  description: "Calls one tool.",
  instructions: "Look it up when asked.",
  modelPolicy: { role: "primary" },
  responseFormat: { kind: "text" },
  toolPolicy: { preloaded: ["look_up"], categories: ["analytics"], excluded: [] },
  limits: { maxSteps: 3, maxToolCalls: 3 },
  authorizationPolicyId: "default",
} as unknown as AgentManifest;

const streamOf = (chunks: readonly unknown[]): ReadableStream<unknown> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/** Calls `look_up` once, then answers. */
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
                { type: "tool-call", toolCallId: "call-1", toolName: "look_up", input: JSON.stringify({ target: "x" }) },
                { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
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

describe("the pinned ai SDK", () => {
  it("executes a scripted tool call and records its result", async () => {
    executed.length = 0;
    const agent = createAgent({
      manifest: MANIFEST,
      tools: [{ id: "test", async listTools() { return [lookupTool()]; } }],
      resolveModel: () => ({ model: scriptedModel(), modelId: "scripted", currency: "USD", price: () => 0 }) as never,
      tenantId: TENANT,
      authorization: allowAll,
    });

    const result = await agent.run({
      conversationId: "c1",
      message: "look it up",
      principalId: asId<PrincipalId>("22222222-2222-2222-2222-222222222222"),
      roleIds: ["editor"],
    });

    // 7.0.70+ fails both: the call is recorded, `execute` is never reached, and no result part exists.
    expect(executed).toEqual([{ target: "x" }]);
    expect(result.parts.some((part) => part.type === "tool-result")).toBe(true);
  });
});
