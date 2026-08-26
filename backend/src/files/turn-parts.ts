/**
 * Turning stored attachments into turn parts — REQ-036 (#185), AC-3.
 *
 * `TurnContentPart` carries bytes or a URL, never a platform file id: the SDK boundary knows nothing about the
 * file store. Something has to bridge the two, and that something is the place where a modality bridge either
 * respects file authorization or quietly becomes a way around it.
 *
 * So this reads through `FileService` — the same call `read_attachment` makes, not the stores underneath it.
 * Entitlement, existence and state all come from the service, so a turn cannot carry a file the person could not
 * have opened. That is not a convention here; it is the only read path this module has.
 *
 * ## What it refuses, and why each one is a refusal rather than a silence
 *
 * Every skip comes back with a reason, and the caller is expected to say so in the transcript. A dropped
 * attachment that nobody mentions is the worst outcome available: the person sees their screenshot in the
 * thread, the model never received it, and the answer reads as though the model looked and disagreed.
 *
 * - **A media type the model cannot take.** Sending a `.docx` as an image part produces a provider error at best
 *   and a confidently wrong answer at worst.
 * - **A file over the byte ceiling.** Base64 inflates by a third, and an image is a single indivisible part —
 *   there is no paging a picture. A 20MB photo is a request that fails after the money is spent.
 * - **More attachments than the ceiling.** Ten images in one turn is a context window, not a question.
 * - **A file the caller may not read.** `FileService.get` throws; the throw is caught and reported as a skip, so
 *   one inaccessible attachment does not fail a turn that had three others.
 */

