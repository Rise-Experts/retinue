/**
 * The export pipeline (#134).
 *
 * The renderers turn blocks into bytes; this decides *when*, *where the bytes go*, and *what happens when a
 * render fails* — and one thing the issue asked for differently, which is worth stating plainly.
 *
 * **An export is not an artifact version.** The issue's wording says a render should produce "a new blob and
 * an artifact version". #133's versions are versions of the *content*; a PDF is a rendering of one. Making a
 * render a new version would bump `latestVersion` for a reason unrelated to what the assistant wrote, and
 * "the newest version" would stop meaning "the newest content" — and exporting the same artifact to two
 * formats would create two content versions that are not content. So an export is its own record, keyed on
 * `(artifactId, version, format)`, which delivers the property the issue actually wanted: the same export is
 * re-downloaded rather than re-rendered.
 *
 * Four properties, each answering an AC:
 *
 * - **The bytes go through the file ports** (AC-5). A rendered PDF becomes a `FileMetadata` row plus content
 *   in `FileContentStore`, so it inherits #129's conversation entitlement and 15-minute signed URLs rather
 *   than needing a second mediated-download path. There is no code here that could produce a permanent URL.
 * - **Rendering is enqueued, not awaited** (AC-3). `requestExport` claims the slot and returns a reference.
 * - **A failure creates no partial anything** (AC-4). The bytes are written before the export row is
 *   completed, and the row is only marked `rendered` once the file exists — so a failed render leaves a
 *   `failed` row with a reason and no file, never a row promising a download that is not there.
 * - **Identical input yields identical bytes** (AC-6). The renderers are pure and the PDF's date is fixed;
 *   the checksum is recorded so a re-render can be compared without re-downloading.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext, Page } from "../core/context.js";
import { asId } from "../core/ids.js";
import type { ArtifactId, ConversationId, FileId } from "../core/ids.js";
import type { DocumentBlock } from "../documents/index.js";
import { parseMarkdown } from "../documents/parsers/text.js";
import { DEFAULT_EXTRACTION_LIMITS } from "../documents/index.js";
import type { ArtifactService } from "../artifacts/index.js";
import { MAX_SIGNED_URL_SECONDS } from "../files/index.js";
import type {
  ArtifactExport,
  ArtifactExportStore,
  ExportFormat,
  FileContentStore,
  FileMetadataStore,
} from "../persistence/index.js";
import { renderMarkdown } from "./markdown.js";
import { FIXED_CREATION_DATE, renderPdf, type ExportCitation } from "./pdf.js";

/** The media type each format is served as. Exact, because a browser decides how to treat it from this. */
export const EXPORT_MEDIA_TYPES: Readonly<Record<ExportFormat, string>> = {
  pdf: "application/pdf",
  markdown: "text/markdown",
};

/** A job on the export queue. Mirrors `ExtractionJob`, so the two queues read the same way. */
export type ExportJob = { readonly tenantId: string; readonly exportId: string };

export interface ExportDispatcher {
  enqueueExport(job: ExportJob): Promise<void>;
}

/**
 * The largest export this platform will render.
 *
 * A ceiling exists because an artifact is bounded but its *rendering* is not obviously so — a table of ten
 * thousand rows is a small JSON value and a very large PDF. 32 MiB is far past any document a person reads.
 */
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

