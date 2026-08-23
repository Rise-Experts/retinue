/**
 * The traffic mix and the synthetic engine — the load the harness actually offers.
 *
 * **Why the engine is synthetic, and why that is not a compromise.** A load test cannot drive a real model
 * provider: it would cost money proportional to the load, the provider's own rate limits would become the thing
 * under test, and a provider outage would look like a platform bug. Nobody load-tests through a paid third
 * party. What *is* under test is the platform — the claim, the lease, the checkpoint, the queue, the event log,
 * the idempotency of external effects — and every one of those is real here.
 *
 * The engine's job is therefore to be a *believable* source of latency and failure, and its knobs are exactly
 * the failure modes #144 lists: a timeout, a rate limit, a tool that performs an external effect, and an
 * approval that suspends the run.
 *
 * The one thing it must get right is the **external effect**: it performs a side effect under an idempotency
 * key, so "no duplicated external action" becomes a count of effects against a count of distinct keys rather
 * than a reading of logs.
 */

import { asId } from "../core/ids.js";
import type { InteractionId } from "../core/ids.js";
import type { AgentEngine, EngineEvent, EngineRunInput } from "../runtime/worker.js";

export type TrafficShape = {
  /** Steps a run takes before completing. More steps means more checkpoints and more to lose on a kill. */
  readonly steps: number;
  /** Simulated model latency per step. */
  readonly modelLatencyMs: number;
  /** Fraction of runs that call a tool with an external effect. */
  readonly externalActionRate: number;
  /** Fraction of runs that pause for an approval. */
  readonly approvalRate: number;
  /** Fraction of steps where the provider times out before eventually succeeding. */
  readonly providerTimeoutRate: number;
  /** Fraction of steps the provider rate-limits. */
  readonly rateLimitRate: number;
};

/**
 * The default mix.
 *
 * Chosen to look like the product rather than to look good: most runs are a few steps of model output, a
 * meaningful minority calls a tool that touches the outside world, and a smaller minority stops for a human. A
 * mix with no approvals would miss the longest-lived state the platform has, and a mix with no external actions
 * would make the one assertion that matters untestable.
 */
export const DEFAULT_TRAFFIC: TrafficShape = {
  steps: 3,
  modelLatencyMs: 40,
  externalActionRate: 0.3,
  approvalRate: 0.1,
  providerTimeoutRate: 0,
  rateLimitRate: 0,
};

/** Where the synthetic external effects are counted. Shared by the engine and the assertions. */
export type EffectLedger = {
  /** Every effect performed, in order, with the key it was performed under. */
  readonly performed: { readonly key: string; readonly atMs: number }[];
  perform(key: string, atMs: number): void;
  /** Distinct keys. Compared against `performed.length` — equality is "no duplicate". */
  distinctKeys(): number;
};

export const createEffectLedger = (): EffectLedger => {
  const performed: { key: string; atMs: number }[] = [];
  return {
    performed,
    perform(key, atMs) {
      // Deliberately **not** deduplicated here. The platform's idempotency is what is under test, so a ledger
      // that refused a repeat would be answering the question on the platform's behalf and every run would pass.
      performed.push({ key, atMs });
    },
    distinctKeys: () => new Set(performed.map((p) => p.key)).size,
  };
};

/**
 * Deterministic pseudo-randomness.
 *
 * A seeded generator, so a run that found a failure can be replayed exactly. `Math.random()` would make the
 * interesting runs — the ones that broke — unrepeatable, which is the opposite of what a load test is for.
 */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32. Small, fast, and good enough to pick a branch; it is choosing traffic, not generating keys.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
};

/**
 * Two stable, well-distributed fractions from a run id.
 *
 * Stable because a resumed run must draw the same fate as its first attempt — `Math.random()` and a shared
 * generator both fail at that, and a scenario that changes under a resume can make no claim about resumption.
 *
 * Well-distributed because the first version was not, and it mattered. Plain FNV-1a with two different offset
 * bases, taken as a raw fraction, gave 0.03 external-action rate for one id prefix and 0.50 for another against a
 * configured 0.30 — the low bits are poorly mixed and two bases correlate. So: FNV-1a over a *salted* string,
 * then murmur3's `fmix32` avalanche. A biased traffic mix is a load test that measures a different workload than
 * the one it reports, and nothing in the output would have said so.
 */
