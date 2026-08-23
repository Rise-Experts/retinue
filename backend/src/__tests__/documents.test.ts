/**
 * Document extraction (#131).
 *
 * Three layers, tested separately because they fail differently: the parsers (does structure survive?), the
 * pipeline (are the bounds and the failure records right?), and the read tool (is the window bounded and
 * navigable?).
 *
 * The PDF fixtures are built here rather than checked in as binaries. That is deliberate: a fixture whose
 * bytes nobody can read is a fixture nobody can change, and when the parser breaks on it the test says
 * "extraction failed" and nothing more. Constructed PDFs say exactly which operator sequence is being tested.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { BlobRef, ConversationId, FileId, PrincipalId, RequestId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import {
  createMemoryBlobStore,
  createMemoryFileContentStore,
  createMemoryFileMetadataStore,
} from "../adapters/memory/index.js";
import { createExtractionService } from "../documents/extraction.js";
import { DEFAULT_EXTRACTION_LIMITS } from "../documents/index.js";
import type { DocumentBlock, DocumentParser, ExtractionLimits } from "../documents/index.js";
import {
  createPdfDocumentParser,
  decodeHexString,
  parsePdf,
  unescapePdfString,
} from "../documents/parsers/pdf.js";
import {
  createTextDocumentParser,
  parseDelimited,
  parseJsonDocument,
  parseMarkdown,
} from "../documents/parsers/text.js";
import { renderBlocks, summariseBlocks } from "../documents/render.js";
import { MAX_BLOCKS_PER_READ, createReadDocumentTool } from "../documents/read-tool.js";

const T1 = asId<TenantId>("tenant-1");
const C1 = asId<ConversationId>("convo-1");
const LIMITS: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS;

const ctx = (): ExecutionContext => ({
  tenantId: T1,
  principalId: asId<PrincipalId>("user-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------------------------
// PDF fixtures. Minimal but real: a header, a page tree, and a content stream whose operators are
// the thing under test.
// ---------------------------------------------------------------------------------------------

/**
 * A one-page PDF around a content stream.
 *
 * The xref table is omitted, which is legal-ish and beside the point: this parser scans for streams rather
 * than walking the xref, precisely because the xref is the part that breaks first in real documents.
 */
const pdfWith = (content: string, options: { compress?: boolean; pages?: number; encrypt?: boolean } = {}): Uint8Array => {
  const body = options.compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const filter = options.compress ? " /Filter /FlateDecode" : "";
  const head =
    `%PDF-1.4\n` +
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
    `2 0 obj << /Type /Pages /Count ${options.pages ?? 1} /Kids [3 0 R] >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n` +
    `4 0 obj << /Length ${body.byteLength}${filter} >>\nstream\n`;
  const tail = `\nendstream endobj\n` + (options.encrypt ? `trailer << /Encrypt 9 0 R >>\n` : ``) + `%%EOF\n`;
  return new Uint8Array(Buffer.concat([Buffer.from(head, "latin1"), body, Buffer.from(tail, "latin1")]));
};

/** Text drawn at a position and size — the operator sequence every PDF writer emits. */
const show = (x: number, y: number, size: number, text: string): string =>
  `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${text.replace(/([()\\])/g, "\\$1")}) Tj ET\n`;

