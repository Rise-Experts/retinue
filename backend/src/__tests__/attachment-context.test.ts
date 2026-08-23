/**
 * Attachments in context: referenced, never injected (#130).
 *
 * The tests are mostly about a *cost*, which is an unusual thing to assert and the reason this file exists.
 * "Do not inject file content" is trivially true of code that has no way to reach file content — so what is
 * worth testing is the property that would break silently: attaching a large file must not quietly consume
 * the conversation's budget, and the read step that does bring content in must stay bounded.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { ConversationId, FileId, MessageId, PrincipalId, RequestId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import { createMemoryFileContentStore, createMemoryFileMetadataStore } from "../adapters/memory/index.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import { assemblePrompt, gatherSections, inspectAssembledPrompt } from "../context/assembler.js";
import type { ContextBudget } from "../context/index.js";
import { createFileService } from "../files/index.js";
import {
  ATTACHMENT_PROVIDER_ID,
  MAX_LISTED_ATTACHMENTS,
  createAttachmentContextProvider,
  SIZE_FIELD_WIDTH,
  humanSize,
  renderAttachmentReference,
  truncateFilename,
} from "../files/context.js";
import {
  MAX_READ_BYTES,
  createListAttachmentsTool,
  createReadAttachmentTool,
} from "../files/read-tool.js";
import { parseMessagePart, serializeMessagePart } from "../core/validation.js";
import { createMemoryMessageStore } from "../adapters/memory/index.js";

const T1 = asId<TenantId>("tenant-1");
const C1 = asId<ConversationId>("convo-1");

const ctx = (): ExecutionContext => ({
  tenantId: T1,
  principalId: asId<PrincipalId>("user-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

const allowAll: AuthorizationPolicy = {
  async can() {
    return { allow: true };
  },
  filterTools() {
    throw new Error("unused");
  },
  scope() {
    throw new Error("unused");
  },
};

const BUDGET: ContextBudget = {
  basePolicyTokens: 500,
  userContextTokens: 500,
  toolTokens: 500,
  skillTokens: 500,
  knowledgeTokens: 500,
  historyTokens: 500,
};

const stream = (text: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield new TextEncoder().encode(text);
  })();

/** A file service and the attachment provider over the same stores. */
const setup = () => {
  const metadata = createMemoryFileMetadataStore();
  const content = createMemoryFileContentStore();
  let n = 0;
  const files = createFileService({
    metadata,
    content,
    authorization: allowAll,
    limits: {
      maxBytes: 200 * 1024 * 1024,
      allowedMediaTypes: ["text/plain", "text/csv", "application/pdf"],
      signedUrlSeconds: 300,
    },
    clock: () => "2026-08-23T10:00:00.000Z",
    fileId: () => `file-${++n}`,
    contentKey: () => `key-${n}`,
  });
  const provider = createAttachmentContextProvider({ metadata, conversationId: C1 });
  return { files, metadata, content, provider };
};

/**
 * A file of a stated size without the bytes to match.
 *
 * The metadata row is written directly: AC-2 is about a 100 MB *attachment*, and streaming 100 MB through
 * the reference adapter to prove a property about a rendered line would make the test slow to no purpose.
 * The read-step tests below use real bytes, where the size does matter.
 */
const attach = async (
  metadata: ReturnType<typeof createMemoryFileMetadataStore>,
  file: { id: string; filename: string; byteSize: number; mediaType?: string },
) =>
  metadata.create({
    tenantId: T1,
    file: {
      id: asId<FileId>(file.id),
      conversationId: C1,
      filename: file.filename,
      mediaType: file.mediaType ?? "text/plain",
      byteSize: file.byteSize,
      contentKey: `key-${file.id}`,
      state: "stored",
      uploadedBy: asId<PrincipalId>("user-1"),
      createdAt: "2026-08-23T10:00:00.000Z",
    },
  });

