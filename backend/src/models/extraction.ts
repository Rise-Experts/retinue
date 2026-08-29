/**
 * Entity and relationship extraction through a language model — REQ-064 (#270), task #271.
 *
 * Lives in `models/` for the reason `vision.ts` does: boundary rule R3 keeps the Vercel AI SDK here, so the
 * knowledge layer calls `extractGraph` and never sees `generateText`.
 *
 * ## Why the output is parsed leniently rather than schema-constrained
 *
 * The obvious approach is structured output with a JSON schema. Two measured facts in this repository say
 * otherwise: `experimental_output` is silently ignored by `ai@7` (the option is `output`), and
 * `jsonSchema().validate` is `undefined`, so a JSON schema is refused for structured output outright. Both were
 * found by live calls after typechecking cleanly — the exact failure mode where a wrong option name does
 * nothing at all.
 *
 * So the prompt asks for JSON, and `parseExtraction` is deliberately forgiving: it finds the JSON in whatever
 * the model wrapped it in. That is not a workaround for a broken schema mechanism, it is the honest shape for
 * a call whose output cannot be constrained — and it is *safe* because `sanitiseExtraction` downstream treats
 * everything here as untrusted anyway. A chunk whose extraction is unusable contributes nothing; it never
 * corrupts the graph.
 */

import { generateText, type LanguageModel } from "ai";

import { AgentPlatformError } from "../core/errors.js";

/**
 * What the model is asked for.
 *
 * Three things in this prompt are load-bearing and should not be trimmed:
 *
 * - **"only what this text states"** — extraction's characteristic failure is inventing plausible relationships
 *   between things that merely co-occur, and those are the edges a traversal follows most confidently.
 * - **"use exactly the names you listed"** — an edge naming an endpoint that was not extracted is dropped by
 *   `sanitiseExtraction`, because repairing it would invent a provenance nobody asserted. Asking for
 *   consistency up front is much cheaper than losing the edge.
 * - **"JSON and nothing else"** — it does not always work, which is why `parseExtraction` exists, but it works
 *   often enough to matter at one call per chunk.
 */
export const DEFAULT_EXTRACTION_PROMPT = [
  "Extract the named entities and the relationships between them from the text below.",
  "",
  "Report only what this text states. Do not infer a relationship from two things merely appearing together,",
  "and do not add anything you know from elsewhere.",
  "",
  "For each entity give a short name, a lowercase type such as person, organisation, system, concept or place,",
  "and a one-sentence description drawn from this text.",
  "For each relationship give the two entity names, a short lowercase type such as depends-on, owns, part-of or",
  "reports-to, and a one-sentence description. Use exactly the names you listed as entities.",
  "",
  'Answer with JSON and nothing else, in this shape:',
  '{"entities":[{"name":"","type":"","description":""}],',
  ' "relationships":[{"from":"","to":"","type":"","description":""}]}',
].join("\n");

export type ExtractGraphRequest = {
  readonly model: LanguageModel;
  readonly text: string;
  readonly prompt?: string;
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
};

export type ExtractGraphResult = {
  /** Whatever the model produced, already parsed but **not** validated. `sanitiseExtraction` does that. */
  readonly extraction: { readonly entities?: readonly unknown[]; readonly relationships?: readonly unknown[] };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The JSON inside whatever the model said.
 *
 * Three attempts, cheapest first: the whole string, a fenced block, then the outermost braces. Returns an empty
 * extraction rather than throwing, because a chunk that produced prose is a chunk that contributes nothing —
 * not an error that should fail an index of a document that embedded perfectly well.
 *
 * Exported for its own test: this is the function that decides whether a real model's output is usable, and
 * "the model wrapped it in a fence" is not a hypothetical.
 */
export const parseExtraction = (text: string): ExtractGraphResult["extraction"] => {
  const attempts: string[] = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));

  for (const attempt of attempts) {
    if (attempt === "") continue;
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ExtractGraphResult["extraction"];
      }
    } catch {
      // Next attempt. A parse failure here is expected often enough that logging each one would be noise.
    }
  }
  return {};
};

/**
 * One extraction call.
 *
 * The usage comes back rather than being recorded here, exactly as in `describeImage`: this module has no
 * `ExecutionContext` and no `UsageRecorder`, and reaching for either would put a billing decision inside a
 * provider call. AC-9 needs the number, and the caller is what has the context to attribute it to.
 */
export const extractGraph = async (req: ExtractGraphRequest): Promise<ExtractGraphResult> => {
  try {
    const result = await generateText({
      model: req.model,
      messages: [{ role: "user", content: `${req.prompt ?? DEFAULT_EXTRACTION_PROMPT}\n\n---\n\n${req.text}` }],
      ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
      ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    });
    const usage = result.usage as { inputTokens?: number; outputTokens?: number };
    return {
      extraction: parseExtraction(result.text),
      usage: { inputTokens: num(usage?.inputTokens), outputTokens: num(usage?.outputTokens) },
    };
  } catch (error) {
    // Wrapped so a provider's error shape does not reach the knowledge layer, which would then have to know
    // about three SDKs to decide whether a failure is retryable. The graph indexer catches this and the chunk
    // contributes nothing — see AC-7.
    throw new AgentPlatformError(
      {
        code: "provider_unavailable",
        message: "The model could not extract entities from that text.",
        retryable: true,
      },
      { cause: error },
    );
  }
};
