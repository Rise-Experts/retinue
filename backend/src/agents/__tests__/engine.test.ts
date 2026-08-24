import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { InteractionId, MessagePartId, RunId } from "../../core/ids.js";
import { AgentPlatformError } from "../../core/errors.js";
import { questionPending } from "../../hitl/service.js";
import type { PendingQuestion } from "../../hitl/index.js";
import type { NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import { reduceRunEvents, type RunEvent } from "../../core/events.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import { createDefaultEngine } from "../engine.js";
import { defineAgent } from "../agent.js";

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
const manifest = defineAgent({ id: "a1", name: "A", instructions: "be helpful", modelPolicy: { role: "smart" } });
const model = {} as ResolvedModel;
const signal = { isCancelled: () => false };

/** Stamp engine events into full RunEvents so we can reduce them like the worker would. */
const stamp = (events: EngineEvent[]): RunEvent[] =>
  events.map((e, i) => ({ ...e, runId: RUN, sequence: i + 1, occurredAt: `t${i + 1}` }) as RunEvent);

const baseDeps = (streamTurn: () => AsyncIterable<NeutralStreamChunk>, over = {}) => ({
  loadManifest: async () => manifest,
  resolveModel: () => ({ model, modelId: "claude-sonnet-5", currency: "USD", price: () => 42 }),
  loadHistory: async () => [{ role: "user" as const, text: "hi" }],
  streamTurn,
  ...over,
});

const collect = async (engine: ReturnType<typeof createDefaultEngine>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context, resume: null, signal })) out.push(e);
  return out;
};

describe("default engine — chunk → event mapping", () => {
  it("maps text deltas, tool call/result, and usage to typed events", async () => {
    async function* chunks(): AsyncIterable<NeutralStreamChunk> {
      yield { type: "text-delta", id: "t", text: "Hel" };
      yield { type: "text-delta", id: "t", text: "lo" };
      yield { type: "tool-call", toolCallId: "tc1", toolName: "search", input: { q: "x" } };
      yield { type: "tool-result", toolCallId: "tc1", toolName: "search", output: { hits: 1 } };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } };
    }
    const engine = createDefaultEngine(baseDeps(chunks));
    const events = collect(engine);
    const state = reduceRunEvents(stamp(await events));

    expect(state.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)).toEqual(["Hello"]);
    expect(state.parts.some((p) => p.type === "tool-call")).toBe(true);
    expect(state.parts.some((p) => p.type === "tool-result")).toBe(true);
    expect(state.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costMinorUnits: 42 });
  });

  it("throws when the stream emits an error after output (no silent swallow)", async () => {
    async function* chunks(): AsyncIterable<NeutralStreamChunk> {
      yield { type: "text-delta", id: "t", text: "partial" };
      yield { type: "error", error: new Error("provider blew up") };
    }
    const engine = createDefaultEngine(baseDeps(chunks));
    await expect(collect(engine)).rejects.toThrow("provider blew up");
  });
});

describe("default engine — retry before first output", () => {
  it("retries a transient failure that happens before any output, then succeeds", async () => {
    const { AgentPlatformError } = await import("../../core/errors.js");
    let attempts = 0;
    function makeStream(): () => AsyncIterable<NeutralStreamChunk> {
      return async function* () {
        attempts += 1;
        if (attempts === 1) throw new AgentPlatformError({ code: "rate_limited", message: "429", retryable: true });
        yield { type: "text-delta", id: "t", text: "recovered" };
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      };
    }
    const sleep = vi.fn(async () => {});
    const engine = createDefaultEngine(baseDeps(makeStream(), { sleep, now: () => 0 }));
    const events = await collect(engine);
    expect(attempts).toBe(2);
    expect(events.some((e) => e.type === "run.retry-pending")).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
    const state = reduceRunEvents(stamp(events));
    expect(state.parts.some((p) => p.type === "text")).toBe(true);
  });

  it("does NOT retry once output has already streamed", async () => {
    const { AgentPlatformError } = await import("../../core/errors.js");
    let attempts = 0;
    function makeStream(): () => AsyncIterable<NeutralStreamChunk> {
      return async function* () {
        attempts += 1;
        yield { type: "text-delta", id: "t", text: "some output" };
        throw new AgentPlatformError({ code: "rate_limited", message: "429", retryable: true });
      };
    }
    const engine = createDefaultEngine(baseDeps(makeStream(), { sleep: async () => {}, now: () => 0 }));
    await expect(collect(engine)).rejects.toMatchObject({ code: "rate_limited" });
    expect(attempts).toBe(1); // not retried — would have duplicated the partial answer
  });
});

