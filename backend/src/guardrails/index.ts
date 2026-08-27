/**
 * Guardrails — REQ-046 (#205), task #211.
 *
 * A seam for checks a deployment needs and this runtime does not ship: PII redaction, moderation, a topic
 * restriction, an output schema. Without it, a deployment that needs any of those has to edit the engine.
 *
 * The injection half of "guardrails" is already built and lives elsewhere (`security/prompt-safety.ts`), and it
 * is deliberately *not* a guardrail in this sense: containment is structural — untrusted content is wrapped in a
 * nonce-delimited envelope whether or not anything recognises an attack — whereas everything here is
 * *inspection*, which can only act on what it detects. Conflating the two would invite someone to switch off
 * containment because a detector is present.
 *
 * ## Three decisions that make this worth having
 *
 * **Tool calls are outputs.** A guardrail that inspects only the final message can be walked straight past by
 * putting the data in a tool argument. Checking prose and not arguments is checking the boring half, so
 * `GuardrailOutput` is a discriminated union of a message *and* a tool call, and the tool-call case is enforced
 * at the one choke point every call goes through.
 *
 * **Fail closed.** A guardrail that throws refuses the turn, attributed to the guardrail that threw. The
 * opposite default is how a guardrail silently stops guarding the day its dependency times out — and the run
 * looks entirely normal afterwards, which is the property that makes it dangerous.
 *
 * **Every verdict is recorded, and never the value.** A redaction that leaves no trace is indistinguishable from
 * the model never having been told, which makes an incident unreconstructable. So a record names *what* was
 * redacted — the field, the entity type — and never what it contained, or the audit trail becomes the leak.
 */

import type { ExecutionContext } from "../core/context.js";

/** What a guardrail may conclude. */
export const GUARDRAIL_OUTCOMES = ["pass", "redacted", "refused"] as const;
export type GuardrailOutcome = (typeof GUARDRAIL_OUTCOMES)[number];

/** The turn's input, before the model sees it. */
export type GuardrailInput = {
  readonly text: string;
  /** Identifiers only. A guardrail that needs contents reads them through the file service, under its own budget. */
  readonly attachmentIds?: readonly string[];
};

/**
 * Every boundary crossing that is not the turn's own input.
 *
 * Three kinds, one hook, deliberately. A separate hook per kind lets an author implement two of three and have a
 * gap they did not choose — and the gap would be in whichever kind was added last, which is the one nobody
 * remembers. The union forces the `switch` to be written.
 *
 * `tool-result` is here even though a tool produced it rather than the model: it is content *entering* the
 * model's context from outside the tenant, and it is the likeliest source of personal data in a whole run — a
 * document read by a tool contains what the document contains. Inspecting the arguments and not the results
 * would check the direction data leaves and ignore the direction it arrives.
 */
export type GuardrailOutput =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "tool-call"; readonly toolName: string; readonly input: unknown }
  | { readonly kind: "tool-result"; readonly toolName: string; readonly output: unknown };

export type GuardrailVerdict<T> =
  | { readonly kind: "pass" }
  /** `what` names fields or entity types — never values. */
  | { readonly kind: "redacted"; readonly value: T; readonly what: readonly string[] }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

export interface Guardrail {
  /** Stable, and used in records and refusals: "which check stopped this" must be answerable. */
  readonly name: string;
  inspectInput?(
    input: GuardrailInput,
    context: ExecutionContext,
  ): Promise<GuardrailVerdict<GuardrailInput>> | GuardrailVerdict<GuardrailInput>;
  inspectOutput?(
    output: GuardrailOutput,
    context: ExecutionContext,
  ): Promise<GuardrailVerdict<GuardrailOutput>> | GuardrailVerdict<GuardrailOutput>;
}

/** One line of the audit trail. Carries no inspected value, by construction. */
export type GuardrailRecord = {
  readonly guardrail: string;
  readonly subject: "input" | "message" | "tool-call" | "tool-result";
  readonly outcome: GuardrailOutcome;
  /** For a redaction: the fields or entity types touched. Never their contents. */
  readonly what?: readonly string[];
  /** For a refusal. */
  readonly code?: string;
  /** True when the guardrail threw and was therefore treated as a refusal. */
  readonly threw?: boolean;
};