describe("humanSize", () => {
  it("keeps a thousand-fold size difference the same width", () => {
    // The mechanism behind AC-2. A byte count would make an attachment's token cost a function of its size.
    expect(humanSize(1024).trim()).toBe("1.0 KB");
    expect(humanSize(100 * 1024 * 1024).trim()).toBe("100 MB");
    // Fixed width, not merely similar width: this is what makes the cost exactly constant.
    expect(humanSize(1024)).toHaveLength(SIZE_FIELD_WIDTH);
    expect(humanSize(100 * 1024 * 1024)).toHaveLength(SIZE_FIELD_WIDTH);
  });

  it("names a unit at every scale a file can reach", () => {
    expect(humanSize(0).trim()).toBe("0 B");
    expect(humanSize(999).trim()).toBe("999 B");
    expect(humanSize(5 * 1024 ** 4).trim()).toBe("5.0 TB");
    // Past the largest unit it keeps counting in it rather than falling off the end.
    expect(humanSize(9999 * 1024 ** 4).trim()).toBe("9999 TB");
    // Every size a file can plausibly have lands on one width.
    for (const size of [0, 1, 999, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4]) {
      expect(humanSize(size)).toHaveLength(SIZE_FIELD_WIDTH);
    }
  });
});

describe("truncateFilename", () => {
  it("bounds a filename and keeps the extension", () => {
    // A filename is user input, and user input has no length. The extension survives because it is the part
    // that tells the model what the file is.
    const long = `${"a".repeat(300)}.csv`;
    const rendered = truncateFilename(long);
    expect(rendered.length).toBeLessThanOrEqual(80);
    expect(rendered.endsWith(".csv")).toBe(true);
  });

  it("leaves a short filename exactly as the user named it", () => {
    expect(truncateFilename("q3-report.csv")).toBe("q3-report.csv");
  });
});

describe("the attachment context section", () => {
  it("carries the reference and no content", async () => {
    // AC-1. Asserted positively on the fields *and* negatively on the shape: a section that happened to
    // contain the text of the file would satisfy every "contains the filename" assertion.
    const { metadata, provider } = setup();
    await attach(metadata, { id: "f1", filename: "q3.csv", byteSize: 2048, mediaType: "text/csv" });
    const [section] = await provider.provide(ctx());

    expect(section?.body).toContain("q3.csv");
    expect(section?.body).toContain("text/csv");
    expect(section?.body).toContain("2.0 KB");
    expect(section?.body).toContain("file:f1");
    expect(section?.body).toContain("read_attachment");
    // The whole section is two lines: the reference and the instruction. There is nowhere for content to be.
    expect(section?.body.split("\n")).toHaveLength(2);
  });

  it("never puts the storage key in front of the model", async () => {
    // `contentKey` is the object-storage path. A model that can see it can put it in a tool argument, which
    // is the forged-path risk `assertSafeKey` exists for on the other side. The reference is the file *id*;
    // the key is the platform's business.
    const { metadata, provider } = setup();
    await attach(metadata, { id: "f1", filename: "q3.csv", byteSize: 2048 });
    const [section] = await provider.provide(ctx());
    expect(section?.body).not.toContain("key-f1");
  });

  it("reports a token count computed from the body it built", async () => {
    // `estimatedTokens` is self-reported, and the assembler budgets on it. A section under-reporting its cost
    // survives budgeting it should have lost, so the number is derived here rather than accepted.
    const { metadata, provider } = setup();
    await attach(metadata, { id: "f1", filename: "q3.csv", byteSize: 2048 });
    const [section] = await provider.provide(ctx());
    expect(section?.estimatedTokens).toBe(Math.ceil((section?.body.length ?? 0) / 4));
  });

  it("says nothing at all when there are no attachments", async () => {
    // An empty "Attachments: none" section would cost tokens on every turn of every conversation that never
    // had one.
    const { provider } = setup();
    expect(await provider.provide(ctx())).toEqual([]);
  });

  it("does not show another tenant's or another conversation's files", async () => {
    const { metadata, provider } = setup();
    await attach(metadata, { id: "f1", filename: "mine.csv", byteSize: 10 });
    await metadata.create({
      tenantId: asId<TenantId>("tenant-2"),
      file: {
        id: asId<FileId>("f2"),
        conversationId: C1,
        filename: "theirs.csv",
        mediaType: "text/csv",
        byteSize: 10,
        contentKey: "key-f2",
        state: "stored",
        uploadedBy: asId<PrincipalId>("user-2"),
        createdAt: "2026-08-23T10:00:00.000Z",
      },
    });
    const [section] = await provider.provide(ctx());
    expect(section?.body).toContain("mine.csv");
    expect(section?.body).not.toContain("theirs.csv");
  });

  it("caps the list and says so rather than truncating silently", async () => {
    // Linear in something the user controls is the same unbounded-growth failure by a slower route. A list
    // that ends without saying so is a model concluding a file is not there.
    const { metadata, provider } = setup();
    for (let i = 0; i < MAX_LISTED_ATTACHMENTS + 5; i += 1) {
      await attach(metadata, { id: `f${i}`, filename: `file-${i}.csv`, byteSize: 100 });
    }
    const [section] = await provider.provide(ctx());
    const lines = section?.body.split("\n") ?? [];
    // Capped entries, the "and more" line, and the read instruction.
    expect(lines).toHaveLength(MAX_LISTED_ATTACHMENTS + 2);
    expect(section?.body).toContain("list_attachments");
  });

  it("is prunable knowledge, not history competing with recent turns", async () => {
    const { metadata, provider } = setup();
    await attach(metadata, { id: "f1", filename: "q3.csv", byteSize: 10 });
    const [section] = await provider.provide(ctx());
    expect(section?.kind).toBe("knowledge");
    expect(section?.pruneStage).toBe("old-knowledge");
    // Not cacheable: the list changes when a file is attached or deleted, and a stale list is a model
    // confidently reading a file that is gone.
    expect(section?.cacheable).toBe(false);
  });
});