/**
 * Generation parameters actually reaching the provider — #160.
 *
 * They never did: `streamText` was called with model, system, messages, tools and `stopWhen` only, so
 * `ModelDefinition.limits.maxOutputTokens` was decorative in the text path. Every test in this file overrides
 * `streamTurn`, which is exactly why it survived — so these assert on the **request the engine builds**, which
 * is the thing that was empty.
 */
describe("generation parameters — #160", () => {
  const empty = async function* (): AsyncIterable<NeutralStreamChunk> {
    yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
  };

  /** Capture the request rather than the chunks: the bug was in what was *sent*. */
  const captureRequest = async (over: Record<string, unknown>) => {
    let seen: ModelTurnRequest | null = null;
    const engine = createDefaultEngine(
      baseDeps(
        ((req: ModelTurnRequest) => {
          seen = req;
          return empty();
        }) as never,
        over,
      ) as never,
    );
    await collect(engine);
    return seen as ModelTurnRequest | null;
  };

  it("sends the model definition's declared output ceiling", async () => {
    const req = await captureRequest({
      resolveModel: () => ({
        model,
        modelId: "m",
        definition: { limits: { maxOutputTokens: 1_024, contextTokens: 8_000 } },
      }),
    });
    expect(req?.maxOutputTokens).toBe(1_024);
  });

  it("lets an agent ask for less, but never more than its model allows", async () => {
    // The point of AC-2. Without the `min`, the definition's limit is a *default* an agent can raise — which
    // means it is not a limit, which was the substance of the bug.
    const lower = await captureRequest({
      loadManifest: async () => ({ ...manifest, limits: { ...manifest.limits, maxOutputTokens: 256 } }),
      resolveModel: () => ({ model, modelId: "m", definition: { limits: { maxOutputTokens: 1_024 } } }),
    });
    expect(lower?.maxOutputTokens).toBe(256);

    const higher = await captureRequest({
      loadManifest: async () => ({ ...manifest, limits: { ...manifest.limits, maxOutputTokens: 99_999 } }),
      resolveModel: () => ({ model, modelId: "m", definition: { limits: { maxOutputTokens: 1_024 } } }),
    });
    expect(higher?.maxOutputTokens).toBe(1_024);
  });

  it("sends nothing when neither side declares a limit, leaving the provider's default alone", async () => {
    // Absent, not zero. Pinning an invented number would be this layer overriding a provider default it knows
    // nothing about — and `maxOutputTokens: 0` would truncate every reply to nothing.
    const req = await captureRequest({
      loadManifest: async () => ({ ...manifest, limits: { maxSteps: 4 } }),
      resolveModel: () => ({ model, modelId: "m" }),
    });
    expect(req?.maxOutputTokens).toBeUndefined();
  });

  it("passes temperature through, including zero", async () => {
    // `0` is meaningful and distinct from absent: a graded run needs to be able to ask for it, which is what
    // #141's reproducibility argument partly rests on. A truthiness check here would silently drop it.
    const req = await captureRequest({
      loadManifest: async () => ({ ...manifest, limits: { ...manifest.limits, temperature: 0 } }),
    });
    expect(req?.temperature).toBe(0);
  });
});

/**
 * A tool that puts a question to a person parks the run — #163.
 *
 * `question.requested` was in the event union and the worker turned it into `waiting-for-question`, and no code
 * path in the platform emitted one. So a tool could store a question durably, tell the model it had asked, and
 * let the run finish: the picker never appeared, and an answer would have arrived for a run already over.
 */
