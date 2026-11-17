/**
 * The chat box's image/video settings applied to `generate_media` — #575.
 *
 * The prompt says to use them (`turn-context.ts`), and this makes it so: a person who picked 9:16 gets
 * 9:16 whether the model repeated it, left it out, or guessed another shape. Fields the person did not
 * set are left as the model passed them.
 *
 * Also the guard the production sweep asked for (2026-09-28): a video asked for with `model: "z_image"`,
 * an image-only model. An image model on a video job is dropped so the video default applies, rather
 * than sending a job the provider can only refuse.
 */
import type { ToolRegistry } from "@retinue/agentkit";
import type { MediaSettings, TurnInputReader } from "./turn-settings.js";

type ExecuteInput = Parameters<ToolRegistry["execute"]>[1];

/** Image-only generators seen in the catalogue. A video job with one of these would be refused. */
export const IMAGE_ONLY_MODEL = /^(z_image|soul|gpt_image|seedream|flux|imagen|nano_banana)/i;

/** A model name the model made up to mean "the default" — production sent `default_video_model`. */
const INVENTED_MODEL = /default|placeholder|auto_model|best_model/i;

export const withMediaInput = (input: Record<string, unknown>, media: MediaSettings | undefined): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...input };
  const kind = next["kind"] === "video" || next["kind"] === "image" ? next["kind"] : media?.kind;
  if (next["kind"] === undefined && kind !== undefined) next["kind"] = kind;
  /*
   * The person's settings apply to the kind they were set for, and they WIN over the model's guess.
   * Production, 2026-09-28: Video · 9:16 was set under the chat box and the model passed "16:9" and
   * "default_video_model" anyway. A choice made in the interface is the person speaking; a value the
   * model filled in is not.
   */
  if (media !== undefined && (media.kind === undefined || media.kind === kind)) {
    if (media.aspectRatio !== undefined) next["aspectRatio"] = media.aspectRatio;
    if (media.model !== undefined) next["model"] = media.model;
  }
  if (typeof next["model"] === "string" && INVENTED_MODEL.test(next["model"])) delete next["model"];
  if (kind === "video" && typeof next["model"] === "string" && IMAGE_ONLY_MODEL.test(next["model"])) delete next["model"];
  return next;
};

export const withMediaDefaults = (registry: ToolRegistry, deps: { readonly turnInput: TurnInputReader }): ToolRegistry => ({
  ...registry,
  async execute(context, input: ExecuteInput) {
    const viaExecuteTool = input.name === "execute_tool";
    const inner = (input.input ?? {}) as { name?: unknown; input?: unknown };
    const target = viaExecuteTool ? String(inner.name ?? "") : input.name;
    if (target === "create_artifact") {
      const turn = await deps.turnInput(context);
      const made = await registry.execute(context, input);
      const printed = await withPrintedPdf(registry, context, input, made, turn);
      return printed ?? withPdfNote(made, turn.message);
    }
    if (target !== "generate_media") return registry.execute(context, input);
    const { settings } = await deps.turnInput(context);
    const args = ((viaExecuteTool ? inner.input : input.input) ?? {}) as Record<string, unknown>;
    const filled = withMediaInput(args, settings.media);
    const result = await registry.execute(
      context,
      (viaExecuteTool ? { ...input, input: { ...inner, input: filled } } : { ...input, input: filled }) as ExecuteInput,
    );
    /*
     * What was actually sent, written into the answer. Production: the settings turned the model's
     * "16:9" into 9:16, and the model then told the person "it will be in a 16:9 aspect ratio" — it
     * reports what it asked for unless the result says otherwise.
     */
    const ok = result as { ok?: unknown; data?: unknown };
    if (ok.ok === true && ok.data !== null && typeof ok.data === "object") {
      /*
       * A sentence, first, when the settings changed the request. Production: with `sent` alone the
       * model still told the person "16:9" — it reads a plain instruction, not a nested field.
       */
      const changed = [
        args["aspectRatio"] !== filled["aspectRatio"] && filled["aspectRatio"] !== undefined ? `shape ${String(filled["aspectRatio"])}` : null,
        args["model"] !== filled["model"] ? `model ${filled["model"] === undefined ? "the default" : String(filled["model"])}` : null,
      ].filter((part): part is string => part !== null);
      return {
        ...result,
        data: {
          ...(changed.length === 0
            ? {}
            : {
                // Credit the person's settings only when they set some — an invented model name dropped is not their choice.
                note: `${settings.media !== undefined ? "Sent with the person's chat-box settings" : "Sent with the defaults"} (${changed.join(", ")}), not what you passed — tell them ${changed.join(" and ")}. You cannot notify them later; tell them to ask you to check the job.`,
              }),
          ...(ok.data as Record<string, unknown>),
          sent: {
            kind: filled["kind"],
            ...(filled["aspectRatio"] === undefined ? {} : { aspectRatio: filled["aspectRatio"] }),
            model: filled["model"] ?? "the default for the kind",
          },
        },
      } as typeof result;
    }
    return result;
  },
});