describe("AC-2: attaching a large file does not change the assembled context size", () => {
  const assembleWith = async (byteSize: number) => {
    const { metadata, provider } = setup();
    // The same filename in both runs, because the filename is the part that legitimately costs tokens.
    await attach(metadata, { id: "f1", filename: "report.csv", byteSize, mediaType: "text/csv" });
    const sections = await gatherSections(ctx(), [provider]);
    return assemblePrompt({ sections, budget: BUDGET, modelContextTokens: 10_000 });
  };

  it("costs the same for 1 KB and 100 MB", async () => {
    // The issue's own test step. Not "effectively identical" — identical, because the size is rendered in
    // rounded units and both land on the same width.
    const small = await assembleWith(1024);
    const large = await assembleWith(100 * 1024 * 1024);
    expect(large.totalTokens).toBe(small.totalTokens);
  });

  it("costs the same across every order of magnitude a file can have", async () => {
    // One pair could pass by coincidence. The property is that the cost is constant in the file size, so it
    // is asserted across the whole range rather than at two points.
    const sizes = [1, 999, 1024, 1024 ** 2, 50 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 4];
    const totals = await Promise.all(sizes.map(async (size) => (await assembleWith(size)).totalTokens));
    expect(new Set(totals).size).toBe(1);
  });

  it("stays constant when the whole conversation is assembled around it", async () => {
    // The measurement that matters is the assembled prompt, not the section: a section could be constant
    // while the assembler did something size-dependent with it. The *text* legitimately differs — it names
    // the size — so what is compared is the cost and the width, not the string.
    const small = await assembleWith(1024);
    const large = await assembleWith(100 * 1024 * 1024);
    expect(large.preview.sections).toEqual(small.preview.sections);
    expect(large.sections.map((s) => s.body.length)).toEqual(small.sections.map((s) => s.body.length));
    // Same section, still one, still the attachment provider's — not two sections that happened to sum the
    // same.
    expect(large.sections.map((s) => s.providerId)).toEqual([ATTACHMENT_PROVIDER_ID]);
  });
});

describe("AC-6: the inspector shows the attachment's true, constant cost", () => {
  it("attributes the cost to the attachment provider, unchanged by file size", async () => {
    const inspect = async (byteSize: number) => {
      const { metadata, provider } = setup();
      await attach(metadata, { id: "f1", filename: "report.csv", byteSize });
      const sections = await gatherSections(ctx(), [provider]);
      const assembled = assemblePrompt({ sections, budget: BUDGET, modelContextTokens: 10_000 });
      return inspectAssembledPrompt(assembled).sections.find(
        (s) => s.providerId === ATTACHMENT_PROVIDER_ID,
      );
    };
    const small = await inspect(1024);
    const large = await inspect(100 * 1024 * 1024);
    expect(small?.estimatedTokens).toBeGreaterThan(0);
    // The inspector's number is the section's number is the body's number — one cost, reported once, so the
    // panel cannot show a figure the budget did not use.
    expect(large?.estimatedTokens).toBe(small?.estimatedTokens);
  });
});

