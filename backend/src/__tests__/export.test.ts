/**
 * Export rendering (#134).
 *
 * The interesting tests are the two the issue asked for by name and that are easy to fake:
 *
 * - **Fidelity** is verified by round-tripping the rendered PDF through the *independent* PDF parser from
 *   #131. That is much stronger than comparing against a golden blob: a golden file proves the writer still
 *   produces what it produced yesterday, whereas a parser proves the headings and table cells are actually
 *   recoverable from the bytes. "Verify against reference outputs rather than by eye" — and the reference is
 *   a reader that knows nothing about the writer.
 * - **Determinism** is verified byte-for-byte across two independent renders, not by hashing one twice.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { ArtifactId, ConversationId, FileId, PrincipalId, RequestId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import {
  createMemoryArtifactExportStore,
  createMemoryArtifactStore,
  createMemoryBlobStore,
  createMemoryFileContentStore,
  createMemoryFileMetadataStore,
} from "../adapters/memory/index.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import { createArtifactService } from "../artifacts/index.js";
import { parsePdf } from "../documents/parsers/pdf.js";
import { DEFAULT_EXTRACTION_LIMITS, type DocumentBlock } from "../documents/index.js";
import { MAX_SIGNED_URL_SECONDS } from "../files/index.js";
import {
  EXPORT_MEDIA_TYPES,
  createExportService,
  exportFilename,
  toBlocks,
  toCitations,
} from "../export/index.js";
import { renderMarkdown } from "../export/markdown.js";
import { encodeWinAnsi, renderPdf, textWidth, wrapText } from "../export/pdf.js";

const T1 = asId<TenantId>("tenant-1");
const T2 = asId<TenantId>("tenant-2");
const C1 = asId<ConversationId>("convo-1");

const ctx = (tenantId: TenantId = T1): ExecutionContext => ({
  tenantId,
  principalId: asId<PrincipalId>("user-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

const policy = (deny: readonly string[] = []): AuthorizationPolicy => ({
  async can(_context, _action, resource) {
    return { allow: !(resource.id !== undefined && deny.includes(resource.id)) };
  },
  filterTools() {
    throw new Error("unused");
  },
  scope() {
    throw new Error("unused");
  },
});

/** A document with every block kind the renderers must handle. */
const RICH_BLOCKS: readonly DocumentBlock[] = [
  { kind: "heading", level: 1, text: "Quarterly Review" },
  { kind: "paragraph", text: "Revenue rose across every region, driven mostly by renewals." },
  { kind: "heading", level: 2, text: "By region" },
  {
    kind: "table",
    hasHeader: true,
    rows: [
      ["Region", "Revenue", "Growth"],
      ["EMEA", "4210", "9%"],
      ["APAC", "3155", "12%"],
    ],
  },
  { kind: "list", items: ["Renewals up", "Churn flat"], ordered: false },
  { kind: "list", items: ["Hire two AEs", "Revisit pricing"], ordered: true },
];

const CITATIONS = [
  { marker: 1, title: "Q3 board deck", locator: "slide 4" },
  { marker: 2, title: "Billing export", url: "https://example.test/billing" },
];

