/**
 * OCR and vision, feeding the same derived-artifact path (#132).
 *
 * The point of this file is that a screenshot, a scanned PDF and a Markdown file all end up as the same
 * `ExtractedDocument`. Downstream — `read_document`, the context section, the blob — sees one representation
 * regardless of where the text came from, which is what stops "can the model read this?" depending on the
 * format the user happened to attach.
 *
 * Two ports, because the two jobs are genuinely different and conflating them would force one adapter to do
 * both badly:
 *
 * - **`OcrProvider`** transcribes. Given a scan it returns the words that are on the page, with a confidence.
 *   It does not interpret.
 * - **`VisionProvider`** describes. Given a screenshot or a chart it says what is shown, which is the only
 *   useful answer for an image with no text in it.
 *
 * **There is no built-in OCR adapter, and there cannot honestly be one.** OCR needs a trained engine —
 * Tesseract, or a hosted service. The PDF parser in #131 could be written over the raw syntax with `zlib`
 * because a PDF *contains* its text; a scan does not contain text at all. So `OcrProvider` is a port with a
 * documented contract and no implementation in this package, and a deployment that needs OCR supplies one.
 * The alternative — a stub that returns empty text — would make every scan look like a successful extraction
 * of nothing, which is precisely the failure `no-text-layer` exists to prevent.
 *
 * The vision side *is* implemented, over the model registry, because a vision-capable model is already a
 * dependency this platform has.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { RunId } from "../core/ids.js";
import type { ModelRegistry } from "../models/index.js";
import type { ProviderFactory } from "../models/provider-factory.js";
import { DEFAULT_VISION_PROMPT, describeImage } from "../models/vision.js";
import type { UsageRecorder } from "../usage/index.js";
import { LOW_CONFIDENCE_THRESHOLD as THRESHOLD } from "../persistence/index.js";
import type {
  DocumentBlock,
  DocumentParser,
  ExtractedDocument,
  ExtractionFailure,
  ExtractionLimits,
} from "./index.js";

/**
 * Below this, extraction is flagged rather than presented as certain — AC-5.
 *
 * Re-exported from `persistence`, not defined here. Two layers interpret the field and neither may import the
 * other, so the port that declares `confidence` owns the number that gives it meaning.
 */
export { LOW_CONFIDENCE_THRESHOLD } from "../persistence/index.js";

export const LOW_CONFIDENCE_WARNING =
  "The text was recognised with low confidence and may contain errors. Treat figures and names as uncertain.";

/** The image types this platform will send to a vision model or an OCR engine. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type OcrResult = {
  readonly blocks: readonly DocumentBlock[];
  /**
   * 0–1, the engine's own confidence.
   *
   * Required, not optional. An engine that cannot report one should say `0` and let the low-confidence flag
   * fire, because "no confidence reported" and "high confidence" must never be the same value — the default
   * would be the optimistic one and nobody would notice.
   */
  readonly confidence: number;
  readonly pageCount?: number;
  readonly warnings?: readonly string[];
};

/**
 * Transcribes an image or a scanned document.
 *
 * Takes the **original bytes and media type**, not page images: rasterising a PDF needs a renderer, and every
 * real OCR service (Textract, Document AI, Azure Document Intelligence) accepts a PDF directly and does that
 * itself. Making rasterisation the provider's business is both simpler and what the APIs already assume.
 */
export interface OcrProvider {
  readonly id: string;
  readonly mediaTypes: readonly string[];
  recognise(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly limits: ExtractionLimits;
  }): Promise<OcrResult | ExtractionFailure>;
}

export type VisionResult = {
  readonly description: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
};

/** Describes an image. Separate from OCR: transcribing and interpreting are different jobs. */
export interface VisionProvider {
  readonly id: string;
  readonly mediaTypes: readonly string[];
  describe(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly prompt?: string;
  }): Promise<VisionResult>;
}