describe("default engine — parking a run on a question (#163)", () => {
  /** A stream that calls one tool and then keeps talking, so "did it stop?" is observable. */
  const callsTool = (toolName: string) =>
    async function* (input: { tools?: readonly { name: string; execute: (i: unknown) => Promise<unknown> }[] }) {
      const tool = (input.tools ?? []).find((t) => t.name === toolName);
      if (tool === undefined) throw new Error(`the engine did not declare ${toolName}`);
      yield { type: "text-delta", id: "t", text: "asking" } as NeutralStreamChunk;
      const result = await tool.execute({});
      yield { type: "tool-result", toolCallId: "tc1", toolName, output: result } as NeutralStreamChunk;
      // Would be emitted if the run were not parked — the assertion below is that it never is.
      yield { type: "text-delta", id: "t2", text: "carrying on regardless" } as NeutralStreamChunk;
    };

  const askingTool = (raise: () => never) => ({
    name: "ask_user",
    description: "Ask the person",
    inputSchema: {},
    execute: async () => raise(),
  });

  it("emits question.requested and stops, with no gate configured at all", async () => {
    // The case the old code could not reach: tools were only wrapped when `deps.approvals` was set, so a
    // deployment with no approval gate had no interception point and no question could ever be noticed.
    const engine = createDefaultEngine(
      baseDeps(callsTool("ask_user") as never, {
        buildTools: async () => [askingTool(() => { throw questionPending({ id: asId<InteractionId>("int-1") }); })],
      }),
    );
    const events = await collect(engine);

    const requested = events.filter((e) => e.type === "question.requested");
    expect(requested).toHaveLength(1);
    expect((requested[0] as { interactionId: string }).interactionId).toBe("int-1");
    // Parked means parked: nothing after the question, and the run is not completed by the engine.
    expect(events.at(-1)?.type).toBe("question.requested");
    const texts = events.filter((e) => e.type === "part.added" || e.type === "part.updated");
    expect(JSON.stringify(texts)).not.toContain("carrying on regardless");
  });

  it("tells the model the run is parked instead of surfacing a failure", async () => {
    // A thrown error would teach the model to retry or apologise. It gets a marker naming the interaction.
    let seen: unknown = null;
    const engine = createDefaultEngine(
      baseDeps(
        (async function* (input: { tools?: readonly { name: string; execute: (i: unknown) => Promise<unknown> }[] }) {
          const tool = (input.tools ?? []).find((t) => t.name === "ask_user");
          seen = await tool?.execute({});
          yield { type: "text-delta", id: "t", text: "ok" } as NeutralStreamChunk;
        }) as never,
        { buildTools: async () => [askingTool(() => { throw questionPending({ id: asId<InteractionId>("int-2") }); })] },
      ),
    );
    await collect(engine);

    expect(seen).toMatchObject({ status: "question_pending", interactionId: "int-2" });
    expect(String((seen as { message: string }).message)).toContain("do not retry");
  });

  /**
   * A signal with no interaction id would park a run nobody can ever un-park — a hang, not a pause. It is
   * treated as an ordinary failure instead, which is loud and recoverable.
   */
  it("refuses to park on a question with no interaction id", async () => {
    const engine = createDefaultEngine(
      baseDeps(callsTool("ask_user") as never, {
        buildTools: async () => [
          askingTool(() => {
            throw new AgentPlatformError({ code: "question_pending", message: "no id", retryable: false });
          }),
        ],
      }),
    );
    await expect(collect(engine)).rejects.toThrow("no id");
  });

  /**
   * The **code** is what marks a parked question, not the presence of an interaction id.
   *
   * This error carries an `interactionId` and is still a failure — an approval expiring names its interaction
   * too. Written this way deliberately: the weaker version of this test (a `provider_error` with no details)
   * passed even with the code check deleted, because the id guard happened to reject it. It proved nothing.
   */
  it("leaves every other tool failure a failure, even one naming an interaction", async () => {
    const engine = createDefaultEngine(
      baseDeps(callsTool("ask_user") as never, {
        buildTools: async () => [
          askingTool(() => {
            throw new AgentPlatformError({
              code: "approval_expired",
              message: "kaboom",
              retryable: false,
              details: { interactionId: "int-9" },
            });
          }),
        ],
      }),
    );
    await expect(collect(engine)).rejects.toThrow("kaboom");
  });
});

/**
 * Resuming after an answer — the other half of #163.
 *
 * Parking the run was only half the loop. `approvals` has had a resume path from the start; questions had
 * none, so the model resumed knowing nothing and asked the same question again. Verified live: picking two
 * options from the picker resumed the run and produced the identical picker.
 */
