/**
 * The summarizer `compactThread` needs, over this deployment's own model.
 *
 * Compaction replaces the older half of a long thread with a condensed version of it, so the model
 * keeps the sense of a conversation whose beginning no longer fits. The platform injects the
 * summarizer precisely so it stays provider-neutral; this is ShareFlow's, and it is the piece that was
 * missing — `compactThread` has never had a caller, in this package or in `@retinue/agentkit`.
 *
 * ## What a summary of *this* conversation has to keep
 *
 * A generic "summarise the above" loses the things that make the next turn possible. The assistant
 * works by passing ids between tools — a post draft id from `create_post_draft` into
 * `publish_post_now`, a campaign id into `get_campaign_calendar` — and every tool that takes one says
 * so in its schema: *"An id this workspace's own tools returned. Never invent one — read it from a
 * previous result."* A summary that says "we drafted a post about the launch" and drops the id has
 * turned a workable thread into one where the model must either re-list drafts or make an id up, and
 * the second is the failure the schemas are worded to prevent.
 *
 * So the instruction is explicit about identifiers, decisions and commitments, and explicit that
 * pleasantries go. That is the whole difference between a summary that costs a round trip and one that
 * costs the thread.
 *
 * ## It is bounded, and that is not decoration
 *
 * A summariser that returns something as long as its input has achieved nothing — the budget would
 * still be blown, and now a model call has been spent on it. The schema caps the text and
 * `SUMMARY_MAX_CHARS` is enforced again on the way out, because a schema is a request and a cap is a
 * guarantee.
 */
import { z } from "zod";

import type { ExecutionContext } from "@retinue/agentkit";
import type { ThreadSummarizer } from "@retinue/agentkit/context";

import type { StructuredGenerate } from "../adapters/model/generator.js";

/**
 * The ceiling on a summary, in characters.
 *
 * 8,000 characters is ~2,000 tokens — the size Anthropic uses for condensed hand-offs, comfortably
 * inside the history budget and enough for a long thread's sections (#630 raised it from 6,000 when the
 * summary gained sections and tool outcomes). The number is a ceiling rather than a target: most
 * summaries should be far shorter, and one that reaches this is a thread worth looking at.
 */
export const SUMMARY_MAX_CHARS = 8_000;

/** What the model is asked for. An object rather than a bare string, because `generate` takes a schema. */
const SummarySchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(SUMMARY_MAX_CHARS)
    .describe("The condensed thread, in the sections asked for. Identifiers preserved verbatim."),
});

const SYSTEM = `You condense the earlier part of a conversation between a person and a social-media assistant, so the assistant can continue the thread after its beginning no longer fits in context.

What you produce replaces those messages entirely — anything you leave out is gone. Write in the third person, under exactly these headings, and leave a heading out only when there is nothing under it:

## Goal
What the person is trying to achieve overall, and for whom (brand, project, audience).

## Decisions
What was chosen or rejected, and why — "they chose the durability angle over the price angle" is worth more than "they discussed angles". Constraints they set: dates, platforms, tone, things not to do or claim.

## Things made and their ids
Every post draft, artifact, document, image, video, campaign, schedule, lead or link — with its **id verbatim** and one line on what it is and its state (draft, scheduled for a date, published, failed). The assistant passes these ids between tools and cannot invent one; an id you drop is work that has to be redone.

## Findings
Facts the tools found that later turns may rely on — search results, figures, quotes with their sources, what a page or PDF said. Short, with the source.

## Done
What was published, scheduled, replied to, remembered or deleted, and whether it succeeded.

## Open
Anything asked for and not yet delivered, anything waiting for the person's approval or answer, and anything the assistant said it would do next.

## Failed attempts
What was tried and did not work, and why — so it is not retried blindly.

Keep every identifier verbatim. Drop greetings, acknowledgements, restatements, the assistant's reasoning about how it would do something it then did, and full caption text unless the person wrote it themselves (refer to a draft by its id).

If a prior summary is given, produce one summary covering both it and the new messages. Do not append; merge each section, and never drop an identifier that appeared in the prior summary.`;

