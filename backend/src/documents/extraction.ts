/**
 * The extraction pipeline (#131).
 *
 * The parsers do the reading; this decides *when*, *within what bounds*, and *what is recorded when it goes
 * wrong* — which is the part that makes extraction safe to run on a shared worker tier.
 *
 * Four properties, each answering an AC:
 *
 * - **It never throws for a document problem** (AC-4). Every outcome is recorded on the file: `extracted` with
 *   a reference, or `failed` with a typed reason and a sentence the user reads. An extractor that threw would
 *   leave the file looking unextracted, which is indistinguishable from "not got round to it yet" — and the
 *   user would see an empty document rather than a reason.
 * - **It is bounded in every dimension a document can grow** (AC-3): bytes read, pages, extracted text,
 *   blocks, and wall clock. The timeout is enforced *here* rather than trusted to the parser, because a
 *   parser stuck in a loop is exactly the case a parser-side check does not catch.
 * - **It is enqueued, not awaited** (AC-2). `requestExtraction` puts a job on the queue and returns; an
 *   enqueue failure marks the file `pending` and is reported, never propagated — an attachment that uploaded
 *   fine must not fail because the extraction queue was briefly unreachable.
 * - **The result is stored by reference and read in windows** (AC-6). The `ExtractedDocument` goes to
 *   `BlobStore` and the file carries the ref. Nothing loads it into context; `read_document` reads a bounded
 *   window, exactly as #130 established for the raw bytes.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { BlobRef, FileId, TenantId } from "../core/ids.js";
import type { BlobStore, FileContentStore, FileExtraction, FileMetadataStore } from "../persistence/index.js";
import { DEFAULT_EXTRACTION_LIMITS, isExtractionFailure } from "./index.js";
import { type DocumentParser, type ExtractedDocument, type ExtractionDispatcher, type ExtractionFailure, type ExtractionJob, type ExtractionLimits } from "./index.js";

export type ExtractionServiceDeps = {
  readonly metadata: FileMetadataStore;
  readonly content: FileContentStore;
  /** Where the extracted document goes. `BlobStore` stores JSON, which is what an `ExtractedDocument` is. */
  readonly blobs: BlobStore;
  readonly parsers: readonly DocumentParser[];
  /**
   * Parsers to try when the primary one reports `no-text-layer` (#132).
   *
   * Keyed by media type like `parsers`, and separate because the dispatch table holds one parser per type:
   * both the text-layer PDF parser and the OCR one claim `application/pdf`. This is where #131's insistence
   * that `no-text-layer` be its own reason becomes load-bearing — the fallback triggers on exactly that
   * answer and on nothing else. An encrypted or malformed document is *not* retried through OCR, because
   * OCR will not decrypt it and the second attempt would cost money to reach the same conclusion.
   */
  readonly fallbackParsers?: readonly DocumentParser[];
  /**
   * Bills a vision or OCR call (#132, AC-4).
   *
   * A callback rather than a `UsageRecorder`, so `documents` does not depend on `usage`. The pipeline knows
   * *when* a priced operation happened; what it costs is the caller's pricing model.
   */
  readonly onPricedOperation?: (input: {
    readonly tenantId: TenantId;
    readonly fileId: FileId;
    readonly usage: PricedExtractionUsage;
  }) => Promise<void>;
  readonly limits?: ExtractionLimits;
  readonly clock?: () => string;
  /**
   * The queue. Optional, and its absence means extraction runs only when something calls `extract` directly.
   *
   * Optional rather than required because a single-process deployment is a real configuration, and requiring a
   * queue there would mean standing up Redis to attach a text file. What is *not* optional is that `upload`
   * never blocks on extraction — that holds either way.
   */
  readonly dispatcher?: ExtractionDispatcher;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

/** The media type without its parameters, lowercased. `text/plain; charset=utf-8` is `text/plain`. */
const normaliseMediaType = (mediaType: string): string =>
  mediaType.split(";")[0]?.trim().toLowerCase() ?? "";