describe("Markdown and plain text extraction", () => {
  it("keeps a heading's level rather than flattening it to text", () => {
    const doc = parseMarkdown(utf8("# Title\n\nSome prose.\n\n### Detail\n"), LIMITS);
    expect(doc.blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Some prose." },
      { kind: "heading", level: 3, text: "Detail" },
    ]);
  });

  it("joins a wrapped paragraph back into a sentence", () => {
    // A hard-wrapped source becomes one paragraph. Keeping the line breaks would leave the model reading a
    // sentence a fragment at a time.
    const doc = parseMarkdown(utf8("The quarterly figures\nwere better than\nexpected.\n"), LIMITS);
    expect(doc.blocks).toEqual([{ kind: "paragraph", text: "The quarterly figures were better than expected." }]);
  });

  it("keeps a pipe table's cells", () => {
    // AC-1. The whole reason for a block intermediate: flattened, "1200" stops being Q3's revenue.
    const doc = parseMarkdown(
      utf8("| Quarter | Revenue |\n|---|---|\n| Q3 | 1200 |\n| Q4 | 1500 |\n"),
      LIMITS,
    );
    expect(doc.blocks).toEqual([
      {
        kind: "table",
        hasHeader: true,
        rows: [
          ["Quarter", "Revenue"],
          ["Q3", "1200"],
          ["Q4", "1500"],
        ],
      },
    ]);
  });

  it("does not turn a sentence containing a pipe into a table", () => {
    // A table is recognised by its divider. Without that rule, `a | b` in prose becomes a one-row table and
    // the sentence disappears.
    const doc = parseMarkdown(utf8("Run `ls | wc -l` to count them.\n"), LIMITS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(["paragraph"]);
  });

  it("keeps a bullet list and a numbered list apart", () => {
    // Merging them would renumber the second, which changes what the document said.
    const doc = parseMarkdown(utf8("- one\n- two\n1. first\n2. second\n"), LIMITS);
    expect(doc.blocks).toEqual([
      { kind: "list", items: ["one", "two"], ordered: false },
      { kind: "list", items: ["first", "second"], ordered: true },
    ]);
  });

  it("stops at the block limit and says the document continues", () => {
    // AC-3. A limit that truncated silently would look like a short document.
    const many = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    const doc = parseMarkdown(utf8(many), { ...LIMITS, maxBlocks: 5 });
    expect(doc.blocks).toHaveLength(5);
    expect(doc.truncated).toBe(true);
    expect(doc.warnings.join(" ")).toMatch(/Stopped after 5 blocks/);
  });

  it("stops at the text limit as well as the block limit", () => {
    // Separate ceilings because they bound different attacks: a million empty paragraphs costs no text, and
    // one enormous paragraph costs no blocks.
    const doc = parseMarkdown(utf8("x".repeat(5000)), { ...LIMITS, maxTextBytes: 100 });
    expect(doc.truncated).toBe(true);
    expect(doc.warnings.join(" ")).toMatch(/100 bytes of text/);
  });
});

describe("CSV extraction", () => {
  it("becomes a table with a header", () => {
    const doc = parseDelimited(utf8("Quarter,Revenue\nQ3,1200\nQ4,1500\n"), LIMITS);
    expect(doc.blocks).toEqual([
      {
        kind: "table",
        hasHeader: true,
        rows: [
          ["Quarter", "Revenue"],
          ["Q3", "1200"],
          ["Q4", "1500"],
        ],
      },
    ]);
  });

  it("respects a comma inside a quoted field", () => {
    // The failure this prevents is the worst kind: a naive split shifts every later column, and the result
    // is plausible rather than obviously wrong.
    const doc = parseDelimited(utf8('Name,Note\n"Smith, Jane",ok\n'), LIMITS);
    const table = doc.blocks[0];
    expect(table?.kind === "table" && table.rows[1]).toEqual(["Smith, Jane", "ok"]);
  });

  it("respects a doubled quote as one literal quote", () => {
    const doc = parseDelimited(utf8('Quote\n"she said ""hi"""\n'), LIMITS);
    const table = doc.blocks[0];
    expect(table?.kind === "table" && table.rows[1]).toEqual(['she said "hi"']);
  });

  it("respects a newline inside a quoted field", () => {
    const doc = parseDelimited(utf8('Name,Note\n"multi\nline",ok\n'), LIMITS);
    const table = doc.blocks[0];
    // Two rows, not three: the newline is data.
    expect(table?.kind === "table" && table.rows).toHaveLength(2);
    expect(table?.kind === "table" && table.rows[1]?.[0]).toBe("multi\nline");
  });

  it("does not add a phantom row for a trailing newline", () => {
    const doc = parseDelimited(utf8("a,b\n1,2\n"), LIMITS);
    const table = doc.blocks[0];
    expect(table?.kind === "table" && table.rows).toHaveLength(2);
  });

  it("does not claim a header when the first row has blanks", () => {
    // A header of blanks is a sign the file has none, and claiming one mislabels every column below it.
    const doc = parseDelimited(utf8("a,,c\n1,2,3\n"), LIMITS);
    const table = doc.blocks[0];
    expect(table?.kind === "table" && table.hasHeader).toBe(false);
  });

  it("reads tab-separated files with the same parser", () => {
    const doc = parseDelimited(utf8("a\tb\n1\t2\n"), LIMITS, "\t");
    const table = doc.blocks[0];
    expect(table?.kind === "table" && table.rows[1]).toEqual(["1", "2"]);
  });
});