describe("the PDF writer", () => {
  it("produces a structurally valid PDF an independent parser can read", () => {
    // The reference-output check, done by a reader that knows nothing about this writer.
    const { bytes } = renderPdf({ title: "Quarterly Review", blocks: RICH_BLOCKS });
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("xref");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    const parsed = parsePdf(bytes, DEFAULT_EXTRACTION_LIMITS);
    expect("blocks" in parsed).toBe(true);
  });

  it("keeps headings, paragraphs and table cells recoverable from the bytes", () => {
    // AC-2's testable core. Not "it looks right" — the words are still in the file, in the structure they
    // were written with, according to a parser with no knowledge of the layout code.
    const { bytes } = renderPdf({ title: "Quarterly Review", blocks: RICH_BLOCKS });
    const parsed = parsePdf(bytes, DEFAULT_EXTRACTION_LIMITS);
    if (!("blocks" in parsed)) throw new Error("the rendered PDF could not be parsed");
    const all = parsed.blocks
      .map((b) => (b.kind === "table" ? b.rows.flat().join(" ") : b.kind === "list" ? b.items.join(" ") : b.text))
      .join("\n");

    expect(all).toContain("Quarterly Review");
    expect(all).toContain("By region");
    expect(all).toContain("Revenue rose across every region");
    // The table's cells, each still present.
    for (const cell of ["Region", "EMEA", "4210", "APAC", "3155", "12%"]) expect(all).toContain(cell);
    expect(all).toContain("Renewals up");
    expect(all).toContain("Revisit pricing");
  });

  it("renders a heading larger than body text, so structure survives visually too", () => {
    // The parser infers headings from font size, so this asserts through it: if headings were drawn at body
    // size the reader would see one long paragraph, which is what "formatting intact" rules out.
    const parsed = parsePdf(
      renderPdf({ title: "Report", blocks: [{ kind: "heading", level: 1, text: "Findings" }, { kind: "paragraph", text: "Body text here." }] }).bytes,
      DEFAULT_EXTRACTION_LIMITS,
    );
    if (!("blocks" in parsed)) throw new Error("unparseable");
    expect(parsed.blocks.some((b) => b.kind === "heading")).toBe(true);
  });

  it("carries citations into the file, markers and references alike", () => {
    const parsed = parsePdf(
      renderPdf({ title: "Report", blocks: RICH_BLOCKS, citations: CITATIONS }).bytes,
      DEFAULT_EXTRACTION_LIMITS,
    );
    if (!("blocks" in parsed)) throw new Error("unparseable");
    const all = parsed.blocks.map((b) => ("text" in b ? b.text : "")).join("\n");
    expect(all).toContain("References");
    expect(all).toContain("Q3 board deck");
    expect(all).toContain("https://example.test/billing");
  });

  it("AC-6: two renders of the same input are byte-identical", () => {
    // Two independent calls, not one hashed twice. A `new Date()` anywhere in the writer breaks this, which is
    // exactly the regression it exists to catch.
    const a = renderPdf({ title: "Quarterly Review", blocks: RICH_BLOCKS, citations: CITATIONS });
    const b = renderPdf({ title: "Quarterly Review", blocks: RICH_BLOCKS, citations: CITATIONS });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("stamps a constant creation date by default, not the current time", () => {
    // Found by sabotage: replacing the default with `new Date()` left the byte-identity test passing, because
    // two renders microseconds apart produce the same millisecond-resolution timestamp. Comparing two renders
    // is therefore not enough — the *value* has to be pinned.
    const text = new TextDecoder("latin1").decode(renderPdf({ title: "R", blocks: [] }).bytes);
    expect(text).toContain("/CreationDate (D:20000101000000Z)");
    expect(text).toContain("/ModDate (D:20000101000000Z)");
    // And a caller that wants a real date gets it, giving up reproducibility knowingly.
    const dated = new TextDecoder("latin1").decode(
      renderPdf({ title: "R", blocks: [], createdAt: "2026-08-23T14:15:16.000Z" }).bytes,
    );
    expect(dated).toContain("/CreationDate (D:20260823141516Z)");
  });

  it("differs when the content differs", () => {
    // The other half: byte-identical output is only meaningful if it is sensitive to the input. Without this,
    // a writer that emitted a constant would pass the test above.
    const a = renderPdf({ title: "One", blocks: [{ kind: "paragraph", text: "first" }] });
    const b = renderPdf({ title: "One", blocks: [{ kind: "paragraph", text: "second" }] });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false);
  });

  it("reports characters the export font cannot represent instead of dropping them silently", () => {
    // A report whose title rendered as blanks is a document someone forwards believing it is correct.
    const result = renderPdf({ title: "四半期レポート", blocks: [{ kind: "paragraph", text: "text" }] });
    expect(result.unsupportedCharacters.length).toBeGreaterThan(0);
    // Sorted, so the same input reports the same list in the same order — AC-6 covers the result, not only
    // the bytes.
    expect([...result.unsupportedCharacters].sort()).toEqual(result.unsupportedCharacters);
  });

  it("represents European characters rather than reporting them as unsupported", () => {
    // WinAnsi covers these, and a German report with mangled umlauts is unusable.
    const result = renderPdf({ title: "Quartalsbericht", blocks: [{ kind: "paragraph", text: "Größe: 5 µm — „Umsatz“ stieg." }] });
    expect(result.unsupportedCharacters).toEqual([]);
  });

  it("paginates a long document rather than writing off the bottom of the page", () => {
    const long = Array.from({ length: 200 }, (_, i) => ({ kind: "paragraph" as const, text: `Paragraph ${i} of the long report.` }));
    const result = renderPdf({ title: "Long", blocks: long });
    expect(result.pageCount).toBeGreaterThan(1);
    // And the page tree agrees with the count, or a viewer shows a truncated document.
    expect(new TextDecoder("latin1").decode(result.bytes)).toContain(`/Count ${result.pageCount}`);
  });

  it("escapes the characters that would otherwise terminate a PDF string", () => {
    // An unescaped `)` ends the string and everything after it is parsed as operators — which is a corrupt
    // file produced by ordinary prose.
    const { encoded } = encodeWinAnsi("a (b) c \\ d");
    expect(encoded).toBe("a \\(b\\) c \\\\ d");
  });

  it("wraps on words, and inside a word only when it must", () => {
    const wrapped = wrapText("the quarterly figures were better than expected", 120, 10.5, "regular");
    expect(wrapped.length).toBeGreaterThan(1);
    // Every line fits — the property, rather than a specific split that would pin the font metrics.
    for (const line of wrapped) expect(textWidth(line, 10.5, "regular")).toBeLessThanOrEqual(120);

    // A URL longer than the column is broken rather than allowed to overflow: an overflowing line is silently
    // truncated by the viewer, which loses text without saying so.
    const url = wrapText("https://example.test/a/very/long/path/that/will/not/fit/anywhere", 60, 10.5, "regular");
    expect(url.length).toBeGreaterThan(1);
    for (const line of url) expect(textWidth(line, 10.5, "regular")).toBeLessThanOrEqual(60);
  });

  it("measures proportional text proportionally", () => {
    // A monospace approximation would make these equal, and wrapping would be visibly wrong.
    expect(textWidth("iiii", 10, "regular")).toBeLessThan(textWidth("WWWW", 10, "regular"));
    // Courier is monospace, so there it *should* be equal.
    expect(textWidth("iiii", 10, "mono")).toBe(textWidth("WWWW", 10, "mono"));
  });
});

describe("the Markdown writer", () => {
  it("keeps headings, tables and lists", () => {
    const md = renderMarkdown({ title: "Quarterly Review", blocks: RICH_BLOCKS });
    expect(md).toContain("# Quarterly Review");
    expect(md).toContain("## By region");
    expect(md).toContain("| Region | Revenue | Growth |");
    expect(md).toContain("| --- | --- | --- |");
    expect(md).toContain("| EMEA | 4210 | 9% |");
    expect(md).toContain("- Renewals up");
    expect(md).toContain("1. Hire two AEs");
  });

  it("renders citations as a numbered References section", () => {
    const md = renderMarkdown({ title: "R", blocks: [], citations: CITATIONS });
    expect(md).toContain("## References");
    expect(md).toContain("1. Q3 board deck — slide 4");
    expect(md).toContain("2. Billing export — https://example.test/billing");
  });

  it("orders references by marker, not by the order they were handed over", () => {
    // The numbers in the text have to match the order of the list, and relying on the caller's ordering is
    // relying on something no type enforces.
    const md = renderMarkdown({
      title: "R",
      blocks: [],
      citations: [
        { marker: 2, title: "second" },
        { marker: 1, title: "first" },
      ],
    });
    expect(md.indexOf("1. first")).toBeLessThan(md.indexOf("2. second"));
  });

  it("is byte-identical across two renders", () => {
    expect(renderMarkdown({ title: "R", blocks: RICH_BLOCKS, citations: CITATIONS })).toBe(
      renderMarkdown({ title: "R", blocks: RICH_BLOCKS, citations: CITATIONS }),
    );
  });

  it("ends with exactly one newline", () => {
    // A file without a trailing newline is a file every diff tool complains about.
    const md = renderMarkdown({ title: "R", blocks: [{ kind: "paragraph", text: "x" }] });
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});

describe("content coercion", () => {
  it("parses a markdown artifact with the same parser extraction uses", () => {
    // Two markdown parsers would eventually disagree, and the one that disagreed would be whichever the
    // exporter used.
    expect(toBlocks("# Title\n\nBody.\n")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Body." },
    ]);
  });

  it("accepts a block list and a document wrapper alike", () => {
    expect(toBlocks(RICH_BLOCKS)).toEqual(RICH_BLOCKS);
    expect(toBlocks({ blocks: RICH_BLOCKS })).toEqual(RICH_BLOCKS);
  });

  it("renders a structureless value rather than refusing to export it", () => {
    const blocks = toBlocks({ rows: [{ q: "Q3" }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
  });

  it("numbers citations by position when none is given", () => {
    // A list with no explicit numbering renders consistently rather than as a row of zeroes.
    expect(toCitations({ citations: [{ title: "a" }, { title: "b" }] })).toEqual([
      { marker: 1, title: "a" },
      { marker: 2, title: "b" },
    ]);
  });

  it("treats an absent citation list as no citations rather than an error", () => {
    expect(toCitations({ blocks: [] })).toEqual([]);
    expect(toCitations("just markdown")).toEqual([]);
  });
});

describe("filenames", () => {
  it("strips what a Content-Disposition header must not carry", () => {
    // A filename is a header value, and a header value containing a newline is a response-splitting bug
    // rather than a badly-named file.
    expect(exportFilename("Q3 Review\r\nX-Evil: 1", "pdf")).toBe("Q3-ReviewX-Evil-1.pdf");
    expect(exportFilename("../../etc/passwd", "markdown")).toBe("....etcpasswd.md");
  });

  it("falls back to a name rather than producing a bare extension", () => {
    expect(exportFilename("四半期", "pdf")).toBe("export.pdf");
  });
});

// ---------------------------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------------------------

const setup = (options: { deny?: readonly string[]; enqueue?: () => Promise<void> } = {}) => {
  const artifactStore = createMemoryArtifactStore();
  const blobs = createMemoryBlobStore();
  const exports = createMemoryArtifactExportStore();
  const files = createMemoryFileMetadataStore();
  const content = createMemoryFileContentStore();
  const enqueued: string[] = [];
  let n = 0;
  const artifacts = createArtifactService({
    artifacts: artifactStore,
    blobs,
    authorization: policy(options.deny ?? []),
    clock: () => "2026-08-23T10:00:00.000Z",
    artifactId: () => "art-1",
    versionId: () => `ver-${++n}`,
  });
  const service = createExportService({
    artifacts,
    exports,
    files,
    content,
    clock: () => "2026-08-23T10:00:00.000Z",
    exportId: () => `exp-${++n}`,
    fileId: () => `file-${n}`,
    contentKey: () => `key-${n}`,
    dispatcher: {
      async enqueueExport(job) {
        if (options.enqueue) await options.enqueue();
        enqueued.push(job.exportId);
      },
    },
  });
  return { artifacts, artifactStore, exports, files, content, service, enqueued };
};

const seed = (s: ReturnType<typeof setup>, value: unknown = { blocks: RICH_BLOCKS, citations: CITATIONS }) =>
  s.artifacts.create(ctx(), {
    conversationId: C1,
    name: "Quarterly Review",
    content: { kind: "markdown", value },
    provenance: { producedBy: "create_artifact", inputs: {} },
  });

describe("AC-3: rendering is asynchronous", () => {
  it("claims and enqueues without rendering", async () => {
    const s = setup();
    const artifact = await seed(s);
    const result = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    expect(result.enqueued).toBe(true);
    expect(result.export).toMatchObject({ state: "pending", version: 1, format: "pdf" });
    // Nothing rendered: no file exists yet.
    expect((await s.content.listObjects({ tenantId: T1, limit: 10 })).items).toEqual([]);
  });

  it("returns the existing export instead of rendering it twice", async () => {
    // The property the issue wanted from "an artifact version rather than a transient stream".
    const s = setup();
    const artifact = await seed(s);
    const first = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    const second = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    expect(second.export.id).toBe(first.export.id);
    expect(second.enqueued).toBe(false);
    expect(s.enqueued).toEqual([first.export.id]);
  });

  it("treats two formats as two exports", async () => {
    const s = setup();
    const artifact = await seed(s);
    const pdf = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    const md = await s.service.requestExport(ctx(), { id: artifact.id, format: "markdown" });
    expect(md.export.id).not.toBe(pdf.export.id);
  });

  it("treats two versions as two exports", async () => {
    // An export is of a *version*. Sharing one across versions would hand someone last week's PDF.
    const s = setup();
    const artifact = await seed(s);
    await s.artifacts.regenerate(ctx(), {
      id: artifact.id,
      content: { kind: "markdown", value: { blocks: [{ kind: "paragraph", text: "revised" }] } },
      provenance: { producedBy: "t", inputs: {} },
    });
    const v1 = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf", version: 1 });
    const v2 = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    expect(v1.export.version).toBe(1);
    expect(v2.export.version).toBe(2);
    expect(v1.export.id).not.toBe(v2.export.id);
  });

  it("leaves the export pending when the queue is unreachable", async () => {
    // The claim succeeded and the artifact is untouched; an unreachable queue must not turn a request into a
    // failure the user has to understand.
    const s = setup({
      enqueue: async () => {
        throw new Error("redis unreachable");
      },
    });
    const artifact = await seed(s);
    const result = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    expect(result).toMatchObject({ enqueued: false, export: { state: "pending" } });
  });
});

describe("AC-1: rendering and downloading", () => {
  it("renders a PDF into the file ports and marks the export rendered", async () => {
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    const rendered = await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());

    expect(rendered).toMatchObject({ state: "rendered", format: "pdf" });
    expect(rendered.byteSize).toBeGreaterThan(500);
    expect(rendered.checksum).toMatch(/^[0-9a-f]{64}$/);

    const file = await s.files.get({ tenantId: T1, id: rendered.fileId as FileId });
    expect(file).toMatchObject({ state: "stored", mediaType: EXPORT_MEDIA_TYPES.pdf, conversationId: C1 });
    expect(file?.filename).toBe("Quarterly-Review.pdf");
  });

  it("streams the rendered bytes back through the mediated path", async () => {
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "markdown" });
    await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());

    let text = "";
    for await (const chunk of await s.service.download(ctx(), requested.export.id))
      text += new TextDecoder().decode(chunk);
    expect(text).toContain("# Quarterly Review");
    expect(text).toContain("| EMEA | 4210 | 9% |");
  });

  it("marks the export's file as not needing extraction", async () => {
    // A rendered export *is* extraction output. Without this the extraction sweep would pick up every export
    // forever and try to read a PDF it just wrote.
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    const rendered = await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    expect((await s.files.get({ tenantId: T1, id: rendered.fileId as FileId }))?.extraction).toMatchObject({
      state: "skipped",
    });
  });

  it("is a no-op when asked to render an export that is already rendered", async () => {
    // A re-delivered queue message must not render again and orphan the first file.
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    const first = await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    const again = await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    expect(again.fileId).toBe(first.fileId);
    expect((await s.content.listObjects({ tenantId: T1, limit: 10 })).items).toHaveLength(1);
  });

  it("AC-6: re-rendering produces the identical checksum", async () => {
    // Through the whole pipeline, not only the writer: the service is what stamps the date, and a real
    // timestamp there would break reproducibility while the writer's own test still passed.
    const a = setup();
    const artifactA = await seed(a);
    const reqA = await a.service.requestExport(ctx(), { id: artifactA.id, format: "pdf" });
    const renderedA = await a.service.render({ tenantId: T1, exportId: reqA.export.id }, ctx());

    const b = setup();
    const artifactB = await seed(b);
    const reqB = await b.service.requestExport(ctx(), { id: artifactB.id, format: "pdf" });
    const renderedB = await b.service.render({ tenantId: T1, exportId: reqB.export.id }, ctx());

    expect(renderedB.checksum).toBe(renderedA.checksum);
    expect(renderedB.byteSize).toBe(renderedA.byteSize);
  });
});

describe("AC-4: a failed render creates nothing partial", () => {
  it("records the reason and no file when the source cannot be read", async () => {
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    // The artifact goes away between the request and the render.
    await s.artifacts.softDelete(ctx(), artifact.id);
    const result = await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());

    expect(result).toMatchObject({ state: "failed", failureReason: "source-unavailable" });
    expect(result.fileId).toBeUndefined();
    // No bytes, and no file row promising a download.
    expect((await s.content.listObjects({ tenantId: T1, limit: 10 })).items).toEqual([]);
  });

  it("records a reason rather than throwing when the renderer breaks", async () => {
    // A thrown renderer is the renderer being broken, not the artifact being unrenderable. The user gets a
    // sentence; the stack trace stays in the log.
    const s = setup();
    const artifact = await seed(s, {
      // A value that makes the writer throw: a block claiming to be a table with no rows array.
      blocks: [{ kind: "table", hasHeader: true }],
    });
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    const result = await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    expect(result).toMatchObject({ state: "failed", failureReason: "render-failed" });
    expect(result.failureMessage).not.toMatch(/undefined|TypeError/);
  });

  it("refuses an export past the size ceiling, naming it", async () => {
    // A ceiling exists because an artifact is bounded but its *rendering* is not obviously so: a table of ten
    // thousand rows is a small JSON value and a very large PDF.
    const s = setup();
    const artifact = await seed(s);
    const tiny = createExportService({
      artifacts: s.artifacts,
      exports: s.exports,
      files: s.files,
      content: s.content,
      clock: () => "2026-08-23T10:00:00.000Z",
      exportId: () => "exp-tiny",
      fileId: () => "file-tiny",
      contentKey: () => "key-tiny",
      maxExportBytes: 200,
    });
    const requested = await tiny.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    const result = await tiny.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    expect(result).toMatchObject({ state: "failed", failureReason: "too-large" });
    expect(result.failureMessage).toMatch(/limit is 200 bytes/);
    // And no file was left behind promising a download.
    expect(result.fileId).toBeUndefined();
  });

  it("removes the bytes and fails when the conversation is deleted mid-render", async () => {
    // The realistic interleaving: the file row is created, the bytes are written, and the transition to
    // `stored` loses because a conversation delete scheduled the row for removal. The bytes are now referenced
    // by nothing, so they go immediately rather than waiting for a sweep — and the export reports a reason
    // rather than pointing at a dead file.
    const s = setup();
    const artifact = await seed(s);
    const racing = createExportService({
      artifacts: s.artifacts,
      exports: s.exports,
      files: {
        ...s.files,
        // Exactly what `transition` returns when a conversation delete moved the row first.
        async transition() {
          return { moved: false };
        },
      },
      content: s.content,
      clock: () => "2026-08-23T10:00:00.000Z",
      exportId: () => "exp-race",
      fileId: () => "file-race",
      contentKey: () => "key-race",
    });
    const requested = await racing.requestExport(ctx(), { id: artifact.id, format: "markdown" });
    const result = await racing.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    expect(result).toMatchObject({ state: "failed", failureReason: "source-unavailable" });
    expect(result.failureMessage).toMatch(/deleted while the export was rendering/);
    // No orphaned object.
    expect((await s.content.listObjects({ tenantId: T1, limit: 10 })).items).toEqual([]);
  });

  it("refuses to download a failed export, with the reason", async () => {
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    await s.artifacts.softDelete(ctx(), artifact.id);
    await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    // The artifact is gone, so the download is refused for that reason first — either way it is not a
    // silently empty file.
    await expect(s.service.download(ctx(), requested.export.id)).rejects.toThrow();
  });

  it("refuses to download an export that is still rendering", async () => {
    // Distinguished from a failure, because one is worth retrying and the other is not.
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    await expect(s.service.downloadUrl(ctx(), requested.export.id)).rejects.toThrow(/still rendering/);
  });
});