/**
 * A `VisionProvider` over the model registry.
 *
 * `requiredModalities: ["image"]` is AC-3, and it is enforced by `resolve` throwing rather than by a check
 * here — see `models/vision.ts`. The refusal surfaces as `capability_unavailable`, which the pipeline records
 * as a typed failure, so a deployment with no vision model gets "this platform cannot describe images"
 * instead of a description of an image nobody looked at.
 */
export const createModelVisionProvider = (deps: {
  readonly registry: ModelRegistry;
  readonly providers: ProviderFactory;
  /** `smart` by default: a description is read by a person and a cheap model's is not worth the tokens. */
  readonly role?: "fast" | "smart";
  readonly maxOutputTokens?: number;
}): VisionProvider => ({
  id: "model-vision",
  mediaTypes: IMAGE_MEDIA_TYPES,
  async describe({ bytes, mediaType, prompt }) {
    // Throws `capability_unavailable` when nothing satisfies it. Deliberately not caught: a fabricated
    // description is the one outcome worse than no description, and swallowing this is how you get one.
    const definition = deps.registry.resolve({
      role: deps.role ?? "smart",
      requiredModalities: ["image"],
    });
    const model = deps.providers.languageModel(definition);
    const result = await describeImage({
      model,
      bytes,
      mediaType,
      ...(prompt === undefined ? {} : { prompt }),
      ...(deps.maxOutputTokens === undefined ? {} : { maxOutputTokens: deps.maxOutputTokens }),
    });
    return {
      description: result.text,
      modelId: definition.modelId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
    };
  },
});

/**
 * A synthetic run id for a background extraction.
 *
 * `UsageEvent.runId` is required, and an extraction is **not a run** — it has no conversation turn and no
 * agent. Rather than widen the usage ledger with a second identity dimension, the extraction borrows the
 * field with a namespaced value. Two consequences worth knowing:
 *
 * - The ledger stays single, which is what AC-4 asks for: one place to answer "what did this tenant spend".
 * - `usageDedupeKey` is `(runId, stepId)`, so a retried extraction of the same file records **once**. That is
 *   not incidental — vision calls are the expensive kind, and a re-enqueued job double-charging a tenant is
 *   the failure this shape prevents.
 *
 * The wart is that `runId` no longer always names a run. Flagged rather than hidden; a separate cost dimension
 * would be the cleaner answer if the ledger ever needs to distinguish them.
 */
export const extractionRunId = (fileId: string): RunId => `extraction:${fileId}` as RunId;

/**
 * The image parser: OCR when there is text to transcribe, vision to describe, or both.
 *
 * Both is the useful default for a screenshot. A screenshot of a dashboard has text *and* a chart, and either
 * alone loses half of it — the numbers without the layout, or the layout without the numbers.
 */
