/**
 * A misspelled argument is refused with the right name, and the model can retry in the same turn — #689.
 *
 * Production, 2026-10-04: `generate_media` got `as1pectRatio`, nothing was generated, and the reply said the image
 * was coming. Run end to end through `createAgent` against a scripted model (see `ai-tool-execution.test.ts` for
 * why a stub): step 1 sends the typo, step 2 reads what came back and retries only if it names `aspectRatio`.
 */
import { describe, expect, it } from "vitest";

import { asId, type AgentManifest, type PrincipalId, type TenantId, type Tool } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { createAgent } from "@retinue/agentkit/providers";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import { z } from "zod";

import { withJsonTextArguments } from "../tools/factory.js";

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

const executed: unknown[] = [];

const makeImage = (schema: z.ZodTypeAny): Tool =>
  withJsonTextArguments(
    defineDelegatingTool(
      { authorization: allowAll, approvals: {} as never, idempotency: createMemoryIdempotencyStore() },
      {
        name: "make_image",
        label: "Make an image",
        description: "Makes an image.",
        category: "media",
        effect: "read",
        inputSchema: schema,
        delegatesTo: "MediaService.generate",
        delegate: async (input: unknown) => {
          executed.push(input);
          return { jobId: "job-1" };
        },
      },
    ),
  );

const MANIFEST = {
  id: "argument-retry-test",
  version: 1,
  name: "argument retry test",
  description: "Makes an image.",
  instructions: "Make the image.",
  modelPolicy: { role: "primary" },
  responseFormat: { kind: "text" },
  toolPolicy: { preloaded: ["make_image"], categories: ["media"], excluded: [] },
  limits: { maxSteps: 4, maxToolCalls: 4 },
  authorizationPolicyId: "default",
} as unknown as AgentManifest;

const streamOf = (chunks: readonly unknown[]): ReadableStream<unknown> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const call = (id: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: "make_image", input: JSON.stringify(input) },
  { type: "finish", finishReason: "tool-calls", usage },
];
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: text },
  { type: "text-end", id: "0" },
  { type: "finish", finishReason: "stop", usage },
];

/** Sends the typo, then retries with whatever valid name the refusal suggested — or gives up if it named none. */
const typoThenRetry = (seen: string[], typo: string) => {
  let step = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "scripted",
    async doStream(params: { prompt: { role: string; content: unknown }[] }) {
      step += 1;
      if (step === 1) return { stream: streamOf(call("call-1", { prompt: "a cafe", [typo]: "4:5" })) };
      if (step === 2) {
        // Escapes stripped: the refusal is JSON text inside JSON text by the time it is in the prompt.
        const refusal = JSON.stringify(params.prompt.filter((message) => message.role === "tool")).replace(/\\/g, "");
        seen.push(refusal);
        const meant = /did you mean "(\w+)"/.exec(refusal)?.[1];
        return { stream: streamOf(meant === undefined ? say("gave up") : call("call-2", { prompt: "a cafe", [meant]: "4:5" })) };
      }
      return { stream: streamOf(say("Your image is being made.")) };
    },
  } as never;
};

const run = async (schema: z.ZodTypeAny, typo = "aspectRaito") => {
  executed.length = 0;
  const seen: string[] = [];
  const agent = createAgent({
    manifest: MANIFEST,
    tools: [{ id: "test", async listTools() { return [makeImage(schema)]; } }],
    resolveModel: () => ({ model: typoThenRetry(seen, typo), modelId: "scripted", currency: "USD", price: () => 0 }) as never,
    tenantId: TENANT,
    authorization: allowAll,
  });
  await agent.run({
    conversationId: "c1",
    message: "make an image in 4:5",
    principalId: asId<PrincipalId>("22222222-2222-2222-2222-222222222222"),
    roleIds: ["editor"],
  });
  return { seen: seen.join("\n") };
};

describe("a misspelled tool argument (#689)", () => {
  const strict = z.object({ prompt: z.string(), aspectRatio: z.enum(["1:1", "4:5", "16:9"]).optional() }).strict();
  const loose = z.object({ prompt: z.string(), aspectRatio: z.enum(["1:1", "4:5", "16:9"]).default("1:1") });

  it("is refused naming the argument it meant and every valid one (AC-1)", async () => {
    const { seen } = await run(strict);
    expect(seen).toContain("aspectRaito");
    expect(seen).toContain('did you mean "aspectRatio"');
    expect(seen).toContain("This tool takes: prompt, aspectRatio");
  });

  it("lets the model retry with the right name in the same turn (AC-2)", async () => {
    await run(strict);
    expect(executed).toEqual([{ prompt: "a cafe", aspectRatio: "4:5" }]);
  });

  it("is refused even where the schema would have dropped it and used the default", async () => {
    // Without the check a non-strict schema runs with aspectRatio "1:1": the person's 4:5 silently lost.
    await run(loose);
    expect(executed).toEqual([{ prompt: "a cafe", aspectRatio: "4:5" }]);
  });
});

describe("a stray digit in an argument name (#746)", () => {
  const strict = z.object({ prompt: z.string(), aspectRatio: z.enum(["1:1", "4:5", "16:9"]).optional() }).strict();

  it("is read as the name it plainly is, so the first call runs", async () => {
    const { seen } = await run(strict, "as1pectRatio");
    expect(seen).not.toContain("Unknown argument");
    expect(executed).toEqual([{ prompt: "a cafe", aspectRatio: "4:5" }]);
  });

  it("is repaired only when removing the digits gives exactly one valid name that was not also sent", async () => {
    const { repairGlitchedNames } = await import("../tools/factory.js");
    const keys = ["resultId", "maxPassages"];
    expect(repairGlitchedNames({ resultId: "r", maxPas1sages: 8 }, keys)).toEqual({ resultId: "r", maxPassages: 8 });
    expect(repairGlitchedNames({ maxPassages: 3, maxPas1sages: 8 }, keys)).toEqual({ maxPassages: 3, maxPas1sages: 8 });
    expect(repairGlitchedNames({ maxPasages2: 8 }, keys)).toEqual({ maxPasages2: 8 });
    expect(repairGlitchedNames("text", keys)).toBe("text");
  });
});

describe("argument names (#689)", () => {
  it("are read through refine and preprocess, and not claimed for schemas that take extra keys", async () => {
    const { argumentNames, closestArgument } = await import("../tools/factory.js");
    expect(argumentNames(z.object({ a: z.string() }).strict().refine(() => true))).toEqual(["a"]);
    expect(argumentNames(z.preprocess((v) => v, z.object({ a: z.string(), b: z.number() })))).toEqual(["a", "b"]);
    expect(argumentNames(z.object({ a: z.string() }).passthrough())).toBeUndefined();
    expect(argumentNames(z.object({ a: z.string() }).catchall(z.string()))).toBeUndefined();
    expect(argumentNames(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]))).toBeUndefined();
    expect(closestArgument("as1pectRatio", ["prompt", "aspectRatio"])).toBe("aspectRatio");
    expect(closestArgument("colour", ["prompt", "aspectRatio"])).toBeUndefined();
  });
});
