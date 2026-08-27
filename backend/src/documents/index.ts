/**
 * Document extraction — `docs/05-knowledge-and-documents.md`, REQ-027 (#131).
 *
 * Extraction turns an opaque attachment into something the model can reason about. The shape it produces is
 * the design decision here, and it is deliberately **not a flat string**.
 *
 * A flat string is what every quick extractor produces and it destroys exactly the information a question is
 * usually about. "What was Q3 revenue?" is answerable from a table and unanswerable from that table flattened
 * into prose — the row and column that gave a number its meaning are gone, and the model has no way to know
 * they were ever there. So the intermediate is a block list: headings keep their level, tables keep their
 * cells, lists keep their items.
 *
 * The second decision is that **failure is a value, not an exception**. A document that cannot be read is an
 * ordinary outcome — a scan with no text layer, an encrypted file, something past a limit — and the
 * assistant has to be able to say which. An extractor that threw would leave the caller with a stack trace
 * and the user with a file that silently behaves as if it were empty, which is the failure mode AC-4 names.
 */

import type { BlobRef, FileId, TenantId } from "../core/ids.js";

/** Heading depth, as in HTML. Beyond six the source is not using headings for structure. */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * One piece of a document.
 *
 * A closed union rather than a bag with optional fields: a `table` with no `rows` and a `heading` with no
 * `level` are both unrepresentable, so a renderer never has to decide what to do about one.
 */
export type DocumentBlock =
  | { readonly kind: "heading"; readonly level: HeadingLevel; readonly text: string; readonly page?: number }
  | { readonly kind: "paragraph"; readonly text: string; readonly page?: number }
  | {
      readonly kind: "table";
      /** Rows of cells. The first row is the header when `hasHeader` is true. */
      readonly rows: readonly (readonly string[])[];
      readonly hasHeader: boolean;
      readonly page?: number;
    }
  | {
      readonly kind: "list";
      readonly items: readonly string[];
      readonly ordered: boolean;
      readonly page?: number;
    };

/**
 * Why a document could not be read.
 *
 * Each value exists because the user-facing sentence differs. `no-text-layer` is not `malformed`: the first
 * means "this is a scan, OCR would help" and the second means "this file is broken". Collapsing them would
 * send someone to re-export a file that needed a different pipeline.
 */
export const EXTRACTION_FAILURES = [
  "unsupported-type",
  "too-large",
  "too-many-pages",
  "timed-out",
  "encrypted",
  "no-text-layer",
  "malformed",
] as const;

export type ExtractionFailureReason = (typeof EXTRACTION_FAILURES)[number];

export type ExtractionFailure = {
  readonly reason: ExtractionFailureReason;
  /** What the user is told. Names the limit when there is one, because "too large" sends someone to guess. */
  readonly message: string;
};

/** What a parser produces when it succeeds. */
export type ExtractedDocument = {
  readonly blocks: readonly DocumentBlock[];
  /** Pages seen. Absent for formats with no pagination — a CSV does not have pages. */
  readonly pageCount?: number;
  /** True when a limit stopped extraction early. The content is usable; it is just not all of it. */
  readonly truncated: boolean;
  /**
   * Things the caller should know that are not failures.
   *
   * Surfaced rather than logged: "three pages had no text layer" changes how much a user should trust an
   * answer, and a log line does not reach them.
   */
  readonly warnings: readonly string[];
  /**
   * YAML front matter, when the source had a leading `---` block — REQ-050 (#209), task #220.
   *
   * **Scalar keys only, and deliberately not a YAML parser.** A nested mapping, a list of mappings or a flow
   * collection is reported in `warnings` and otherwise dropped, because a half-correct parse of provenance
   * metadata is worse than none: `generated: { by: x, at: y }` silently read as the string `{ by: x, at: y }`
   * would be recorded as if it had been understood.
   *
   * It exists because the alternative was worse. Front matter used to reach the block stream as *content*: a
   * document's `sidebar_position` and `type` became a paragraph, got chunked, embedded, and could be returned as
   * a retrieval hit and cited. #220 found it while reading the Open Knowledge Format — whose concept files carry
   * far more metadata than ours — and it was already happening to this repository's own documentation site.
   */
  readonly frontMatter?: Readonly<Record<string, string>>;
  /**
   * How confident the extraction is, 0–1 (#132).
   *
   * Present only for extraction that *has* a confidence — OCR and vision. A PDF's text layer is not
   * recognised, it is read, so a confidence there would be a number with nothing behind it. Absent therefore
   * means "not a probabilistic extraction", which is a different fact from "confidence unknown".
   */
  readonly confidence?: number;
  /**
   * Priced operations this extraction performed (#132, AC-4).
   *
   * **Transport only.** The pipeline reports each entry to `onPricedOperation` and then strips the field
   * before storing the blob, so a stored document never carries billing data. It lives on the result rather
   * than in a callback because only the pipeline knows which file and tenant a parse belonged to — a callback
   * handed to the parser at construction is shared across every file it ever parses, and correlating one
   * would mean trusting that parses never interleave.
   */
  readonly usage?: readonly {
    readonly kind: "vision" | "ocr";
    readonly modelId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
  }[];
};

