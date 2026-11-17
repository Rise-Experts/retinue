import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";

import { withWorkspaceModel } from "../workspace-turn-model.js";

/** #630 — the model middleware knows which model answers, and shapes each call's prompt for it. */
const context = { tenantId: "t1", principalId: "u1", runId: "r1", conversationId: "conv-9" } as unknown as ExecutionContext;

const build = (deployment: { provider: string; modelId: string }, byo?: { provider: string; modelId: string }) => {
  let middleware: { transformParams: (o: { params: unknown }) => Promise<unknown> } | undefined;
  const turn = withWorkspaceModel({
    model: {},
    context,
    resolve: async () => (byo === undefined ? undefined : ({ ...byo, apiKey: "k" } as never)),
    languageModelFor: async () => ({}),
    wrap: ({ middleware: m }) => {
      middleware = m as never;
      return {};
    },
    deployment,
  });
  return { turn, transform: (params: unknown) => middleware!.transformParams({ params }) };
};

describe("the turn's target", () => {
  it("is the deployment's model without a key of the workspace's own", async () => {
    const { turn } = build({ provider: "google", modelId: "gemini-2.5-flash" });
    expect(await turn.target()).toEqual({ provider: "google", modelId: "gemini-2.5-flash" });
  });

  it("is the workspace's model when it has its own key", async () => {
    const { turn } = build({ provider: "google", modelId: "gemini-2.5-flash" }, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(await turn.target()).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });
});

describe("each call's params", () => {
  const params = { prompt: [{ role: "system", content: "s" }, { role: "user", content: [{ type: "text", text: "hi" }] }] };

  it("get Anthropic cache breakpoints on a Claude turn", async () => {
    const { transform } = build({ provider: "google", modelId: "gemini-2.5-flash" }, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
    const out = (await transform(params)) as { prompt: { providerOptions?: unknown }[] };
    expect(out.prompt[0]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(out.prompt[1]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("get the conversation as OpenAI's cache key", async () => {
    const { transform } = build({ provider: "openai", modelId: "gpt-4.1" });
    const out = (await transform(params)) as { providerOptions: { openai: { promptCacheKey: string } } };
    expect(out.providerOptions.openai.promptCacheKey).toBe("conv-9");
  });

  it("are left alone on Gemini, which caches implicitly", async () => {
    const { transform } = build({ provider: "google", modelId: "gemini-2.5-flash" });
    expect(await transform(params)).toEqual(params);
  });
});
