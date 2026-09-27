/**
 * Per-run reasoning effort — #286.
 *
 * One neutral dial, `low | medium | high`, that a host puts behind a "Faster ↔ Smarter" control and that this
 * module translates into whatever each provider calls the same idea. The providers genuinely differ, and not only
 * in name:
 *
 * - **Anthropic** has no effort level for extended thinking; it has a *token budget* for it, and thinking is off
 *   unless a budget is sent. So effort becomes a budget, and sending one is what turns thinking on.
 * - **OpenAI** (and Azure OpenAI, which serves the same models) takes `reasoningEffort` with the same three words,
 *   so the mapping is the identity — but only for its reasoning models.
 * - **Google** takes a thinking budget in tokens, like Anthropic, under `thinkingConfig`.
 * - **Mistral** and an arbitrary **OpenAI-compatible** endpoint have no such concept this platform can rely on.
 *
 * ## Why not the AI SDK's own `reasoning` option
 *
 * `ai@7` has a neutral `reasoning` call option and maps it per provider itself. It was the obvious choice and was
 * not taken, for the reason the issue states in its acceptance criteria: *a provider without the concept must say
 * so*. The SDK's answer to an unsupported provider is a warning on the call result — something the engine would
 * have to go looking for after the tokens are spent, and which a host-supplied `streamTurn` would never produce.
 * Mapping here makes "applied" or "ignored, and why" a fact known **before** the call, recorded on the run's usage,
 * and testable per provider without a network. It also keeps the budgets ours: a change in the SDK's defaults
 * would otherwise change what a host is billed for "high" without a line changing in this repository.
 *
 * **No AI SDK import.** This module is pure so the durable layers (`runtime`, `persistence`, `usage`) can name
 * `ReasoningEffort` without dragging the SDK into their dependency graph — the rule `pricing.ts` exists for.
 */

import type { UsageUpdatedEvent } from "../core/events.js";
import type { ModelDefinition, ModelProvider } from "./index.js";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * `core/events.ts` spells the union out rather than importing it — `core` depends on nothing above it — so the two
 * are held together here instead. Adding a fourth effort without widening the event fails the build on this line.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const eventEffortAgrees: Same<NonNullable<UsageUpdatedEvent["effort"]>, ReasoningEffort> = true;
void eventEffortAgrees;

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);

/**
 * Thinking budgets in tokens, for the providers that express effort as one.
 *
 * Anthropic's floor is 1,024 — the API refuses less — so `low` is the floor rather than a guess below it. `high`
 * stays under Gemini 2.5 Flash's 24,576 ceiling so one table serves both families without a per-model clamp.
 * Anthropic adds the budget to `max_tokens` itself (the AI SDK does it in `@ai-sdk/anthropic`), so a budget never
 * eats into the answer's own output allowance.
 *
 * Exported so a host can show "high ≈ 16k thinking tokens" beside the slider, and so the number a customer is
 * billed for is written down in one place.
 */
export const EFFORT_THINKING_BUDGETS: Readonly<Record<"anthropic" | "google", Readonly<Record<ReasoningEffort, number>>>> = {
  anthropic: { low: 1_024, medium: 4_096, high: 16_384 },
  google: { low: 1_024, medium: 8_192, high: 24_576 },
};

/** Provider-specific call options, keyed by the AI SDK's provider namespace (`anthropic`, `openai`, …). */
export type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * What became of a requested effort. Exactly one of two outcomes, so a caller cannot read an `applied` without a
 * mapping or an `ignored` without a reason.
 */
export type EffortMapping =
  | { readonly applied: true; readonly effort: ReasoningEffort; readonly providerOptions: ProviderOptions }
  | { readonly applied: false; readonly effort: ReasoningEffort; readonly ignored: string };

