/**
 * OCR and vision (#132).
 *
 * There is no OCR engine in this package and there cannot honestly be one — OCR needs a trained model. So
 * `OcrProvider` is a port, and what is tested here is everything around it: that a scan routes to it, that a
 * failure is typed, that low confidence is flagged everywhere a consumer might look, that a vision call is
 * billed once, and — the one that matters most — that a model without vision capability is never used.
 *
 * That last one is tested against the real `ModelRegistry` rather than a stub. AC-3 is a claim about
 * resolution, and a stubbed resolver would prove only that the stub refuses.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { BlobRef, ConversationId, FileId, PrincipalId, RequestId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError } from "../core/errors.js";
import {
  createMemoryBlobStore,
  createMemoryFileContentStore,
  createMemoryFileMetadataStore,
} from "../adapters/memory/index.js";
import { createModelRegistry, type ModelDefinition } from "../models/index.js";
import { LOW_CONFIDENCE_THRESHOLD } from "../persistence/index.js";
import type { UsageEventInput, UsageRecorder } from "../usage/index.js";
import { createExtractionService } from "../documents/extraction.js";
import { DEFAULT_EXTRACTION_LIMITS } from "../documents/index.js";
import type { ExtractionLimits } from "../documents/index.js";
import { createPdfDocumentParser } from "../documents/parsers/pdf.js";
import { createTextDocumentParser } from "../documents/parsers/text.js";
import { createReadDocumentTool } from "../documents/read-tool.js";
import {
  IMAGE_MEDIA_TYPES,
  LOW_CONFIDENCE_WARNING,
  createImageDocumentParser,
  createModelVisionProvider,
  createScannedPdfParser,
  extractionRunId,
  isImageMediaType,
  recordVisionUsage,
  type OcrProvider,
  type OcrResult,
  type VisionProvider,
} from "../documents/vision.js";
import { renderAttachmentReference } from "../files/context.js";

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
const PNG = utf8("\x89PNG fake image bytes");

// ---------------------------------------------------------------------------------------------
// Doubles.
// ---------------------------------------------------------------------------------------------

const ocrReturning = (result: OcrResult | { reason: string; message: string }): OcrProvider => ({
  id: "test-ocr",
  mediaTypes: [...IMAGE_MEDIA_TYPES, "application/pdf"],
  async recognise() {
    return result as OcrResult;
  },
});

const visionReturning = (description: string, tokens = { input: 900, output: 60 }): VisionProvider & {
  readonly calls: number;
} => {
  let calls = 0;
  return {
    id: "test-vision",
    mediaTypes: [...IMAGE_MEDIA_TYPES],
    async describe() {
      calls += 1;
      return {
        description,
        modelId: "vision-1",
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cachedInputTokens: 0,
      };
    },
    get calls() {
      return calls;
    },
  };
};

const model = (overrides: Partial<ModelDefinition>): ModelDefinition => ({
  provider: "openai",
  modelId: "m",
  label: "M",
  lifecycle: "generally-available",
  inputModalities: ["text"],
  capabilities: { tools: true, structuredOutput: true, reasoning: false, nativeSearch: false },
  limits: { contextTokens: 128_000, maxOutputTokens: 4096 },
  pricing: { currency: "EUR", inputPerMillion: 100, outputPerMillion: 300 },
  dataResidency: ["EU"],
  ...overrides,
});

describe("AC-3: a model without vision capability is never used for an image", () => {
  it("refuses when no configured model accepts images", async () => {
    // Against the real registry, because AC-3 is a claim about resolution. A stubbed resolver would prove
    // only that the stub refuses.
    const registry = createModelRegistry({
      models: [model({ modelId: "text-only", inputModalities: ["text"] })],
      roles: { fast: ["text-only"], smart: ["text-only"] },
    });
    const provider = createModelVisionProvider({
      registry,
      providers: {
        languageModel() {
          // Reaching here at all is the failure: it means a text-only model was selected for an image.
          throw new Error("a model was resolved for an image request");
        },
      },
    });
    const error = await provider.describe({ bytes: PNG, mediaType: "image/png" }).catch((e: AgentPlatformError) => e);
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error).toMatchObject({ code: "capability_unavailable" });
  });

  it("selects the vision-capable model when one is configured", async () => {
    const registry = createModelRegistry({
      models: [
        model({ modelId: "text-only", inputModalities: ["text"] }),
        model({ modelId: "sees-things", inputModalities: ["text", "image"] }),
      ],
      // Text-only is *preferred* for the role, so this also asserts the modality constraint outranks the
      // preference order rather than merely agreeing with it.
      roles: { fast: ["text-only", "sees-things"], smart: ["text-only", "sees-things"] },
    });
    const chosen: string[] = [];
    const provider = createModelVisionProvider({
      registry,
      providers: {
        languageModel(definition) {
          chosen.push(definition.modelId);
          return "stub" as never;
        },
      },
    });
    // The SDK call fails against a stub model; what is asserted is which model got picked.
    await provider.describe({ bytes: PNG, mediaType: "image/png" }).catch(() => undefined);
    expect(chosen).toEqual(["sees-things"]);
  });

  it("does not swallow the refusal into an empty description", async () => {
    // A fabricated description is the one outcome worse than no description, so the refusal has to propagate
    // rather than becoming a successful extraction of nothing.
    const registry = createModelRegistry({
      models: [model({ modelId: "text-only" })],
      roles: { fast: ["text-only"], smart: ["text-only"] },
    });
    const parser = createImageDocumentParser({
      vision: createModelVisionProvider({
        registry,
        providers: { languageModel: () => "stub" as never },
      }),
    });
    await expect(parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS })).rejects.toMatchObject({
      code: "capability_unavailable",
    });
  });
});

describe("AC-2: an attached screenshot can be described", () => {
  it("produces a labelled description block", async () => {
    // Labelled, because a description is the model's *reading* of an image and a transcription is what the
    // image says. Presenting them identically would let a later answer cite an inference as a quote.
    const parser = createImageDocumentParser({ vision: visionReturning("A dashboard showing a sales chart.") });
    const doc = await parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    expect("blocks" in doc && doc.blocks).toEqual([
      { kind: "heading", level: 2, text: "Image description" },
      { kind: "paragraph", text: "A dashboard showing a sales chart." },
    ]);
  });

  it("combines transcription and description for a screenshot that has both", async () => {
    // A dashboard screenshot has text *and* a chart. Either alone loses half of it — the numbers without the
    // layout, or the layout without the numbers.
    const parser = createImageDocumentParser({
      ocr: ocrReturning({
        blocks: [{ kind: "table", hasHeader: true, rows: [["Region", "Revenue"], ["EMEA", "4210"]] }],
        confidence: 0.95,
      }),
      vision: visionReturning("A bar chart with EMEA highest."),
    });
    const doc = await parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    const kinds = "blocks" in doc ? doc.blocks.map((b) => b.kind) : [];
    expect(kinds).toEqual(["table", "heading", "paragraph"]);
  });

  it("still describes an image whose text recognition failed", async () => {
    // A photograph with no text is exactly this case, and refusing the whole extraction would lose the
    // description too.
    const parser = createImageDocumentParser({
      ocr: ocrReturning({ reason: "no-text-layer", message: "no words found" }),
      vision: visionReturning("A photograph of a whiteboard."),
    });
    const doc = await parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    expect("blocks" in doc && doc.blocks.some((b) => b.kind === "paragraph")).toBe(true);
    expect("warnings" in doc && doc.warnings.join(" ")).toMatch(/Text recognition failed/);
  });

  it("reports an unreadable image rather than an empty document", async () => {
    const parser = createImageDocumentParser({});
    expect(await parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS })).toMatchObject({
      reason: "no-text-layer",
    });
  });

  it("names the size limit when it refuses a large image", async () => {
    // AC-6, with the number in the message rather than implied.
    const parser = createImageDocumentParser({ vision: visionReturning("x") });
    const doc = await parser.parse({ bytes: new Uint8Array(200), mediaType: "image/png", limits: { ...LIMITS, maxBytes: 100 } });
    expect(doc).toMatchObject({ reason: "too-large" });
    expect("message" in doc && doc.message).toMatch(/100 byte/);
  });
});

describe("AC-5: low-confidence recognition is flagged", () => {
  it("adds the warning below the threshold and not above it", async () => {
    const low = createImageDocumentParser({
      ocr: ocrReturning({ blocks: [{ kind: "paragraph", text: "blurry" }], confidence: 0.4 }),
    });
    const high = createImageDocumentParser({
      ocr: ocrReturning({ blocks: [{ kind: "paragraph", text: "crisp" }], confidence: 0.98 }),
    });
    const lowDoc = await low.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    const highDoc = await high.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    expect("warnings" in lowDoc && lowDoc.warnings).toContain(LOW_CONFIDENCE_WARNING);
    expect("warnings" in highDoc && highDoc.warnings).not.toContain(LOW_CONFIDENCE_WARNING);
  });

  it("treats an engine that reports no confidence as low, not as certain", async () => {
    // `confidence` is required on `OcrResult` for exactly this reason: an optional field would default to
    // the optimistic answer and nobody would notice.
    const parser = createImageDocumentParser({
      ocr: ocrReturning({ blocks: [{ kind: "paragraph", text: "who knows" }], confidence: 0 }),
    });
    const doc = await parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    expect("warnings" in doc && doc.warnings).toContain(LOW_CONFIDENCE_WARNING);
  });

  it("carries the confidence onto the file record, not only into the blob", async () => {
    // So a listing can flag it without fetching the blob to find out.
    const s = setup({ ocr: ocrReturning({ blocks: [{ kind: "paragraph", text: "blurry" }], confidence: 0.42 }) });
    const id = await storeFile(s, { id: "f1", mediaType: "image/png", body: PNG });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record).toMatchObject({ state: "extracted", confidence: 0.42 });
  });

  it("marks the reference line so a model knows before it reads", async () => {
    // A model choosing which of three attachments to trust decides before it reads any of them.
    const line = renderAttachmentReference({
      id: asId<FileId>("f1"),
      conversationId: C1,
      filename: "scan.png",
      mediaType: "image/png",
      byteSize: 2048,
      contentKey: "key-f1",
      state: "stored",
      extraction: { state: "extracted", ref: asId<BlobRef>("b1"), confidence: 0.4 },
      uploadedBy: asId<PrincipalId>("user-1"),
      createdAt: "2026-08-23T10:00:00.000Z",
    });
    expect(line).toContain("low confidence");
  });

  it("surfaces both the number and the flag through read_document", async () => {
    // The warning is the sentence a model passes on; the number is what a caller comparing two extractions
    // needs. A consumer reading only structured fields still cannot mistake uncertain text for certain.
    const s = setup({ ocr: ocrReturning({ blocks: [{ kind: "paragraph", text: "blurry" }], confidence: 0.35 }) });
    const id = await storeFile(s, { id: "f1", mediaType: "image/png", body: PNG });
    await s.service.extract({ tenantId: T1, fileId: id });
    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    expect(result.ok && result.data).toMatchObject({ confidence: 0.35, lowConfidence: true });
    expect(result.ok && (result.data as { warnings?: string[] }).warnings).toContain(LOW_CONFIDENCE_WARNING);
  });

  it("reports no confidence at all for a PDF's text layer", async () => {
    // A text layer is *read*, not recognised. A confidence there would be a number with nothing behind it,
    // and "1.0" would be a lie about a different kind of extraction.
    const s = setup();
    const id = await storeFile(s, { id: "f1", mediaType: "text/markdown", body: utf8("# Title\n") });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record.confidence).toBeUndefined();
  });
});

describe("AC-1: a scanned document yields readable text", () => {
  it("falls back to OCR when the text layer is empty", async () => {
    // #131 made `no-text-layer` a distinct reason; this is where that becomes load-bearing.
    const scan = utf8("%PDF-1.4\n4 0 obj << /Length 20 >>\nstream\nq /Im1 Do Q\nendstream endobj\n%%EOF\n");
    const s = setup({
      ocr: ocrReturning({
        blocks: [{ kind: "heading", level: 1, text: "Invoice" }, { kind: "paragraph", text: "Total 1,234" }],
        confidence: 0.91,
        pageCount: 1,
      }),
    });
    const id = await storeFile(s, { id: "f1", mediaType: "application/pdf", body: scan });
    const record = await s.service.extract({ tenantId: T1, fileId: id });
    expect(record).toMatchObject({ state: "extracted", blockCount: 2, confidence: 0.91 });

    const tool = createReadDocumentTool({ extraction: s.service });
    const result = await tool.execute({ context: ctx(), input: { fileId: id } });
    expect(result.ok && (result.data as { text: string }).text).toContain("Total 1,234");
  });

  it("does not spend OCR on an encrypted or malformed document", async () => {
    // OCR will not decrypt anything, so a second attempt costs money to reach the same conclusion.
    let called = 0;
    const counting: OcrProvider = {
      id: "counting",
      mediaTypes: ["application/pdf"],
      async recognise() {
        called += 1;
        return { blocks: [{ kind: "paragraph", text: "should not happen" }], confidence: 1 };
      },
    };
    const s = setup({ ocr: counting });
    const encrypted = utf8("%PDF-1.4\ntrailer << /Encrypt 9 0 R >>\n%%EOF\n");
    const id = await storeFile(s, { id: "f1", mediaType: "application/pdf", body: encrypted });
    expect(await s.service.extract({ tenantId: T1, fileId: id })).toMatchObject({
      state: "failed",
      failureReason: "encrypted",
    });
    expect(called).toBe(0);
  });

  it("reports a scan OCR could not read as still having no text", async () => {
    const scan = utf8("%PDF-1.4\n4 0 obj << /Length 12 >>\nstream\nq /Im1 Do Q\nendstream endobj\n%%EOF\n");
    const s = setup({ ocr: ocrReturning({ blocks: [], confidence: 0.9 }) });
    const id = await storeFile(s, { id: "f1", mediaType: "application/pdf", body: scan });
    expect(await s.service.extract({ tenantId: T1, fileId: id })).toMatchObject({
      state: "failed",
      failureReason: "no-text-layer",
    });
  });

  it("feeds the same derived-artifact path regardless of source", async () => {
    // The point of the whole file: a scan and a Markdown file produce the same shape, so nothing downstream
    // branches on where the text came from.
    const s = setup({ ocr: ocrReturning({ blocks: [{ kind: "paragraph", text: "scanned" }], confidence: 0.9 }) });
    const scanned = await storeFile(s, {
      id: "scan",
      mediaType: "application/pdf",
      body: utf8("%PDF-1.4\n4 0 obj << /Length 12 >>\nstream\nq /Im1 Do Q\nendstream endobj\n%%EOF\n"),
    });
    const typed = await storeFile(s, { id: "typed", mediaType: "text/plain", body: utf8("typed") });
    const a = await s.service.extract({ tenantId: T1, fileId: scanned });
    const b = await s.service.extract({ tenantId: T1, fileId: typed });

    const docA = await s.blobs.get({ tenantId: T1, ref: a.ref as BlobRef });
    const docB = await s.blobs.get({ tenantId: T1, ref: b.ref as BlobRef });
    // Same keys, same block shape. Only `confidence` differs, and its absence is itself meaningful.
    expect(Object.keys(docB as object).sort()).toEqual(["blocks", "truncated", "warnings"]);
    expect(Object.keys(docA as object).sort()).toEqual(["blocks", "confidence", "truncated", "warnings"]);
  });
});

describe("AC-4: vision and OCR cost is recorded", () => {
  const recorder = () => {
    const events: UsageEventInput[] = [];
    const impl: UsageRecorder = {
      async record(_context, event) {
        events.push(event);
      },
      async reserve() {
        return { id: "r", withinCeiling: true };
      },
    };
    return { events, impl };
  };

  it("records a vision call against the usage ledger", async () => {
    const { events, impl } = recorder();
    await recordVisionUsage(impl, ctx(), {
      fileId: "f1",
      usage: { description: "d", modelId: "vision-1", inputTokens: 900, outputTokens: 60, cachedInputTokens: 0 },
      costMinorUnits: 42,
      currency: "EUR",
    });
    expect(events).toEqual([
      {
        runId: extractionRunId("f1"),
        stepId: "vision",
        modelId: "vision-1",
        inputTokens: 900,
        outputTokens: 60,
        cachedInputTokens: 0,
        costMinorUnits: 42,
        currency: "EUR",
      },
    ]);
  });

  it("keys the record so a retried extraction cannot charge twice", async () => {
    // `usageDedupeKey` is `(runId, stepId)`. Vision calls are the expensive kind, and a re-enqueued job
    // double-charging a tenant is the failure this shape prevents.
    const first = extractionRunId("f1");
    const again = extractionRunId("f1");
    expect(first).toBe(again);
    // And it is namespaced, so it cannot collide with a real run's id.
    expect(String(first).startsWith("extraction:")).toBe(true);
  });

  it("reports a vision call to the pipeline, keyed to the file it was for", async () => {
    // The end-to-end path AC-4 actually asks for: a priced operation reaches the ledger with the tenant and
    // file it belonged to. The parser's own callback cannot do this — it is constructed once and shared by
    // every file it ever parses.
    const billed: { tenantId: string; fileId: string; kind: string; modelId: string }[] = [];
    const metadata = createMemoryFileMetadataStore();
    const content = createMemoryFileContentStore();
    const blobs = createMemoryBlobStore();
    const service = createExtractionService({
      metadata,
      content,
      blobs,
      parsers: [createImageDocumentParser({ vision: visionReturning("A chart.") })],
      clock: () => "2026-08-23T10:00:00.000Z",
      async onPricedOperation({ tenantId, fileId, usage }) {
        billed.push({ tenantId, fileId, kind: usage.kind, modelId: usage.modelId });
      },
    });
    const id = await storeFile({ metadata, content, blobs, service }, {
      id: "f1",
      mediaType: "image/png",
      body: PNG,
    });
    const record = await service.extract({ tenantId: T1, fileId: id });
    expect(billed).toEqual([{ tenantId: T1, fileId: id, kind: "vision", modelId: "vision-1" }]);

    // And the stored document does not carry the billing data: it is transport only.
    const stored = (await blobs.get({ tenantId: T1, ref: record.ref as BlobRef })) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain("usage");
  });

  it("keeps the extraction when the ledger write fails", async () => {
    // An unbilled call is a smaller problem than a document the user paid for and cannot read.
    const metadata = createMemoryFileMetadataStore();
    const content = createMemoryFileContentStore();
    const blobs = createMemoryBlobStore();
    const service = createExtractionService({
      metadata,
      content,
      blobs,
      parsers: [createImageDocumentParser({ vision: visionReturning("A chart.") })],
      clock: () => "2026-08-23T10:00:00.000Z",
      async onPricedOperation() {
        throw new Error("ledger unreachable");
      },
    });
    const id = await storeFile({ metadata, content, blobs, service }, {
      id: "f1",
      mediaType: "image/png",
      body: PNG,
    });
    expect(await service.extract({ tenantId: T1, fileId: id })).toMatchObject({ state: "extracted" });
  });

  it("reports the vision call to the parser's observer as well", async () => {
    // The parser does not bill — it reports. Keeping billing out of the parser is what lets the same parser
    // run in a test with no ledger at all.
    const seen: { modelId: string; inputTokens: number }[] = [];
    const parser = createImageDocumentParser({
      vision: visionReturning("A chart."),
      onVisionUsage: (usage) => seen.push({ modelId: usage.modelId, inputTokens: usage.inputTokens }),
    });
    await parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    expect(seen).toEqual([{ modelId: "vision-1", inputTokens: 900 }]);
  });

  it("calls the vision model once per extraction, not once per block", async () => {
    // A vision call per block would be a bill that scales with the description's own length.
    const vision = visionReturning("A chart.");
    const parser = createImageDocumentParser({ vision });
    await parser.parse({ bytes: PNG, mediaType: "image/png", limits: LIMITS });
    expect(vision.calls).toBe(1);
  });
});

describe("helpers", () => {
  it("recognises an image media type with parameters", () => {
    expect(isImageMediaType("image/png")).toBe(true);
    expect(isImageMediaType("IMAGE/PNG; foo=bar")).toBe(true);
    // An SVG is not on the list: it is a script container, and the same reason keeps it out of upload limits.
    expect(isImageMediaType("image/svg+xml")).toBe(false);
    expect(isImageMediaType("application/pdf")).toBe(false);
  });

  it("uses one threshold everywhere", () => {
    // Two layers interpret `confidence` and neither may import the other, so the port owns the number.
    expect(LOW_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(LOW_CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Pipeline fixture, shared by the AC blocks above.
// ---------------------------------------------------------------------------------------------

function setup(options: { ocr?: OcrProvider; vision?: VisionProvider } = {}) {
  const metadata = createMemoryFileMetadataStore();
  const content = createMemoryFileContentStore();
  const blobs = createMemoryBlobStore();
  const service = createExtractionService({
    metadata,
    content,
    blobs,
    parsers: [
      createTextDocumentParser(),
      createPdfDocumentParser(),
      ...(options.ocr || options.vision
        ? [
            createImageDocumentParser({
              ...(options.ocr === undefined ? {} : { ocr: options.ocr }),
              ...(options.vision === undefined ? {} : { vision: options.vision }),
            }),
          ]
        : []),
    ],
    // The OCR fallback for a scanned PDF, keyed on the same media type the text parser claims.
    ...(options.ocr === undefined ? {} : { fallbackParsers: [createScannedPdfParser({ ocr: options.ocr })] }),
    clock: () => "2026-08-23T10:00:00.000Z",
  });
  return { metadata, content, blobs, service };
}

async function storeFile(
  s: ReturnType<typeof setup>,
  file: { id: string; mediaType: string; body: Uint8Array },
): Promise<FileId> {
  await s.content.putFile({
    tenantId: T1,
    contentKey: `key-${file.id}`,
    mediaType: file.mediaType,
    bytes: (async function* () {
      yield file.body;
    })(),
    maxBytes: 10 * 1024 * 1024,
  });
  await s.metadata.create({
    tenantId: T1,
    file: {
      id: asId<FileId>(file.id),
      conversationId: C1,
      filename: `${file.id}.bin`,
      mediaType: file.mediaType,
      byteSize: file.body.byteLength,
      contentKey: `key-${file.id}`,
      state: "stored",
      uploadedBy: asId<PrincipalId>("user-1"),
      createdAt: "2026-08-23T09:00:00.000Z",
    },
  });
  return asId<FileId>(file.id);
}
