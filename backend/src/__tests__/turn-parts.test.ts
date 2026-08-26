/**
 * An attachment reaching a model — REQ-036 (#185), AC-3.
 *
 * The AC is that "attachments reach the model through the same authorization and size limits as
 * `read_attachment`; a modality bridge is not a way around the file path". The way a bridge becomes one is
 * unglamorous: it needs bytes, the stores have bytes, and reading them directly is one line shorter than going
 * through the service. So the property worth testing is not that the happy path works — it is that the
 * unhappy paths are the *service's* answers and not this module's.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import { createMemoryFileContentStore, createMemoryFileMetadataStore } from "../adapters/memory/index.js";
import { createFileService } from "../files/index.js";
import { createAttachmentResolver, describeSkipped, MAX_ATTACHMENT_PARTS } from "../files/turn-parts.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import type { ExecutionContext } from "../core/context.js";
import type { ConversationId, PrincipalId, RequestId, TenantId } from "../core/ids.js";

const T1 = asId<TenantId>("tenant-1");
const C1 = asId<ConversationId>("conv-1");

const ctx = (): ExecutionContext => ({
  tenantId: T1,
  principalId: asId<PrincipalId>("person-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  conversationId: C1,
  requestId: asId<RequestId>("req-1"),
});

const policy = (allow: boolean): AuthorizationPolicy => ({
  async can() {
    return allow ? { allow: true } : { allow: false, reason: "not yours" };
  },
  filterTools() {
    throw new Error("unused");
  },
  scope() {
    throw new Error("unused");
  },
});

const stream = (bytes: Uint8Array): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield bytes;
  })();

/** A one-pixel PNG, so the bytes are real and the media type is not a claim about nothing. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const setup = (options: { allow?: boolean } = {}) => {
  const metadata = createMemoryFileMetadataStore();
  const content = createMemoryFileContentStore();
  let n = 0;
  const files = createFileService({
    metadata,
    content,
    authorization: policy(options.allow ?? true),
    limits: {
      maxBytes: 50 * 1024 * 1024,
      allowedMediaTypes: ["image/png", "image/jpeg", "application/pdf", "text/plain"],
      signedUrlSeconds: 300,
    },
    clock: () => "2026-08-26T10:00:00.000Z",
    fileId: () => `file-${++n}`,
    contentKey: () => `key-${n}`,
  });
  return { files, metadata, content };
};

const upload = async (
  files: ReturnType<typeof setup>["files"],
  input: { filename: string; mediaType: string; bytes: Uint8Array },
) =>
  files.upload(ctx(), {
    conversationId: C1,
    filename: input.filename,
    mediaType: input.mediaType,
    declaredBytes: input.bytes.byteLength,
    bytes: stream(input.bytes),
  });

describe("resolving attachments into turn parts", () => {
  it("turns an image into an image part with its media type", async () => {
    const { files } = setup();
    const file = await upload(files, { filename: "shot.png", mediaType: "image/png", bytes: PNG });

    const resolved = await createAttachmentResolver({ files }).resolve(ctx(), { fileIds: [String(file.id)] });

    expect(resolved.skipped).toEqual([]);
    expect(resolved.parts).toHaveLength(1);
    const part = resolved.parts[0]!;
    expect(part.kind).toBe("image");
    expect(part.kind === "image" && part.mediaType).toBe("image/png");
    // The bytes, base64, as a data URL — not a store key and not a signed URL. A URL the provider fetches is a
    // second read path with its own lifetime, and the whole point is that there is one.
    expect(part.kind === "image" && String(part.image).startsWith("data:image/png;base64,")).toBe(true);
  });

  it("turns a PDF into a file part", async () => {
    const { files } = setup();
    const file = await upload(files, {
      filename: "report.pdf",
      mediaType: "application/pdf",
      bytes: Buffer.from("%PDF-1.4 minimal"),
    });
    const resolved = await createAttachmentResolver({ files }).resolve(ctx(), { fileIds: [String(file.id)] });
    expect(resolved.parts[0]?.kind).toBe("file");
  });

  it("accepts the `file:` prefix a message part carries", async () => {
    const { files } = setup();
    const file = await upload(files, { filename: "shot.png", mediaType: "image/png", bytes: PNG });
    const resolved = await createAttachmentResolver({ files }).resolve(ctx(), { fileIds: [`file:${String(file.id)}`] });
    expect(resolved.parts).toHaveLength(1);
  });
});

describe("what it refuses", () => {
  it("skips a file the caller may not read, and does not say whether it exists", async () => {
    /**
     * The authorization test, and the reason the resolver has no store access of its own.
     *
     * The refusal is the *service's*: the policy says no, `get` throws, and this module reports a skip. There is
     * no branch here that could be reached with a policy that said no — which is the difference between
     * "authorization is applied" and "authorization is applied unless someone adds a fast path".
     */
    const permitted = setup();
    const file = await upload(permitted.files, { filename: "shot.png", mediaType: "image/png", bytes: PNG });

    // The same stores, a service that refuses. So the bytes are definitely there and definitely not returned.
    const refusing = createFileService({
      metadata: permitted.metadata,
      content: permitted.content,
      authorization: policy(false),
      clock: () => "2026-08-26T10:00:00.000Z",
    });
    const resolved = await createAttachmentResolver({ files: refusing }).resolve(ctx(), { fileIds: [String(file.id)] });

    expect(resolved.parts).toEqual([]);
    expect(resolved.skipped[0]?.reason).toBe("unreadable");
    // Says nothing about existence: telling a caller that a file they cannot read exists is the leak.
    expect(resolved.skipped[0]?.message).toBe("That attachment could not be read.");
  });

  it("skips a media type a model cannot be shown", async () => {
    const { files } = setup();
    const file = await upload(files, {
      filename: "notes.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("hello"),
    });
    const resolved = await createAttachmentResolver({ files }).resolve(ctx(), { fileIds: [String(file.id)] });
    expect(resolved.parts).toEqual([]);
    expect(resolved.skipped[0]?.reason).toBe("unsupported-media-type");
    // Points at the tool that can read it, rather than only refusing.
    expect(resolved.skipped[0]?.message).toContain("Read it with a tool instead");
  });

  it("skips a file over the byte ceiling, and names the numbers", async () => {
    const { files } = setup();
    const big = Buffer.alloc(40 * 1024, 1);
    const file = await upload(files, { filename: "big.png", mediaType: "image/png", bytes: big });

    const resolved = await createAttachmentResolver({ files, maxBytes: 8 * 1024 }).resolve(ctx(), {
      fileIds: [String(file.id)],
    });
    expect(resolved.skipped[0]?.reason).toBe("too-large");
    expect(resolved.skipped[0]?.message).toContain("40KB");
    expect(resolved.skipped[0]?.message).toContain("8KB");
    // The reason the ceiling exists at all, said in the message: a picture has no pages.
    expect(resolved.skipped[0]?.message).toContain("cannot be read in pages");
  });

  it("stops reading at the ceiling even when the metadata understates the size", async () => {
    /**
     * `byteSize` is metadata and metadata can disagree with the object — a truncated upload, a store somebody
     * wrote to directly. A resolver that trusted the number would read the whole thing to find out.
     */
    const { files, metadata, content } = setup();
    const file = await upload(files, { filename: "shot.png", mediaType: "image/png", bytes: PNG });
    // The object grows behind the row's back: same content key, more bytes. This is the store being written to
    // directly, which is exactly the situation the metadata cannot be trusted in.
    await content.putFile({
      tenantId: T1,
      contentKey: "key-1",
      mediaType: "image/png",
      bytes: stream(Buffer.alloc(64 * 1024, 7)),
      maxBytes: 1024 * 1024,
    });
    void metadata;

    const resolved = await createAttachmentResolver({ files, maxBytes: 1024 }).resolve(ctx(), {
      fileIds: [String(file.id)],
    });
    expect(resolved.parts).toEqual([]);
    expect(resolved.skipped[0]?.reason).toBe("too-large");
    expect(resolved.skipped[0]?.message).toContain("larger than its recorded size");
  });

  it("stops after the attachment ceiling and reports the rest", async () => {
    const { files } = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ATTACHMENT_PARTS + 2; i += 1) {
      const file = await upload(files, { filename: `s${i}.png`, mediaType: "image/png", bytes: PNG });
      ids.push(String(file.id));
    }
    const resolved = await createAttachmentResolver({ files }).resolve(ctx(), { fileIds: ids });
    expect(resolved.parts).toHaveLength(MAX_ATTACHMENT_PARTS);
    expect(resolved.skipped).toHaveLength(2);
    expect(resolved.skipped.every((s) => s.reason === "too-many")).toBe(true);
  });

  it("skips a modality the chosen model does not accept, naming the file", async () => {
    // The second check, and not a redundant one: `streamModelTurn`'s gate can only refuse the whole turn, and
    // this one can say which attachment was the problem.
    const { files } = setup();
    const file = await upload(files, { filename: "shot.png", mediaType: "image/png", bytes: PNG });
    const resolved = await createAttachmentResolver({ files }).resolve(ctx(), {
      fileIds: [String(file.id)],
      accepts: ["text", "pdf"],
    });
    expect(resolved.parts).toEqual([]);
    expect(resolved.skipped[0]?.reason).toBe("modality-not-accepted");
    expect(resolved.skipped[0]?.message).toContain("shot.png");
  });

  it("keeps the readable attachments when one of several fails", async () => {
    // One bad attachment must not fail a turn that had three good ones.
    const { files } = setup();
    const good = await upload(files, { filename: "a.png", mediaType: "image/png", bytes: PNG });
    const bad = await upload(files, { filename: "b.txt", mediaType: "text/plain", bytes: Buffer.from("x") });
    const resolved = await createAttachmentResolver({ files }).resolve(ctx(), {
      fileIds: [String(bad.id), String(good.id)],
    });
    expect(resolved.parts).toHaveLength(1);
    expect(resolved.skipped).toHaveLength(1);
  });
});

describe("saying so in the transcript", () => {
  it("writes one sentence per skip, and nothing when nothing was skipped", () => {
    expect(describeSkipped([])).toBeNull();
    const text = describeSkipped([
      { fileId: "f1", reason: "too-large", message: "big.png is too large." },
      { fileId: "f2", reason: "unreadable", message: "That attachment could not be read." },
    ]);
    expect(text).toContain("big.png is too large.");
    expect(text).toContain("could not be read");
  });
});
