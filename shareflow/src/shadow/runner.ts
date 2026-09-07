/**
 * Driving a real ShareFlow turn with every external write suppressed — #128 AC-4, REQ-041 (#190).
 *
 * This is the piece that was missing. `shadow/index.ts` has held the recorder and the parity diff since #126,
 * `rollout/` has held the flag, `parity/` has held the gates, and `scripts/parity-report.mjs` has correctly
 * refused to run on an empty set — because **nothing could produce a shadow run**. Every part of the
 * measurement existed except the measurement.
 *
 * ## Why it runs in this process rather than through the queue
 *
 * Three reasons, in order of how much they matter, and they are `app/server.ts`'s reasons too:
 *
 * 1. The caller needs the result. A queued shadow would answer with a run id and the writes would arrive
 *    later, so the client would have to poll — and an empty answer is indistinguishable from "it would have
 *    written nothing", which is a real and different result.
 * 2. A shadow run must not compete with real ones for worker slots. It is measurement, and measurement that
 *    slows the thing it measures changes it.
 * 3. Nobody is waiting on the prose, so there is nothing to stream.
 *
 * ## What `createAgent` gives that the GraphQL host does not
 *
 * `retinue serve`'s `sendMessage(conversationId, runId)` takes no message content and does not create the run
 * row, so a remote caller gets `started` back and nothing executes. `createAgent` writes the message *and*
 * the run, then processes to completion — which is exactly the shape a shadow turn needs, and the reason the
 * ShareFlow application exists at all.
 *
 * ## What a shadow run does and does not prove
 *
 * It suppresses **gated** effects — `external-write` and `destructive` — before the approval gate. An
 * `internal-write` still happens, so **a shadow run does create real drafts**. It measures everything up to
 * the external write and nothing after it, because what an agent does after publishing cannot be observed
 * without publishing. That limit is inherent, and stating it is the difference between a measurement and a
 * claim.
 */

import { createAgent } from "@retinue/agentkit/providers";
import type {
  AgentManifest,
  AuthorizationPolicy,
  ExecutionContext,
  MessagePart,
  ResolvedModelInfo,
  ToolProvider,
} from "@retinue/agentkit";
import type { SuppressedWrite } from "@retinue/agentkit/tools";

import { createShadowRecorder, type ShadowRun } from "./index.js";

export type ShadowTurnConfig = {
  readonly manifest: AgentManifest;
  readonly providers: readonly ToolProvider[];
  /**
   * How the manifest resolves to a model. The **real one** — a stub would make the whole exercise circular.
   *
   * Passed as a resolver rather than a model id because the host already decides role, capabilities,
   * residency and cost ceiling through `ModelPolicy`; a runner that took an id would bypass all four.
   */
  readonly resolveModel: (manifest: AgentManifest, context: ExecutionContext) => ResolvedModelInfo;
  readonly tenantId: string;
  readonly principalId?: string;
  readonly roleIds?: readonly string[];
  /**
   * The policy named by `manifest.authorizationPolicyId`, keyed by that id.
   *
   * Required in practice, and the platform says so loudly: an agent whose manifest names a policy that is not
   * registered refuses to construct rather than falling back to a permissive default. Worth carrying here
   * rather than making callers reach past this runner, because the shadow path must authorise exactly as the
   * live path does — a shadow run that could do things a real one cannot is not a measurement of anything.
   */
  readonly authorizationPolicies?: Readonly<Record<string, AuthorizationPolicy>>;
  readonly authorization?: AuthorizationPolicy;
};

export type ShadowTurnResult = {
  readonly runId: string;
  /** What the turn would have written externally, in the order it would have written it. */
  readonly writes: readonly SuppressedWrite[];
  /** The assistant's prose. Kept because a turn that answered nothing at all is a different failure. */
  readonly text: string;
  readonly outcome: string;
  /**
   * Every part the turn produced, tool calls and results included.
   *
   * Carried because the prose is not enough to tell what happened. The first real run of this looked like a
   * model that would not use its tools; it was an authorization list that matched none, so the catalogue was
   * empty. The second looked like a model that gave up; it was `create_post_draft` being refused by a
   * validation rule. Neither was visible in the text — a parity harness reading only prose would have
   * recorded both as "the assistant answered".
   */
  readonly parts: readonly MessagePart[];
  /** A `ShadowRun` ready for `diffShadowRuns`, once the caller says which workflow this was. */
  readonly asShadowRun: (workflow: string, runtime: string) => ShadowRun;
};

/**
 * A shadow turn runner over one ShareFlow app.
 *
 * Reused across turns rather than built per turn: `createAgent` holds the conversation, run, message and
 * checkpoint stores, so a fresh agent per turn would give every turn an empty history — and a parity run
 * comparing single-turn behaviour to a real multi-turn conversation would be comparing the wrong things.
 */
export const createShadowTurnRunner = (config: ShadowTurnConfig) => {
  /**
   * One recorder for the runner's lifetime, keyed by run id.
   *
   * The recorder is per-agent because `createAgent` takes it once at construction. Keying by run is what
   * keeps two turns' writes apart — and `SuppressedWrite.runId` is populated by both suppressing layers, so
   * the key is the platform's rather than something counted here.
   */
  const recorder = createShadowRecorder();

  const agent = createAgent({
    manifest: config.manifest,
    tools: [...config.providers],
    resolveModel: config.resolveModel,
    tenantId: config.tenantId,
    ...(config.authorization === undefined ? {} : { authorization: config.authorization }),
    ...(config.authorizationPolicies === undefined ? {} : { authorizationPolicies: config.authorizationPolicies }),
    /**
     * Without this the run is **refused**, not performed unshadowed.
     *
     * The registry's rule, and it is the right one: a run that says it is shadow and has nowhere to record
     * the suppression is a run that would publish while reporting that it did not.
     */
    shadow: recorder,
  });

  return {
    manifest: agent.manifest,

    async run(input: { readonly conversationId: string; readonly message: string }): Promise<ShadowTurnResult> {
      const result = await agent.run({
        conversationId: input.conversationId,
        message: input.message,
        ...(config.principalId === undefined ? {} : { principalId: config.principalId }),
        ...(config.roleIds === undefined ? {} : { roleIds: config.roleIds }),
        shadow: true,
      });

      const writes = recorder.written(result.runId);
      return {
        runId: result.runId,
        writes,
        text: result.text,
        outcome: String(result.outcome),
        parts: result.parts,
        asShadowRun: (workflow: string, runtime: string) => ({ workflow, runtime, writes }),
      };
    },

    /** Every run this runner has recorded, for a harness reporting over a batch. */
    runIds: () => recorder.runIds(),
  };
};

export type ShadowTurnRunner = ReturnType<typeof createShadowTurnRunner>;