export const createImageDocumentParser = (deps: {
  readonly vision?: VisionProvider;
  readonly ocr?: OcrProvider;
  /**
   * Observed for tests and hosts that want the raw result.
   *
   * **Not the billing path.** Billing goes through the returned document's `usage`, because only the pipeline
   * knows which file a parse belonged to — a callback held by the parser is shared across every file it ever
   * parses, so correlating one would mean trusting that parses never interleave.
   */
  readonly onVisionUsage?: (usage: VisionResult) => void;
}): DocumentParser => ({
  id: "image",
  mediaTypes: IMAGE_MEDIA_TYPES,
  async parse({ bytes, mediaType, limits }) {
    if (bytes.byteLength > limits.maxBytes)
      return {
        reason: "too-large",
        // AC-6, with the limit named rather than implied.
        message: `That image is larger than the ${limits.maxBytes} byte limit.`,
      };

    const blocks: DocumentBlock[] = [];
    const warnings: string[] = [];
    const usage: {
      kind: "vision" | "ocr";
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
    }[] = [];
    let confidence: number | undefined;

    if (deps.ocr !== undefined && deps.ocr.mediaTypes.includes(mediaType)) {
      const result = await deps.ocr.recognise({ bytes, mediaType, limits });
      if ("reason" in result) {
        // An OCR failure is not fatal when vision can still describe the image: a photograph with no text
        // is exactly that case, and refusing the whole extraction would lose the description too.
        warnings.push(`Text recognition failed: ${result.message}`);
      } else {
        blocks.push(...result.blocks);
        confidence = result.confidence;
        warnings.push(...(result.warnings ?? []));
        // AC-5. The flag is derived from the number rather than left to a reader to compare, so every
        // consumer treats the same document as uncertain.
        if (result.confidence < THRESHOLD) warnings.push(LOW_CONFIDENCE_WARNING);
      }
    }

    if (deps.vision !== undefined && deps.vision.mediaTypes.includes(mediaType)) {
      const result = await deps.vision.describe({ bytes, mediaType });
      deps.onVisionUsage?.(result);
      // Reported whether or not the description came back usable: the tokens were spent either way, and a
      // call that produced nothing is exactly the one a bill should show.
      usage.push({
        kind: "vision",
        modelId: result.modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedInputTokens: result.cachedInputTokens,
      });
      if (result.description.trim() !== "")
        // Labelled, because a description is the model's reading of an image and a transcription is what the
        // image says. Presenting them identically would let a later answer cite an inference as a quote.
        blocks.push({ kind: "heading", level: 2, text: "Image description" });
      blocks.push({ kind: "paragraph", text: result.description.trim() });
    }

    if (blocks.length === 0)
      return {
        reason: "no-text-layer",
        message:
          deps.ocr === undefined && deps.vision === undefined
            ? "This platform is not configured to read images."
            : "Nothing could be read from that image.",
      };

    return {
      blocks,
      truncated: false,
      warnings,
      ...(confidence === undefined ? {} : { confidence }),
      ...(usage.length === 0 ? {} : { usage }),
    } satisfies ExtractedDocument;
  },
});

/**
 * OCR for a document the text parser could not read — a scanned PDF.
 *
 * A *fallback* parser rather than a second entry in the dispatch table, because both parsers claim
 * `application/pdf` and the dispatch table holds one per media type. The pipeline tries the text parser
 * first and falls back only on `no-text-layer`, which is the reason #131 made that a distinct reason rather
 * than folding it into `malformed`: the distinction is now load-bearing.
 */
export const createScannedPdfParser = (deps: { readonly ocr: OcrProvider }): DocumentParser => ({
  id: "scanned-pdf",
  mediaTypes: ["application/pdf"],
  async parse({ bytes, mediaType, limits }) {
    if (bytes.byteLength > limits.maxBytes)
      return { reason: "too-large", message: `That document is larger than the ${limits.maxBytes} byte limit.` };
    const result = await deps.ocr.recognise({ bytes, mediaType, limits });
    if ("reason" in result) return result;
    const warnings = [...(result.warnings ?? [])];
    if (result.confidence < THRESHOLD) warnings.push(LOW_CONFIDENCE_WARNING);
    if (result.blocks.length === 0)
      return {
        reason: "no-text-layer",
        message: "Text recognition found no readable text in that document.",
      };
    return {
      blocks: result.blocks,
      ...(result.pageCount === undefined ? {} : { pageCount: result.pageCount }),
      truncated: false,
      warnings,
      confidence: result.confidence,
    } satisfies ExtractedDocument;
  },
});

/** Records a vision call against the usage ledger. Separate so the parser stays free of billing. */
export const recordVisionUsage = async (
  recorder: UsageRecorder,
  context: ExecutionContext,
  input: { readonly fileId: string; readonly usage: VisionResult; readonly costMinorUnits: number; readonly currency: string },
): Promise<void> => {
  await recorder.record(context, {
    runId: extractionRunId(input.fileId),
    // The step, so `usageDedupeKey` makes a retried extraction record once rather than charging twice for
    // the same image.
    stepId: "vision",
    modelId: input.usage.modelId,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cachedInputTokens: input.usage.cachedInputTokens,
    costMinorUnits: input.costMinorUnits,
    currency: input.currency,
  });
};

/** Guard for a media type this platform treats as an image. */
export const isImageMediaType = (mediaType: string): boolean =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType.split(";")[0]?.trim().toLowerCase() ?? "");

export { DEFAULT_VISION_PROMPT, AgentPlatformError };
