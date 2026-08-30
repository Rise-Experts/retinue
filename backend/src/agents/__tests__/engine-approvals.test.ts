/**
 * The engine's half of the approval loop — where a refused tool call becomes a paused run, and
 * where a decided approval becomes an executed one.
 *
 * The wiring below is real: a real registry over a real delegating capability, a real gate, real
 * stores. Only the model is a stub, because the model is the one part whose behaviour is not a
 * guarantee — what matters is that a gated call cannot get through and an approved call does.
 */

import { turnText } from "../../models/streaming.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, PrincipalId, RunId, TenantId } from "../../core/ids.js";
import type { AuthorizationPolicy } from "../../authorization/index.js";
import {
  createMemoryApprovalGrantStore,
  createMemoryIdempotencyStore,
  createMemoryInteractionStore,
} from "../../adapters/memory/index.js";
import type { ModelTurnRequest, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import { createApprovalGate, createApprovalService, createRunApprovals } from "../../hitl/index.js";
import { createToolRegistry, defineDelegatingTool } from "../../tools/index.js";
import type { Tool, ToolProvider } from "../../tools/index.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import { createDefaultEngine } from "../engine.js";
import { defineAgent } from "../define.js";

const T = asId<TenantId>("t1");
const RUN = asId<RunId>("run1");

const run: Run = {
  id: RUN,
  tenantId: T,
  conversationId: asId<ConversationId>("c1"),
  agentId: asId<AgentId>("a1"),
  agentVersion: 1,
  status: "running",
  createdAt: "t",
};
const context: ExecutionContext = {
  tenantId: T,
  principalId: asId<PrincipalId>("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
  runId: RUN,
};
const manifest = defineAgent({ id: "a1", name: "A", instructions: "be helpful", modelPolicy: { role: "smart" } });
const signal = { isCancelled: () => false };

const allowAll = (): AuthorizationPolicy => ({
  async can() {
    return { allow: true };
  },
  async filterTools(_c, tools) {
    return tools;
  },
  async scope(c) {
    return { tenantId: c.tenantId, roleIds: c.roleIds };
  },
});

/** The whole run path: capability → registry → gate → approval service → coordinator → engine. */
const harness = () => {
  const published: { draftId: string }[] = [];
  const interactions = createMemoryInteractionStore();
  const grants = createMemoryApprovalGrantStore();
  const idempotency = createMemoryIdempotencyStore();
  const authorization = allowAll();
  const clock = () => "2026-08-23T12:00:00.000Z";
  const approvals = createApprovalGate({ grants, interactions, clock });

  const publish: Tool = defineDelegatingTool<{ draftId: string }, { url: string }>(
    { authorization, approvals, idempotency },
    {
      name: "publish_post",
      description: "Publish a draft",
      category: "publishing",
      effect: "external-write",
      inputSchema: z.object({ draftId: z.string() }),
      delegatesTo: "shareflow:publishPost",
      delegate: (input) => {
        published.push(input);
        return { url: `https://example.test/${input.draftId}` };
      },
    },
  );
  const provider: ToolProvider = { id: "p", async listTools() { return [publish]; } };
  const registry = createToolRegistry({ providers: [provider], authorization, idempotency, approval: approvals });
  let n = 0;
  const service = createApprovalService({
    interactions,
    grants,
    dispatcher: { async enqueueRun() {} },
    clock,
    idFactory: () => `int-${(n += 1)}`,
  });
  const runApprovals = createRunApprovals({ interactions, approvals: service, tools: registry, clock });

  /** A model that calls `publish_post` once, then finishes. The tool it calls is the engine's. */
  const modelCalls = (input: unknown) =>
    (req: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> =>
      (async function* () {
        yield { type: "tool-call", toolCallId: "tc1", toolName: "publish_post", input };
        const tool = req.tools?.find((t) => t.name === "publish_post");
        if (!tool) throw new Error("the engine did not expose the tool to the model");
        const output = await tool.execute(input);
        yield { type: "tool-result", toolCallId: "tc1", toolName: "publish_post", output };
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      })();

  const engine = (streamTurn: (req: ModelTurnRequest) => AsyncIterable<NeutralStreamChunk>, history: string[] = ["publish d1"]) => {
    const seen: ModelTurnRequest[] = [];
    const e = createDefaultEngine({
      loadManifest: async () => manifest,
      resolveModel: () => ({ model: {} as ResolvedModel, modelId: "claude-sonnet-5" }),
      loadHistory: async () => history.map((text) => ({ role: "user" as const, content: text })),
      buildTools: async () => [
        {
          name: "publish_post",
          description: "Publish a draft",
          execute: async () => {
            throw new Error("tool calls must be routed through the approval loop, not executed directly");
          },
        },
      ],
      approvals: runApprovals,
      streamTurn: (req) => {
        seen.push(req);
        return streamTurn(req);
      },
    });
    return { engine: e, seen };
  };

  return { published, interactions, service, runApprovals, modelCalls, engine };
};

const collect = async (
  engine: ReturnType<typeof createDefaultEngine>,
  resume: Parameters<typeof engine.run>[0]["resume"] = null,
): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context, resume, signal })) out.push(e);
  return out;
};

