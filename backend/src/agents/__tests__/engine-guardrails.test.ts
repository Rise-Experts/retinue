/**
 * Guardrails in the engine — REQ-046 (#205), task #211, AC-2/AC-3/AC-4.
 *
 * The unit tests next to the port prove the composer. These prove the *wiring*, which is where the guarantee
 * actually lives: a correct composer nobody calls is the shape of defect this repository keeps finding.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, RunId } from "../../core/ids.js";
import type { ModelTurnRequest, NeutralStreamChunk, ResolvedModel } from "../../models/index.js";
import type { EngineEvent, Run } from "../../runtime/index.js";
import type { Guardrail } from "../../guardrails/index.js";
import { createDefaultEngine } from "../engine.js";
import { defineAgent } from "../define.js";

const RUN = asId<RunId>("r1");
const run: Run = {
  id: RUN,
  tenantId: asId("t1"),
  conversationId: asId<ConversationId>("c1"),
  agentId: asId<AgentId>("a1"),
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
  conversationId: asId<ConversationId>("c1"),
  runId: RUN,
};
const manifest = defineAgent({ id: "a1", name: "A", instructions: "be helpful", modelPolicy: { role: "smart" } });
const signal = { isCancelled: () => false };

const deps = (streamTurn: (req: ModelTurnRequest) => AsyncIterable<NeutralStreamChunk>, over = {}) => ({
  loadManifest: async () => manifest,
  resolveModel: () => ({ model: {} as ResolvedModel, modelId: "claude-sonnet-5", currency: "USD", price: () => 0 }),
  loadHistory: async () => [{ role: "user" as const, content: "my card is 4111111111111111" }],
  streamTurn,
  ...over,
});

const collect = async (engine: ReturnType<typeof createDefaultEngine>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const e of engine.run({ run, context, resume: null, signal })) out.push(e);
  return out;
};

async function* oneWord(): AsyncIterable<NeutralStreamChunk> {
  yield { type: "text-delta", id: "t", text: "fine" };
  yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
}

describe("input guardrails — AC-3", () => {
  it("a refusal means the model is never called", async () => {
    const streamTurn = vi.fn(oneWord);
    const refuse: Guardrail = {
      name: "pii",
      inspectInput: () => ({ kind: "refused", code: "pii_present", message: "That message contains a card number." }),
    };
    const events = await collect(createDefaultEngine(deps(streamTurn, { guardrails: [refuse] })));

    // The whole point of AC-3: not "the answer was suppressed" but "no provider call happened". A guardrail that
    // inspects after the spend is a guardrail that costs money to refuse.
    expect(streamTurn).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "guardrail.verdict")).toHaveLength(1);
    expect(events.some((e) => e.type === "run.completed")).toBe(true);
  });

  it("says why, as a text part rather than a thrown error", async () => {
    const refuse: Guardrail = { name: "pii", inspectInput: () => ({ kind: "refused", code: "pii", message: "no card numbers, please" }) };
    const events = await collect(createDefaultEngine(deps(oneWord, { guardrails: [refuse] })));
    const text = events.find((e) => e.type === "part.added" && (e as { part: { type: string } }).part.type === "text");
    // A refusal is a policy outcome, not a crash. A run that failed with a stack trace tells the person nothing.
    expect((text as unknown as { part: { text: string } }).part.text).toBe("no card numbers, please");
  });

  it("a throwing guardrail also stops the turn — fail closed, end to end", async () => {
    const streamTurn = vi.fn(oneWord);
    const flaky: Guardrail = { name: "moderation", inspectInput: () => { throw new Error("upstream 503"); } };
    const events = await collect(createDefaultEngine(deps(streamTurn, { guardrails: [flaky] })));
    expect(streamTurn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "guardrail.verdict" && (e as { threw?: boolean }).threw === true)).toBe(true);
  });

  it("a redaction lets the turn proceed", async () => {
    const streamTurn = vi.fn(oneWord);
    const redact: Guardrail = {
      name: "cards",
      inspectInput: () => ({ kind: "redacted", value: { text: "my card is [redacted]" }, what: ["card_number"] }),
    };
    const events = await collect(createDefaultEngine(deps(streamTurn, { guardrails: [redact] })));
    expect(streamTurn).toHaveBeenCalledTimes(1);
    const verdict = events.find((e) => e.type === "guardrail.verdict") as unknown as { outcome: string; what: string[] };
    expect(verdict.outcome).toBe("redacted");
    expect(verdict.what).toEqual(["card_number"]);
  });

  it("emits no verdict at all when no guardrail is configured", async () => {
    const events = await collect(createDefaultEngine(deps(oneWord)));
    // "Nothing ran" must stay distinguishable from "something ran and allowed it".
    expect(events.some((e) => e.type === "guardrail.verdict")).toBe(false);
  });
});

describe("tool arguments are inspected — AC-2", () => {
  /**
   * A model that actually calls the tool the engine exposed.
   *
   * `req.tools[…].execute` rather than only yielding a `tool-call` chunk: the wrapper under test is invoked by
   * the SDK, not by the engine's chunk mapper, so a fake stream that merely announces a call exercises none of
   * it. The first version of this test did exactly that and passed the input cases while silently testing
   * nothing on the tool ones.
   */
  const callsATool = (req: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> =>
    (async function* () {
      const input = { token: "sk-live-1", url: "https://x" };
      yield { type: "tool-call", toolCallId: "tc1", toolName: "http_write", input };
      const tool = req.tools?.find((t) => t.name === "http_write");
      if (!tool) throw new Error("the engine did not expose the tool to the model");
      const output = await tool.execute(input);
      yield { type: "tool-result", toolCallId: "tc1", toolName: "http_write", output };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
    })();

  it("a refusal stops the tool from running, and the model is told why", async () => {
    const executed = vi.fn(async () => ({ ok: true }));
    const noExfil: Guardrail = {
      name: "no-exfil",
      inspectOutput: (o) => (o.kind === "tool-call" ? { kind: "refused", code: "exfiltration", message: "token in a tool argument" } : { kind: "pass" }),
    };
    const events = await collect(
      createDefaultEngine(
        deps(callsATool, {
          guardrails: [noExfil],
          buildTools: async () => [{ name: "http_write", description: "write", execute: executed }],
        }),
      ),
    );
    // Checking only the final message would let this through: the data leaves in an argument, not in prose.
    expect(executed).not.toHaveBeenCalled();
    const verdict = events.find((e) => e.type === "guardrail.verdict") as unknown as { subject: string; outcome: string };
    expect(verdict).toMatchObject({ subject: "tool-call", outcome: "refused" });
  });

  it("a redacted argument is what actually runs", async () => {
    const seen: unknown[] = [];
    const strip: Guardrail = {
      name: "strip-token",
      inspectOutput: (o) =>
        o.kind === "tool-call"
          ? { kind: "redacted", value: { ...o, input: { ...(o.input as object), token: "[redacted]" } }, what: ["token"] }
          : { kind: "pass" },
    };
    await collect(
      createDefaultEngine(
        deps(callsATool, {
          guardrails: [strip],
          buildTools: async () => [{ name: "http_write", description: "write", execute: async (input: unknown) => { seen.push(input); return { ok: true }; } }],
        }),
      ),
    );
    // The tool must receive the redaction, not what the model typed — otherwise the guardrail is decorative.
    expect(seen).toEqual([{ token: "[redacted]", url: "https://x" }]);
  });

  it("the verdict reaches the run event log, not just the enforcement path — AC-4", async () => {
    const strip: Guardrail = {
      name: "strip-token",
      inspectOutput: (o) => (o.kind === "tool-call" ? { kind: "redacted", value: { ...o, input: {} }, what: ["token"] } : { kind: "pass" }),
    };
    const events = await collect(
      createDefaultEngine(
        deps(callsATool, { guardrails: [strip], buildTools: async () => [{ name: "http_write", description: "write", execute: async () => ({ ok: true }) }] }),
      ),
    );
    const verdicts = events.filter((e) => e.type === "guardrail.verdict") as unknown as { subject: string; outcome: string }[];
    /**
     * **Two**, and that is the point rather than an accident.
     *
     * This asserted one until #212 added tool-*result* inspection. A tool call now crosses the boundary twice —
     * arguments out, result back in — and both are inspected, because a document read by a tool contains
     * whatever the document contains. Loosening this to "at least one" would have hidden the second crossing;
     * naming both is what makes a future regression on either side fail here.
     */
    expect(verdicts.map((v) => v.subject)).toEqual(["tool-call", "tool-result"]);
    expect(verdicts[0]?.outcome).toBe("redacted");
    // The result guardrail has no opinion on results, so it passes — and a pass is still recorded, so "nothing
    // ran" stays distinguishable from "ran and allowed it".
    expect(verdicts[1]?.outcome).toBe("pass");
    // And neither carries a value: the token must not be recoverable from the audit trail.
    expect(JSON.stringify(verdicts)).not.toContain("sk-live-1");
  });
});