describe("default engine — resuming after a question is answered (#163)", () => {
  const answeredQuestion = (answers: Record<string, string | readonly string[]>): PendingQuestion => ({
    id: asId<InteractionId>("int-1"),
    tenantId: asId("t1"),
    runId: RUN,
    questions: [
      { key: "keep", prompt: "Which notes?", options: ["a", "b", "c"], multiple: true },
      { key: "why", prompt: "Why?" },
    ],
    createdAt: "t",
    answeredAt: "t2",
    answers,
  });

  /** Captures the messages the engine actually sends, which is where the answer has to appear. */
  const capture = async (over: Record<string, unknown>) => {
    let sent: readonly { role: string; text: string }[] = [];
    async function* chunks(req: { messages: readonly { role: string; text: string }[] }) {
      sent = req.messages;
      yield { type: "text-delta", id: "t", text: "ok" } as NeutralStreamChunk;
    }
    await collect(createDefaultEngine(baseDeps(chunks as never, over)));
    return sent;
  };

  it("puts the answer in the model's history so it stops asking", async () => {
    const sent = await capture({
      questions: { answered: async () => answeredQuestion({ keep: ["a", "c"], why: "tidier" }) },
    });
    const text = sent.map((m) => m.text).join("\n");
    expect(text).toContain("[answer] Which notes?");
    // A multi-select renders as a list, not a joined string: a value containing a comma would otherwise read
    // as more choices than the person made.
    expect(text).toContain("- a\n- c");
    expect(text).toContain("[answer] Why?\ntidier");
  });

  it("emits question.answered for the durable record", async () => {
    const engine = createDefaultEngine(
      baseDeps((async function* () { yield { type: "text-delta", id: "t", text: "ok" } as NeutralStreamChunk; }) as never, {
        questions: { answered: async () => answeredQuestion({ keep: "a" }) },
      }),
    );
    const events = await collect(engine);
    // A client that reconnects has to see that the question was resolved, or its picker stays on screen.
    expect(events.filter((e) => e.type === "question.answered")).toHaveLength(1);
  });

  it("says nothing when the run was never asked anything", async () => {
    const sent = await capture({ questions: { answered: async () => null } });
    expect(sent.map((m) => m.text).join("\n")).not.toContain("[answer]");
  });

  it("skips a question key the person did not answer", async () => {
    // Partial answers are possible — a client may send only what was filled in. An empty `[answer]` line
    // would tell the model something false about what it was told.
    const sent = await capture({ questions: { answered: async () => answeredQuestion({ keep: "a" }) } });
    const text = sent.map((m) => m.text).join("\n");
    expect(text).toContain("[answer] Which notes?");
    expect(text).not.toContain("[answer] Why?");
  });

  it("needs no questions dependency to run", async () => {
    // Optional, like `approvals`. A host that asks nothing should not have to wire the machinery for it.
    const sent = await capture({});
    expect(sent.length).toBeGreaterThan(0);
  });
});

/**
 * A tool's citations become citation parts — #165.
 *
 * `createCitationEmitter`, `CitationPart`, the frontend's renderer and the groundedness graders all existed, and
 * no code path put a citation into a run. The whole provenance feature was unreachable from an agent.
 */