describe("AC-5: downloads are authorised and time-limited", () => {
  it("clamps the signed URL to the platform ceiling", async () => {
    // Delegated to the file ports, which already clamp to fifteen minutes. Asserted on the argument, because
    // the reference content store returns null by design.
    const seen: number[] = [];
    const s = setup();
    const artifact = await seed(s);
    const spying = createExportService({
      artifacts: s.artifacts,
      exports: s.exports,
      files: s.files,
      content: {
        ...s.content,
        async signedUrl(input) {
          seen.push(input.expiresInSeconds);
          return `https://example.test/${input.contentKey}`;
        },
      },
      clock: () => "2026-08-23T10:00:00.000Z",
      exportId: () => "exp-x",
      fileId: () => "file-x",
      contentKey: () => "key-x",
    });
    const requested = await spying.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    await spying.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    await spying.downloadUrl(ctx(), requested.export.id);
    expect(seen).toEqual([MAX_SIGNED_URL_SECONDS]);
  });

  it("refuses a download for a caller not entitled to the conversation", async () => {
    // Re-checked on every download rather than trusted from the request that created the export: a user
    // removed from a conversation must stop being able to download what they exported while they were in it.
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());

    const restricted = createExportService({
      artifacts: createArtifactService({
        artifacts: s.artifactStore,
        blobs: createMemoryBlobStore(),
        authorization: policy([C1]),
        clock: () => "2026-08-23T10:00:00.000Z",
      }),
      exports: s.exports,
      files: s.files,
      content: s.content,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await expect(restricted.download(ctx(), requested.export.id)).rejects.toThrow(/no such artifact/);
    await expect(restricted.downloadUrl(ctx(), requested.export.id)).rejects.toThrow(/no such artifact/);
    await expect(restricted.listForArtifact(ctx(), { id: artifact.id, limit: 5 })).rejects.toThrow(
      /no such artifact/,
    );
  });

  it("refuses to export an artifact the caller may not read", async () => {
    const s = setup({ deny: [C1] });
    // Seeding itself is refused, so the artifact is created with an allowing service and then requested with
    // a denying one.
    const permissive = setup();
    const artifact = await seed(permissive);
    const denied = createExportService({
      artifacts: createArtifactService({
        artifacts: permissive.artifactStore,
        blobs: createMemoryBlobStore(),
        authorization: policy([C1]),
        clock: () => "2026-08-23T10:00:00.000Z",
      }),
      exports: s.exports,
      files: s.files,
      content: s.content,
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    await expect(denied.requestExport(ctx(), { id: artifact.id, format: "pdf" })).rejects.toThrow(
      /no such artifact/,
    );
  });

  it("does not resolve another tenant's export", async () => {
    const s = setup();
    const artifact = await seed(s);
    const requested = await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    await s.service.render({ tenantId: T1, exportId: requested.export.id }, ctx());
    await expect(s.service.download(ctx(T2), requested.export.id)).rejects.toThrow(/no such export/);
  });

  it("lists an artifact's exports for an entitled caller", async () => {
    const s = setup();
    const artifact = await seed(s);
    await s.service.requestExport(ctx(), { id: artifact.id, format: "pdf" });
    await s.service.requestExport(ctx(), { id: artifact.id, format: "markdown" });
    const page = await s.service.listForArtifact(ctx(), { id: artifact.id, limit: 10 });
    expect(page.items.map((e) => e.format).sort()).toEqual(["markdown", "pdf"]);
  });
});
