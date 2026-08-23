/**
 * `read_attachment` and `list_attachments` — the explicit, bounded read step (#130, AC-3).
 *
 * Attaching a file puts a *reference* in context. Nothing loads its content, and that is the whole design:
 * "referenced, not injected" only means something if bringing content in is a separate, deliberate act.
 * These two tools are that act, and both are bounded on purpose.
 *
 * **The bound is the point, not a nicety.** A read step with no ceiling reintroduces exactly what the
 * reference part avoided — one call and a 100 MB file is in the transcript, permanently, because a tool
 * result is a message part. So a read returns at most `MAX_READ_BYTES`, says so, and reports the offset to
 * continue from. The model can page; it cannot flood.
 *
 * **Reads go through `FileService`, not the stores.** That is where AC-3's entitlement check lives, and
 * duplicating it here would be a second permission model to keep in step with the first. A tool that reached
 * for `FileContentStore` directly would be tenant-scoped but not conversation-scoped, which is the exact hole
 * #129 closed.
 */

import { AgentPlatformError } from "../core/errors.js";
import { asId } from "../core/ids.js";
import type { FileId } from "../core/ids.js";
import { defineTool } from "../tools/define.js";
import type { Tool } from "../tools/index.js";
import type { FileService } from "./index.js";
import { MAX_LISTED_ATTACHMENTS, humanSize, truncateFilename } from "./context.js";

/**
 * The most one call returns.
 *
 * 32 KiB is roughly 8k tokens — a large but survivable share of a context window, and small enough that a
 * model paging a long document has to decide it is worth the budget rather than getting there by accident.
 */
export const MAX_READ_BYTES = 32 * 1024;

/**
 * Media types this tool will decode as text.
 *
 * An exact list, for the same reason `DEFAULT_UPLOAD_LIMITS` uses one: `text/*` is how a `text/html` payload
 * with a script becomes "just text". A PDF or an image is refused *with the reason and the alternative*, so
 * the model redirects instead of retrying — a refusal that does not say what to do next produces a loop.
 */
export const READABLE_AS_TEXT: readonly string[] = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
];

export type ReadAttachmentInput = {
  readonly fileId: string;
  readonly offset?: number;
  readonly maxBytes?: number;
};

export type ReadAttachmentOutput = {
  readonly fileId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly text: string;
  readonly byteOffset: number;
  readonly bytesReturned: number;
  readonly totalBytes: number;
  /** True when there is more to read. The model pages from `nextOffset` rather than guessing. */
  readonly truncated: boolean;
  readonly nextOffset?: number;
};

const refuse = (code: "invalid_input" | "not_found", message: string) =>
  new AgentPlatformError({ code, message, retryable: false });

/**
 * Read a bounded window of an attachment.
 *
 * The window is taken by consuming the stream and discarding what precedes the offset, rather than by
 * assembling the whole file and slicing it: a 100 MB file must not be held in memory to read its first
 * kilobyte, which is the mistake that makes a "bounded" read unbounded in the only dimension that matters.
 */
export const createReadAttachmentTool = (deps: { readonly files: FileService }): Tool =>
  defineTool<ReadAttachmentInput, ReadAttachmentOutput>({
    name: "read_attachment",
    label: "Read attachment",
    description:
      `Read up to ${MAX_READ_BYTES} bytes of a text attachment, from an optional byte offset. ` +
      "Attachments are referenced in context but never loaded; this is the only way to see their contents.",
    category: "files",
    effect: "read",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      additionalProperties: false,
      properties: {
        fileId: { type: "string", description: "The id from the attachment reference, without the `file:` prefix." },
        offset: { type: "integer", minimum: 0, description: "Byte offset to start from. Defaults to 0." },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_READ_BYTES,
          description: `At most ${MAX_READ_BYTES}. A larger value is clamped, not refused.`,
        },
      },
    },
    async execute(input, context) {
      const id = asId<FileId>(input.fileId.replace(/^file:/, ""));
      // Entitlement, existence and state all come from the service, so a tool cannot see a file a user
      // cannot.
      const file = await deps.files.get(context, id);

      if (!READABLE_AS_TEXT.includes(file.mediaType.split(";")[0]?.trim().toLowerCase() ?? ""))
        throw refuse(
          "invalid_input",
          `${file.filename} is ${file.mediaType}, which this tool cannot decode as text. ` +
            "Use a document-extraction tool for that type.",
        );

      const offset = Math.max(0, Math.floor(input.offset ?? 0));
      // Clamped rather than refused: a model asking for more than the ceiling has made a reasonable request
      // that the platform answers with less, and refusing it would just be answered by a retry.
      const limit = Math.min(Math.max(1, Math.floor(input.maxBytes ?? MAX_READ_BYTES)), MAX_READ_BYTES);

      const collected: Uint8Array[] = [];
      let seen = 0;
      let taken = 0;
      for await (const chunk of await deps.files.read(context, id)) {
        // Past the window: stop pulling. The generator is abandoned here, which cancels the underlying read
        // rather than draining the rest of a large object for bytes nobody asked for.
        if (taken >= limit) break;
        const chunkStart = seen;
        seen += chunk.byteLength;
        if (seen <= offset) continue;
        const from = Math.max(0, offset - chunkStart);
        const slice = chunk.subarray(from, from + (limit - taken));
        collected.push(slice);
        taken += slice.byteLength;
      }

      const joined = new Uint8Array(taken);
      let at = 0;
      for (const slice of collected) {
        joined.set(slice, at);
        at += slice.byteLength;
      }

      const end = offset + taken;
      // `file.byteSize` is the size as *written* (#129), not as declared, so "is there more" is answered
      // against what is actually stored.
      const truncated = end < file.byteSize;
      return {
        fileId: id,
        filename: file.filename,
        mediaType: file.mediaType,
        // `fatal: false` on purpose: a window boundary can land mid-codepoint, and a decode error would turn
        // a legitimate paged read into a failure. The replacement character is the honest answer.
        text: new TextDecoder("utf-8", { fatal: false }).decode(joined),
        byteOffset: offset,
        bytesReturned: taken,
        totalBytes: file.byteSize,
        truncated,
        ...(truncated ? { nextOffset: end } : {}),
      };
    },
  });

export type ListAttachmentsOutput = {
  readonly attachments: readonly {
    readonly fileId: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly size: string;
  }[];
  readonly nextCursor?: string;
};

/**
 * The rest of the list, when the context section capped it.
 *
 * The section names this tool rather than silently truncating, because a list that ends without saying so is
 * a model concluding a file is not there.
 */
export const createListAttachmentsTool = (deps: {
  readonly files: FileService;
  readonly conversationId: string;
}): Tool =>
  defineTool<{ readonly cursor?: string }, ListAttachmentsOutput>({
    name: "list_attachments",
    label: "List attachments",
    description: "List this conversation's attachments as references. Contents are not returned.",
    category: "files",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { cursor: { type: "string", description: "From a previous call's `nextCursor`." } },
    },
    async execute(input, context) {
      const page = await deps.files.listForConversation(context, {
        conversationId: asId(deps.conversationId),
        limit: MAX_LISTED_ATTACHMENTS,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        // The same fields the reference line carries, and no others. A listing that returned more than the
        // reference does would be a second, richer view of an attachment for no reason — and the place a
        // content field would eventually be added.
        attachments: page.items.map((file) => ({
          fileId: file.id,
          filename: truncateFilename(file.filename),
          mediaType: file.mediaType,
          size: humanSize(file.byteSize),
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });
