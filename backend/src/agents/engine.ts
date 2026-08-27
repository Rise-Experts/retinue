/**
 * Default agent engine — `docs/03-intelligence-runtime.md`.
 *
 * The concrete model loop that plugs into the durable worker's `AgentEngine` slot. It resolves the
 * agent's model, assembles the system prompt + history, exposes the authorized tools, and drives one
 * turn through the neutral `streamModelTurn` primitive (which owns the AI SDK), mapping its chunks to
 * the platform's typed `RunEvent`s. Transient provider failures are retried Claude-style — but only
 * before any output has streamed, so a retry never duplicates a partial answer; tool side effects
 * stay safe via the registry's idempotency keys.
 *
 * **Human-in-the-loop.** With `approvals` wired, the engine owns the two ends of the approval
 * loop that `docs/04` describes and nothing implemented:
 *
 * 1. *Before the turn*, a decided approval is executed — the stored tool and the stored input, never a
 *    regenerated call — and the model is told what ran.
 * 2. *During the turn*, every tool call is routed through the loop, so a gated call that has no
 *    approval raises a durable one and the run pauses into `waiting-for-approval` instead of looping
 *    on a refusal the model cannot resolve.
 */

import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError, isAgentPlatformError } from "../core/errors.js";
import type { InteractionId, MessageId, MessagePartId, RunId, TenantId, ToolCallId } from "../core/ids.js";
import { asId } from "../core/ids.js";
import type { MessagePart, StructuredPart, TextPart, ToolCallPart, ToolResultPart } from "../core/content-parts.js";
import type {
  ModelDefinition,
  ModelToolCallOptions,
  ModelTurnRequest,
  ModelTurnTool,
  NeutralStreamChunk,
  NeutralUsage,
  ResolvedModel,
  TurnMessage,
} from "../models/index.js";
import { applyInputGuardrails, applyOutputGuardrails, type Guardrail, type GuardrailRecord } from "../guardrails/index.js";
import { streamModelTurn, turnText } from "../models/index.js";
import {
  decideRetry,
  deriveRunMessageId,
  toPlatformError,
  DEFAULT_RETRY_POLICY,
  type AgentEngine,
  type EngineEvent,
  type EngineRunInput,
  type RetryPolicy,
  type Run,
} from "../runtime/index.js";
import { META_TOOLS } from "../tools/index.js";
// The specific modules rather than `core/index.js`: the barrel pulls in `zod` through `core/validation.ts`,
// and a subpath's dependency graph is a guarantee this package tests for.
import { applyTokenBudget, type TokenBudget } from "../core/budget.js";
import { estimateTokens } from "../core/tokens.js";
import type { PendingQuestion, RunApprovals } from "../hitl/index.js";
import { isQuestionPending } from "../hitl/service.js";
import type { CitationCandidate, CitationEmitter } from "../citations/index.js";
import type { AgentManifest } from "./index.js";

/**
 * What one tool costs the model's context.
 *
 * A `ModelTurnTool` is not a catalogue entry — it carries the full input schema, because that is what a provider
 * puts in the request — so this deliberately does *not* reuse `entryTokens`. Using the compact estimate here
 * would understate a schema-heavy tool by an order of magnitude and produce a budget that never binds.
 */
export const turnToolTokens = (tool: ModelTurnTool): number =>
  estimateTokens(`${tool.name} ${tool.description ?? ""}`) + estimateTokens(JSON.stringify(tool.inputSchema ?? {}));

/** A model resolved for a turn: the opaque handle plus what the engine needs to attribute usage. */
export type ResolvedModelInfo = {
  readonly model: ResolvedModel;
  readonly modelId: string;
  readonly currency?: string;
  /** Optional cost function (minor units) from the model's pricing, used to bill each turn. */
  readonly price?: (usage: NeutralUsage) => number;
  /**
   * The definition this model resolved from, so its declared limits can actually be applied (#160).
   *
   * Optional for compatibility with existing resolvers, and absent means "no declared ceiling" rather than
   * "unbounded by policy" — the agent's own limit still applies.
   */
  readonly definition?: ModelDefinition;
};

export type DefaultEngineDeps = {
  /** Load the manifest the run executes (by agent id + version), so history is never rewritten. */
  loadManifest: (input: { agentId: string; version: number; context: ExecutionContext }) => Promise<AgentManifest>;
  resolveModel: (manifest: AgentManifest, context: ExecutionContext) => ResolvedModelInfo;
  /** Conversation history as neutral turn messages, oldest first. */
  loadHistory: (context: ExecutionContext, run: Run) => Promise<readonly TurnMessage[]>;
  /** The tools the model may call this turn (already permission-filtered / guarded on execute). */
  buildTools?: (context: ExecutionContext, manifest: AgentManifest) => Promise<readonly ModelTurnTool[]>;
  /** System prompt; defaults to the manifest instructions. */
  systemPrompt?: (manifest: AgentManifest, context: ExecutionContext) => Promise<string> | string;
  /**
   * The approval loop. Absent means no HITL: tool calls go straight to `buildTools`' own `execute`,
   * which is how every caller behaved before this existed.
   *
   * Present means the loop owns tool execution for the turn — deliberately, and not as a layer on top
   * of the caller's `execute`. A gated call has to be *routed* through the loop rather than merely
   * observed after the fact, because by the time a refusal has been thrown there is nothing left to
   * pause on.
   */
  readonly approvals?: RunApprovals;
  /**
   * Checks a deployment adds — REQ-046 (#205).
   *
   * Absent means no inspection, which is the current behaviour and stays the default: a runtime that imposed a
   * model call on every turn to moderate it would be making a cost decision that belongs to the host.
   */
  readonly guardrails?: readonly Guardrail[];
  /**
   * A ceiling in tokens on the tool list handed to the model — REQ-045 (#204), task #210, AC-3.
   *
   * Here rather than only in the registry because *this* is where the tokens are actually spent: the registry's
   * catalogue is what a client renders, and `buildTools` is what reaches the provider. A budget enforced in one
   * and not the other would be a budget a deployment believes it has.
   *
   * Absent means no ceiling, which stays the default — a runtime that silently withheld tools from a model
   * nobody had asked it to withhold would be making a correctness decision on the host's behalf.
   */
  readonly catalogBudget?: TokenBudget;
  /**
   * The question side of resumption — #163.
   *
   * Optional and symmetrical with `approvals`. Without it a run that parked on a question resumes with no idea
   * it was answered, and the model asks the same question again — the person picks an option and gets the
   * picker back. `approvals` has had a resume path from the start; this is the half that was missing.
   */
  readonly questions?: {
    answered(input: { tenantId: TenantId; runId: RunId }): Promise<PendingQuestion | null>;
  };
  /**
   * Turns a tool's citation candidates into citation parts — #165.
   *
   * Optional. `createCitationEmitter`, `CitationPart`, the frontend's renderer and the groundedness graders all
   * existed, and **nothing put a citation into a run**: there was no path from a tool that read a passage to a
   * part on the message. Supply this and a tool returning `{ citations: [...] }` produces citation parts;
   * leave it out and the field is ignored, exactly as before.
   *
   * The emitter, not a raw mapper, because emission is where the access check lives: a citation carries an
   * excerpt, so emitting one the reader may not see leaks the text and not merely the existence of the source.
   */
  readonly citations?: CitationEmitter;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** The streaming primitive. Defaults to the models-layer `streamModelTurn`; overridden in tests. */
  readonly streamTurn?: (req: ModelTurnRequest) => AsyncIterable<NeutralStreamChunk>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Take citation candidates off a tool's result — #165.
 *
 * A recognised `citations` field, read and **removed** before the result reaches the model. Removed because the
 * model does not need it: it has the tool's answer, and handing it a parallel list of chunk ids and excerpts
 * invites it to paraphrase provenance in prose, which is the unverifiable thing citations exist to replace.
 *
 * A non-array `citations`, or one with unusable entries, is left alone rather than rejected — a tool whose real
 * answer happens to have a field of that name is not misconfigured, and failing its call would be a worse
 * outcome than ignoring a field.
 */
const collectCitations = (result: unknown, into: CitationCandidate[]): unknown => {
  if (typeof result !== "object" || result === null || !("citations" in result)) return result;
  const { citations, ...rest } = result as { citations: unknown };
  if (!Array.isArray(citations)) return result;
  const usable = citations.filter(
    (c): c is CitationCandidate =>
      typeof c === "object" &&
      c !== null &&
      "origin" in c &&
      typeof (c as { excerpt?: unknown }).excerpt === "string" &&
      typeof (c as { retrievedAt?: unknown }).retrievedAt === "string",
  );
  if (usable.length === 0) return result;
  into.push(...usable);
  return rest;
};

/**
 * Recognise a parked question in whatever shape it reached us — #163.
 *
 * A tool's throw arrives as an `AgentPlatformError` when nothing is between the engine and the tool, and as a
 * flattened `PlatformError` when the registry caught it. One reader for both, so the two paths cannot come to
 * disagree about what a parked question looks like.
 *
 * Returns `null` for anything else, which the caller rethrows — a question is the one refusal that is not a
 * failure, and everything else must stay one.
 */
const questionMarker = (
  thrown: unknown,
  toolName: string,
): { readonly interactionId: string; readonly marker: Record<string, unknown> } | null => {
  const error = isAgentPlatformError(thrown)
    ? { code: thrown.code, details: thrown.details }
    : typeof thrown === "object" && thrown !== null && "code" in thrown
      ? (thrown as { code: string; details?: Record<string, unknown> })
      : null;
  if (error === null || !isQuestionPending(error)) return null;
  const interactionId = error.details?.["interactionId"];
  // No id means no way to route the answer back, so it is a broken signal rather than a parked run. Rethrown
  // as an ordinary failure: parking a run nobody can ever un-park is the worse outcome.
  if (typeof interactionId !== "string" || interactionId === "") return null;
  return {
    interactionId,
    // Returned to the model in place of a result, mirroring the approval marker exactly.
    marker: {
      status: "question_pending",
      interactionId,
      message: `${toolName} has put a question to the person. The run is paused; do not retry or guess an answer.`,
    },
  };
};

/**
 * A record becomes an event, with no value ever attached.
 *
 * One place, so a future field on `GuardrailRecord` cannot reach the event log by being spread in somewhere: the
 * mapping is explicit, field by field, and adding one here is a decision rather than a consequence.
 */
const verdictEvent = (record: GuardrailRecord): EngineEvent => ({
  type: "guardrail.verdict",
  guardrail: record.guardrail,
  subject: record.subject,
  outcome: record.outcome,
  ...(record.what === undefined ? {} : { what: record.what }),
  ...(record.code === undefined ? {} : { code: record.code }),
  ...(record.threw === undefined ? {} : { threw: record.threw }),
});

export const createDefaultEngine = (deps: DefaultEngineDeps): AgentEngine => {
  const policy = deps.retry ?? DEFAULT_RETRY_POLICY;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const streamTurn = deps.streamTurn ?? streamModelTurn;

  return {
    async *run({ run, context, signal }: EngineRunInput): AsyncIterable<EngineEvent> {
      const manifest = await deps.loadManifest({ agentId: run.agentId, version: run.agentVersion, context });
      const resolved = deps.resolveModel(manifest, context);
      /**
       * A structured agent needs a model that can do it — task #243 AC-3.
       *
       * Checked at resolution, before a token is spent, and here rather than only in the host's `resolveModel`
       * because that callback is the host's: a host that has not been updated would resolve a text-only model
       * and the agent would silently get prose, which is the defect being fixed rather than a new one.
       *
       * Skipped when the host returned no `definition`, following the same rule `modelModalities` already uses
       * (#185): a caller that did not say what the model can do has not said it cannot do this, and refusing
       * every structured agent from every host that has not been updated would be an outage dressed as a check.
       */
      if (manifest.responseFormat?.kind === "structured" && resolved.definition !== undefined) {
        if (resolved.definition.capabilities?.structuredOutput !== true)
          throw new AgentPlatformError({
            code: "capability_unavailable",
            message:
              `agent "${manifest.id}" asks for a structured response format and the resolved model ` +
              `${resolved.modelId} does not declare the \`structuredOutput\` capability. Add ` +
              "`requiredCapabilities: { structuredOutput: true }` to the agent's model policy so resolution " +
              "picks a model that can, rather than discovering it mid-turn.",
            retryable: false,
          });
      }
      const system = (await (deps.systemPrompt?.(manifest, context) ?? manifest.instructions)) || undefined;
      const history = await deps.loadHistory(context, run);
      const built = deps.buildTools ? await deps.buildTools(context, manifest) : [];

      /**
       * The budget, applied to the list the model will actually see — AC-3.
       *
       * Meta-tools are protected: dropping `find_tools` to save its own ~35 tokens would leave the model with a
       * shortened list and no way to discover that it was shortened, which is the failure this whole mechanism
       * exists to prevent.
       *
       * `findable` is *derived* rather than configured. Whether truncation is a deferral or an amputation
       * depends on one fact — is `find_tools` in the model's hands this turn — and asking the host to declare
       * that separately would let the declaration be wrong.
       */
      const budgetOutcome =
        deps.catalogBudget === undefined
          ? undefined
          : applyTokenBudget({
              items: built,
              budget: deps.catalogBudget,
              tokensOf: turnToolTokens,
              nameOf: (tool) => tool.name,
              protect: (tool) => (META_TOOLS as readonly string[]).includes(tool.name),
            });
      const declared = budgetOutcome?.resident ?? built;

      if (budgetOutcome !== undefined && (budgetOutcome.dropped.length > 0 || budgetOutcome.overBudget)) {
        yield {
          type: "catalog.truncated",
          catalog: "tools",
          budgetTokens: budgetOutcome.budgetTokens,
          residentTokens: budgetOutcome.residentTokens,
          dropped: budgetOutcome.dropped,
          findable: declared.some((tool) => tool.name === "find_tools"),
          ...(budgetOutcome.overBudget ? { overBudget: true } : {}),
        };
      }
      const maxSteps = manifest.limits?.maxSteps ?? 8;
      const messageId = deriveRunMessageId(run.id) as MessageId;

      // A decision taken while the run was parked. Executed before the model gets another turn, so the
      // approved side effect happens even if the model would never ask for it again — and so the model
      // sees the outcome in its history rather than re-requesting something already done.
      const messages: TurnMessage[] = [...history];
      if (deps.approvals) {
        const resumed = await deps.approvals.resume(context, run.id);
        for (const event of approvalEvents(resumed, messageId, messages)) yield event;
      }
      // The answer to a question this run asked, if it was parked on one. Same shape as the approval
      // resumption above: an event for the durable record, and a history line so the model stops asking.
      if (deps.questions) {
        const answered = await deps.questions.answered({ tenantId: context.tenantId, runId: run.id });
        for (const event of questionEvents(answered, messages)) yield event;
      }

      /**
       * Inspection, before the model sees anything — REQ-046 (#205), AC-1.
       *
       * Placed after resumption so an approved side effect that already happened is not re-inspected, and
       * *before* the tools are built so a refusal costs nothing: no provider call, no tool discovery, no spend.
       *
       * The subject is the newest user turn rather than the whole history. Re-inspecting history every turn
       * would re-refuse a conversation over something already allowed, and a guardrail that changes its mind
       * about the past makes a conversation impossible to continue.
       */
      const guardrails = deps.guardrails ?? [];
      if (guardrails.length > 0) {
        const latest = [...messages].reverse().find((m) => m.role === "user");
        const decision = await applyInputGuardrails(
          guardrails,
          { text: latest ? turnText(latest) : "" },
          context,
        );
        for (const record of decision.records) yield verdictEvent(record);
        if (decision.outcome === "refused") {
          /**
           * The turn ends here, and it ends *visibly*.
           *
           * A text part rather than a thrown error: a refusal is a policy outcome, not a crash, and a run that
           * failed with a stack trace tells the person nothing and the operator the wrong thing. The model is
           * never called, which is what AC-3 asks for — "the turn does not proceed".
           */
          const partId = `${messageId}:guardrail:refused` as MessagePartId;
          yield {
            type: "part.added",
            messageId,
            part: {
              id: partId,
              type: "text",
              schemaVersion: 1,
              createdAt: new Date(0).toISOString(),
              text: decision.message,
            },
          };
          yield { type: "run.completed" };
          return;
        }
      }

      /**
       * The tools the model may call, with execution routed through the approval loop.
       *
       * The caller's own `execute` is replaced rather than wrapped: the loop calls the same registry,
       * and running both would mean two executions of one call — the exact duplicate the approval
       * exists to prevent.
       */
      let pendingApproval: string | null = null;
      /**
       * A question a tool put to a person this turn — #163.
       *
       * Tracked exactly like `pendingApproval`, and for the same reason: the run has to stop, and it has to
       * stop on an *event* the worker understands rather than on an error the model would try to work around.
       * Before this, `question.requested` was in the event union and handled by the worker, and no code path in
       * the platform could produce one — so a tool that raised a question had it stored durably while the run
       * carried on and completed. The person's answer arrived for a run that was already over.
       */
      let pendingQuestion: string | null = null;
      /**
       * Citation candidates a tool handed back this turn, waiting for the claims they ground — #165.
       *
       * Buffered rather than emitted on the spot, because `supports` names the *text parts* a citation grounds
       * and those do not exist yet: the tool reads the passage, and only then does the model write the sentence
       * the passage supports. Emitting at the tool call would produce citations supporting nothing.
       */
      const pendingCitations: CitationCandidate[] = [];
      /**
       * Guardrail verdicts on tool arguments, buffered — REQ-046 (#205), AC-2 and AC-4.
       *
       * Buffered for the same reason as the citations above: the inspection happens inside a tool's `execute`,
       * which is a callback the model's stream invokes and not a generator, so it cannot yield. Dropping the
       * records instead would satisfy the enforcement half of AC-2 and quietly fail AC-4 — the check would work
       * and leave no trace, which is the combination that makes an incident unreconstructable.
       */
      const pendingVerdicts: GuardrailRecord[] = [];
      const approvals = deps.approvals;
      /**
       * Every tool is wrapped, whether or not an approval gate is configured.
       *
       * This used to wrap only when `deps.approvals` was set, which meant a deployment with no gate had no
       * interception point at all — and a question raised by one of its tools could not be noticed. The gate
       * decides *approvals*; parking a run on a question is not its business.
       */
      /**
       * What each call actually ran, keyed by the provider's call id — task #210.
       *
       * `execute_tool` names its target, so the tool the model called and the action performed are two different
       * things. The wrapper is the only place that knows both, and the events are emitted somewhere else, so the
       * fact has to be carried across. Without it a `destructive` tool invoked through `execute_tool` appears in
       * the audit trail as "execute_tool", which is not an answer to the question the trail exists to answer.
       */
      const ranByCall = new Map<string, string>();

      const tools: readonly ModelTurnTool[] = declared.map((t) => ({
        ...t,
        execute: async (input: unknown, options?: ModelToolCallOptions) => {
          /**
           * What this call is allowed to tell us — task #210.
           *
           * The host's closure is what reaches the registry, so it is the only thing that can know a call
           * resolved to a different tool. `report` is how it says so, and the map is read where the events are
           * emitted.
           */
          const report = (fact: { readonly ranToolName: string }) => {
            if (options?.toolCallId !== undefined) ranByCall.set(options.toolCallId, fact.ranToolName);
          };
          /**
           * A tool call is an output — AC-2.
           *
           * Before either branch below, so it applies whether or not an approval gate is configured, and
           * *before* the gate so a refused call never becomes an approval request: asking a person to approve
           * something that will not happen is how approving comes to feel meaningless.
           *
           * The refusal is returned as a tool *result* rather than thrown. The model then sees why its call did
           * not happen and can say so, which is the difference between a run that explains itself and one that
           * dies with a stack trace the person cannot act on.
           */
          if (guardrails.length > 0) {
            const decision = await applyOutputGuardrails(guardrails, { kind: "tool-call", toolName: t.name, input }, context);
            pendingVerdicts.push(...decision.records);
            if (decision.outcome === "refused") {
              return { refused: true, guardrail: decision.by, code: decision.code, message: decision.message };
            }
            // A redacted call runs with the redaction, not with what the model typed.
            if (decision.value.kind === "tool-call") input = decision.value.input;
          }
          /**
           * What a tool hands back is inspected too — AC-3.
           *
           * A tool result is content entering the model's context from outside the tenant, and it is the
           * likeliest source of personal data in a run: a document read by a tool contains whatever the document
           * contains. Checking arguments and not results would guard the direction data leaves and ignore the
           * direction it arrives.
           *
           * A refusal replaces the result rather than throwing, for the same reason as above: the model is told
           * why and can say so, instead of the run dying where the person cannot see the cause.
           */
          const inspectResult = async (output: unknown): Promise<unknown> => {
            if (guardrails.length === 0) return output;
            const decision = await applyOutputGuardrails(guardrails, { kind: "tool-result", toolName: t.name, output }, context);
            pendingVerdicts.push(...decision.records);
            if (decision.outcome === "refused") {
              return { refused: true, guardrail: decision.by, code: decision.code, message: decision.message };
            }
            return decision.value.kind === "tool-result" ? decision.value.output : output;
          };

          if (approvals === undefined) {
            try {
              return collectCitations(
                await inspectResult(await t.execute(input, { ...(options ?? {}), report })),
                pendingCitations,
              );
            } catch (thrown) {
              const parked = questionMarker(thrown, t.name);
              if (parked === null) throw thrown;
              pendingQuestion = parked.interactionId;
              return parked.marker;
            }
          }
          const outcome = await approvals.runTool(context, run.id, { name: t.name, input });
          if (outcome.outcome === "approval-requested") {
            pendingApproval = outcome.approval.id;
            // Returned to the model, not thrown. The tool call is a real part of the record with a
            // real result, and the run pauses on the event below rather than on an error the model
            // would try to work around.
            return {
              status: "approval_required",
              interactionId: outcome.approval.id,
              summary: outcome.approval.summary,
              message: `${t.name} needs human approval before it can run. The run is paused; do not retry.`,
            };
          }
          // The approval path reaches the registry itself, so the fact needs no host cooperation here.
          if (outcome.result.ranToolName !== undefined) report({ ranToolName: outcome.result.ranToolName });
          if (!outcome.result.ok) {
            // The registry flattens a delegate's throw into a result, so the question arrives here as a code.
            const parked = questionMarker(outcome.result.error, t.name);
            if (parked !== null) {
              pendingQuestion = parked.interactionId;
              return parked.marker;
            }
            throw new AgentPlatformError(outcome.result.error);
          }
          return collectCitations(await inspectResult(outcome.result.data), pendingCitations);
        },
      }));

      let attempt = 1;
      for (;;) {
        let emitted = 0;
        // Whether this turn produced the structured answer a structured agent promises — #243.
        let sawStructured = false;
        const textParts = new Map<string, { partId: MessagePartId; text: string }>();
        const controller = new AbortController();
        try {
          /**
           * Generation parameters, from the resolved definition with the agent as a **ceiling-respecting**
           * override (#160).
           *
           * `maxOutputTokens` takes the *lower* of what the agent asks for and what the model's definition
           * allows — otherwise the definition's limit still would not be a limit, only a default an agent could
           * raise. That was the substance of the bug: the field existed, was set deliberately per model, and
           * bounded nothing.
           */
          const limit = ((): number | undefined => {
            const declared = resolved.definition?.limits?.maxOutputTokens;
            const asked = manifest.limits?.maxOutputTokens;
            if (declared === undefined) return asked;
            return asked === undefined ? declared : Math.min(asked, declared);
          })();
          const chunks = streamTurn({
            model: resolved.model,
            ...(system ? { system } : {}),
            messages,
            /**
             * What the resolved model accepts — #185.
             *
             * Passed only when the definition says. `ResolvedModel.definition` is optional, and a caller that
             * did not supply one has not told us the model is text-only — so the check is skipped rather than
             * refusing every attachment from every host that has not been updated.
             *
             * `resolveModel` already refuses to hand out a model missing a *required* modality. This catches the
             * case that one cannot see: a model resolved for a text conversation, and an image arriving later in
             * it.
             */
            ...(resolved.definition === undefined
              ? {}
              : { modelModalities: resolved.definition.inputModalities }),
            // Mapped from the manifest here, so the model layer stays free of any dependency on `agents/`.
            ...(manifest.responseFormat?.kind === "structured"
              ? { structuredOutput: { schema: manifest.responseFormat.schema } }
              : {}),
            tools,
            maxSteps,
            abortSignal: controller.signal,
            ...(limit === undefined ? {} : { maxOutputTokens: limit }),
            ...(manifest.limits?.temperature === undefined ? {} : { temperature: manifest.limits.temperature }),
          });
          for await (const chunk of chunks) {
            if (signal.isCancelled()) {
              controller.abort();
              return;
            }
            for (const event of mapChunk(chunk, messageId, resolved, textParts, ranByCall)) {
              emitted += 1;
              if (event.type === "part.added" && event.part.type === "structured") sawStructured = true;
              yield event;
            }
            // Raised by a tool call this turn. Stop here rather than letting the model keep going: the
            // run is about to be parked, and anything it does now would be work nobody can act on.
            if (pendingApproval !== null) {
              controller.abort();
              yield { type: "approval.requested", interactionId: asId<InteractionId>(pendingApproval) };
              return;
            }
            // The same stop, for a question rather than an approval. Checked separately rather than folded into
            // one flag so the emitted event says which kind of answer the run is waiting for — the worker parks
            // it in `waiting-for-question` or `waiting-for-approval` accordingly, and those resume differently.
            if (pendingQuestion !== null) {
              controller.abort();
              yield { type: "question.requested", interactionId: asId<InteractionId>(pendingQuestion) };
              return;
            }
          }
          /**
           * Citations last, grounding the claims that were actually written — #165.
           *
           * Here rather than at the tool call because `supports` names text parts, and the model writes them
           * after reading the passage. Every text part of the turn is named: without model-level markers there
           * is no way to know which sentence a given passage supported, and claiming a narrower link would be
           * inventing precision. `docs/06`'s renderer treats a text part as grounded exactly when some citation
           * names it, so this says "these passages support this answer", which is true.
           *
           * After the stream, so a citation cannot appear above text the reader is already looking at — the
           * append-only property `citationViewModel` depends on.
           */
          /**
           * A structured agent must have produced a structured answer — task #243 AC-2.
           *
           * `streamModelTurn` already validates and fails, so in the normal path this never fires. It fires for
           * a host that supplied its own `streamTurn`, and that is the case worth guarding: the guarantee a
           * consumer bought is "structured or an error", and if it depended solely on the shipped model layer
           * then any host replacing that layer would silently get prose again — the original defect, reachable
           * through a documented extension point.
           */
          if (manifest.responseFormat?.kind === "structured" && !sawStructured)
            throw new AgentPlatformError({
              code: "provider_error",
              message:
                `agent "${manifest.id}" asks for a structured response format and the turn produced none. ` +
                "The run fails rather than returning the turn's text, which would be prose presented as a " +
                "validated object.",
              retryable: true,
            });

          for (const record of pendingVerdicts.splice(0)) yield verdictEvent(record);
          if (deps.citations !== undefined && pendingCitations.length > 0) {
            const claims = [...textParts.values()].map((t) => t.partId);
            if (claims.length > 0) {
              const emittedCitations = await deps.citations.emit(
                context,
                pendingCitations.map((c) => ({ ...c, supports: claims })),
              );
              for (const part of emittedCitations.parts) {
                yield { type: "part.added", messageId, part };
              }
            }
          }
          return; // turn complete
        } catch (thrown) {
          const error = toPlatformError(thrown);
          const decision = decideRetry({ error, attempt, policy });
          // Only retry when nothing has streamed yet — otherwise a retry would duplicate output.
          if (emitted > 0 || !decision.retry) throw new AgentPlatformError(error, { cause: thrown });
          yield {
            type: "run.retry-pending",
            attempt,
            maxAttempts: policy.maxAttempts,
            nextAttemptAt: new Date(now() + decision.delayMs).toISOString(),
            error,
          };
          await sleep(decision.delayMs);
          attempt += 1;
        }
      }
    },
  };
};

/**
 * Turn an answered question into the event and the history line it deserves — #163.
 *
 * Deliberately the same shape as `approvalEvents`, for the same reason it exists: the executed call is stored
 * as run *parts* and `loadHistory` reads conversation *messages*, so without a line here the model resumes
 * knowing nothing. For a question the consequence was sharper than for an approval — it asked again, so the
 * person answered, and got the same picker back.
 *
 * A `user`-role note, matching the approval line: a mid-conversation `system` message is handled
 * inconsistently across providers, and this is not an instruction — it is the person's answer.
 */
function* questionEvents(
  answered: PendingQuestion | null,
  messages: TurnMessage[],
): Generator<EngineEvent> {
  if (answered === null || answered.answers === undefined) return;
  yield { type: "question.answered", interactionId: answered.id };
  for (const spec of answered.questions) {
    const value = answered.answers[spec.key];
    if (value === undefined) continue;
    // An array is rendered as a list rather than joined blind: a multi-select answer whose values contain
    // commas would otherwise read as more choices than were made.
    const rendered = Array.isArray(value) ? value.map((v) => `- ${v}`).join("\n") : String(value);
    messages.push({
      role: "user",
      content: `[answer] ${spec.prompt}\n${rendered}`,
    });
  }
}

/**
 * Turn a resumption outcome into the events and the history line it deserves.
 *
 * The events are the durable record — a client refreshing after an approval must see the call that
 * ran. The history line is what stops the model asking again: the executed call is stored as run
 * *parts*, and `loadHistory` reads conversation *messages*, so without a line here the model resumes
 * with no idea the publish happened.
 *
 * It is a plain `user`-role note rather than a `system` one. A system message arriving mid-conversation
 * is handled inconsistently across providers, and the note is not an instruction — it is something the
 * model is being told about the world.
 */
function* approvalEvents(
  resumed: Awaited<ReturnType<RunApprovals["resume"]>>,
  messageId: MessageId,
  messages: TurnMessage[],
): Generator<EngineEvent> {
  if (resumed.outcome === "none") return;
  const { approval } = resumed;
  yield { type: "approval.decided", interactionId: approval.id };

  if (resumed.outcome === "denied") {
    messages.push({ role: "user", content: `[approval] ${approval.toolName} was denied. Do not attempt it again.` });
    return;
  }
  if (resumed.outcome === "expired") {
    messages.push({
      role: "user",
      content: `[approval] the approval for ${approval.toolName} expired before it could run. Ask again if it is still wanted.`,
    });
    return;
  }

  const toolCallId = asId<ToolCallId>(`approval:${approval.id}`);
  const call: ToolCallPart = {
    id: `${toolCallId}:call` as MessagePartId,
    type: "tool-call",
    schemaVersion: 1,
    createdAt: new Date(0).toISOString(),
    toolCallId,
    toolName: approval.toolName,
    input: approval.normalizedInput,
  };
  yield { type: "tool.started", toolCallId, toolName: approval.toolName };
  yield { type: "part.added", messageId, part: call };

  const outcome = resumed.result.ok ? resumed.result.data : resumed.result.error;
  const result: ToolResultPart = {
    id: `${toolCallId}:result` as MessagePartId,
    type: "tool-result",
    schemaVersion: 1,
    createdAt: new Date(0).toISOString(),
    toolCallId,
    toolName: approval.toolName,
    output: outcome,
    truncated: false,
  };
  yield {
    type: resumed.result.ok ? "tool.completed" : "tool.failed",
    toolCallId,
    toolName: approval.toolName,
  };
  yield { type: "part.added", messageId, part: result as MessagePart };
  messages.push({
    role: "user",
    content: `[approval] ${approval.toolName} was approved and has now run. Result: ${JSON.stringify(outcome)}`,
  });
}

/** Map one neutral chunk to zero or more engine events. Mutates `textParts` to accumulate deltas. */
function* mapChunk(
  chunk: NeutralStreamChunk,
  messageId: MessageId,
  resolved: ResolvedModelInfo,
  textParts: Map<string, { partId: MessagePartId; text: string }>,
  /** What each call resolved to, when it was not what the model named — task #210. */
  ranByCall: Map<string, string> = new Map(),
): Generator<EngineEvent> {
  switch (chunk.type) {
    case "text-delta": {
      const existing = textParts.get(chunk.id);
      const text = (existing?.text ?? "") + chunk.text;
      if (!existing) {
        const partId = `${messageId}:text:${chunk.id}` as MessagePartId;
        textParts.set(chunk.id, { partId, text });
        const part: TextPart = { id: partId, type: "text", schemaVersion: 1, createdAt: new Date(0).toISOString(), text };
        yield { type: "part.added", messageId, part };
      } else {
        existing.text = text;
        const part: TextPart = { id: existing.partId, type: "text", schemaVersion: 1, createdAt: new Date(0).toISOString(), text };
        yield { type: "part.updated", messageId, part };
      }
      return;
    }
    case "tool-call": {
      const part: ToolCallPart = {
        id: `${chunk.toolCallId}:call` as MessagePartId,
        type: "tool-call",
        schemaVersion: 1,
        createdAt: new Date(0).toISOString(),
        toolCallId: asId(chunk.toolCallId),
        toolName: chunk.toolName,
        input: chunk.input,
      };
      yield { type: "tool.started", toolCallId: asId(chunk.toolCallId), toolName: chunk.toolName };
      yield { type: "part.added", messageId, part };
      return;
    }
    case "tool-result": {
      const ran = ranByCall.get(chunk.toolCallId);
      const part: ToolResultPart = {
        id: `${chunk.toolCallId}:result` as MessagePartId,
        type: "tool-result",
        schemaVersion: 1,
        createdAt: new Date(0).toISOString(),
        toolCallId: asId(chunk.toolCallId),
        toolName: chunk.toolName,
        ...(ran === undefined ? {} : { ranToolName: ran }),
        output: chunk.output,
        truncated: false,
      };
      yield {
        type: "tool.completed",
        toolCallId: asId(chunk.toolCallId),
        toolName: chunk.toolName,
        ...(ran === undefined ? {} : { ranToolName: ran }),
      };
      yield { type: "part.added", messageId, part };
      return;
    }
    case "finish": {
      yield {
        type: "usage.updated",
        inputTokens: chunk.usage.inputTokens,
        outputTokens: chunk.usage.outputTokens,
        cachedInputTokens: chunk.usage.cachedInputTokens,
        ...(chunk.usage.reasoningTokens !== undefined ? { reasoningTokens: chunk.usage.reasoningTokens } : {}),
        // Counted at the send site (`nonTextCounts`), carried through so the ledger records it (#185).
        ...(chunk.usage.imageCount !== undefined ? { imageCount: chunk.usage.imageCount } : {}),
        ...(chunk.usage.audioSeconds !== undefined ? { audioSeconds: chunk.usage.audioSeconds } : {}),
        modelId: resolved.modelId,
        currency: resolved.currency ?? "USD",
        costMinorUnits: resolved.price ? resolved.price(chunk.usage) : 0,
      };
      return;
    }
    case "structured-output": {
      /**
       * The validated answer of a structured agent — task #243.
       *
       * Emitted once, complete. `streamModelTurn` has already validated it against the schema and fails the turn
       * if it does not conform, so reaching here means the value satisfies what the caller asked for. Nothing
       * partial is ever emitted: a half-built object does not satisfy a schema, so streaming one would publish
       * values that violate the contract.
       */
      const part: StructuredPart = {
        id: `${messageId}:structured` as MessagePartId,
        type: "structured",
        schemaVersion: 1,
        createdAt: new Date(0).toISOString(),
        value: chunk.value,
      };
      yield { type: "part.added", messageId, part };
      return;
    }
    case "error":
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
  }
}
