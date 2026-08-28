/**
 * A scripted model, for testing an agent without calling a provider — task #253 AC-4.
 *
 * Testing an agent currently means writing a `streamTurn` by hand, and every consumer writes the same one badly:
 * a single `text-delta` and a `finish`, which exercises none of the paths that actually break. The interesting
 * behaviour of this platform — retry, approval gates, tool errors, structured output, the catalogue budget — all
 * live in what the model does *across steps*, and a one-chunk fake cannot express any of it.
 *
 * ## Scripted per turn, not per call
 *
 * A script is a list of **turns**, and each call consumes the next one. That is what lets a test say "the model
 * calls the tool, sees the result, then answers" — three chunks in one turn — separately from "the first turn
 * fails and the second succeeds", which is two turns and is how a retry test is written.
 *
 * Running past the end of the script is an **error**, not a silent empty turn. A test whose agent took one more
 * turn than the author expected should fail loudly, because the alternative is an assertion passing against a
 * turn that produced nothing.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ModelTurnRequest, NeutralStreamChunk, NeutralUsage } from "../models/streaming.js";

/** What the model does on one turn. */
export type ScriptedTurn =
  /** Answers with text. */
  | { readonly say: string; readonly usage?: Partial<NeutralUsage> }
  /** Calls tools, then answers — the shape almost every interesting test needs. */
  | {
      readonly call: readonly { readonly tool: string; readonly input?: unknown; readonly id?: string }[];
      readonly then?: string;
      readonly usage?: Partial<NeutralUsage>;
    }
  /**
   * Fails, as a provider would.
   *
   * `retryable` defaults to **true**, because the case worth testing is the retry path — a non-retryable failure
   * is just a thrown error and needs no scripting to produce.
   */
  | { readonly fail: string; readonly code?: AgentPlatformError["code"]; readonly retryable?: boolean };

export type StubModel = {
  /** Pass as `DefaultEngineDeps.streamTurn`. */
  readonly streamTurn: (request: ModelTurnRequest) => AsyncIterable<NeutralStreamChunk>;
  /** Every request the engine made, in order — so a test can assert what the model was *given*. */
  readonly requests: readonly ModelTurnRequest[];
  /** Turns consumed so far. */
  readonly turns: () => number;
};

const usageOf = (partial: Partial<NeutralUsage> | undefined): NeutralUsage => ({
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  ...partial,
});

export const createStubModel = (script: readonly ScriptedTurn[]): StubModel => {
  const requests: ModelTurnRequest[] = [];
  let index = 0;

  async function* run(request: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> {
    requests.push(request);
    const turn = script[index];
    index += 1;
    if (turn === undefined) {
      // Loud, not empty. An agent that took one more turn than the test expected is a finding, and an empty
      // turn would let an assertion pass against a model that said nothing.
      throw new AgentPlatformError({
        code: "internal",
        message:
          `the stub model's script has ${script.length} turn(s) and the agent asked for turn ${index}. ` +
          "Either the agent is looping, or the script is short — both are worth knowing.",
        retryable: false,
      });
    }

    if ("fail" in turn) {
      throw new AgentPlatformError({
        code: turn.code ?? "provider_error",
        message: turn.fail,
        retryable: turn.retryable ?? true,
      });
    }

    if ("say" in turn) {
      yield { type: "text-delta", id: `t${index}`, text: turn.say };
      yield { type: "finish", usage: usageOf(turn.usage) };
      return;
    }

    for (const [n, call] of turn.call.entries()) {
      const id = call.id ?? `call-${index}-${n}`;
      yield { type: "tool-call", toolCallId: id, toolName: call.tool, input: call.input ?? {} };
      /**
       * No `tool-result` is emitted here, deliberately.
       *
       * The engine runs the tool itself and produces the result — that is the path under test. A stub that
       * emitted its own result would test nothing but the stub, and would hide an unwired tool entirely.
       */
    }
    if (turn.then !== undefined) yield { type: "text-delta", id: `t${index}`, text: turn.then };
    yield { type: "finish", usage: usageOf(turn.usage) };
  }

  return { streamTurn: run, requests, turns: () => index };
};
