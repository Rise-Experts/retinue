/**
 * The models a chat may pick, and what "effort" means for each — #551.
 *
 * ## The catalogue
 *
 * Three sources, and only these:
 *
 *  - **the deployment's model** (`RETINUE_MODEL_PROVIDER` / `RETINUE_MODEL_ID`), id `chorus:<modelId>`;
 *  - **more models on the deployment's key**, when `RETINUE_MODEL_CHOICES` names them
 *    (`gemini-2.5-pro|Gemini 2.5 Pro,gemini-2.5-flash-lite|Flash Lite`), same provider and credential —
 *    a second provider would need a second key this deployment does not hold;
 *  - **the workspace's own key** (#462), id `workspace:<modelId>`, costing the platform nothing.
 *
 * A chat that names anything else runs on the default and the turn says so in the log: a model id is
 * never silently replaced by a *different named* model, only by "the default", which is what the person
 * gets when they pick nothing.
 *
 * ## Effort
 *
 * One slider, three stops, mapped per provider to the knob that provider actually has. `medium` is the
 * provider's own default — nothing is sent — so the stop the person did not touch cannot change
 * behaviour. A model with no such knob ignores effort, and `effortOptions` says so rather than sending an
 * option the provider would reject.
 */
import { optionalEnv } from "./env.js";
import type { Effort } from "./turn-settings.js";

export type CatalogueModel = {
  readonly id: string;
  readonly label: string;
  readonly source: "chorus" | "workspace";
  readonly provider: string;
  readonly modelId: string;
};

const LABEL: Readonly<Record<string, string>> = {
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "gpt-4o": "GPT-4o",
  "gpt-5": "GPT-5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
};

const labelFor = (modelId: string): string => LABEL[modelId] ?? modelId;

/** The deployment's choices: its model first, then `RETINUE_MODEL_CHOICES` on the same key. */
export const deploymentChoices = (
  deployment: { readonly provider: string; readonly modelId: string },
  env: Readonly<Record<string, string | undefined>>,
): CatalogueModel[] => {
  const out: CatalogueModel[] = [
    { id: `chorus:${deployment.modelId}`, label: labelFor(deployment.modelId), source: "chorus", provider: deployment.provider, modelId: deployment.modelId },
  ];
  for (const entry of (optionalEnv("RETINUE_MODEL_CHOICES", env) ?? "").split(",")) {
    const [rawId, rawLabel] = entry.split("|");
    const modelId = (rawId ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(modelId) || out.some((m) => m.modelId === modelId)) continue;
    out.push({ id: `chorus:${modelId}`, label: (rawLabel ?? "").trim() || labelFor(modelId), source: "chorus", provider: deployment.provider, modelId });
  }
  return out;
};

export const workspaceChoice = (workspace: { readonly provider: string; readonly modelId: string }): CatalogueModel => ({
  id: `workspace:${workspace.modelId}`,
  label: labelFor(workspace.modelId),
  source: "workspace",
  provider: workspace.provider,
  modelId: workspace.modelId,
});

/* ---- effort ---- */

const GOOGLE_THINKING = /^gemini-(2\.5|3)/i;
const OPENAI_REASONING = /^(o\d|gpt-5)/i;
const ANTHROPIC_THINKING = /^claude-(3-7|(opus|sonnet)-[4-9]|[a-z]+-[4-9])/i;

/** Tokens a model may spend thinking. Low is the least a model that must think accepts (Gemini Pro: 128). */
const BUDGET: Record<Exclude<Effort, "medium">, number> = { low: 128, high: 8_192 };

export type EffortResult = {
  readonly providerOptions?: Record<string, Record<string, unknown>>;
  /** A raised output ceiling, when thinking would otherwise eat the whole answer. */
  readonly maxOutputTokens?: number;
  readonly applied: boolean;
};

export const effortOptions = (
  target: { readonly provider: string; readonly modelId: string },
  effort: Effort,
  current: { readonly maxOutputTokens?: number } = {},
): EffortResult => {
  if (effort === "medium") return { applied: true };
  const provider = target.provider.toLowerCase();
  if (provider === "google" && GOOGLE_THINKING.test(target.modelId)) {
    return { applied: true, providerOptions: { google: { thinkingConfig: { thinkingBudget: BUDGET[effort] } } } };
  }
  if ((provider === "openai" || provider === "azure-openai") && OPENAI_REASONING.test(target.modelId)) {
    return { applied: true, providerOptions: { openai: { reasoningEffort: effort } } };
  }
  if (provider === "anthropic" && ANTHROPIC_THINKING.test(target.modelId)) {
    // Low is simply no extended thinking. High thinks, and the answer still needs room after the thinking.
    if (effort === "low") return { applied: true };
    const budgetTokens = 4_096;
    const floor = budgetTokens + 2_048;
    return {
      applied: true,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens } } },
      ...(current.maxOutputTokens === undefined || current.maxOutputTokens < floor ? { maxOutputTokens: floor } : {}),
    };
  }
  return { applied: false };
};

/** Merge an effort result into a call's params without dropping the options already there (Anthropic cache control). */
export const withEffort = <P extends { providerOptions?: unknown; maxOutputTokens?: number }>(params: P, result: EffortResult): P => {
  if (result.providerOptions === undefined && result.maxOutputTokens === undefined) return params;
  const existing = (params.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
  const merged: Record<string, Record<string, unknown>> = { ...existing };
  for (const [provider, options] of Object.entries(result.providerOptions ?? {})) merged[provider] = { ...(existing[provider] ?? {}), ...options };
  return {
    ...params,
    providerOptions: merged,
    ...(result.maxOutputTokens === undefined ? {} : { maxOutputTokens: result.maxOutputTokens }),
  };
};
