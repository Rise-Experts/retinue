import { describe, expect, it, vi } from "vitest";

import { createWorkspaceModelFactory, withWorkspaceModel } from "../workspace-turn-model.js";

/**
 * A conversational turn on the workspace's own model — the half of #462 that shipped unfixed.
 *
 * The assistant kept answering on the deployment's key because `resolveModel(manifest, context)` is
 * called synchronously by the engine, so the per-tenant lookup it exists for could not happen inside
 * it. With the platform's Google credits depleted that stopped being an accounting problem and became
 * "the assistant does not answer" — for a workspace that had configured a working provider of its own.
 *
 * These assert on **which model actually received the call**, because that is the only observable that
 * distinguishes a wired turn from an unwired one. A test that checked the resolver was merely *called*
 * would pass against a wrapper that called it and then used the deployment's model anyway.
 */

type Captured = { params?: unknown; calls: number };

const fakeModel = (label: string, captured: Captured) => ({
  label,
  doGenerate: async (params: unknown) => {
    captured.params = params;
    captured.calls += 1;
    return { label, kind: "generate" };
  },
  doStream: async (params: unknown) => {
    captured.params = params;
    captured.calls += 1;
    return { label, kind: "stream" };
  },
});

/** `wrapLanguageModel` stands in as the identity here: the middleware itself is what we drive. */
const passthroughWrap = ({ middleware }: { model: unknown; middleware: unknown }) => middleware;

const CONTEXT = { tenantId: "11111111-1111-1111-1111-111111111111" } as never;

const CLAUDE = { provider: "anthropic" as const, modelId: "claude-sonnet-5", apiKey: "sk-ant", baseUrl: undefined };