export type GuardrailDecision<T> =
  | { readonly outcome: "allowed"; readonly value: T; readonly records: readonly GuardrailRecord[] }
  | {
      readonly outcome: "refused";
      readonly by: string;
      readonly code: string;
      readonly message: string;
      readonly records: readonly GuardrailRecord[];
    };

const REFUSED_BY_THROW = "guardrail_failed";

const subjectOf = (value: unknown): GuardrailRecord["subject"] => {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const kind = (value as { kind: string }).kind;
    return kind === "tool-call" || kind === "tool-result" ? kind : "message";
  }
  return "input";
};

/**
 * Run a list in declared order, threading the value through.
 *
 * Threading is what makes two redacting guardrails compose: the second inspects what the first produced, so one
 * cannot undo the other by inspecting the original and returning its own edit of it. Order is the caller's
 * declaration and is never sorted here — a guardrail set whose order depends on object key iteration is a set
 * whose behaviour changes when someone reformats the config.
 *
 * A refusal short-circuits: the remaining guardrails are not consulted, because the turn is over and running
 * them would spend money to annotate a decision already taken.
 *
 * Two exported entry points over one core rather than a `hook: "inspectInput" | "inspectOutput"` parameter. The
 * parameterised version does not typecheck — indexing a union of two method signatures gives a function callable
 * with neither argument type — and the `never` cast that silences it would have erased exactly the distinction
 * the two subjects exist to keep.
 */
const applyEach = async <T>(
  guardrails: readonly Guardrail[],
  select: (guardrail: Guardrail) => ((value: T, context: ExecutionContext) => Promise<GuardrailVerdict<T>> | GuardrailVerdict<T>) | undefined,
  value: T,
  context: ExecutionContext,
): Promise<GuardrailDecision<T>> => {
  const records: GuardrailRecord[] = [];
  let current = value;

  for (const guardrail of guardrails) {
    const inspect = select(guardrail);
    if (inspect === undefined) continue;

    let verdict: GuardrailVerdict<T>;
    try {
      verdict = await inspect(current, context);
    } catch (error) {
      // Fail closed, and say which one. A guardrail whose dependency timed out must not become a guardrail that
      // passed everything: the whole point is that its absence is visible.
      records.push({
        guardrail: guardrail.name,
        subject: subjectOf(current),
        outcome: "refused",
        code: REFUSED_BY_THROW,
        threw: true,
      });
      return {
        outcome: "refused",
        by: guardrail.name,
        code: REFUSED_BY_THROW,
        message: `guardrail ${guardrail.name} could not complete: ${error instanceof Error ? error.message : String(error)}`,
        records,
      };
    }

    if (verdict.kind === "pass") {
      records.push({ guardrail: guardrail.name, subject: subjectOf(current), outcome: "pass" });
      continue;
    }
    if (verdict.kind === "redacted") {
      records.push({ guardrail: guardrail.name, subject: subjectOf(current), outcome: "redacted", what: verdict.what });
      current = verdict.value;
      continue;
    }
    records.push({ guardrail: guardrail.name, subject: subjectOf(current), outcome: "refused", code: verdict.code });
    return { outcome: "refused", by: guardrail.name, code: verdict.code, message: verdict.message, records };
  }

  return { outcome: "allowed", value: current, records };
};

/** Before the model sees the turn. */
export const applyInputGuardrails = (
  guardrails: readonly Guardrail[],
  input: GuardrailInput,
  context: ExecutionContext,
): Promise<GuardrailDecision<GuardrailInput>> =>
  applyEach(guardrails, (g) => (g.inspectInput ? (v, c) => g.inspectInput!(v, c) : undefined), input, context);

/** Before anything leaves the model — a message *or* a tool call. */
export const applyOutputGuardrails = (
  guardrails: readonly Guardrail[],
  output: GuardrailOutput,
  context: ExecutionContext,
): Promise<GuardrailDecision<GuardrailOutput>> =>
  applyEach(guardrails, (g) => (g.inspectOutput ? (v, c) => g.inspectOutput!(v, c) : undefined), output, context);

/**
 * Whether a record could carry an inspected value — used by the test that asserts it never does.
 *
 * Here rather than in the test file because it states the invariant next to the type it constrains: a record has
 * a fixed shape, and adding a field that holds content is the change this is meant to make somebody notice.
 */
export const recordCarriesOnlyMetadata = (record: GuardrailRecord): boolean =>
  Object.keys(record).every((key) => ["guardrail", "subject", "outcome", "what", "code", "threw"].includes(key));