/**
 * The bounds a parser runs inside — AC-3.
 *
 * Every one of these exists because a document is attacker-controlled input. A page limit alone is not
 * enough: a single-page PDF can carry a content stream that decompresses to gigabytes, which is why
 * `maxTextBytes` is separate from `maxBytes`, and why `maxBlocks` is separate again — a million empty
 * paragraphs cost little text and a great deal of everything else.
 */
export type ExtractionLimits = {
  /** Bytes read from storage. Past this the document is refused rather than truncated: a half-read PDF is not a shorter PDF. */
  readonly maxBytes: number;
  readonly maxPages: number;
  /** Extracted text kept, across all blocks. Truncates rather than refuses — half a document is still useful. */
  readonly maxTextBytes: number;
  readonly maxBlocks: number;
  /** Wall-clock ceiling. A parser that ignores it is stopped by the pipeline's own race. */
  readonly timeoutMs: number;
};

/**
 * Conservative defaults.
 *
 * `maxPages: 500` is a long report, not a book; `maxTextBytes: 2 MiB` is roughly 500k tokens of source text,
 * far more than any context window, so the ceiling never binds before the read bounds do. `timeoutMs` is
 * short on purpose — a worker occupied for a minute by one document is a worker not serving anyone else, and
 * a document that slow is a document to reject rather than wait for.
 */
export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxPages: 500,
  maxTextBytes: 2 * 1024 * 1024,
  maxBlocks: 20_000,
  timeoutMs: 20_000,
};

/**
 * A parser for one family of media types.
 *
 * `mediaTypes` is data rather than a `canParse(type)` method so the pipeline can build its dispatch table
 * once and answer "is this type supported at all" without running anything — which is what makes
 * `unsupported-type` a decision taken before a byte is read.
 */
export interface DocumentParser {
  readonly id: string;
  readonly mediaTypes: readonly string[];
  /**
   * Parse, or return a typed failure.
   *
   * Returns rather than throws for document problems; a thrown error means the parser itself is broken, and
   * the pipeline records that separately so the two are never confused in a report.
   */
  parse(input: {
    readonly bytes: Uint8Array;
    /**
     * The normalised media type, without parameters.
     *
     * Passed in rather than re-derived: a parser serving five types has to know which one it was handed, and
     * a parser that guessed from the bytes would disagree with the dispatch table that chose it.
     */
    readonly mediaType: string;
    readonly limits: ExtractionLimits;
  }): Promise<ExtractedDocument | ExtractionFailure>;
}

/** Discriminates a parser's two return shapes without a tag on the success side. */
export const isExtractionFailure = (
  value: ExtractedDocument | ExtractionFailure,
): value is ExtractionFailure => "reason" in value;

/**
 * Extraction state on a file.
 *
 * `pending` and `failed` are both terminal-ish states a user can see, and they are separate from the file's
 * own `state`: a file is perfectly `stored` while its extraction is `failed`, and conflating the two would
 * make an unreadable document look like a lost upload.
 */
export const EXTRACTION_STATES = ["pending", "running", "extracted", "failed", "skipped"] as const;
export type ExtractionState = (typeof EXTRACTION_STATES)[number];

/** What the file metadata records about its derived text. */
export type ExtractionRecord = {
  readonly state: ExtractionState;
  /** Where the `ExtractedDocument` lives. `BlobStore` holds JSON, which is exactly what this is. */
  readonly ref?: BlobRef;
  readonly failure?: ExtractionFailure;
  readonly pageCount?: number;
  readonly blockCount?: number;
  readonly truncated?: boolean;
  readonly at?: string;
};

/** A unit of extraction work. Mirrors `RunJob`'s shape so the two queues read the same way. */
export type ExtractionJob = { readonly tenantId: TenantId; readonly fileId: FileId };

/**
 * The queue's producing side.
 *
 * Separate from `JobDispatcher` rather than a method added to it: the run path depends on that interface, and
 * widening it would make every existing implementation — including test doubles — incomplete for a job type
 * they have nothing to do with.
 */
export interface ExtractionDispatcher {
  enqueueExtraction(job: ExtractionJob): Promise<void>;
}

export * from "./parsers/text.js";
export * from "./parsers/pdf.js";
export * from "./extraction.js";
export * from "./render.js";
export * from "./read-tool.js";
export * from "./vision.js";