export type ExportServiceDeps = {
  readonly artifacts: ArtifactService;
  readonly exports: ArtifactExportStore;
  readonly files: FileMetadataStore;
  readonly content: FileContentStore;
  readonly dispatcher?: ExportDispatcher;
  readonly clock?: () => string;
  readonly exportId?: () => string;
  readonly fileId?: () => string;
  readonly contentKey?: () => string;
  /**
   * The date stamped into a rendered PDF.
   *
   * Defaults to a **constant**, not to now. AC-6 is byte-for-byte reproducibility, and a real timestamp makes
   * it unachievable — every comparison would fail on a field nobody reads. A deployment that wants real dates
   * in its PDFs sets this and gives up the guarantee knowingly.
   */
  readonly documentDate?: () => string;
  /**
   * The ceiling on a rendered export.
   *
   * Injectable rather than a constant, for the reason `UploadLimits` is in #129: the real ceiling belongs to
   * the storage bucket, and a limit here larger than the bucket's would refuse at the wrong moment with the
   * wrong number. Defaults to `MAX_EXPORT_BYTES`.
   */
  readonly maxExportBytes?: number;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

const refuse = (code: "invalid_input" | "not_found" | "conflict", message: string) =>
  new AgentPlatformError({ code, message, retryable: false });

/**
 * An artifact's content as blocks.
 *
 * Accepts either the block list #131 produces or a markdown string, and parses the latter with #131's own
 * parser rather than a second one. Two parsers for markdown would eventually disagree, and the one that
 * disagreed would be whichever the exporter used.
 */
export const toBlocks = (value: unknown): readonly DocumentBlock[] => {
  if (typeof value === "string") return parseMarkdown(new TextEncoder().encode(value), DEFAULT_EXTRACTION_LIMITS).blocks;
  if (Array.isArray(value)) return value as readonly DocumentBlock[];
  if (typeof value === "object" && value !== null && Array.isArray((value as { blocks?: unknown }).blocks))
    return (value as { blocks: readonly DocumentBlock[] }).blocks;
  // A JSON artifact with no block structure: rendered as one preformatted paragraph rather than refused, so
  // exporting a data artifact produces something rather than an error.
  return [{ kind: "paragraph", text: JSON.stringify(value, null, 2) }];
};

/** Citations carried on the artifact's content, if any. Absent is normal and not an error. */
export const toCitations = (value: unknown): readonly ExportCitation[] => {
  if (typeof value !== "object" || value === null) return [];
  const raw = (value as { citations?: unknown }).citations;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c, i) => ({
      // The marker defaults to position, so a citation list with no explicit numbering still renders
      // consistently rather than as a row of zeroes.
      marker: typeof c["marker"] === "number" ? c["marker"] : i + 1,
      title: typeof c["title"] === "string" ? c["title"] : "Untitled source",
      ...(typeof c["locator"] === "string" ? { locator: c["locator"] } : {}),
      ...(typeof c["url"] === "string" ? { url: c["url"] } : {}),
    }));
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const createExportService = (deps: ExportServiceDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const documentDate = deps.documentDate ?? (() => FIXED_CREATION_DATE);
  const newExportId = deps.exportId ?? (() => `exp_${crypto.randomUUID()}`);
  const newFileId = deps.fileId ?? (() => `file_${crypto.randomUUID()}`);
  const newContentKey = deps.contentKey ?? (() => `x_${crypto.randomUUID()}`);
  const log = deps.log ?? (() => {});
  const maxBytes = deps.maxExportBytes ?? MAX_EXPORT_BYTES;

  return {
    /**
     * Ask for an export — AC-3.
     *
     * Entitlement first, through `ArtifactService`, so an export is never more accessible than the
     * conversation that produced the artifact and there is no second permission model here.
     *
     * An existing export is *returned*, not re-rendered. That is the property the issue wanted from "an
     * artifact version rather than a transient stream", and the unique constraint is what makes it hold under
     * two simultaneous requests rather than under one.
     */
    async requestExport(
      context: ExecutionContext,
      input: { readonly id: ArtifactId; readonly format: ExportFormat; readonly version?: number },
    ): Promise<{ readonly export: ArtifactExport; readonly enqueued: boolean }> {
      // Reads the artifact through the service, which authorises on the conversation and refuses a deleted
      // artifact -- so both checks happen before an export row exists.
      const { artifact, version } = await this.resolveTarget(context, input);

      const claim = await deps.exports.claim({
        tenantId: context.tenantId,
        export: {
          id: newExportId(),
          artifactId: artifact.id,
          version,
          format: input.format,
          requestedBy: context.principalId,
          createdAt: clock(),
        },
      });
      // Someone already has it: rendered, or being rendered. Either way the answer is this row.
      if (!claim.claimed) return { export: claim.export, enqueued: false };

      if (deps.dispatcher === undefined) return { export: claim.export, enqueued: false };
      try {
        await deps.dispatcher.enqueueExport({ tenantId: context.tenantId, exportId: claim.export.id });
        return { export: claim.export, enqueued: true };
      } catch (error) {
        // Left `pending` rather than propagated. The claim succeeded and the artifact is untouched; an
        // unreachable queue must not turn a request into a failure the user has to understand.
        log("export enqueue failed; left pending", { exportId: claim.export.id, error });
        return { export: claim.export, enqueued: false };
      }
    },

    /** Which version an export targets. The latest unless one is named. */
    async resolveTarget(
      context: ExecutionContext,
      input: { readonly id: ArtifactId; readonly version?: number },
    ): Promise<{ readonly artifact: { id: ArtifactId; name: string; conversationId: ConversationId }; readonly version: number }> {
      const read = await deps.artifacts.read(context, {
        id: input.id,
        ...(input.version === undefined ? {} : { version: input.version }),
      });
      return {
        artifact: {
          id: read.artifact.id,
          name: read.artifact.name,
          conversationId: read.artifact.conversationId,
        },
        version: read.version.version,
      };
    },

    /**
     * Render. Called by the worker, and directly by a single-process host.
     *
     * Returns the record rather than throwing for a render problem. The only throw is for an export row that
     * is not there, which is a caller error rather than a rendering one.
     */
    async render(job: { readonly tenantId: string; readonly exportId: string }, context: ExecutionContext): Promise<ArtifactExport> {
      const record = await deps.exports.get({ tenantId: context.tenantId, id: job.exportId });
      if (record === null) throw refuse("not_found", "no such export");
      if (record.state === "rendered") return record;

      const fail = async (reason: string, message: string): Promise<ArtifactExport> => {
        await deps.exports.complete({
          tenantId: context.tenantId,
          id: record.id,
          state: "failed",
          failureReason: reason,
          failureMessage: message,
          at: clock(),
        });
        return { ...record, state: "failed", failureReason: reason, failureMessage: message };
      };

      let read;
      try {
        // Through the service again, so the render is authorised as the requester rather than as the worker.
        read = await deps.artifacts.read(context, { id: record.artifactId, version: record.version });
      } catch (error) {
        return fail(
          "source-unavailable",
          error instanceof AgentPlatformError ? error.message : "That artifact version could not be read.",
        );
      }

      const blocks = toBlocks(read.content);
      const citations = toCitations(read.content);
      let bytes: Uint8Array;
      let warnings: readonly string[] = [];
      try {
        if (record.format === "pdf") {
          const rendered = renderPdf({
            title: read.artifact.name,
            blocks,
            ...(citations.length === 0 ? {} : { citations }),
            createdAt: documentDate(),
          });
          bytes = rendered.bytes;
          warnings =
            rendered.unsupportedCharacters.length === 0
              ? []
              : [
                  // Reported, because a report whose title rendered without its accents is a document someone
                  // forwards believing it is correct.
                  `These characters are not supported by the export font and were omitted: ${rendered.unsupportedCharacters.join(" ")}`,
                ];
        } else {
          bytes = new TextEncoder().encode(
            renderMarkdown({ title: read.artifact.name, blocks, ...(citations.length === 0 ? {} : { citations }) }),
          );
        }
      } catch (error) {
        // A thrown renderer is the renderer being broken, not the artifact being unrenderable. Logged with
        // the detail; the user gets a sentence.
        log("renderer threw", { exportId: record.id, format: record.format, error });
        return fail("render-failed", "That artifact could not be rendered.");
      }

      if (bytes.byteLength > maxBytes)
        return fail(
          "too-large",
          // The limit named, because "too large" sends someone to guess what to cut.
          `The rendered export is ${bytes.byteLength} bytes and the limit is ${maxBytes} bytes.`,
        );

      const fileId = asId<FileId>(newFileId());
      const contentKey = newContentKey();
      const at = clock();
      // The file row first, then the bytes, then the export row -- the same ordering #129 chose and for the
      // same reason: a crash leaves a `pending` file row reconciliation can see, rather than an object nothing
      // references. And the export stays `pending`, so nothing offers a download that does not exist.
      await deps.files.create({
        tenantId: context.tenantId,
        file: {
          id: fileId,
          conversationId: read.artifact.conversationId,
          filename: exportFilename(read.artifact.name, record.format),
          mediaType: EXPORT_MEDIA_TYPES[record.format],
          byteSize: bytes.byteLength,
          contentKey,
          state: "pending",
          uploadedBy: record.requestedBy,
          createdAt: at,
          // Nothing to extract: this file *is* the extraction's output, rendered. Marking it skipped stops the
          // extraction sweep from picking up every export forever.
          extraction: { state: "skipped", failureMessage: "A rendered export is not extracted.", at },
        },
      });

      const stored = await deps.content.putFile({
        tenantId: context.tenantId,
        contentKey,
        mediaType: EXPORT_MEDIA_TYPES[record.format],
        bytes: (async function* () {
          yield bytes;
        })(),
        maxBytes,
      });
      const moved = await deps.files.transition({
        tenantId: context.tenantId,
        id: fileId,
        from: "pending",
        to: "stored",
        at: clock(),
        checksum: stored.checksum,
      });
      if (!moved.moved) {
        // The conversation was deleted mid-render. The bytes are unreferenced, so they go now rather than
        // waiting for a sweep -- and the export fails with a reason rather than pointing at a dead file.
        await deps.content.deleteFile({ tenantId: context.tenantId, contentKey });
        return fail("source-unavailable", "That conversation was deleted while the export was rendering.");
      }

      const checksum = await sha256Hex(bytes);
      await deps.exports.complete({
        tenantId: context.tenantId,
        id: record.id,
        state: "rendered",
        fileId,
        byteSize: bytes.byteLength,
        checksum,
        at: clock(),
      });
      if (warnings.length > 0) log("export rendered with warnings", { exportId: record.id, warnings });
      return {
        ...record,
        state: "rendered",
        fileId,
        byteSize: bytes.byteLength,
        checksum,
        renderedAt: clock(),
      };
    },

    /**
     * A short-lived download URL — AC-5.
     *
     * Delegated to the file ports, which already clamp the expiry to fifteen minutes and refuse a file whose
     * conversation the caller is not entitled to. Nothing here can produce a permanent URL because nothing
     * here constructs a URL at all.
     */
    async downloadUrl(context: ExecutionContext, exportId: string): Promise<string | null> {
      const record = await this.readyExport(context, exportId);
      const file = await deps.files.get({ tenantId: context.tenantId, id: record.fileId! });
      if (file === null || file.state !== "stored") throw refuse("not_found", "that export's file is missing");
      return deps.content.signedUrl({
        tenantId: context.tenantId,
        contentKey: file.contentKey,
        expiresInSeconds: MAX_SIGNED_URL_SECONDS,
      });
    },

    /** The proxied download, for a content store that cannot sign — and the fallback when one can. */
    async download(context: ExecutionContext, exportId: string): Promise<AsyncIterable<Uint8Array>> {
      const record = await this.readyExport(context, exportId);
      const file = await deps.files.get({ tenantId: context.tenantId, id: record.fileId! });
      if (file === null || file.state !== "stored") throw refuse("not_found", "that export's file is missing");
      const bytes = await deps.content.readFile({ tenantId: context.tenantId, contentKey: file.contentKey });
      if (bytes === null) throw refuse("not_found", "that export's contents are missing");
      return bytes;
    },

    /**
     * An export that is ready to download, or the reason it is not.
     *
     * Entitlement is re-checked through `ArtifactService` on every download rather than trusted from the
     * request that created the export: a user removed from a conversation must stop being able to download
     * what they exported while they were in it.
     */
    async readyExport(context: ExecutionContext, exportId: string): Promise<ArtifactExport> {
      const record = await deps.exports.get({ tenantId: context.tenantId, id: exportId });
      if (record === null) throw refuse("not_found", "no such export");
      // Re-authorised here. The artifact read throws `not_found` for an unentitled caller.
      await deps.artifacts.read(context, { id: record.artifactId, version: record.version });
      if (record.state === "failed")
        throw refuse("invalid_input", record.failureMessage ?? "That export failed to render.");
      if (record.state !== "rendered" || record.fileId === undefined)
        throw refuse("conflict", "That export is still rendering. Try again shortly.");
      return record;
    },

    async listForArtifact(
      context: ExecutionContext,
      input: { readonly id: ArtifactId; readonly limit: number; readonly cursor?: string },
    ): Promise<Page<ArtifactExport>> {
      // Authorised before the query runs: for an unentitled caller a page count still answers "has this been
      // exported".
      await deps.artifacts.read(context, { id: input.id });
      return deps.exports.listByArtifact({
        tenantId: context.tenantId,
        artifactId: input.id,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
    },
  };
};

export type ExportService = ReturnType<typeof createExportService>;

/**
 * A safe download filename.
 *
 * Derived from the artifact's name, which is user input, so it is reduced to a conservative character class
 * rather than trusted: a filename is a `Content-Disposition` header value, and a header value containing a
 * newline is a response-splitting bug rather than a badly-named file.
 */
export const exportFilename = (name: string, format: ExportFormat): string => {
  const stem =
    name
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._ -]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "export";
  return `${stem}.${format === "pdf" ? "pdf" : "md"}`;
};