describe("a gated tool call pauses the run for approval", () => {
  it("raises a durable approval and ends the turn with approval.requested", async () => {
    const h = harness();
    const { engine } = h.engine(h.modelCalls({ draftId: "d1" }));
    const events = await collect(engine);

    const requested = events.find((e) => e.type === "approval.requested");
    expect(requested).toBeDefined();
    // The worker turns this into `waiting-for-approval`; without it the run would complete having
    // silently done nothing, which is how the loop used to spin.
    expect(events.at(-1)?.type).toBe("approval.requested");
    expect(h.published).toEqual([]);
    const pending = await h.interactions.findPendingApproval({ tenantId: T, runId: RUN });
    expect(pending).toMatchObject({ toolName: "publish_post", normalizedInput: { draftId: "d1" } });
  });

  it("never lets a tool call reach the caller's own execute — every call goes through the loop", async () => {
    const h = harness();
    // buildTools' execute throws by construction; reaching the end without that error is the assertion.
    const { engine } = h.engine(h.modelCalls({ draftId: "d1" }));
    await expect(collect(engine)).resolves.toBeInstanceOf(Array);
  });
});

describe("a resumed run executes the approved call", () => {
  const decide = async (h: ReturnType<typeof harness>, decision: "allow-once" | "deny") => {
    const pending = await h.interactions.findPendingApproval({ tenantId: T, runId: RUN });
    if (!pending) throw new Error("no pending approval to decide");
    await h.service.decide({ tenantId: T, interactionId: pending.id, runId: RUN, decision });
    return pending;
  };

  /** Turn one: the model asks, the gate refuses, the run pauses. */
  const firstTurn = async (h: ReturnType<typeof harness>) => {
    const { engine } = h.engine(h.modelCalls({ draftId: "d1" }));
    await collect(engine);
  };

  it("publishes the stored input and reports the tool call it ran", async () => {
    const h = harness();
    await firstTurn(h);
    const approval = await decide(h, "allow-once");

    // Turn two: the model has nothing left to do, but the approved call must still run.
    const { engine } = h.engine(() =>
      (async function* () {
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      })(),
    );
    const events = await collect(engine, null);

    expect(h.published).toEqual([{ draftId: "d1" }]);
    expect(events.find((e) => e.type === "approval.decided")).toMatchObject({ interactionId: approval.id });
    const started = events.filter((e) => e.type === "tool.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ toolName: "publish_post" });
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
    // The executed call is on the record as parts, so a refreshing client sees what ran.
    const parts = events.filter((e) => e.type === "part.added").map((e) => (e as { part: { type: string } }).part.type);
    expect(parts).toContain("tool-call");
    expect(parts).toContain("tool-result");
  });

  it("tells the model what ran, so it does not ask for the same publish again", async () => {
    const h = harness();
    await firstTurn(h);
    await decide(h, "allow-once");

    const { engine, seen } = h.engine(() =>
      (async function* () {
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      })(),
    );
    await collect(engine, null);

    const messages = seen[0]?.messages ?? [];
    expect(turnText(messages.at(-1)!)).toContain("publish_post");
  });

  it("publishes exactly once even if the model asks again in the same resumed turn", async () => {
    const h = harness();
    await firstTurn(h);
    await decide(h, "allow-once");

    // The resumed model re-issues the very same call. The approved execution already happened; this
    // one must not add a second publish.
    const { engine } = h.engine(h.modelCalls({ draftId: "d1" }));
    await collect(engine, null);

    expect(h.published).toEqual([{ draftId: "d1" }]);
  });

  it("does not publish a denied call, and lets the turn carry on", async () => {
    const h = harness();
    await firstTurn(h);
    const approval = await decide(h, "deny");

    const { engine, seen } = h.engine(() =>
      (async function* () {
        yield { type: "text-delta", id: "t", text: "Understood." };
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      })(),
    );
    const events = await collect(engine, null);

    expect(h.published).toEqual([]);
    expect(events.find((e) => e.type === "approval.decided")).toMatchObject({ interactionId: approval.id });
    expect(events.some((e) => e.type === "tool.started")).toBe(false);
    expect(turnText(seen[0]!.messages.at(-1)!)).toMatch(/denied/i);
  });

  it("runs the turn untouched when there is nothing to resume", async () => {
    const h = harness();
    const { engine } = h.engine(() =>
      (async function* () {
        yield { type: "text-delta", id: "t", text: "hello" };
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      })(),
    );
    const events = await collect(engine, null);
    expect(events.some((e) => e.type === "approval.decided")).toBe(false);
    expect(events.some((e) => e.type === "part.added")).toBe(true);
  });
});
