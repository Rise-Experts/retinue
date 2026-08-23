/**
 * `read_document` — bounded reads of extracted structure (#131, AC-6).
 *
 * The counterpart to #130's `read_attachment`, and the reason both exist rather than one: `read_attachment`
 * returns raw bytes, which for a PDF is binary noise. This returns the *extracted* document, rendered as
 * Markdown so a table is still a table, in a bounded window.
 *
 * **The window is in blocks, not characters.** A character bound can land inside a table and hand the model
 * half of one, which is worse than no table because the missing rows are invisible — the model answers
 * confidently from the half it can see. A block is the smallest unit that is still true on its own.
 *
 * When there is nothing to read, this reports *why* (AC-4). "That PDF is a scan and needs OCR" is a sentence
 * the assistant can pass on; an empty result is one it would paper over.
 */

import { AgentPlatformError } from "../core/errors.js";
import { asId } from "../core/ids.js";
import type { FileId } from "../core/ids.js";
import { defineTool } from "../tools/define.js";
import type { Tool } from "../tools/index.js";
import type { ExtractionService } from "./extraction.js";
import { renderBlocks, summariseBlocks } from "./render.js";
import { LOW_CONFIDENCE_THRESHOLD } from "../persistence/index.js";

/**
 * Blocks per call, and the character ceiling that overrides it.
 *
 * Both, because either alone is escapable: fifty paragraphs is a reasonable window and fifty *tables* is not,
 * so the block count bounds the common case and the character count bounds the adversarial one.
 */
export const MAX_BLOCKS_PER_READ = 50;
export const MAX_CHARS_PER_READ = 24_000;

export type ReadDocumentOutput = {
  readonly fileId: string;
  readonly text: string;
  readonly fromBlock: number;
  readonly blocksReturned: number;
  readonly totalBlocks: number;
  readonly truncated: boolean;
  readonly nextBlock?: number;
  /** Present when extraction itself truncated the document — a different fact from this window truncating. */
  readonly documentTruncated?: boolean;
  /**
   * OCR/vision confidence, 0–1, and only when the extraction was probabilistic (#132).
   *
   * Present alongside the low-confidence warning rather than instead of it: the warning is the sentence a
   * model should pass on, and the number is what a caller comparing two extractions needs.
   */
  readonly confidence?: number;
  readonly lowConfidence?: boolean;
  readonly warnings?: readonly string[];
};

export const createReadDocumentTool = (deps: { readonly extraction: ExtractionService }): Tool =>
  defineTool<{ readonly fileId: string; readonly fromBlock?: number; readonly maxBlocks?: number }, ReadDocumentOutput>({
    name: "read_document",
    label: "Read document",
    description:
      `Read a bounded portion of an attached document's extracted text, with headings and tables preserved. ` +
      `At most ${MAX_BLOCKS_PER_READ} blocks per call; continue from the block index it returns.`,
    category: "files",
    effect: "read",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      additionalProperties: false,
      properties: {
        fileId: { type: "string", description: "The id from the attachment reference, without the `file:` prefix." },
        fromBlock: { type: "integer", minimum: 0, description: "Block index to start from. Defaults to 0." },
        maxBlocks: {
          type: "integer",
          minimum: 1,
          maximum: MAX_BLOCKS_PER_READ,
          description: `At most ${MAX_BLOCKS_PER_READ}. A larger value is clamped, not refused.`,
        },
      },
    },
    async execute(input, context) {
      const id = asId<FileId>(input.fileId.replace(/^file:/, ""));
      const { document, extraction } = await deps.extraction.getExtracted(context, id);

      if (document === null) {
        // The reason, not an empty result. This is AC-4 reaching the user: the message a parser wrote is the
        // message the assistant repeats, so "that PDF is a scan" survives all the way out.
        const detail =
          extraction === undefined
            ? "That file has not been processed for text yet. Try again shortly."
            : (extraction.failureMessage ??
              (extraction.state === "pending" || extraction.state === "running"
                ? "That document is still being processed. Try again shortly."
                : "No extracted text is available for that document."));
        throw new AgentPlatformError({ code: "not_found", message: detail, retryable: extraction?.state !== "failed" });
      }

      const from = Math.max(0, Math.floor(input.fromBlock ?? 0));
      // Clamped rather than refused: a model asking for more gets less, which it can act on, instead of an
      // error it would answer with a retry.
      const wanted = Math.min(Math.max(1, Math.floor(input.maxBlocks ?? MAX_BLOCKS_PER_READ)), MAX_BLOCKS_PER_READ);

      const taken: typeof document.blocks[number][] = [];
      let chars = 0;
      for (const block of document.blocks.slice(from, from + wanted)) {
        const rendered = renderBlocks([block]);
        // The character ceiling stops *before* adding an oversized block rather than after, but always takes
        // at least one: a single table larger than the ceiling would otherwise return nothing at all, and a
        // window that can return nothing is a window a model cannot page past.
        if (chars + rendered.length > MAX_CHARS_PER_READ && taken.length > 0) break;
        taken.push(block);
        chars += rendered.length;
      }

      const end = from + taken.length;
      const truncated = end < document.blocks.length;
      return {
        fileId: id,
        text: renderBlocks(taken),
        fromBlock: from,
        blocksReturned: taken.length,
        totalBlocks: document.blocks.length,
        truncated,
        ...(truncated ? { nextBlock: end } : {}),
        // Only when true. A `false` on every response is a field a model has to read and discard.
        ...(document.truncated ? { documentTruncated: true } : {}),
        // AC-5 reaching the model. The flag is derived here as well as warned about in the document, so a
        // consumer that only reads structured fields still cannot mistake uncertain text for certain.
        ...(document.confidence === undefined
          ? {}
          : {
              confidence: document.confidence,
              ...(document.confidence < LOW_CONFIDENCE_THRESHOLD ? { lowConfidence: true } : {}),
            }),
        ...(document.warnings.length > 0 ? { warnings: document.warnings } : {}),
      };
    },
  });

/** A one-line description of a document's shape, for a context section that must stay cheap. */
export const describeExtraction = (blockCount: number, pageCount: number | undefined): string =>
  pageCount !== undefined && pageCount > 0
    ? `${pageCount} page${pageCount === 1 ? "" : "s"}, ${blockCount} block${blockCount === 1 ? "" : "s"}`
    : `${blockCount} block${blockCount === 1 ? "" : "s"}`;

export { summariseBlocks };
