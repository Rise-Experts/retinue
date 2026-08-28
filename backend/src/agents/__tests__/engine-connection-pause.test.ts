/**
 * A tool that needs a connection pauses the run — REQ-063 (#259), task #264.
 *
 * Before this, a missing connection was `capability_unavailable`: the run died and a person read an error.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentPlatformError } from "../../core/errors.js";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId } from "../../core/ids.js";
import type { ModelTurnRequest, ModelTurnTool, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import { withConnectionGap } from "../../connections/pause.js";
import { createDefaultEngine } from "../engine.js";
import { defineAgent } from "../define.js";

const RUN = asId<RunId>("r1");
const run: Run = {
  id: RUN,
  tenantId: asId("t1"),
  conversationId: asId("c1"),
  agentId: asId("a1"),
  agentVersion: 1,
  status: "running",
  createdAt: "t",
};
const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
  runId: RUN,
};
const signal = { isCancelled: () => false };
const manifest = defineAgent({ id: "a1", name: "A", instructions: "x", modelPolicy: { role: "smart" } });

/** A tool whose credential is missing, marked so the engine can recognise it. */
const needsGithub: ModelTurnTool = {
  name: "github_list_issues",
  description: "list issues",
  inputSchema: { type: "object", properties: {} },
  execute: async () => {
    throw withConnectionGap(
      new AgentPlatformError({ code: "capability_unavailable", message: "no github connection", retryable: false }),
      { provider: "github", gap: "absent", scopes: ["repo"] },
    );
  },
};

/** A tool that fails for an ordinary reason. */
const brokenTool: ModelTurnTool = {
  name: "broken",
  description: "broken",
  inputSchema: { type: "object", properties: {} },
  execute: async () => {
    throw new AgentPlatformError({ code: "provider_error", message: "upstream is down", retryable: false });
  },
};

/**
 * A model that calls one tool, and **actually invokes the engine's wrapped tool**.
 *
 * That last part is the whole point. The real `streamModelTurn` hands the tool set to the AI SDK, which runs
 * `execute` itself; a fake that only emits a `tool-call` chunk never touches the tool, so the failure this test
 * is about never happens. My first version did exactly that and reported no pause — a test passing over the
 * code it meant to exercise.
 */
const callsTool = (name: string) =>
  (req: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> =>
    (async function* () {
      yield { type: "tool-call", toolCallId: "c1", toolName: name, input: {} };
      const tool = req.tools?.find((t) => t.name === name);
      if (!tool) throw new Error("the engine did not expose the tool to the model");
      const output = await tool.execute({});
      yield { type: "tool-result", toolCallId: "c1", toolName: name, output };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
    })();

const collect = async (deps: Record<string, unknown>): Promise<EngineEvent[]> => {
  const engine = createDefaultEngine({
    loadManifest: async () => manifest,
    resolveModel: () => ({ model: {} as ResolvedModel, modelId: "m", currency: "USD", price: () => 0 }),
    loadHistory: async () => [{ role: "user" as const, content: "list my issues" }],
    ...deps,
  } as never);
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context, resume: null, signal })) out.push(e);
  return out;
};

const consent = vi.fn(async () => ({
  loginUrl: "https://app.example.com/oauth/github/start?state=abc",
  scopes: ["repo"],
  expiresAt: "2030-01-01T00:00:00.000Z",
}));

describe("the run pauses rather than failing", () => {
  it("emits connection.requested with the provider, scopes and URL", async () => {
    const events = await collect({
      streamTurn: callsTool("github_list_issues"),
      buildTools: async () => [needsGithub],
      connectionConsent: consent,
    });
    const requested = events.find((e) => e.type === "connection.requested");
    expect(requested).toMatchObject({
      provider: "github",
      loginUrl: "https://app.example.com/oauth/github/start?state=abc",
      scopes: ["repo"],
      toolName: "github_list_issues",
    });
  });

  it("carries no secret — it is rendered in a UI and goes wherever a screenshot goes", async () => {
    const events = await collect({
      streamTurn: callsTool("github_list_issues"),
      buildTools: async () => [needsGithub],
      connectionConsent: consent,
    });
    const serialised = JSON.stringify(events.find((e) => e.type === "connection.requested"));
    for (const forbidden of ["client_secret", "code_verifier", "access_token"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("stops the turn there, so nothing after the paused call is emitted", async () => {
    const events = await collect({
      streamTurn: callsTool("github_list_issues"),
      buildTools: async () => [needsGithub],
      connectionConsent: consent,
    });
    expect(events.at(-1)?.type).toBe("connection.requested");
  });

  it("records the tool call as a real part, rather than losing it to an error", async () => {
    // The same choice the approval path makes: the call is a real part of the record with a real result, and
    // the run pauses on the event rather than on an error the model would try to work around.
    const events = await collect({
      streamTurn: callsTool("github_list_issues"),
      buildTools: async () => [needsGithub],
      connectionConsent: consent,
    });
    const parts = events.filter((e) => e.type === "part.added");
    expect(parts.some((e) => (e as { part: { type: string } }).part.type === "tool-call")).toBe(true);
  });
});

describe("where it must NOT pause — AC-8", () => {
  it("fails when no consent callback is wired, which is today's behaviour", async () => {
    // A host with no OAuth flow has no login URL to offer, so pausing would park the run for ever.
    await expect(
      collect({ streamTurn: callsTool("github_list_issues"), buildTools: async () => [needsGithub] }),
    ).rejects.toThrow(/no github connection/);
  });

  it("fails when the callback declines, which is what a token-only provider does", async () => {
    await expect(
      collect({
        streamTurn: callsTool("github_list_issues"),
        buildTools: async () => [needsGithub],
        connectionConsent: async () => null,
      }),
    ).rejects.toThrow(/no github connection/);
  });

  it("does not pause for an ordinary tool failure", async () => {
    // Only a *marked* connection gap pauses. Anything else is a broken tool and must fail as it always did.
    const consentFn = vi.fn(async () => ({ loginUrl: "x", scopes: [], expiresAt: "t" }));
    await expect(
      collect({
        streamTurn: callsTool("broken"),
        buildTools: async () => [brokenTool],
        connectionConsent: consentFn,
      }),
    ).rejects.toThrow(/upstream is down/);
    expect(consentFn).not.toHaveBeenCalled();
  });
});