describe("JSON extraction", () => {
  it("turns an array of flat objects into a table", () => {
    const doc = parseJsonDocument(utf8('[{"q":"Q3","rev":1200},{"q":"Q4","rev":1500}]'), LIMITS);
    expect("blocks" in doc && doc.blocks[0]).toEqual({
      kind: "table",
      hasHeader: true,
      rows: [
        ["q", "rev"],
        ["Q3", "1200"],
        ["Q4", "1500"],
      ],
    });
  });

  it("fills a missing key with a blank rather than shifting the row", () => {
    // The same silent-corruption failure quoted CSV fields avoid: a short row would move every value left.
    const doc = parseJsonDocument(utf8('[{"a":1,"b":2},{"a":3}]'), LIMITS);
    expect("blocks" in doc && doc.blocks[0]?.kind === "table" && doc.blocks[0].rows[2]).toEqual(["3", ""]);
  });

  it("reports invalid JSON as malformed rather than as empty", () => {
    expect(parseJsonDocument(utf8("{not json"), LIMITS)).toEqual({
      reason: "malformed",
      message: "That file is not valid JSON.",
    });
  });
});

describe("PDF extraction", () => {
  it("reads text from an uncompressed content stream", () => {
    const doc = parsePdf(pdfWith(show(72, 700, 12, "Hello from a PDF.")), LIMITS);
    expect("blocks" in doc && renderBlocks(doc.blocks)).toContain("Hello from a PDF.");
  });

  it("reads text from a FlateDecode stream", () => {
    // Every real PDF writer compresses. A parser that only handled the uncompressed case would pass the test
    // above and fail on every actual document.
    const doc = parsePdf(pdfWith(show(72, 700, 12, "Compressed content."), { compress: true }), LIMITS);
    expect("blocks" in doc && renderBlocks(doc.blocks)).toContain("Compressed content.");
  });

  it("infers a heading from a larger font", () => {
    // A PDF has no headings — it has text that happens to be bigger. Inferring from size is the only signal
    // there is, and losing it flattens a report's structure entirely.
    const content = show(72, 720, 24, "Annual Report") + show(72, 690, 12, "The year went well.");
    const doc = parsePdf(pdfWith(content), LIMITS);
    expect("blocks" in doc && doc.blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "Annual Report" });
    expect("blocks" in doc && doc.blocks[1]).toMatchObject({ kind: "paragraph" });
  });

  it("recovers a table from text at repeating column positions", () => {
    // AC-1 for PDFs, and the honest hard case: a PDF contains no tables, only coordinates.
    const rows = [
      ["Quarter", "Revenue", "Growth"],
      ["Q1", "1000", "4%"],
      ["Q2", "1100", "10%"],
      ["Q3", "1200", "9%"],
    ];
    let content = "";
    rows.forEach((row, i) => {
      const y = 700 - i * 20;
      content += show(72, y, 11, row[0] ?? "");
      content += show(200, y, 11, row[1] ?? "");
      content += show(320, y, 11, row[2] ?? "");
    });
    const doc = parsePdf(pdfWith(content), LIMITS);
    const table = "blocks" in doc ? doc.blocks.find((b) => b.kind === "table") : undefined;
    expect(table).toBeDefined();
    expect(table?.kind === "table" && table.rows).toEqual(rows);
    // The header is claimed only on evidence — a first row of non-numeric labels.
    expect(table?.kind === "table" && table.hasHeader).toBe(true);
  });

  it("joins columns on one line with a space rather than running them together", () => {
    // Without the gap heuristic, `Total` and `1,234` in adjacent columns become `Total1,234` — a number
    // welded to a label, which is worse than either alone.
    const content = show(72, 700, 11, "Total") + show(300, 700, 11, "1,234");
    const doc = parsePdf(pdfWith(content), LIMITS);
    expect("blocks" in doc && renderBlocks(doc.blocks)).toMatch(/Total\s+1,234/);
  });

  it("refuses an encrypted PDF rather than returning nothing", () => {
    // AC-4. Extracting from one would mean implementing the security handler, which is a decryption tool.
    const doc = parsePdf(pdfWith(show(72, 700, 12, "secret"), { encrypt: true }), LIMITS);
    expect(doc).toMatchObject({ reason: "encrypted" });
    expect("message" in doc && doc.message).toMatch(/password/);
  });

  it("reports a scan as having no text layer, not as malformed", () => {
    // The distinction that decides what a user does next: OCR, or re-export the file.
    const doc = parsePdf(pdfWith("q 1 0 0 1 0 0 cm /Im1 Do Q\n"), LIMITS);
    expect(doc).toMatchObject({ reason: "no-text-layer" });
    expect("message" in doc && doc.message).toMatch(/optical character recognition/i);
  });

  it("names the page limit when it refuses a long document", () => {
    // AC-3, and the limit is in the message: "too long" sends someone to guess where to split it.
    const doc = parsePdf(pdfWith(show(72, 700, 12, "page one"), { pages: 900 }), { ...LIMITS, maxPages: 500 });
    expect(doc).toMatchObject({ reason: "too-many-pages" });
    expect("message" in doc && doc.message).toMatch(/900 pages and the limit is 500/);
  });

  it("refuses a file that is not a PDF at all", () => {
    expect(parsePdf(utf8("just some text"), LIMITS)).toMatchObject({ reason: "malformed" });
  });

  it("stops decompressing a stream that expands past the limit", () => {
    // The decompression bomb. Checking the *file* size does not catch this: a small file can inflate to
    // gigabytes, which is why the ceiling is on the inflated total.
    const bomb = pdfWith(`${show(72, 700, 12, "hello")}${"0".repeat(2_000_000)}`, { compress: true });
    // Well under the file-size limit, and far over the inflated one.
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    const doc = parsePdf(bomb, { ...LIMITS, maxTextBytes: 1000 });
    // `too-large`, specifically. An earlier version asserted "something was truncated" and passed with the
    // ceiling removed, because the *text* ceiling fired instead — a different bound that does nothing to stop
    // the decompression. Writing the stronger assertion also surfaced a wrong answer: the bomb was reported as
    // `no-text-layer`, which would send someone to run OCR on a file whose problem is its size.
    expect(doc).toMatchObject({ reason: "too-large" });
    expect("message" in doc && doc.message).toMatch(/expands past the extraction limit/);
  });

  it("joins a PDF's wrapped lines into one paragraph, and splits on a real gap", () => {
    // A PDF has no paragraphs — it has lines at coordinates. Treating every line as its own paragraph leaves
    // the model reading a sentence a fragment at a time; ignoring the gap welds two paragraphs together. The
    // baseline gap is the only signal there is, so both directions are pinned.
    const wrapped =
      show(72, 700, 11, "The quarterly figures were") +
      show(72, 686, 11, "better than expected.") +
      show(72, 620, 11, "Next quarter is uncertain.");
    const doc = parsePdf(pdfWith(wrapped), LIMITS);
    const paragraphs = "blocks" in doc ? doc.blocks.filter((b) => b.kind === "paragraph") : [];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toMatchObject({ text: "The quarterly figures were better than expected." });
    expect(paragraphs[1]).toMatchObject({ text: "Next quarter is uncertain." });
  });

  it("unescapes a literal string's escape sequences", () => {
    // Tested directly rather than through a document, because the interesting cases are invisible from
    // outside: whitespace is normalised downstream, so a wrong line-continuation collapses to the same output
    // as the right one. The rules themselves are where the bugs are.
    expect(unescapePdfString("A\\050B\\051")).toBe("A(B)");
    // Three octal digits at most: `\0501` is a character followed by a literal `1`, not a four-digit code.
    expect(unescapePdfString("\\0501")).toBe("(1");
    // A backslash at end of line contributes nothing at all — not a newline, and not a backslash.
    expect(unescapePdfString("wrapped\\\nline")).toBe("wrappedline");
    expect(unescapePdfString("wrapped\\\r\nline")).toBe("wrappedline");
    expect(unescapePdfString("tab\\there")).toBe("tab\there");
    // An escaped backslash is one backslash; an escaped paren is a paren that does not close the string.
    expect(unescapePdfString("a\\\\b")).toBe("a\\b");
  });

  it("decodes a hex string, padding an odd final digit as the spec requires", () => {
    expect(decodeHexString("48656C6C6F")).toBe("Hello");
    // `<4>` is `0x40`, not a parse error: the spec pads the final digit with zero.
    expect(decodeHexString("4")).toBe("@");
    // Whitespace inside a hex string is ignored.
    expect(decodeHexString("48 65 6C")).toBe("Hel");
  });

  it("reads a hex string", () => {
    const content = `BT /F1 12 Tf 1 0 0 1 72 700 Tm <48656C6C6F> Tj ET\n`;
    const doc = parsePdf(pdfWith(content), LIMITS);
    expect("blocks" in doc && renderBlocks(doc.blocks)).toContain("Hello");
  });
});