/**
 * "No PDF", "don't make a PDF", "ohne PDF" — the word is there and the request is the opposite. Production,
 * 2026-10-01: "Do not make a PDF." got the note "The person asked for a PDF … call generate_pdf". A negation
 * at most three words before "pdf", in English or German — "how do I not lose formatting in the PDF" still asks.
 */
export const refusesPdf = (message: string): boolean =>
  /\b(?:do\s+not|don['’]?t|dont|no\s+need\s+(?:for|to)|without|no|not|never|skip|kein\w*|nicht|ohne)(?:\s+[^\s.!?]+){0,3}?\s+pdfs?\b/i.test(message);

/** "Make a PDF" — and not "put it on a post as a PDF", which attach_artifact_to_post does, nor "no PDF". */
export const asksForPdf = (message: string): boolean => /\bpdf\b/i.test(message) && !refusesPdf(message) && !/\b(post|attach)/i.test(message);

/**
 * Asked for a PDF, the model made the document and stopped — so the PDF is printed here.
 *
 * Production, 2026-09-28, after the prompt said "call generate_pdf" and the result's note said it again:
 * gpt-4.1-mini made the artifact and told the person "It's ready as a PDF". Two instructions were not
 * enough for a small model, so the step no longer depends on one. Through the same registry, so
 * generate_pdf's own authorization and approval still apply; anything but a success falls back to the note.
 */
export const withPrintedPdf = async (
  registry: ToolRegistry,
  context: Parameters<ToolRegistry["execute"]>[0],
  call: ExecuteInput,
  made: Awaited<ReturnType<ToolRegistry["execute"]>>,
  turn: { readonly message: string; readonly settings: { readonly mode?: string } },
): Promise<typeof made | null> => {
  const ok = made as { ok?: unknown; data?: unknown };
  if (ok.ok !== true || ok.data === null || typeof ok.data !== "object") return null;
  const data = ok.data as Record<string, unknown>;
  if (!asksForPdf(turn.message) || turn.settings.mode === "chat_only") return null;
  if (typeof data["artifactId"] !== "string" || (data["kind"] !== "markdown" && data["kind"] !== "html")) return null;
  const pdf = (await registry.execute(context, {
    name: "generate_pdf",
    // `kind` is required by generate_pdf's schema; the first deploy sent only the id and every print was refused.
    input: { kind: data["kind"], artifactId: data["artifactId"] },
    ...(call.idempotencyKey === undefined ? {} : { idempotencyKey: `${call.idempotencyKey}:pdf` }),
    ...(call.toolCallId === undefined ? {} : { toolCallId: `${call.toolCallId}:pdf` }),
  }).catch(() => null)) as { ok?: unknown; data?: unknown } | null;
  if (pdf === null || pdf.ok !== true || pdf.data === null || typeof pdf.data !== "object") return null;
  return {
    ...made,
    data: {
      note: "The person asked for a PDF, and it was printed from this document: `pdf` below is the PDF. Link it with its reference and say it is the PDF; the artifact is the on-screen copy.",
      ...data,
      pdf: pdf.data,
    },
  } as typeof made;
};

/**
 * Asked for a PDF, answered with an artifact — #587. Production, 2026-09-28, twice, after the tool
 * description already said "it is NOT a PDF": the model made a markdown document and told the person it
 * was their PDF. When the message asked for one, the result says so, and what to call.
 */
export const withPdfNote = <T>(result: T, message: string): T => {
  const ok = result as { ok?: unknown; data?: unknown };
  if (ok.ok !== true || ok.data === null || typeof ok.data !== "object" || !/\bpdf\b/i.test(message) || refusesPdf(message)) return result;
  return {
    ...result,
    data: {
      // Production: asked to attach a document to a post "as a PDF", the old note sent the model to generate_pdf.
      note: /\b(post|attach)/i.test(message)
        ? "The person wants this on a post as a PDF: call attach_artifact_to_post with this artifactId, the post's postDraftId and as='pdf' — not generate_pdf."
        : "The person asked for a PDF. This is an on-screen document, not a PDF — call generate_pdf with artifactId set to this artifact's id (nothing else needed), and do not call this one a PDF.",
      ...(ok.data as Record<string, unknown>),
    },
  } as T;
};