describe("AC-3: content requires an explicit, bounded read", () => {
  const withContent = async (text: string, mediaType = "text/plain") => {
    const s = setup();
    const file = await s.files.upload(ctx(), {
      conversationId: C1,
      filename: "notes.txt",
      mediaType,
      declaredBytes: new TextEncoder().encode(text).byteLength,
      bytes: stream(text),
    });
    return { ...s, file, tool: createReadAttachmentTool({ files: s.files }) };
  };

  it("returns nothing of the file until the tool is called", async () => {
    const { provider, file } = await withContent("the secret is 42");
    const [section] = await provider.provide(ctx());
    // Attaching alone never loads content: the section names the file and not a word of it.
    expect(section?.body).not.toContain("secret");
    expect(section?.body).toContain(`file:${file.id}`);
  });

  it("reads the content once asked", async () => {
    const { tool, file } = await withContent("the secret is 42");
    const result = await tool.execute({ context: ctx(), input: { fileId: file.id } });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && (result.data as { text: string }).text).toBe("the secret is 42");
  });

  it("never returns more than the ceiling, however much is asked for", async () => {
    // Without this the read step reintroduces exactly what the reference avoided: a tool result is a message
    // part, so one unbounded call puts the whole file in the transcript permanently.
    const { tool, file } = await withContent("x".repeat(MAX_READ_BYTES * 3));
    const result = await tool.execute({
      context: ctx(),
      input: { fileId: file.id, maxBytes: MAX_READ_BYTES * 10 },
    });
    const data = result.ok ? (result.data as { bytesReturned: number; truncated: boolean }) : null;
    // Clamped, not refused: refusing would just be answered by a retry.
    expect(data?.bytesReturned).toBe(MAX_READ_BYTES);
    expect(data?.truncated).toBe(true);
  });

  it("pages the whole file through the offset it reports", async () => {
    // The bound is only acceptable if it is navigable. If `nextOffset` were wrong the model would loop on the
    // same window or skip a chunk, and either looks like a truncated file rather than a bug.
    const text = "abcdefghij".repeat(30);
    const { tool, file } = await withContent(text);
    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < 50; guard += 1) {
      const result = await tool.execute({
        context: ctx(),
        input: { fileId: file.id, offset, maxBytes: 64 },
      });
      if (!result.ok) throw new Error("read failed");
      const data = result.data as { text: string; truncated: boolean; nextOffset?: number };
      assembled += data.text;
      if (!data.truncated) break;
      offset = data.nextOffset ?? offset;
    }
    expect(assembled).toBe(text);
  });

  it("says there is no more when the window reaches the end", async () => {
    const { tool, file } = await withContent("short");
    const result = await tool.execute({ context: ctx(), input: { fileId: file.id } });
    const data = result.ok ? (result.data as { truncated: boolean; nextOffset?: number }) : null;
    expect(data?.truncated).toBe(false);
    // No offset to continue from, so a model cannot be led into a pointless extra call.
    expect(data?.nextOffset).toBeUndefined();
  });

  it("refuses a type it cannot decode, and says what to do instead", async () => {
    // A refusal that does not say what to do next produces a retry loop.
    const { tool, file } = await withContent("%PDF-1.4", "application/pdf");
    const result = await tool.execute({ context: ctx(), input: { fileId: file.id } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/cannot decode as text/);
    expect(!result.ok && result.error.message).toMatch(/document-extraction/);
  });

  it("accepts the id in the form the context section prints it", async () => {
    // The section renders `file:<id>`, so a model copying it verbatim is doing the reasonable thing. Refusing
    // that would be a failure caused by our own formatting.
    const { tool, file } = await withContent("hello");
    const result = await tool.execute({ context: ctx(), input: { fileId: `file:${file.id}` } });
    expect(result.ok).toBe(true);
  });

  it("cannot read a file the caller is not entitled to", async () => {
    // Through `FileService`, so AC-3's check is the same one the read path uses rather than a second copy.
    const s = setup();
    const file = await s.files.upload(ctx(), {
      conversationId: C1,
      filename: "notes.txt",
      mediaType: "text/plain",
      declaredBytes: 5,
      bytes: stream("hello"),
    });
    const denied = createFileService({
      metadata: s.metadata,
      content: s.content,
      authorization: {
        async can() {
          return { allow: false };
        },
        filterTools() {
          throw new Error("unused");
        },
        scope() {
          throw new Error("unused");
        },
      },
    });
    const tool = createReadAttachmentTool({ files: denied });
    const result = await tool.execute({ context: ctx(), input: { fileId: file.id } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("is classified as a read, so it needs no approval and no idempotency key", async () => {
    const { tool } = await withContent("hello");
    expect(tool.descriptor).toMatchObject({
      effect: "read",
      approvalPolicy: "never",
      requiresIdempotencyKey: false,
    });
  });
});

describe("list_attachments", () => {
  it("returns references and nothing else", async () => {
    // The same fields the reference line carries. A listing richer than the reference is where a content
    // field eventually gets added.
    const s = setup();
    await attach(s.metadata, { id: "f1", filename: "q3.csv", byteSize: 4096, mediaType: "text/csv" });
    const tool = createListAttachmentsTool({ files: s.files, conversationId: C1 });
    const result = await tool.execute({ context: ctx(), input: {} });
    expect(result.ok && result.data).toEqual({
      attachments: [{ fileId: "f1", filename: "q3.csv", mediaType: "text/csv", size: humanSize(4096) }],
    });
  });
});

describe("AC-4: the reference part validates and round-trips", () => {
  const part = (overrides: Record<string, unknown> = {}) => ({
    id: "part-1",
    type: "file",
    schemaVersion: 1,
    createdAt: "2026-08-23T10:00:00.000Z",
    fileId: "file-1",
    filename: "q3.csv",
    mediaType: "text/csv",
    byteSize: 4096,
    ...overrides,
  });

  it("round-trips through the message store and back out validated", async () => {
    // The issue's test step, end to end rather than schema-only: stored, read back, and re-parsed. A part
    // that validates in isolation but loses a field through `jsonb` would pass the schema test and fail here.
    const parsed = parseMessagePart(part());
    const messages = createMemoryMessageStore();
    messages.append(T1, {
      id: asId<MessageId>("msg-1"),
      conversationId: C1,
      role: "user",
      parts: [parsed],
      createdAt: "2026-08-23T10:00:00.000Z",
    });
    const page = await messages.listByConversation({ tenantId: T1, conversationId: C1, limit: 10 });
    const stored = page.items[0]?.parts[0];
    expect(parseMessagePart(serializeMessagePart(stored as never))).toEqual(parsed);
  });

  it("refuses a provider bag large enough to hold a document", () => {
    // `providerMetadata` is `Record<string, unknown>`, which is exactly the shape a base64 payload fits into.
    // A file part carrying its own content would satisfy every other rule while breaking the only one that
    // matters.
    expect(() => parseMessagePart(part({ providerMetadata: { blob: "A".repeat(4096) } }))).toThrow(
      /referenced, not inlined/,
    );
  });

  it("refuses a data: URI however small", () => {
    // A 1 KB inline image slips under a size cap and is still content in a part that promises to carry none.
    expect(() =>
      parseMessagePart(part({ providerMetadata: { src: "data:image/png;base64,iVBORw0=" } })),
    ).toThrow(/data: URI/);
    // Nested, because a bag is arbitrary JSON and a check that only looked at the top level would be a check
    // one `{ }` deep.
    expect(() =>
      parseMessagePart(part({ providerMetadata: { a: { b: ["data:text/plain,hello"] } } })),
    ).toThrow(/data: URI/);
  });

  it("still allows the ordinary provider detail the bag exists for", () => {
    expect(parseMessagePart(part({ providerMetadata: { openai: { fileId: "file-abc" } } }))).toMatchObject({
      providerMetadata: { openai: { fileId: "file-abc" } },
    });
  });

  it("applies the same rule to an image part", () => {
    expect(() =>
      parseMessagePart({
        id: "part-2",
        type: "image",
        schemaVersion: 1,
        createdAt: "2026-08-23T10:00:00.000Z",
        fileId: "file-2",
        mediaType: "image/png",
        providerMetadata: { src: "data:image/png;base64,iVBORw0=" },
      }),
    ).toThrow(/data: URI/);
  });

  it("renders the reference from a part's own fields", () => {
    // The section's line and the stored part describe one thing, so the renderer takes the metadata rather
    // than a second shape that could disagree with it.
    expect(
      renderAttachmentReference({
        id: asId<FileId>("f1"),
        conversationId: C1,
        filename: "q3.csv",
        mediaType: "text/csv",
        byteSize: 4096,
        contentKey: "key-f1",
        state: "stored",
        uploadedBy: asId<PrincipalId>("user-1"),
        createdAt: "2026-08-23T10:00:00.000Z",
      }),
    ).toBe(`- q3.csv (text/csv, ${humanSize(4096)}) — file:f1`);
  });
});