describe("rendering extracted structure", () => {
  it("renders a table as Markdown, header divider included", () => {
    // Markdown because a cell's column is unambiguous in it, which is the whole point of not flattening.
    const block: DocumentBlock = {
      kind: "table",
      hasHeader: true,
      rows: [
        ["Quarter", "Revenue"],
        ["Q3", "1200"],
      ],
    };
    expect(renderBlocks([block])).toBe("| Quarter | Revenue |\n| --- | --- |\n| Q3 | 1200 |");
  });

  it("escapes a pipe inside a cell", () => {
    // An unescaped `|` ends the cell, so a value containing one would shift every column after it.
    const block: DocumentBlock = { kind: "table", hasHeader: false, rows: [["a|b", "c"]] };
    expect(renderBlocks([block])).toBe("| a\\|b | c |");
  });

  it("summarises a document's shape without its content", () => {
    expect(
      summariseBlocks([
        { kind: "heading", level: 1, text: "T" },
        { kind: "table", hasHeader: true, rows: [["a"]] },
        { kind: "table", hasHeader: true, rows: [["b"]] },
      ]),
    ).toBe("1 heading, 2 tables");
  });
});

// ---------------------------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------------------------

const setup = (options: { parsers?: readonly DocumentParser[]; limits?: ExtractionLimits } = {}) => {
  const metadata = createMemoryFileMetadataStore();
  const content = createMemoryFileContentStore();
  const blobs = createMemoryBlobStore();
  const enqueued: { tenantId: string; fileId: string }[] = [];
  const service = createExtractionService({
    metadata,
    content,
    blobs,
    parsers: options.parsers ?? [createTextDocumentParser(), createPdfDocumentParser()],
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    clock: () => "2026-08-23T10:00:00.000Z",
    dispatcher: {
      async enqueueExtraction(job) {
        enqueued.push({ tenantId: job.tenantId, fileId: job.fileId });
      },
    },
  });
  return { metadata, content, blobs, service, enqueued };
};