/**
 * The provider a model belongs to, from the definition when the host supplied one, else from the model handle.
 *
 * The fallback matters for the hosts that resolve models themselves and return no `definition` — ShareFlow does,
 * for BYO keys. An AI SDK model object carries `provider` as `"anthropic.messages"`, `"openai.responses"`,
 * `"google.generative-ai"`, `"azure.responses"`; the namespace before the dot is the provider. Anything else —
 * a gateway string id, a custom wrapper — is `undefined`, and effort is then reported as ignored rather than
 * guessed at.
 */
export const providerOfModel = (model: unknown, definition?: ModelDefinition): ModelProvider | undefined => {
  if (definition !== undefined) return definition.provider;
  const raw = typeof model === "object" && model !== null ? (model as { provider?: unknown }).provider : undefined;
  if (typeof raw !== "string") return undefined;
  const namespace = raw.split(".")[0]?.trim();
  switch (namespace) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "google":
      return "google";
    case "azure":
      return "azure-openai";
    case "mistral":
      return "mistral";
    default:
      return undefined;
  }
};

/**
 * Translate an effort for one provider — or say why it cannot be.
 *
 * A definition that declares `capabilities.reasoning: false` is ignored **before** the provider is consulted.
 * That is not caution for its own sake: Anthropic rejects a thinking block sent to a model without extended
 * thinking, and OpenAI rejects `reasoningEffort` on a non-reasoning model, so sending it would turn a cosmetic
 * slider into a failed turn. A definition that says nothing about reasoning is taken at its provider's word.
 */
export const mapReasoningEffort = (input: {
  readonly effort: ReasoningEffort;
  readonly provider: ModelProvider | undefined;
  readonly definition?: ModelDefinition;
}): EffortMapping => {
  const { effort, provider, definition } = input;
  if (definition !== undefined && definition.capabilities.reasoning === false)
    return {
      applied: false,
      effort,
      ignored: `effort ignored: model ${definition.modelId} does not declare the reasoning capability`,
    };
  switch (provider) {
    case "anthropic":
      return {
        applied: true,
        effort,
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: EFFORT_THINKING_BUDGETS.anthropic[effort] } },
        },
      };
    case "openai":
      return { applied: true, effort, providerOptions: { openai: { reasoningEffort: effort } } };
    case "azure-openai":
      /**
       * Both namespaces, deliberately. `@ai-sdk/azure`'s Responses model reads options under `azure` (it derives
       * the namespace from its provider id), while its Chat model reuses the OpenAI implementation, which reads
       * `openai`. Which one a deployment gets depends on how the host built the model, and sending the option to
       * the namespace the model does not read would be a silent no-op — the exact failure this module exists to
       * report.
       */
      return {
        applied: true,
        effort,
        providerOptions: { azure: { reasoningEffort: effort }, openai: { reasoningEffort: effort } },
      };
    case "google":
      return {
        applied: true,
        effort,
        providerOptions: { google: { thinkingConfig: { thinkingBudget: EFFORT_THINKING_BUDGETS.google[effort] } } },
      };
    case "mistral":
    case "openai-compatible":
      return { applied: false, effort, ignored: `effort ignored: provider ${provider} has no reasoning-effort option` };
    case undefined:
      return {
        applied: false,
        effort,
        ignored: "effort ignored: the model's provider is unknown, so there is no option to map it to",
      };
    default: {
      // A provider added to `MODEL_PROVIDERS` must be decided here, not defaulted to "ignored" by accident.
      const exhaustive: never = provider;
      return { applied: false, effort, ignored: `effort ignored: provider ${String(exhaustive)} is not mapped` };
    }
  }
};

/**
 * Merge provider options one namespace deep.
 *
 * The prompt-cache directive and a thinking budget both live under `anthropic`, and a shallow spread would let
 * whichever came second erase the other — caching silently off whenever effort is on, the kind of regression
 * nobody sees until a bill arrives.
 */
export const mergeProviderOptions = (...all: readonly (ProviderOptions | undefined)[]): ProviderOptions | undefined => {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const options of all) {
    if (options === undefined) continue;
    for (const [namespace, values] of Object.entries(options)) merged[namespace] = { ...merged[namespace], ...values };
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
};