export const runFate = (runId: string): { readonly a: number; readonly b: number } => {
  const fnv = (text: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  // murmur3 fmix32. Without it the low bits stay correlated with the input and sequential ids cluster.
  const mix = (h0: number): number => {
    let h = h0 >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 0x1_0000_0000;
  };
  // Two different *strings*, not two different bases: salting the input decorrelates the pair, changing the
  // basis does not.
  return { a: mix(fnv(`effect:${runId}`)), b: mix(fnv(`approval:${runId}`)) };
};

export type SyntheticEngineDeps = {
  readonly traffic: TrafficShape;
  readonly effects: EffectLedger;
  readonly random: () => number;
  readonly now?: () => number;
  /** Injected so a test does not actually wait. Real runs pass a real sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/** A rate-limit failure shaped like a provider's, so the retry path treats it the way it would in production. */
export class SyntheticRateLimit extends Error {
  readonly code = "rate-limited";
  readonly retryable = true;
  constructor() {
    super("synthetic rate limit");
    this.name = "SyntheticRateLimit";
  }
}

export class SyntheticTimeout extends Error {
  readonly code = "timeout";
  readonly retryable = true;
  constructor() {
    super("synthetic provider timeout");
    this.name = "SyntheticTimeout";
  }
}

/**
 * The engine.
 *
 * Resumable, because the whole point of the worker-kill case is that a restarted run must not redo work. It
 * reads `resume` and skips the steps already in the checkpoint — and the external effect is keyed on the run and
 * the step, so a step that *is* redone reuses its key and the duplicate is detectable rather than invisible.
 */
export const createSyntheticEngine = (deps: SyntheticEngineDeps): AgentEngine => {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
      const { traffic } = deps;
      /**
       * How far a previous attempt got — counted from the engine's **own** step parts.
       *
       * Not `parts.length`, and not `resume.step`. `parts.length` was the first version and it was wrong: the
       * approval marker is a part too, so a run that paused for approval came back with `alreadyDone` already
       * equal to `steps`, skipped the loop entirely, never yielded `run.completed`, and sat in
       * `waiting-for-approval` forever. Sixty-five of a hundred and sixty runs did exactly that, and the
       * staircase reported it as an error rate rather than as a resume bug — which is what a `stuckByStatus`
       * breakdown was worth adding for.
       *
       * `resume.step` is no good either: the runtime derives it from *tool-call* parts, and this engine emits
       * none. It would be zero forever and every resumed run would redo all its work — including its external
       * action, which is precisely the duplicate this whole exercise exists to detect.
       */
      const stepPart = new RegExp(`^${input.run.id}-p\\d+$`);
      const alreadyDone = (input.resume?.parts ?? []).filter((part) => stepPart.test(part.id)).length;
      // Derived from the **run id**, not from the shared generator.
      //
      // A real bug the first time: `deps.random()` advances global state, so a resumed run drew *different*
      // values than its first attempt — a run that had performed its external action could come back deciding it
      // never does one, and a run that paused for approval could resume deciding to pause again, forever. A load
      // test whose scenario is not stable across a resume cannot make any claim about resumption at all.
      const fate = runFate(input.run.id);
      const doesExternalAction = fate.a < traffic.externalActionRate;
      const pausesForApproval = fate.b < traffic.approvalRate;

      for (let step = alreadyDone; step < traffic.steps; step += 1) {
        if (input.signal.isCancelled()) return;

        if (deps.random() < traffic.rateLimitRate) throw new SyntheticRateLimit();
        if (deps.random() < traffic.providerTimeoutRate) throw new SyntheticTimeout();

        await sleep(traffic.modelLatencyMs);

        yield {
          type: "part.added",
          part: {
            id: `${input.run.id}-p${step}`,
            type: "text",
            schemaVersion: 1,
            createdAt: new Date(now()).toISOString(),
            text: `step ${step}`,
          },
        } as EngineEvent;

        // The external effect on the *last* step, so a kill mid-run lands before it and recovery has to decide
        // whether to redo it. Placing it on the first step would make the interesting case unreachable.
        if (doesExternalAction && step === traffic.steps - 1) {
          // Keyed on run and step, which is what the platform's own idempotency key would be derived from. A key
          // including an attempt number would make every retry unique and the duplicate check vacuous.
          deps.effects.perform(`${input.run.id}:${step}`, now());
        }

        // The approval is requested once, on the step *after* it is recorded, so `alreadyDone` on resume is past
        // it. Without the marker part the resumed run reaches the same step, requests approval again, and pauses
        // forever — which looks exactly like a platform that cannot resume.
        if (pausesForApproval && step === Math.floor(traffic.steps / 2)) {
          yield {
            type: "part.added",
            part: {
              id: `${input.run.id}-approval-mark`,
              type: "text",
              schemaVersion: 1,
              createdAt: new Date(now()).toISOString(),
              text: "approval requested",
            },
          } as EngineEvent;
          yield {
            type: "approval.requested",
            interactionId: asId<InteractionId>(`${input.run.id}-a`),
            toolName: "publish_post",
            summary: "publish",
            riskCategory: "external-write",
          } as EngineEvent;
          // Suspend. The harness decides the approval, which is what makes approval wait time measurable and
          // what exercises the longest-lived state the platform holds.
          return;
        }
      }

      yield { type: "run.completed" } as EngineEvent;
    },
  };
};