const store = async (
  s: ReturnType<typeof setup>,
  file: { id: string; mediaType: string; body: Uint8Array; state?: "stored" | "pending" },
) => {
  await s.content.putFile({
    tenantId: T1,
    contentKey: `key-${file.id}`,
    mediaType: file.mediaType,
    bytes: (async function* () {
      yield file.body;
    })(),
    maxBytes: 100 * 1024 * 1024,
  });
  await s.metadata.create({
    tenantId: T1,
    file: {
      id: asId<FileId>(file.id),
      conversationId: C1,
      filename: `${file.id}.doc`,
      mediaType: file.mediaType,
      byteSize: file.body.byteLength,
      contentKey: `key-${file.id}`,
      state: file.state ?? "stored",
      uploadedBy: asId<PrincipalId>("user-1"),
      createdAt: "2026-08-23T09:00:00.000Z",
    },
  });
  return asId<FileId>(file.id);
};

describe("the extraction pipeline", () => {
  it("extracts a document and stores it by reference", async () => {
    // AC-6: the file carries a ref, not the text. Nothing put the document in a message or in context.
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "text/markdown", body: utf8("# Title\n\nBody.\n") });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record).toMatchObject({ state: "extracted", blockCount: 2, truncated: false });
    expect(record.ref).toBeDefined();
    const stored = await s.blobs.get({ tenantId: T1, ref: record.ref as BlobRef });
    expect((stored as { blocks: DocumentBlock[] }).blocks[0]).toMatchObject({ kind: "heading" });
  });

  it("records a typed failure instead of throwing", async () => {
    // AC-4. A throw would leave the file looking unextracted, which is indistinguishable from "not yet".
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "application/pdf", body: utf8("not a pdf") });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record).toMatchObject({ state: "failed", failureReason: "malformed" });
    // And it is on the file, so a reader sees it.
    expect((await s.metadata.get({ tenantId: T1, id }))?.extraction).toMatchObject({ state: "failed" });
  });

  it("carries the parser's own message through to the record", async () => {
    // The sentence a user reads is written by the parser that knows what went wrong, and it has to survive
    // the whole way out — that is what makes AC-4 useful rather than merely typed.
    const s = setup();
    const id = await store(s, {
      id: "f1",
      mediaType: "application/pdf",
      body: pdfWith("q /Im1 Do Q\n"),
    });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record).toMatchObject({ state: "failed", failureReason: "no-text-layer" });
    expect(record.failureMessage).toMatch(/optical character recognition/i);
  });

  it("skips a type nothing can read, without calling it a failure", async () => {
    // "We are not going to" is a different sentence from "we tried and could not", and only one of them
    // sends someone looking for a fix.
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "image/png", body: utf8("PNG") });
    expect(await s.service.extract({ tenantId: T1, fileId: id })).toMatchObject({ state: "skipped" });
  });

  it("refuses a document past the read limit, naming it", async () => {
    // AC-3, and it refuses rather than truncating: half a PDF is malformed, not shorter.
    const s = setup({ limits: { ...LIMITS, maxBytes: 100 } });
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("x".repeat(5000)) });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record).toMatchObject({ state: "failed", failureReason: "too-large" });
    expect(record.failureMessage).toMatch(/100 byte/);
  });

  it("stops waiting on a parser that never returns", async () => {
    // AC-3's time bound. It does not kill the parser — nothing single-threaded can — but the file gets a
    // record and the queue moves on, which is what stops one document occupying a worker indefinitely.
    const hanging: DocumentParser = {
      id: "hanging",
      mediaTypes: ["text/plain"],
      async parse() {
        return new Promise(() => {});
      },
    };
    const s = setup({ parsers: [hanging], limits: { ...LIMITS, timeoutMs: 20 } });
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("hello") });
    expect(await s.service.extract({ tenantId: T1, fileId: id })).toMatchObject({
      state: "failed",
      failureReason: "timed-out",
    });
  });

  it("records a thrown parser error as a document failure, not as a crash", async () => {
    // A throw is the parser being broken, not the document being unreadable. The user gets a generic
    // sentence; the stack trace is not their problem.
    const broken: DocumentParser = {
      id: "broken",
      mediaTypes: ["text/plain"],
      async parse() {
        throw new Error("index out of range");
      },
    };
    const s = setup({ parsers: [broken] });
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("hello") });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record).toMatchObject({ state: "failed", failureReason: "malformed" });
    // The internal detail does not leak into what the user reads.
    expect(record.failureMessage).not.toMatch(/index out of range/);
  });

  it("marks the file running before it parses, so a crash leaves evidence", async () => {
    // Without this a worker that died mid-parse would leave the file `pending`, the sweep would re-enqueue
    // it, and the one document that reliably kills a worker would poison the queue forever. Observed from
    // inside the parser, which is the only place the intermediate state is visible.
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("hello") });
    const seen: string[] = [];
    const watching: DocumentParser = {
      id: "watching",
      mediaTypes: ["text/plain"],
      async parse() {
        seen.push((await s.metadata.get({ tenantId: T1, id }))?.extraction?.state ?? "none");
        return { blocks: [{ kind: "paragraph", text: "ok" }], truncated: false, warnings: [] };
      },
    };
    const service = createExtractionService({
      metadata: s.metadata,
      content: s.content,
      blobs: s.blobs,
      parsers: [watching],
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await service.extract({ tenantId: T1, fileId: id });
    expect(seen).toEqual(["running"]);
  });

  it("does not extract a file that is not stored", async () => {
    // A file mid-upload has no stable bytes. Not an error and not a failure — the sweep finds it if it settles.
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("hi"), state: "pending" });
    expect(await s.service.extract({ tenantId: T1, fileId: id })).toMatchObject({ state: "skipped" });
  });

  it("reports missing bytes as a failure rather than as an empty document", async () => {
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("hi") });
    await s.content.deleteFile({ tenantId: T1, contentKey: "key-f1" });
    expect(await s.service.extract({ tenantId: T1, fileId: id })).toMatchObject({
      state: "failed",
      failureReason: "malformed",
    });
  });
});

