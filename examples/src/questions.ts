/**
 * What a single `ask_user` call is asking — #155, #163.
 *
 * Its own module rather than part of `index.ts` because that file is the app module: importing it runs the
 * wiring, which refuses to start without the dev-auth flag. A pure function that needs a database and an
 * environment variable to be tested is a pure function nobody tests.
 */

import type { QuestionSpec } from "@retinue/agentkit";

/** A prompt longer than this is a model mistake, not a question. Stored capped rather than refused. */
export const MAX_PROMPT_LENGTH = 500;

/**
 * The questions a single `ask_user` call is asking — one batch, however the model phrased it.
 *
 * Two accepted shapes: `questions: [...]` for a batch, and the older top-level `question`/`options` for one.
 * Both are kept because a model that has seen the single-question form will keep sending it, and refusing it
 * would turn a working call into an error the model has to guess its way out of.
 *
 * Keys are what answers are filed under, so they have to be unique and stable. A model that omits them, or
 * repeats one, gets positional keys rather than an error — a collision would silently overwrite one answer
 * with another, which is worse than an ugly key.
 */
export const questionSpecsFrom = (input: unknown): QuestionSpec[] => {
  type Raw = { question?: unknown; prompt?: unknown; key?: unknown; options?: unknown; multiple?: unknown; allowOther?: unknown };
  const raw = input as Raw & { questions?: unknown };
  const entries: Raw[] = Array.isArray(raw.questions) && raw.questions.length > 0
    ? (raw.questions as Raw[])
    : [raw];

  const used = new Set<string>();
  const specs: QuestionSpec[] = [];
  for (const [index, entry] of entries.entries()) {
    const prompt = String(entry.question ?? entry.prompt ?? "").trim().slice(0, MAX_PROMPT_LENGTH);
    if (prompt === "") continue;
    const options = Array.isArray(entry.options) ? entry.options.map((o) => String(o)).filter((o) => o !== "") : [];
    const asked = typeof entry.key === "string" ? entry.key.trim() : "";
    const key = asked !== "" && !used.has(asked) ? asked : `answer${entries.length > 1 ? index + 1 : ""}`;
    used.add(key);
    specs.push({
      key,
      prompt,
      ...(options.length > 0 ? { options } : {}),
      ...(entry.multiple === true ? { multiple: true } : {}),
      // Free text is allowed by default when there are no options, and only on request when there are — a short
      // list is usually closed on purpose.
      ...(entry.allowOther === true || options.length === 0 ? { allowOther: true } : {}),
    });
  }
  return specs;
};