import { AgentPlatformError } from "../core/errors.js";
import { asId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import type { FileId } from "../core/ids.js";
import type { FileMetadata } from "../persistence/index.js";
import type { FileService } from "./index.js";
import type { InputModality } from "../models/index.js";
import type { TurnContentPart } from "../models/streaming.js";

/**
 * Media types that may travel as an image part, by modality.
 *
 * An allow-list, not a `image/*` wildcard — the same choice `read_attachment` makes for text. A wildcard admits
 * every future format a provider does not accept, and the failure arrives from the provider as a 400 nobody can
 * act on. `image/svg+xml` is deliberately absent: an SVG is a document that can fetch, and a model asked to
 * "look at" one is being handed markup.
 */
export const IMAGE_PART_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** PDFs travel as a file part where the model accepts the `pdf` modality. */
export const FILE_PART_MEDIA_TYPES = ["application/pdf"] as const;

/**
 * The per-attachment ceiling.
 *
 * Smaller than `read_attachment`'s 32KB window is *larger*, not smaller, and the difference is the point: text
 * can be paged, so its tool reads a window. An image cannot be paged, so the whole thing travels or none of it
 * does — and the ceiling is what stops "the whole thing" from being 20MB.
 */
export const MAX_ATTACHMENT_PART_BYTES = 4 * 1024 * 1024;

/** How many attachments one turn may carry. Ten images is a context window, not a question. */
export const MAX_ATTACHMENT_PARTS = 4;

export type SkippedAttachment = {
  readonly fileId: string;
  readonly filename?: string;
  /** `unreadable` covers both "does not exist" and "not yours" — the service does not distinguish, deliberately. */
  readonly reason: "unsupported-media-type" | "too-large" | "too-many" | "unreadable" | "modality-not-accepted";
  /** A sentence the caller can put in the transcript verbatim. */
  readonly message: string;
};

export type ResolvedAttachments = {
  readonly parts: readonly TurnContentPart[];
  /**
   * What did not make it, and why.
   *
   * Never empty-and-silent: a caller that ignores this is a caller whose users watch their attachment vanish.
   */
  readonly skipped: readonly SkippedAttachment[];
};

const modalityFor = (mediaType: string): InputModality | undefined => {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if ((IMAGE_PART_MEDIA_TYPES as readonly string[]).includes(type)) return "image";
  if ((FILE_PART_MEDIA_TYPES as readonly string[]).includes(type)) return "pdf";
  return undefined;
};

export type AttachmentResolverDeps = {
  readonly files: FileService;
  readonly maxBytes?: number;
  readonly maxParts?: number;
};

export type ResolveInput = {
  readonly fileIds: readonly string[];
  /**
   * What the resolved model accepts.
   *
   * Passed in rather than looked up, because the model is chosen by the caller and this module has no registry.
   * Omitted means "do not filter" — which is only correct when the caller applies `modelModalities` to the turn
   * afterwards, and `streamModelTurn` does exactly that. Both checks existing is not redundancy: this one can
   * say *which file* was dropped, and that one can only refuse the whole turn.
   */
  readonly accepts?: readonly InputModality[];
};

export type AttachmentResolver = {
  resolve(context: ExecutionContext, input: ResolveInput): Promise<ResolvedAttachments>;
};

export const createAttachmentResolver = (deps: AttachmentResolverDeps): AttachmentResolver => {
  const maxBytes = deps.maxBytes ?? MAX_ATTACHMENT_PART_BYTES;
  const maxParts = deps.maxParts ?? MAX_ATTACHMENT_PARTS;

  return {
    async resolve(context, input) {
      const parts: TurnContentPart[] = [];
      const skipped: SkippedAttachment[] = [];

      for (const raw of input.fileIds) {
        const fileId = raw.replace(/^file:/, "");

        if (parts.length >= maxParts) {
          skipped.push({
            fileId,
            reason: "too-many",
            message: `Only ${maxParts} attachments can travel with one message; this one was left out.`,
          });
          continue;
        }

        let file: FileMetadata;
        try {
          // Through the service, so entitlement, existence and state are its answer and not ours.
          file = await deps.files.get(context, asId<FileId>(fileId));
        } catch (error) {
          skipped.push({
            fileId,
            reason: "unreadable",
            // Deliberately not distinguishing "missing" from "not yours": the service does not, because saying
            // which would tell a caller that a file they cannot read exists.
            message:
              error instanceof AgentPlatformError && error.code === "not_found"
                ? "That attachment could not be read."
                : "That attachment could not be read.",
          });
          continue;
        }

        const modality = modalityFor(file.mediaType);
        if (modality === undefined) {
          skipped.push({
            fileId,
            filename: file.filename,
            reason: "unsupported-media-type",
            message: `${file.filename} is ${file.mediaType}, which cannot be shown to a model directly. Read it with a tool instead.`,
          });
          continue;
        }

        if (input.accepts !== undefined && !input.accepts.includes(modality)) {
          skipped.push({
            fileId,
            filename: file.filename,
            reason: "modality-not-accepted",
            message: `${file.filename} is ${modality}, which the selected model does not accept.`,
          });
          continue;
        }

        if (file.byteSize > maxBytes) {
          skipped.push({
            fileId,
            filename: file.filename,
            reason: "too-large",
            // The number, so the sentence is actionable rather than a policy statement.
            message:
              `${file.filename} is ${Math.round(file.byteSize / 1024)}KB, over the ` +
              `${Math.round(maxBytes / 1024)}KB limit for an attachment sent to a model. An image cannot be ` +
              `read in pages, so it travels whole or not at all.`,
          });
          continue;
        }

        /**
         * Read to the ceiling and *stop*, then check.
         *
         * `byteSize` is metadata, and metadata can disagree with the object — a truncated upload, a store
         * someone wrote to directly. Reading with its own bound means a file that lies about its size costs the
         * ceiling rather than whatever it actually is.
         */
        const chunks: Uint8Array[] = [];
        let read = 0;
        let overflowed = false;
        for await (const chunk of await deps.files.read(context, asId<FileId>(fileId))) {
          read += chunk.byteLength;
          if (read > maxBytes) {
            overflowed = true;
            break;
          }
          chunks.push(chunk);
        }
        if (overflowed) {
          skipped.push({
            fileId,
            filename: file.filename,
            reason: "too-large",
            message: `${file.filename} is larger than its recorded size and over the attachment limit.`,
          });
          continue;
        }

        const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        const data = `data:${file.mediaType};base64,${bytes.toString("base64")}`;
        parts.push(
          modality === "image"
            ? { kind: "image", image: data, mediaType: file.mediaType }
            : { kind: "file", data, mediaType: file.mediaType, filename: file.filename },
        );
      }

      return { parts, skipped };
    },
  };
};

/**
 * The sentence a caller puts in the transcript when something was left out.
 *
 * Provided rather than left to each host, because "say so in the transcript" is the half of AC-2 that a host
 * forgets: the parts arrive, the turn works, and the skip is a field nobody read. One sentence, already written.
 */
export const describeSkipped = (skipped: readonly SkippedAttachment[]): string | null => {
  if (skipped.length === 0) return null;
  const lines = skipped.map((s) => `- ${s.message}`);
  return `Some attachments were not sent to the model:\n${lines.join("\n")}`;
};