describe("AC-2: extraction is requested, never awaited", () => {
  it("enqueues and returns without parsing", async () => {
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("hello") });
    const result = await s.service.requestExtraction({ tenantId: T1 }, id, "text/plain");
    expect(result).toEqual({ enqueued: true, state: "pending" });
    expect(s.enqueued).toEqual([{ tenantId: T1, fileId: id }]);
    // Nothing was parsed: the state is `pending`, not `extracted`.
    expect((await s.metadata.get({ tenantId: T1, id }))?.extraction).toMatchObject({ state: "pending" });
  });

  it("does not enqueue a type nothing can read", async () => {
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "image/png", body: utf8("PNG") });
    expect(await s.service.requestExtraction({ tenantId: T1 }, id, "image/png")).toEqual({
      enqueued: false,
      state: "skipped",
    });
    expect(s.enqueued).toEqual([]);
  });

  it("survives an unreachable queue and leaves the file for the sweep", async () => {
    // An attachment that uploaded fine must not fail because the extraction queue blinked.
    const metadata = createMemoryFileMetadataStore();
    const service = createExtractionService({
      metadata,
      content: createMemoryFileContentStore(),
      blobs: createMemoryBlobStore(),
      parsers: [createTextDocumentParser()],
      clock: () => "2026-08-23T10:00:00.000Z",
      dispatcher: {
        async enqueueExtraction() {
          throw new Error("redis unreachable");
        },
      },
    });
    await metadata.create({
      tenantId: T1,
      file: {
        id: asId<FileId>("f1"),
        conversationId: C1,
        filename: "a.txt",
        mediaType: "text/plain",
        byteSize: 2,
        contentKey: "key-f1",
        state: "stored",
        uploadedBy: asId<PrincipalId>("user-1"),
        createdAt: "2026-08-23T09:00:00.000Z",
      },
    });
    const result = await service.requestExtraction({ tenantId: T1 }, asId<FileId>("f1"), "text/plain");
    expect(result).toEqual({ enqueued: false, state: "pending" });
    // Left `pending`, which is exactly what the sweep looks for.
    expect((await metadata.get({ tenantId: T1, id: asId<FileId>("f1") }))?.extraction).toMatchObject({
      state: "pending",
    });
  });

  it("re-enqueues a file whose enqueue was lost and one whose worker died", async () => {
    // The two silent shapes. Neither would ever be noticed without this sweep.
    const s = setup();
    const lost = await store(s, { id: "lost", mediaType: "text/plain", body: utf8("a") });
    const dead = await store(s, { id: "dead", mediaType: "text/plain", body: utf8("b") });
    const done = await store(s, { id: "done", mediaType: "text/plain", body: utf8("c") });
    await s.metadata.recordExtraction({
      tenantId: T1,
      id: dead,
      extraction: { state: "running", at: "2026-08-23T09:00:00.000Z" },
    });
    await s.metadata.recordExtraction({
      tenantId: T1,
      id: done,
      extraction: { state: "extracted", ref: asId<BlobRef>("b1"), at: "2026-08-23T09:00:00.000Z" },
    });

    const result = await s.service.sweepStuckExtractions(
      { tenantId: T1 },
      { olderThan: "2026-08-23T12:00:00.000Z", limit: 10 },
    );
    expect(result.requeued).toBe(2);
    expect(s.enqueued.map((j) => j.fileId).sort()).toEqual([dead, lost].sort());
  });

  it("does not sweep an extraction requested a moment ago", async () => {
    // Without the threshold the sweep races itself and re-enqueues everything it just queued.
    const s = setup();
    await store(s, { id: "f1", mediaType: "text/plain", body: utf8("a") });
    const result = await s.service.sweepStuckExtractions(
      { tenantId: T1 },
      { olderThan: "2026-08-23T08:00:00.000Z", limit: 10 },
    );
    expect(result.requeued).toBe(0);
  });
});

