/**
 * Moderation, as an adapter — REQ-046 (#205), task #212, AC-4.
 *
 * **Off unless declared, and it takes the classifier rather than choosing one.** That is the whole design
 * decision, and it is a cost decision rather than a technical one: a model call on every turn doubles the
 * latency floor and adds a per-turn charge, and whether that is worth it depends on what a deployment is for.
 * A runtime that imposed it would be spending somebody else's money on a policy they did not choose.
 *
 * So `classify` is supplied by the host. OpenAI's moderation endpoint is one implementation; a local classifier,
 * a keyword list, or a shared service are others. None of them is a dependency of this package.
 *
 * ## The cost, stated
 *
 * One classifier call per inspected subject. With `subjects: ["input", "message"]` — the default — that is two
 * calls per turn, in series with the model rather than parallel to it, because a turn that has already been
 * answered cannot be un-answered. Add roughly the classifier's own latency twice to every turn.
 *
 * Reducing that is a real option and is why `subjects` is configurable: inspecting only `input` halves the cost
 * and leaves generated content unchecked, which is the right trade for an internal tool and the wrong one for
 * anything public.
 *
 * ## Failure is handled by the port, not here
 *
 * A classifier that times out throws, and `applyInputGuardrails` turns a throw into a refusal attributed to this
 * guardrail. That is deliberate and it is the expensive-looking choice: a moderation outage stops turns. The
 * alternative is a moderation outage that silently stops moderating, which is the one nobody notices.
 */

import type { Guardrail, GuardrailInput, GuardrailOutput, GuardrailVerdict } from "./index.js";

export type ModerationResult = {
  readonly flagged: boolean;
  /** Category names from the classifier. Used in the refusal message and the record; never the content. */
  readonly categories?: readonly string[];
};

/** What the host supplies. Throwing is a refusal — see the module comment. */
export type ModerationClassifier = (text: string) => Promise<ModerationResult> | ModerationResult;

/** Which subjects to spend a classifier call on. */
export const MODERATION_SUBJECTS = ["input", "message", "tool-result"] as const;
export type ModerationSubject = (typeof MODERATION_SUBJECTS)[number];

export type ModerationOptions = {
  readonly classify: ModerationClassifier;
  /**
   * Defaults to `["input", "message"]` — two calls per turn.
   *
   * `tool-result` is off by default because a tool result is usually structured data rather than prose, and
   * classifying JSON produces confident nonsense. Turn it on when tools return free text somebody will read.
   */
  readonly subjects?: readonly ModerationSubject[];
  /** Minimum text length worth a call. Defaults to 1: a classifier call on an empty string is pure cost. */
  readonly minLength?: number;
  readonly name?: string;
};

const textOf = (output: GuardrailOutput): string | null => {
  if (output.kind === "message") return output.text;
  if (output.kind === "tool-result") return typeof output.output === "string" ? output.output : null;
  // A tool call's arguments are not prose. Classifying a JSON object is a call spent on a question the
  // classifier was not trained for — the PII guardrail is the one that reads arguments.
  return null;
};

export const createModerationGuardrail = (options: ModerationOptions): Guardrail => {
  const subjects = options.subjects ?? ["input", "message"];
  const minLength = options.minLength ?? 1;

  const judge = async <T>(text: string): Promise<GuardrailVerdict<T>> => {
    if (text.trim().length < minLength) return { kind: "pass" };
    const result = await options.classify(text);
    if (!result.flagged) return { kind: "pass" };
    const categories = result.categories ?? [];
    return {
      kind: "refused",
      code: "moderation",
      // Categories, never the content. The message is shown to a person and stored in an event.
      message:
        categories.length > 0
          ? `That content was flagged as ${categories.join(", ")}.`
          : "That content was flagged by moderation.",
    };
  };

  return {
    name: options.name ?? "moderation",
    ...(subjects.includes("input")
      ? { inspectInput: (input: GuardrailInput) => judge<GuardrailInput>(input.text) }
      : {}),
    ...(subjects.some((s) => s === "message" || s === "tool-result")
      ? {
          inspectOutput: async (output: GuardrailOutput): Promise<GuardrailVerdict<GuardrailOutput>> => {
            if (!subjects.includes(output.kind as ModerationSubject)) return { kind: "pass" };
            const text = textOf(output);
            return text === null ? { kind: "pass" } : judge<GuardrailOutput>(text);
          },
        }
      : {}),
  };
};
