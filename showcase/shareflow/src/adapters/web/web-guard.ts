/**
 * Optional guardrails for web content — #667 (Guardrails B and E).
 *
 * `tools/research.ts` explains why fetched text is never *filtered*: a filter cannot be complete, it guts research
 * about the very subject, and it invites trust it has not earned. Both guards here keep to that. Neither removes a
 * word; each only adds information the model and the person can act on.
 *
 * - **Datamarking** (Microsoft's spotlighting, Hines et al. 2024): every run of whitespace in fetched text becomes
 *   `ˆ`, so text from a page cannot read as the instruction channel even after the fence. Measured attack success on
 *   GPT models fell from over 50% to under 2%. It costs fidelity — the model has to put the spaces back when it
 *   quotes — so it is **off unless enabled**, and it never applies to documents (`read_pdf`), whose text the agent
 *   copies exactly into edits.
 * - **An injection check**: a page or search result whose text addresses an AI is *labelled* in the result, and the
 *   tool tells the model to say so to the person. The built-in check is a set of phrasings; a deployment can point
 *   it at a hosted classifier (Meta Prompt Guard 2 served by text-embeddings-inference, which answers
 *   `POST /predict` with `[{label, score}]`). A classifier that fails or times out falls back to the phrasings, so
 *   it never costs a turn.
 *
 * Both apply to fetched pages and search results only, so turns that read nothing from the web pay nothing.
 */
import type { InjectionVerdict, WebContentGuard } from "../../services/index.js";

/** The datamark — a character ordinary prose does not contain, per the spotlighting paper. */
export const DATAMARK = "ˆ";

export const datamark = (text: string): string => text.replace(/\s+/g, DATAMARK);

/**
 * Phrasings that address an AI rather than a reader. Deliberately few and specific: each must be something an
 * article almost never says to its human audience. A page *about* prompt injection will match — that is a label,
 * and labelling it is right.
 */
const PHRASES: readonly (readonly [RegExp, string])[] = [
  [/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|directions|guidelines)\b/i, "tells the reader to ignore its instructions"],
  [/\b(new|updated|real|actual)\s+(system\s+)?instructions?\s*[:：]/i, "announces new instructions"],
  [/\bsystem\s*prompt\b/i, "mentions a system prompt"],
  [/\byou\s+are\s+now\s+(a|an|the|in)\b/i, "tries to change who the assistant is"],
  [/\b(as|dear|attention|note\s+to)\s+(an?\s+)?(ai|llm|language\s+model|assistant|chatbot|agent)\b[,:]/i, "addresses an AI directly"],
  [/\b(ai|llm|assistant|agent)s?\s+(reading|processing|summari[sz]ing)\s+this\b/i, "addresses an AI reading the page"],
  [/\bdo\s+not\s+(tell|inform|mention\s+(this\s+)?to)\s+the\s+(user|person|human)\b/i, "asks to hide something from the person"],
  [/<\/?\s*(system|assistant|instructions?)\s*>|\[\s*(system|INST)\s*\]|<\|im_start\|>/i, "contains chat-format markers"],
  [/\b(ignoriere|vergiss)\b[^.\n]{0,40}\b(anweisungen|instruktionen|regeln)\b/i, "tells the reader to ignore its instructions (German)"],
];

export const checkPhrases = (text: string): InjectionVerdict => {
  const reasons = PHRASES.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
  return { flagged: reasons.length > 0, reasons, checkedBy: "phrases" };
};

/** Labels a Prompt Guard 2 deployment uses for an attack; `BENIGN` / `LABEL_0` are not. */
const ATTACK_LABELS = new Set(["MALICIOUS", "INJECTION", "JAILBREAK", "LABEL_1", "LABEL_2"]);

export type ClassifierOptions = {
  readonly url: string;
  readonly threshold?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
};

/** A hosted classifier, falling back to the phrasings when it cannot answer. */
export const classifierCheck =
  (options: ClassifierOptions) =>
  async (text: string): Promise<InjectionVerdict> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const threshold = options.threshold ?? 0.5;
    try {
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Prompt Guard 2 reads 512 tokens; the start of a page is where an injection that wants to be read sits.
        body: JSON.stringify({ inputs: text.slice(0, 2_000), truncate: true }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
      });
      if (!response.ok) throw new Error(`classifier answered ${response.status}`);
      const body = (await response.json()) as unknown;
      const scores = (Array.isArray(body) && Array.isArray(body[0]) ? body[0] : body) as { label?: unknown; score?: unknown }[];
      if (!Array.isArray(scores)) throw new Error("classifier answered in an unknown shape");
      const hits = scores.filter((s) => ATTACK_LABELS.has(String(s.label).toUpperCase()) && Number(s.score) >= threshold);
      return {
        flagged: hits.length > 0,
        reasons: hits.map((s) => `classifier: ${String(s.label)} ${Number(s.score).toFixed(2)}`),
        checkedBy: "classifier",
      };
    } catch (error) {
      console.warn(`[shareflow] injection classifier unavailable (${error instanceof Error ? error.message : String(error)}); using the phrase check.`);
      return checkPhrases(text);
    }
  };

/**
 * The guard a deployment asked for, or none.
 *
 * - `SHAREFLOW_WEB_DATAMARKING=on` turns datamarking on (off by default).
 * - `SHAREFLOW_INJECTION_CHECK` is `phrases` (the default), `off`, or the URL of a Prompt Guard `/predict` endpoint.
 */
export const webContentGuardFrom = (env: Readonly<Record<string, string | undefined>>, fetchImpl?: typeof fetch): WebContentGuard | undefined => {
  const marking = ["1", "on", "true", "yes"].includes((env["SHAREFLOW_WEB_DATAMARKING"] ?? "").trim().toLowerCase());
  const setting = (env["SHAREFLOW_INJECTION_CHECK"] ?? "phrases").trim();
  const mark = marking ? { mark: datamark } : {};
  if (setting.toLowerCase() === "off") {
    return marking ? { ...mark, check: async () => ({ flagged: false, reasons: [], checkedBy: "phrases" }) } : undefined;
  }
  const check = /^https?:\/\//i.test(setting)
    ? classifierCheck({ url: setting, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
    : async (text: string) => checkPhrases(text);
  return { ...mark, check };
};