const roleOf = (role: string): string => (role === "assistant" ? "assistant" : role === "tool" ? "tool" : "person");

/** How much of one tool output the summarizer sees. Enough for ids, a finding or a failure; not a document. */
const SUMMARY_TOOL_OUTPUT_CHARS = 600;

const clip = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

const json = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};

/**
 * A message flattened to the text a summarizer can read, tool steps included with what they returned.
 *
 * #630: a tool step used to reach the summarizer as "(called X)" and nothing more, so an id or a finding that
 * existed only in a tool's output — a draft id, a search result, a failure — was lost at the first
 * condensation. Now the output comes too, clipped: enough to keep the ids and outcomes, not so much that the
 * summarizer's own prompt becomes the thing that overflows.
 */
const transcribe = (message: { readonly role: string; readonly parts?: readonly unknown[] }): string => {
  const parts = (message.parts ?? [])
    .map((part) => {
      const typed = part as { type?: string; text?: string; toolName?: string; input?: unknown; output?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      if (typed.type === "tool-call" && typeof typed.toolName === "string") {
        return `(called ${typed.toolName} with ${clip(json(typed.input), 300)})`;
      }
      if (typed.type === "tool-result" && typeof typed.toolName === "string") {
        return `(${typed.toolName} returned ${clip(json(typed.output), SUMMARY_TOOL_OUTPUT_CHARS)})`;
      }
      if (typeof typed.toolName === "string") return `(called ${typed.toolName})`;
      return "";
    })
    .filter((text) => text !== "");
  return parts.length === 0 ? "" : `${roleOf(message.role)}: ${parts.join("\n")}`;
};

export const createThreadSummarizer = (input: {
  readonly generate: StructuredGenerate;
  /**
   * The run's context, closed over.
   *
   * `ThreadSummarizer.summarize` takes only the messages — it is the platform's interface and it is
   * provider-neutral by design — while `StructuredGenerate` needs a context to resolve the model,
   * its credentials and its cost ceiling. So the summarizer is built per turn, where the context is.
   */
  readonly context: ExecutionContext;
  /**
   * #657: the model the summary is written on, when not the chat's — a small one (`summaryModelFor`): about a third
   * of the price, and outside the chat model's per-minute limit, so a summary and the turn after it do not compete.
   */
  readonly modelId?: string;
}): ThreadSummarizer => ({
  async summarize({ priorSummary, messages }) {
    const transcript = messages
      .map((message) => transcribe(message as never))
      .filter((line) => line !== "")
      .join("\n\n");

    const prompt =
      priorSummary === undefined
        ? `Condense this part of the thread.\n\n${transcript}`
        : `Here is the summary of the thread so far:\n\n${priorSummary}\n\n` +
          `Here are the messages that came after it. Produce one summary covering both.\n\n${transcript}`;

    const result = await input.generate({
      context: input.context,
      system: SYSTEM,
      prompt,
      schema: SummarySchema,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    });

    /**
     * Capped again here.
     *
     * The schema asks for at most `SUMMARY_MAX_CHARS` and a model can return more — a schema is a
     * request. Compaction that replaced a long history with an equally long summary would have spent a
     * model call to achieve nothing, and the caller has already committed to using whatever comes back.
     */
    return result.summary.length > SUMMARY_MAX_CHARS
      ? `${result.summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
      : result.summary;
  },
});

/**
 * The small model a thread summary is written on, per platform provider — #657. `SHAREFLOW_SUMMARY_MODEL` overrides;
 * a provider not listed summarises on the chat model (undefined).
 */
const SUMMARY_MODELS: Readonly<Record<string, string>> = {
  google: "gemini-2.5-flash-lite",
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-4-5",
};

export const summaryModelFor = (provider: string, override?: string): string | undefined =>
  override !== undefined && override.trim() !== "" ? override.trim() : SUMMARY_MODELS[provider.toLowerCase()];