describe("AC-6: read_document reads bounded windows", () => {
  const withDocument = async (blocks: readonly DocumentBlock[]) => {
    const s = setup();
    const ref = await s.blobs.put({ tenantId: T1, value: { blocks, truncated: false, warnings: [] } });
    const id = await store(s, { id: "f1", mediaType: "text/markdown", body: utf8("x") });
    await s.metadata.recordExtraction({
      tenantId: T1,
      id,
      extraction: { state: "extracted", ref, blockCount: blocks.length, at: "2026-08-23T10:00:00.000Z" },
    });
    return { ...s, id, tool: createReadDocumentTool({ extraction: s.service }) };
  };

  const paragraphs = (n: number): DocumentBlock[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "paragraph" as const, text: `Paragraph ${i}.` }));

  it("returns a bounded window and the block to continue from", async () => {
    const { tool, id } = await withDocument(paragraphs(120));
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    const data = result.ok ? (result.data as { blocksReturned: number; truncated: boolean; nextBlock?: number }) : null;
    expect(data?.blocksReturned).toBe(MAX_BLOCKS_PER_READ);
    expect(data?.truncated).toBe(true);
    expect(data?.nextBlock).toBe(MAX_BLOCKS_PER_READ);
  });

  it("pages the whole document through the indices it reports", async () => {
    // A bound is only acceptable if it is navigable. A wrong `nextBlock` looks like a short document.
    const { tool, id } = await withDocument(paragraphs(120));
    let from = 0;
    const seen: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await tool.execute({ context: ctx(), input: { fileId: id, fromBlock: from } });
      if (!result.ok) throw new Error("read failed");
      const data = result.data as { text: string; truncated: boolean; nextBlock?: number };
      seen.push(data.text);
      if (!data.truncated) break;
      from = data.nextBlock ?? from;
    }
    expect(seen.join("\n\n").split("Paragraph ")).toHaveLength(121);
  });

  it("clamps a request for more blocks than the ceiling", async () => {
    const { tool, id } = await withDocument(paragraphs(200));
    const result = await tool.execute({ context: ctx(), input: { fileId: id, maxBlocks: 999 } });
    expect(result.ok && (result.data as { blocksReturned: number }).blocksReturned).toBe(MAX_BLOCKS_PER_READ);
  });

  it("never cuts a table in half", async () => {
    // A character bound could land inside a table and hand the model half of one — worse than none, because
    // the missing rows are invisible and the model answers confidently from what it can see.
    const bigTable: DocumentBlock = {
      kind: "table",
      hasHeader: true,
      rows: Array.from({ length: 400 }, (_, i) => [`row${i}`, `${i * 10}`]),
    };
    const { tool, id } = await withDocument([bigTable, { kind: "paragraph", text: "after" }]);
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    const text = result.ok ? (result.data as { text: string }).text : "";
    // The whole table or nothing: every row it started is present.
    expect(text).toContain("row0");
    expect(text).toContain("row399");
  });

  it("returns at least one block even when that block is over the character ceiling", async () => {
    // A window that can return nothing is a window a model cannot page past.
    const huge: DocumentBlock = { kind: "paragraph", text: "x".repeat(50_000) };
    const { tool, id } = await withDocument([huge]);
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    expect(result.ok && (result.data as { blocksReturned: number }).blocksReturned).toBe(1);
  });

  it("preserves a table's structure through the read", async () => {
    // AC-1 end to end: extracted as cells, stored as cells, read back as a Markdown table.
    const s = setup();
    const id = await store(s, {
      id: "f1",
      mediaType: "text/csv",
      body: utf8("Quarter,Revenue\nQ3,1200\nQ4,1500\n"),
    });
    await s.service.extract({ tenantId: T1, fileId: id });
    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    const text = result.ok ? (result.data as { text: string }).text : "";
    expect(text).toContain("| Quarter | Revenue |");
    expect(text).toContain("| Q3 | 1200 |");
  });

  it("answers a question only the document contains", async () => {
    // AC-5's mechanism, tested where it can be tested deterministically: the fact is not in context until the
    // tool is called, and then it is — exactly, and attributable to its row.
    const s = setup();
    const id = await store(s, {
      id: "f1",
      mediaType: "text/csv",
      body: utf8("Region,Q3 Revenue\nEMEA,4210\nAPAC,3155\n"),
    });
    await s.service.extract({ tenantId: T1, fileId: id });
    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    const text = result.ok ? (result.data as { text: string }).text : "";
    // The row survives as a row, so "what was EMEA's Q3 revenue" is answerable rather than guessable.
    expect(text).toMatch(/\|\s*EMEA\s*\|\s*4210\s*\|/);
  });

  it("reports why there is nothing to read rather than returning empty", async () => {
    // AC-4 reaching the user: the parser's sentence is the assistant's sentence.
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "application/pdf", body: pdfWith("q /Im1 Do Q\n") });
    await s.service.extract({ tenantId: T1, fileId: id });
    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/optical character recognition/i);
    // Not retryable: the answer will not change on a second attempt.
    expect(!result.ok && result.error.retryable).toBe(false);
  });

  it("says to try again while extraction is still running", async () => {
    // Distinguished from a failure, because one is worth retrying and the other is not.
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("hi") });
    await s.metadata.recordExtraction({
      tenantId: T1,
      id,
      extraction: { state: "running", at: "2026-08-23T10:00:00.000Z" },
    });
    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    expect(!result.ok && result.error.message).toMatch(/still being processed/);
    expect(!result.ok && result.error.retryable).toBe(true);
  });

  it("surfaces the warnings extraction recorded", async () => {
    // "Three pages had no text layer" changes how much a user should trust an answer, and a log line does
    // not reach them.
    const s = setup();
    const ref = await s.blobs.put({
      tenantId: T1,
      value: {
        blocks: [{ kind: "paragraph", text: "partial" }],
        truncated: true,
        warnings: ["The text may be garbled."],
      },
    });
    const id = await store(s, { id: "f1", mediaType: "text/plain", body: utf8("x") });
    await s.metadata.recordExtraction({
      tenantId: T1,
      id,
      extraction: { state: "extracted", ref, at: "2026-08-23T10:00:00.000Z" },
    });
    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    expect(result.ok && result.data).toMatchObject({
      documentTruncated: true,
      warnings: ["The text may be garbled."],
    });
  });

  it("cannot read another tenant's document", async () => {
    const s = setup();
    const id = await store(s, { id: "f1", mediaType: "text/csv", body: utf8("a,b\n1,2\n") });
    await s.service.extract({ tenantId: T1, fileId: id });
    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({
      context: { ...ctx(), tenantId: asId<TenantId>("tenant-2") },
      input: { fileId: id },
    });
    expect(result.ok).toBe(false);
  });
});