/**
 * Read at most `maxBytes` from the content store.
 *
 * Refuses past the limit rather than truncating, because a half-read document is not a shorter document: a
 * PDF's structure is at the end, and half of one is malformed rather than partial. The distinction matters
 * enough that `too-large` is its own failure reason.
 */
const readBounded = async (
  bytes: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | "too-large"> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of bytes) {
    size += chunk.byteLength;
    // Stops pulling, so a hostile object is not drained into memory before being rejected.
    if (size > maxBytes) return "too-large";
    chunks.push(chunk);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

/**
 * Run a parser under a wall-clock ceiling.
 *
 * The race is here rather than inside the parser because a parser caught in a loop cannot check its own
 * clock. This does not *stop* the runaway work — nothing in a single-threaded runtime can — but it stops the
 * pipeline waiting on it, so the file gets a `timed-out` record and the queue moves on. Said plainly because
 * the alternative reading of this code is that it kills the parser, and it does not.
 */
const withTimeout = async (
  work: Promise<ExtractedDocument | ExtractionFailure>,
  timeoutMs: number,
): Promise<ExtractedDocument | ExtractionFailure> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExtractionFailure>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          reason: "timed-out",
          message: `Extraction took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
        }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    // Without this the timer holds the event loop open for the full duration on every successful extraction,
    // which turns a fast worker into one that exits slowly.
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** What a priced extraction step consumed. Vision calls are the expensive kind, so they are reported. */
export type PricedExtractionUsage = {
  readonly kind: "vision" | "ocr";
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
};

export const createExtractionService = (deps: ExtractionServiceDeps) => {
  const limits = deps.limits ?? DEFAULT_EXTRACTION_LIMITS;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});

  /** Built once. Answers "is this type supported" without reading a byte, which is what makes AC-4's `unsupported-type` a cheap decision. */
  const byMediaType = new Map<string, DocumentParser>();
  for (const parser of deps.parsers)
    for (const mediaType of parser.mediaTypes) byMediaType.set(normaliseMediaType(mediaType), parser);
  const fallbackByMediaType = new Map<string, DocumentParser>();
  for (const parser of deps.fallbackParsers ?? [])
    for (const mediaType of parser.mediaTypes) fallbackByMediaType.set(normaliseMediaType(mediaType), parser);

  const record = async (
    tenantId: TenantId,
    id: FileId,
    extraction: FileExtraction,
  ): Promise<FileExtraction> => {
    const { recorded } = await deps.metadata.recordExtraction({ tenantId, id, extraction });
    // Not recorded means the file went away mid-extraction. Logged rather than thrown: the work is wasted,
    // nothing is inconsistent, and a worker that threw here would retry a file that no longer exists.
    if (!recorded) log("extraction outcome dropped: file no longer exists", { tenantId, id });
    return extraction;
  };

  return {
    limits,

    /** Types this pipeline can read at all. Exposed so an upload path can decide not to enqueue at all. */
    supportedMediaTypes(): readonly string[] {
      return [...byMediaType.keys()];
    },

    /**
     * Ask for extraction, without waiting for it — AC-2.
     *
     * Marks the file `pending` first, then enqueues. That order matters: the reverse would let a worker pick
     * the job up, extract, and record its outcome *before* this function overwrote it with `pending`, losing a
     * completed extraction to a race that only shows up under load.
     */
    async requestExtraction(
      context: { readonly tenantId: TenantId },
      id: FileId,
      mediaType: string,
    ): Promise<{ readonly enqueued: boolean; readonly state: FileExtraction["state"] }> {
      if (!byMediaType.has(normaliseMediaType(mediaType))) {
        // Not a failure: nobody asked for this type to be readable. `skipped` says "we are not going to", which
        // is a different sentence from "we tried and could not".
        await record(context.tenantId, id, {
          state: "skipped",
          failureMessage: `${mediaType} is not a document type this platform extracts text from.`,
          at: clock(),
        });
        return { enqueued: false, state: "skipped" };
      }

      await record(context.tenantId, id, { state: "pending", at: clock() });
      if (deps.dispatcher === undefined) return { enqueued: false, state: "pending" };
      try {
        await deps.dispatcher.enqueueExtraction({ tenantId: context.tenantId, fileId: id });
        return { enqueued: true, state: "pending" };
      } catch (error) {
        // Swallowed on purpose, and this is the one place in the module where that is right: the upload
        // succeeded, the file is safe, and the row stays `pending` for `sweepStuckExtractions` to re-enqueue.
        // Propagating would fail an upload because a queue was briefly unreachable.
        log("extraction enqueue failed; left pending for the sweep", { tenantId: context.tenantId, id, error });
        return { enqueued: false, state: "pending" };
      }
    },

    /**
     * Do the extraction. Called by the worker, and directly by a single-process host.
     *
     * Returns the record it wrote rather than throwing, for every document-shaped problem. The only throw is
     * for a *file* that is not there, which is a caller error rather than a document one.
     */
    async extract(job: ExtractionJob): Promise<FileExtraction> {
      const { tenantId, fileId } = job;
      const file = await deps.metadata.get({ tenantId, id: fileId });
      if (file === null)
        throw new AgentPlatformError({ code: "not_found", message: "no such file", retryable: false });
      if (file.state !== "stored")
        // A file mid-upload or mid-delete has no stable bytes to read. Not an error and not a failure — the
        // sweep will find it again if it settles.
        return record(tenantId, fileId, {
          state: "skipped",
          failureMessage: "The file was not in a readable state when extraction ran.",
          at: clock(),
        });

      const mediaType = normaliseMediaType(file.mediaType);
      const parser = byMediaType.get(mediaType);
      if (parser === undefined)
        return record(tenantId, fileId, {
          state: "skipped",
          failureMessage: `${file.mediaType} is not a document type this platform extracts text from.`,
          at: clock(),
        });

      // `running` before the work, so a crash leaves evidence. Without it a worker that died mid-parse would
      // leave the file `pending` and the sweep would re-enqueue it forever, poisoning the queue with the one
      // document that reliably kills a worker.
      await record(tenantId, fileId, { state: "running", at: clock() });

      const stream = await deps.content.readFile({ tenantId, contentKey: file.contentKey });
      if (stream === null)
        return record(tenantId, fileId, {
          state: "failed",
          failureReason: "malformed",
          failureMessage: "The file's contents are missing from storage.",
          at: clock(),
        });

      const bytes = await readBounded(stream, limits.maxBytes);
      if (bytes === "too-large")
        return record(tenantId, fileId, {
          state: "failed",
          failureReason: "too-large",
          // The limit named, so the user knows what to do rather than guessing.
          failureMessage: `That document is larger than the ${limits.maxBytes} byte extraction limit.`,
          at: clock(),
        });

      let outcome: ExtractedDocument | ExtractionFailure;
      try {
        outcome = await withTimeout(parser.parse({ bytes, mediaType, limits }), limits.timeoutMs);
      } catch (error) {
        // A *thrown* error is the parser being broken, not the document being unreadable. Recorded as
        // `malformed` with a generic sentence, and logged with the detail — a stack trace is not a user's
        // problem, and the two must not be confused in a report.
        log("parser threw", { tenantId, fileId, parser: parser.id, error });
        return record(tenantId, fileId, {
          state: "failed",
          failureReason: "malformed",
          failureMessage: "That document could not be read.",
          at: clock(),
        });
      }

      // #132. A scan is the one failure worth a second, more expensive attempt — and only that one. Retrying
      // an encrypted or malformed document through OCR would spend money to reach the same conclusion.
      if (isExtractionFailure(outcome) && outcome.reason === "no-text-layer") {
        const fallback = fallbackByMediaType.get(mediaType);
        if (fallback !== undefined && fallback.id !== parser.id) {
          try {
            outcome = await withTimeout(fallback.parse({ bytes, mediaType, limits }), limits.timeoutMs);
          } catch (error) {
            log("fallback parser threw", { tenantId, fileId, parser: fallback.id, error });
          }
        }
      }

      if (isExtractionFailure(outcome))
        return record(tenantId, fileId, {
          state: "failed",
          failureReason: outcome.reason,
          failureMessage: outcome.message,
          at: clock(),
        });

      // Stored by reference (AC-6). The blob is written *before* the ref is recorded: the reverse would leave
      // a file pointing at a blob that does not exist, and a dangling ref reads as corruption while an
      // unreferenced blob is merely waste.
      // AC-4. Reported before the blob is written, and *stripped* from what is stored: a priced operation
      // already happened, so a crash between here and the record must still have billed it — and a stored
      // document has no business carrying billing data.
      const { usage, ...document } = outcome;
      for (const entry of usage ?? []) {
        try {
          await deps.onPricedOperation?.({ tenantId, fileId, usage: entry });
        } catch (error) {
          // Logged, not thrown. A ledger write that fails must not discard an extraction that succeeded, and
          // an unbilled call is a smaller problem than a document the user paid for and cannot read.
          log("failed to record extraction usage", { tenantId, fileId, kind: entry.kind, error });
        }
      }

      const ref: BlobRef = await deps.blobs.put({ tenantId, value: document });
      return record(tenantId, fileId, {
        state: "extracted",
        ref,
        pageCount: document.pageCount ?? 0,
        blockCount: document.blocks.length,
        truncated: document.truncated,
        // On the record as well as in the document, so a listing can flag a low-confidence extraction
        // without fetching the blob to find out.
        ...(document.confidence === undefined ? {} : { confidence: document.confidence }),
        at: clock(),
      });
    },

    /** The extracted document, or null when there is none to read. */
    async getExtracted(
      context: ExecutionContext,
      id: FileId,
    ): Promise<{ readonly document: ExtractedDocument | null; readonly extraction?: FileExtraction }> {
      const file = await deps.metadata.get({ tenantId: context.tenantId, id });
      if (file === null || file.extraction === undefined) return { document: null };
      if (file.extraction.state !== "extracted" || file.extraction.ref === undefined)
        // The record comes back even with no document, because *why* there is nothing is the useful part —
        // AC-4's whole point is that the assistant says "that PDF is a scan" rather than nothing.
        return { document: null, extraction: file.extraction };
      const value = await deps.blobs.get({ tenantId: context.tenantId, ref: file.extraction.ref });
      return { document: (value as ExtractedDocument | null) ?? null, extraction: file.extraction };
    },

    /**
     * Re-enqueue extractions that never finished.
     *
     * Two shapes, and both are silent without this: a `pending` file whose enqueue was lost, and a `running`
     * file whose worker died. Both are re-requested rather than repaired — the pipeline is idempotent, so
     * running it again is the repair.
     */
    async sweepStuckExtractions(
      context: { readonly tenantId: TenantId },
      input: { readonly olderThan: string; readonly limit: number },
    ): Promise<{ readonly requeued: number; readonly states: Readonly<Record<string, number>> }> {
      const states: Record<string, number> = {};
      let requeued = 0;
      for (const state of ["pending", "running"] as const) {
        const page = await deps.metadata.listByExtractionState({
          tenantId: context.tenantId,
          state,
          olderThan: input.olderThan,
          limit: input.limit,
        });
        states[state] = page.items.length;
        for (const file of page.items) {
          const result = await this.requestExtraction(context, file.id, file.mediaType);
          if (result.enqueued) requeued += 1;
        }
      }
      return { requeued, states };
    },
  };
};

export type ExtractionService = ReturnType<typeof createExtractionService>;