const build = (input: {
  resolve: () => Promise<unknown>;
  languageModelFor?: () => Promise<unknown>;
  workspaceCaptured?: Captured;
}) => {
  const platform = { calls: 0 } as Captured;
  const workspace = input.workspaceCaptured ?? ({ calls: 0 } as Captured);
  const turn = withWorkspaceModel({
    model: fakeModel("platform", platform),
    context: CONTEXT,
    resolve: input.resolve as never,
    languageModelFor: input.languageModelFor ?? (async () => fakeModel("workspace", workspace)),
    wrap: passthroughWrap,
  });
  const middleware = turn.model as {
    wrapStream: (o: { doStream: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown>;
    wrapGenerate: (o: { doGenerate: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown>;
  };
  const platformModel = fakeModel("platform", platform);
  return {
    turn,
    platform,
    workspace,
    stream: (params: unknown = { prompt: "hi" }) =>
      middleware.wrapStream({ doStream: () => platformModel.doStream(params), params }),
    generate: (params: unknown = { prompt: "hi" }) =>
      middleware.wrapGenerate({ doGenerate: () => platformModel.doGenerate(params), params }),
  };
};

describe("the turn's model", () => {
  it("runs on the workspace's model when it has one, not the deployment's", async () => {
    const t = build({ resolve: async () => CLAUDE });
    const result = (await t.stream()) as { label: string };
    expect(result.label, "the turn ran on the deployment's model").toBe("workspace");
    expect(t.workspace.calls).toBe(1);
    expect(t.platform.calls).toBe(0);
    expect(t.turn.ranOnWorkspaceModel()).toBe(true);
  });

  it("hands the workspace's model the same call params, unaltered", async () => {
    /**
     * The redirect replaces the *destination*, never the request. A wrapper that rebuilt params would
     * silently drop tools, system prompt or messages — and the symptom would be an assistant that
     * answers but cannot call anything.
     */
    const params = { prompt: [{ role: "user" }], tools: [{ name: "create_post_draft" }], temperature: 0.3 };
    const t = build({ resolve: async () => CLAUDE });
    await t.stream(params);
    expect(t.workspace.params).toBe(params);
  });

  it("falls back to the deployment's model when the workspace has none", async () => {
    const t = build({ resolve: async () => undefined });
    const result = (await t.stream()) as { label: string };
    expect(result.label).toBe("platform");
    expect(t.workspace.calls).toBe(0);
    expect(t.turn.ranOnWorkspaceModel()).toBe(false);
  });

  it("covers generate as well as stream, since a turn uses both", async () => {
    const t = build({ resolve: async () => CLAUDE });
    const result = (await t.generate()) as { label: string; kind: string };
    expect(result.label).toBe("workspace");
    expect(result.kind).toBe("generate");
  });

  it("resolves once per turn, however many model calls the turn makes", async () => {
    /**
     * A tool-calling turn is a loop, and each pass reaches the model. One lookup per pass would
     * multiply a query by the loop's length for no new information — a credential cannot meaningfully
     * change inside one turn, and the next turn re-resolves.
     */
    let lookups = 0;
    const t = build({
      resolve: async () => {
        lookups += 1;
        return CLAUDE;
      },
    });
    await t.stream();
    await t.generate();
    await t.stream();
    expect(t.workspace.calls).toBe(3);
    expect(lookups).toBe(1);
  });

  it("falls back rather than failing the turn when the lookup throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = build({
      resolve: async () => {
        throw new Error("connection terminated");
      },
    });
    const result = (await t.stream()) as { label: string };
    expect(result.label).toBe("platform");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/connection terminated/);
    warn.mockRestore();
  });

  it("falls back when the workspace's model cannot be built", async () => {
    /**
     * A provider the SDK refuses, or a base URL it will not accept. The turn still has to answer, and
     * it has to say why it answered on the other model.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = build({
      resolve: async () => CLAUDE,
      languageModelFor: async () => {
        throw new Error("unsupported provider");
      },
    });
    const result = (await t.stream()) as { label: string };
    expect(result.label).toBe("platform");
    expect(t.turn.ranOnWorkspaceModel()).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/claude-sonnet-5/);
    warn.mockRestore();
  });

  it("never reports having run on the workspace's model before the call happened", async () => {
    // `price` is read after the turn and branches on this. Reading it early must not claim a BYO run.
    const t = build({ resolve: async () => CLAUDE });
    expect(t.turn.ranOnWorkspaceModel()).toBe(false);
    await t.stream();
    expect(t.turn.ranOnWorkspaceModel()).toBe(true);
  });
});

describe("the provider client cache", () => {
  it("is keyed on the credential, so two workspaces never share one client", async () => {
    /**
     * The most serious failure this code could have. One worker serves every workspace, so the client
     * is the shared thing: keying it by tenant, or building it once, hands workspace B a client holding
     * workspace A's key. No single-workspace test can see it, because each one passes.
     */
    const seen: Array<Record<string, { apiKey?: string }>> = [];
    vi.doMock("@retinue/agentkit/providers", () => ({
      createProviderFactory: (config: { credentials?: Record<string, { apiKey?: string }> }) => {
        seen.push(config.credentials ?? {});
        return { languageModel: () => ({ doStream: async () => ({}) }) };
      },
    }));
    vi.resetModules();
    const { createWorkspaceModelFactory: fresh } = await import("../workspace-turn-model.js");
    const factory = fresh();

    const a = await factory({ provider: "anthropic", modelId: "claude-sonnet-5", apiKey: "sk-AAA", baseUrl: undefined });
    const b = await factory({ provider: "anthropic", modelId: "claude-sonnet-5", apiKey: "sk-BBB", baseUrl: undefined });
    const aAgain = await factory({ provider: "anthropic", modelId: "claude-sonnet-5", apiKey: "sk-AAA", baseUrl: undefined });

    expect(a).not.toBe(b);
    // The same credential reuses its client -- that is the cost this cache exists to avoid.
    expect(aAgain).toBe(a);
    const keys = seen.map((c) => c["anthropic"]?.apiKey);
    expect(keys).toContain("sk-AAA");
    expect(keys, "the second workspace was served the first workspace's client").toContain("sk-BBB");
    vi.doUnmock("@retinue/agentkit/providers");
    vi.resetModules();
  });

  it("carries a self-hosted endpoint's base URL, which is the only thing that reaches it", async () => {
    const seen: Array<Record<string, { baseURL?: string; apiKey?: string }>> = [];
    vi.doMock("@retinue/agentkit/providers", () => ({
      createProviderFactory: (config: { credentials?: Record<string, { baseURL?: string }> }) => {
        seen.push(config.credentials ?? {});
        return { languageModel: () => ({ doStream: async () => ({}) }) };
      },
    }));
    vi.resetModules();
    const { createWorkspaceModelFactory: fresh } = await import("../workspace-turn-model.js");
    await fresh()({
      provider: "openai-compatible",
      modelId: "qwen-plus",
      apiKey: undefined,
      baseUrl: "https://ws-x.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    });
    const creds = seen[0]?.["openai-compatible"];
    expect(creds?.baseURL).toBe("https://ws-x.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
    // Absent rather than empty: the SDK falls back to its env default when `apiKey` is missing, and an
    // `apiKey: ""` would instead send an empty credential.
    expect(creds !== undefined && "apiKey" in creds).toBe(false);
    vi.doUnmock("@retinue/agentkit/providers");
    vi.resetModules();
  });

  it("exists", () => {
    expect(createWorkspaceModelFactory).toBeTypeOf("function");
  });
});

/** #551 — the chat's model choice and effort, on top of #462's workspace default. */
describe("the chat's model and effort", () => {
  const DEPLOYMENT = { provider: "google", modelId: "gemini-2.5-flash" };
  type Mw = {
    transformParams: (o: { params: unknown }) => Promise<unknown>;
    wrapGenerate: (o: { doGenerate: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown>;
  };
  const turnWith = (settings: { mode: "auto"; effort: "low" | "medium" | "high"; model?: string }, workspace?: typeof CLAUDE) => {
    const built: string[] = [];
    const captured = { calls: 0 } as Captured;
    const turn = withWorkspaceModel({
      model: fakeModel("platform", { calls: 0 } as Captured),
      context: CONTEXT,
      resolve: (async () => workspace) as never,
      languageModelFor: async () => fakeModel("workspace", captured),
      wrap: passthroughWrap,
      turnSettings: async () => settings,
      deployment: DEPLOYMENT,
      allowedDeploymentModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
      deploymentModelFor: async (modelId) => {
        built.push(modelId);
        return fakeModel(`chorus:${modelId}`, captured);
      },
    });
    return { mw: turn.model as Mw, turn, built };
  };

  it("runs a chorus:<id> choice on the deployment's key, and it is not a free turn", async () => {
    const { mw, turn, built } = turnWith({ mode: "auto", effort: "medium", model: "chorus:gemini-2.5-pro" }, CLAUDE);
    const result = await mw.wrapGenerate({ doGenerate: async () => ({ label: "platform" }), params: {} });
    expect(result).toMatchObject({ label: "chorus:gemini-2.5-pro" });
    expect(built).toEqual(["gemini-2.5-pro"]);
    expect(turn.ranOnWorkspaceModel()).toBe(false);
  });

  it("refuses a model the deployment does not offer by using the default, never another named model", async () => {
    const { mw, built } = turnWith({ mode: "auto", effort: "medium", model: "chorus:gpt-5" });
    const result = await mw.wrapGenerate({ doGenerate: async () => ({ label: "platform" }), params: {} });
    expect(result).toMatchObject({ label: "platform" });
    expect(built).toEqual([]);
  });

  it("keeps #462's default: no choice and a workspace key runs on the key, free to the platform", async () => {
    const { mw, turn } = turnWith({ mode: "auto", effort: "medium" }, CLAUDE);
    const result = await mw.wrapGenerate({ doGenerate: async () => ({ label: "platform" }), params: {} });
    expect(result).toMatchObject({ label: "workspace" });
    expect(turn.ranOnWorkspaceModel()).toBe(true);
  });

  it("puts the effort in the params of the model that actually runs", async () => {
    const { mw } = turnWith({ mode: "auto", effort: "high" });
    expect(await mw.transformParams({ params: { prompt: [] } })).toEqual({
      prompt: [],
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 8192 } } },
    });
    const onClaude = turnWith({ mode: "auto", effort: "high" }, CLAUDE);
    const params = (await onClaude.mw.transformParams({ params: {} })) as { providerOptions?: Record<string, unknown> };
    expect(Object.keys(params.providerOptions ?? {})).toEqual(["anthropic"]);
  });
});

/**
 * #668: a rate-limited chat call is tried once on the sibling model, on the deployment's key — and only then.
 */
describe("the sibling model", () => {
  const GEMINI = { provider: "google" as const, modelId: "gemini-primary" };
  const RATE_LIMITED = () => Object.assign(new Error("Too Many Requests"), { statusCode: 429 });

  const buildWithSibling = (input: { primary: () => Promise<unknown>; sibling?: boolean }) => {
    const siblingCalls = { calls: 0 } as Captured;
    let primaryCalls = 0;
    const turn = withWorkspaceModel({
      model: fakeModel("platform", { calls: 0 }),
      context: CONTEXT,
      resolve: (async () => undefined) as never,
      languageModelFor: async () => fakeModel("workspace", { calls: 0 }),
      wrap: passthroughWrap,
      deployment: GEMINI,
      ...(input.sibling === false ? {} : { sibling: { modelId: "gemini-sibling", model: async () => fakeModel("sibling", siblingCalls) } }),
    });
    const middleware = turn.model as { wrapGenerate: (o: { doGenerate: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown> };
    return {
      siblingCalls,
      primaryCalls: () => primaryCalls,
      generate: () =>
        middleware.wrapGenerate({
          doGenerate: () => {
            primaryCalls += 1;
            return input.primary();
          },
          params: { prompt: "hi" },
        }),
    };
  };

  it("retries a rate-limited call once on the sibling, and stays there for the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = buildWithSibling({ primary: async () => Promise.reject(RATE_LIMITED()) });
      expect(((await t.generate()) as { label: string }).label).toBe("sibling");
      expect(((await t.generate()) as { label: string }).label).toBe("sibling");
      expect(t.primaryCalls()).toBe(1);
      expect(t.siblingCalls.calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not retry another kind of failure on the sibling", async () => {
    const t = buildWithSibling({ primary: async () => Promise.reject(Object.assign(new Error("bad request"), { statusCode: 400 })) });
    await expect(t.generate()).rejects.toThrow("bad request");
    expect(t.siblingCalls.calls).toBe(0);
  });

  it("does not retry on a sibling when none is configured", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = buildWithSibling({ primary: async () => Promise.reject(RATE_LIMITED()), sibling: false });
      const failed = t.generate().catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await failed).toMatchObject({ code: "rate_limited" });
      // #651's own step retry, on the same model.
      expect(t.primaryCalls()).toBe(3);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("never moves a workspace's own key onto the platform's sibling", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const siblingCalls = { calls: 0 } as Captured;
      const turn = withWorkspaceModel({
        model: fakeModel("platform", { calls: 0 }),
        context: CONTEXT,
        resolve: (async () => CLAUDE) as never,
        languageModelFor: async () => ({ doGenerate: async () => Promise.reject(RATE_LIMITED()) }),
        wrap: passthroughWrap,
        deployment: GEMINI,
        sibling: { modelId: "gemini-sibling", model: async () => fakeModel("sibling", siblingCalls) },
      });
      const middleware = turn.model as { wrapGenerate: (o: { doGenerate: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown> };
      const failed = middleware.wrapGenerate({ doGenerate: async () => ({}), params: { prompt: "hi" } }).catch((thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await failed).toMatchObject({ code: "rate_limited" });
      expect(siblingCalls.calls).toBe(0);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