describe("default engine — citations from a tool (#165)", () => {
  const candidate = (excerpt: string) => ({
    origin: { kind: "retrieval" as const, sourceType: "message" as const, sourceId: "n1", chunkId: "n1:0", chunkIndex: 0 },
    excerpt,
    retrievedAt: "2026-01-01T00:00:00.000Z",
    supports: [],
    authSubject: "c1",
  });

  /** Emits everything. The access check has its own tests in `citations/`; this is about the engine's wiring. */
  const emitter = { emit: async (_ctx: unknown, cands: readonly { excerpt: string; supports: readonly string[] }[]) => ({
    parts: cands.map((c, i) => ({
      id: asId<MessagePartId>(`cite-${i}`),
      type: "citation" as const,
      schemaVersion: 1,
      createdAt: "t",
      excerpt: c.excerpt,
      retrievedAt: "t",
      supports: c.supports,
      origin: { kind: "retrieval" as const, sourceType: "message" as const, sourceId: "n1", chunkId: "n1:0", chunkIndex: 0 },
    })),
    withheld: 0,
  }) };

  /** A stream that calls a citing tool and then writes the claim the passage supports. */
  const citingRun = (toolResult: unknown) =>
    async function* (input: { tools?: readonly { name: string; execute: (i: unknown) => Promise<unknown> }[] }) {
      const tool = (input.tools ?? []).find((t) => t.name === "search");
      const seen = await tool?.execute({});
      yield { type: "tool-result", toolCallId: "tc1", toolName: "search", output: seen } as NeutralStreamChunk;
      yield { type: "text-delta", id: "t1", text: "Revenue rose nine percent." } as NeutralStreamChunk;
    };

  const searchTool = (result: unknown) => ({
    name: "search",
    description: "Search",
    inputSchema: {},
    execute: async () => result,
  });

  it("emits a citation part grounding the claim the tool's passage supports", async () => {
    const engine = createDefaultEngine(
      baseDeps(citingRun({ hits: 1, citations: [candidate("Revenue rose nine percent quarter on quarter.")] }) as never, {
        buildTools: async () => [searchTool({ hits: 1, citations: [candidate("Revenue rose nine percent quarter on quarter.")] })],
        citations: emitter,
      }),
    );
    const events = await collect(engine);
    const cites = events.filter((e) => e.type === "part.added" && (e as { part?: { type?: string } }).part?.type === "citation");
    expect(cites).toHaveLength(1);
    // Grounding the text part that was actually written, so the renderer can mark the claim as supported.
    const part = (cites[0] as { part: { supports: readonly string[]; excerpt: string } }).part;
    expect(part.excerpt).toContain("nine percent");
    expect(part.supports).toHaveLength(1);
  });

  /**
   * Order matters as much as presence. `citationViewModel` numbers citations in arrival order and depends on
   * markup for N citations being a *prefix* of the markup for N+1 — a citation arriving before the text it
   * grounds would insert above the reader's position.
   */
  it("emits citations after the text, never before", async () => {
    const engine = createDefaultEngine(
      baseDeps(citingRun({ citations: [candidate("a passage")] }) as never, {
        buildTools: async () => [searchTool({ citations: [candidate("a passage")] })],
        citations: emitter,
      }),
    );
    const events = await collect(engine);
    const lastText = events.findLastIndex((e) => (e as { part?: { type?: string } }).part?.type === "text");
    const firstCite = events.findIndex((e) => (e as { part?: { type?: string } }).part?.type === "citation");
    expect(firstCite).toBeGreaterThan(lastText);
  });

  it("keeps the citations field away from the model", async () => {
    // The model has the tool's answer; a parallel list of chunk ids invites it to paraphrase provenance in
    // prose, which is the unverifiable thing citations exist to replace.
    let seen: unknown = null;
    const engine = createDefaultEngine(
      baseDeps((async function* (input: { tools?: readonly { name: string; execute: (i: unknown) => Promise<unknown> }[] }) {
        seen = await (input.tools ?? []).find((t) => t.name === "search")?.execute({});
        yield { type: "text-delta", id: "t1", text: "ok" } as NeutralStreamChunk;
      }) as never, {
        buildTools: async () => [searchTool({ hits: 1, citations: [candidate("x")] })],
        citations: emitter,
      }),
    );
    await collect(engine);
    expect(seen).toEqual({ hits: 1 });
  });

  it("emits nothing when a tool cited a passage but the model wrote no claim", async () => {
    // A citation supporting no text part is unrenderable: the view model has nothing to attach a marker to, and
    // `ungroundedCitations` would count it as a defect.
    const engine = createDefaultEngine(
      baseDeps((async function* (input: { tools?: readonly { name: string; execute: (i: unknown) => Promise<unknown> }[] }) {
        await (input.tools ?? []).find((t) => t.name === "search")?.execute({});
      }) as never, {
        buildTools: async () => [searchTool({ citations: [candidate("x")] })],
        citations: emitter,
      }),
    );
    const events = await collect(engine);
    expect(events.some((e) => (e as { part?: { type?: string } }).part?.type === "citation")).toBe(false);
  });

  it("passes an unrecognised citations field through untouched", async () => {
    // A tool whose real answer has a field of that name is not misconfigured. Failing its call, or silently
    // eating the field, would both be worse than ignoring it.
    let seen: unknown = null;
    const engine = createDefaultEngine(
      baseDeps((async function* (input: { tools?: readonly { name: string; execute: (i: unknown) => Promise<unknown> }[] }) {
        seen = await (input.tools ?? []).find((t) => t.name === "search")?.execute({});
        yield { type: "text-delta", id: "t1", text: "ok" } as NeutralStreamChunk;
      }) as never, {
        buildTools: async () => [searchTool({ citations: "a string, not candidates" })],
        citations: emitter,
      }),
    );
    const events = await collect(engine);
    expect(seen).toEqual({ citations: "a string, not candidates" });
    expect(events.some((e) => (e as { part?: { type?: string } }).part?.type === "citation")).toBe(false);
  });

  it("ignores the field entirely with no emitter configured", async () => {
    // Optional, like `approvals` and `questions`. A host that cites nothing should not have to wire an emitter.
    const engine = createDefaultEngine(
      baseDeps(citingRun({ citations: [candidate("x")] }) as never, {
        buildTools: async () => [searchTool({ citations: [candidate("x")] })],
      }),
    );
    const events = await collect(engine);
    expect(events.some((e) => (e as { part?: { type?: string } }).part?.type === "citation")).toBe(false);
  });
});
